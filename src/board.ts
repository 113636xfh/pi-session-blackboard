import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Board, BoardEntry, Section } from "./types.js";
import { SECTION_HEADERS, SECTIONS } from "./types.js";
import { archiveDir, boardPath, safeSid, statePath } from "./paths.js";

/** "2026-08-28 21:40" local time for entry timestamps. */
export function nowLocal(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * UTC stamp for archive file names. Includes milliseconds and a random
 * suffix so two rotations within the same second never collide (a collision
 * would silently overwrite an existing archive file).
 */
export function nowStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
	const rand = String(Math.floor(Math.random() * 1e4)).padStart(4, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${ms}-${rand}`;
}

const HEADER_RE = /<!--\s*sbb:v1\s*\|\s*updated:\s*([^\s|>]+)\s*(?:\|\s*entries:\s*(\d+))?\s*-->/;
const SECTION_RE = /^## +(.+?)\s*$/;
const ENTRY_RE = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.*)$/;

export function emptyBoard(): Board {
	const sections = {} as Record<Section, BoardEntry[]>;
	const raw = {} as Record<Section, string[]>;
	for (const s of SECTIONS) {
		sections[s] = [];
		raw[s] = [];
	}
	return { header: {}, sections, raw, extra: [] };
}

/** Parse a board file. Tolerant: unknown sections and stray lines are preserved, never dropped. */
export function parseBoard(text: string | null): Board {
	const board = emptyBoard();
	if (!text) return board;

	const hm = text.match(HEADER_RE);
	if (hm) {
		board.header.updated = hm[1];
		if (hm[2]) board.header.entries = Number(hm[2]);
	}

	let current: Section | null = null;
	let extra: { title: string; lines: string[] } | null = null;
	let inHeader = true;

	for (const line of text.split("\n")) {
		const sec = line.match(SECTION_RE);
		if (sec) {
			inHeader = false;
			const known = (Object.keys(SECTION_HEADERS) as Section[]).find((s) => SECTION_HEADERS[s].toLowerCase() === sec[1].toLowerCase());
			if (known) {
				current = known;
				extra = null;
			} else {
				current = null;
				extra = { title: sec[1], lines: [] };
				board.extra.push(extra);
			}
			continue;
		}
		if (inHeader) continue; // anything before the first section (title/comment header) is regenerated
		if (current) {
			const em = line.match(ENTRY_RE);
			if (em) board.sections[current].push({ ts: em[1], text: em[2] });
			else if (line.trim() !== "") board.raw[current].push(line);
		} else if (extra) {
			extra.lines.push(line);
		}
	}
	return board;
}

export function countAll(b: Board): number {
	let n = 0;
	for (const s of SECTIONS) n += b.sections[s].length;
	return n;
}

/** Marks a summary this extension produced (so it is never adopted back in). */
export const BOARD_SUMMARY_MARKER = "# Session context checkpoint";

/** Below this many real entries the board is not trusted as the summary. */
export const BOARD_SUMMARY_FLOOR = 3;

/** Real (non-pointer) entries on the board. */
export function countReal(b: Board): number {
	let n = 0;
	for (const s of SECTIONS) {
		for (const e of b.sections[s]) if (!e.text.startsWith("(archived)")) n++;
	}
	return n;
}

// ── adopting a pre-existing (native) summary ──────────────────────────────
//
// Enabling this extension mid-session means pi has already summarised the
// earlier history into a compaction entry. Once the board becomes the summary,
// that text is the only surviving record of it — so parse it into entries
// instead of letting the next compaction overwrite it with an empty board.
//
// Routing is by summary header (pi native `## Goal`, `## Constraints &
// Preferences`, vcc's `[Files And Changes]`, …), with content sniffing as a
// second signal. Anything unrecognised lands in decisions rather than being
// dropped: a slightly wrong section is recoverable at the next checkpoint,
// a lost fact is not.

const SUMMARY_HEADER_ROUTES: [RegExp, Section][] = [
	[/scope change|goal|objective|目标|目的|task/i, "goal"],
	[/preference|constraint|偏好|约束|style|rule/i, "prefs"],
	[/next|todo|follow.?up|下一步|后续|待办/i, "next"],
	[/issue|problem|blocker|error|bug|风险|问题|阻塞|失败|未解决|待解决/i, "issues"],
	[/file|change|artifact|path|edit|文件|改动|修改|progress|done|completed|提交/i, "files"],
	[/decision|choice|trade.?off|选择|决定|方案/i, "decisions"],
	[/finding|learned|discovered|lesson|发现|结论|实测/i, "findings"],
];

// NOTE: no \b around CJK alternatives — CJK chars are not \w in JS, so a CJK
// word glued to other CJK text (no punctuation) never gets a word boundary.
const SUMMARY_CONTENT_ROUTES: [RegExp, Section][] = [
	[/next step|next up|\btodo\b|下一步|接下来/i, "next"],
	[/error|failed|exception|enoent|eacces|报错|失败|阻塞|卡在/i, "issues"],
	[/(?:^|[\s`'"])[A-Za-z]:[\\/][^\s]+|(?:^|\s)\.{0,2}\/[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|cs|gdshader|cpp|h|sh)\b/, "files"],
	[/prefer|must not|do not|always|never|要求|偏好|不要|必须/i, "prefs"],
	[/decide|decided|chosen|instead of|rationale|决定|选择|理由/i, "decisions"],
	// Findings last: a line that also names an error, a path, a preference or a
	// decision stays there; findings catch only pure result/residue lines.
	[/实测|真相|根因|出乎意料|非显然|turns? out|it turns out|it became clear|surprising\w*|unexpected\w*|root cause|measured/i, "findings"],
];

const JUNK_LINE =
	/^(?:[-*+]\s*)?(?:\[?\s*(?:scope change|x|✓|✔|done|n\/a|none|todo|tbd|无|待填)\s*\]?|\(archived\).*|<!--.*-->)$/i;

function routeSummaryHeader(header: string): Section | null {
	for (const [re, section] of SUMMARY_HEADER_ROUTES) if (re.test(header)) return section;
	return null;
}

function routeSummaryContent(line: string): Section | null {
	for (const [re, section] of SUMMARY_CONTENT_ROUTES) if (re.test(line)) return section;
	return null;
}

/**
 * Flatten a compaction summary into board entries. Pure: no fs, no writes.
 *
 * Bullets and prose lines both become candidates; headers only route them.
 * Sub-bullets are kept as their own entries — in a compaction summary a nested
 * line is usually its own fact (a path, an error, a number).
 */
export function parseSummarySections(summary: string): { section: Section; text: string }[] {
	const out: { section: Section; text: string }[] = [];
	let header: Section | null = null;
	let headerText = "";
	for (const raw of String(summary ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("<!--")) continue;
		const md = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		const br = /^\[(.+?)\]\s*:?\s*$/.exec(line);
		if (md || br) {
			headerText = (md ? md[1] : (br as RegExpExecArray)[1]).trim();
			// The board's own summary must never be adopted back in.
			if (headerText.startsWith(BOARD_SUMMARY_MARKER)) {
				header = null;
				continue;
			}
			header = routeSummaryHeader(headerText);
			continue;
		}
		const body = line.replace(/^[-*+]\s+/, "").replace(/^\[[ xX]\]\s*/, "").trim();
		if (!body || JUNK_LINE.test(line)) continue;
		// Content sniffing wins over the header: a "Progress" bullet naming an
		// error is an issue, not a change.
		const section = routeSummaryContent(body) ?? header ?? "decisions";
		out.push({ section, text: body });
	}
	return out;
}

/**
 * Lines already living in this session's archive files, keyed like the board's
 * dedupe key. A merge must treat them as known: otherwise the entries a PREVIOUS
 * merge archived (its own overflow) look fresh again on the next pass and climb
 * back onto the board.
 */
function archivedLineKeys(boardDir: string, sessionId: string): Set<string> {
	const out = new Set<string>();
	const dir = archiveDir(boardDir, sessionId);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return out;
	}
	for (const f of files) {
		let text: string;
		try {
			text = readFileSync(join(dir, f), "utf-8");
		} catch {
			continue;
		}
		let section = "";
		for (const line of text.split(/\r?\n/)) {
			const h = /^##\s*From:\s*(.+?)\s*$/.exec(line);
			if (h) {
				section = routeSummaryHeader(h[1]) ?? "";
				continue;
			}
			const m = /^-\s*\[[^\]]*\]\s*(.+)$/.exec(line);
			if (m && section) out.add(`${section} ${m[1].trim().toLowerCase()}`);
		}
	}
	return out;
}

export type MergeResult =
	| { merged: false; reason: "own-summary" | "empty-summary" | "nothing-parseable" }
	| {
			merged: true;
			/** entries that were new to the board */
			added: number;
			/** lines already present (case-insensitive) — nothing was duplicated */
			deduped: number;
			counts: Record<string, number>;
			archived: string[];
			dropped: number;
	  };

/** Caps when adopting a foreign summary: keep the board readable as a summary. */
const SEED_MAX_PER_SECTION = 6;
/** Adopted lines get more room than agent-written ones (see below). */
const SEED_MAX_ENTRY_CHARS = 600;

/**
 * Merge a native compaction summary INTO the board.
 *
 * The board does not have to be thin: a summary the model just wrote carries
 * whatever the board missed, and losing it is exactly the loss this extension
 * exists to prevent. Safety comes from structure, not from refusing:
 *   - our own board summary is refused (BOARD_SUMMARY_MARKER), so a board-mode
 *     compaction can never be parsed back into the board;
 *   - per-merge section cap (newest SEED_MAX_PER_SECTION kept, the rest archived
 *     into ONE adopted-<ts>.md), so one summary cannot flood the board;
 *   - the normal per-section rotation still applies, so the board stays bounded;
 *   - exact (case-insensitive) dedupe, so re-merging the same summary is a no-op.
 */
export function mergeSummaryIntoBoard(
	boardDir: string,
	sessionId: string,
	cfg: { maxEntriesPerSection: number; maxEntryChars: number },
	summary: string,
): MergeResult {
	const text = String(summary ?? "");
	if (!text.trim()) return { merged: false, reason: "empty-summary" };
	if (text.includes(BOARD_SUMMARY_MARKER)) return { merged: false, reason: "own-summary" };

	const parsed = parseSummarySections(text);
	if (parsed.length === 0) return { merged: false, reason: "nothing-parseable" };

	// Drop what the board already knows BEFORE trimming. Without this, re-merging
	// the same summary would pass the per-section cap again, "drop" lines it had
	// already archived, and write a fresh adopted-<ts>.md on every single pass.
	const board = readBoardFile(boardDir, sessionId);
	const known = new Set<string>();
	for (const s of SECTIONS) for (const e of board.sections[s]) known.add(`${s} ${e.text.toLowerCase()}`);
	for (const k of archivedLineKeys(boardDir, sessionId)) known.add(k);
	const fresh = parsed.filter((p) => !known.has(`${p.section} ${p.text.toLowerCase()}`));
	if (fresh.length === 0) {
		const counts: Record<string, number> = {};
		for (const s of SECTIONS) {
			const n = board.sections[s].filter((e) => !e.text.startsWith("(archived)")).length;
			if (n > 0) counts[s] = n;
		}
		return { merged: true, added: 0, deduped: parsed.length, counts, archived: [], dropped: 0 };
	}

	// Adopted lines come from a summary we did not write, so they get room: a hard
	// cut mid-rationale would lose the part that matters. Overflow is trimmed HERE
	// (newest kept per section) rather than by the per-commit rotation, so the whole
	// merge produces exactly one archive file.
	const grouped = new Map<Section, string[]>();
	for (const p of fresh) {
		const arr = grouped.get(p.section) ?? [];
		arr.push(p.text);
		grouped.set(p.section, arr);
	}
	const keep: CommitInput[] = [];
	const dropped: { section: Section; text: string }[] = [];
	for (const [section, texts] of grouped) {
		if (texts.length <= SEED_MAX_PER_SECTION) {
			for (const text of texts) keep.push({ section, text });
			continue;
		}
		for (const text of texts.slice(0, -SEED_MAX_PER_SECTION)) dropped.push({ section, text });
		for (const text of texts.slice(-SEED_MAX_PER_SECTION)) keep.push({ section, text });
	}

	const archivedRel = writeAdoptionArchive(boardDir, sessionId, dropped);
	const res = commitEntries(
		boardDir,
		sessionId,
		{ maxEntriesPerSection: cfg.maxEntriesPerSection, maxEntryChars: SEED_MAX_ENTRY_CHARS },
		keep,
	);
	const archived = [...res.archivedFiles];
	if (archivedRel) {
		const board = res.board;
		board.sections.archived.push({
			ts: nowLocal(),
			text: `(archived) ${dropped.length} entries from the compaction summary → ${archivedRel}`,
		});
		writeBoard(boardDir, sessionId, board);
		archived.push(archivedRel);
	}

	const counts: Record<string, number> = {};
	for (const s of SECTIONS) {
		const n = res.board.sections[s].filter((e) => !e.text.startsWith("(archived)")).length;
		if (n > 0) counts[s] = n;
	}
	return {
		merged: true,
		added: res.committed,
		deduped: res.deduped,
		counts,
		archived,
		dropped: dropped.length,
	};
}

/** Render the board back to markdown (stable section order; extras last). */
export function renderBoard(b: Board): string {
	const lines: string[] = [];
	lines.push("# Session Blackboard");
	lines.push(`<!-- sbb:v1 | updated: ${b.header.updated ?? "never"} | entries: ${countAll(b)} -->`);
	lines.push("");
	for (const s of SECTIONS) {
		lines.push(`## ${SECTION_HEADERS[s]}`);
		for (const e of b.sections[s]) lines.push(e.ts ? `- [${e.ts}] ${e.text}` : `- ${e.text}`);
		for (const r of b.raw[s]) lines.push(r);
		lines.push("");
	}
	for (const x of b.extra) {
		lines.push(`## ${x.title}`);
		lines.push(...x.lines);
		lines.push("");
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function readBoardFile(boardDir: string, sessionId: string): Board {
	const p = boardPath(boardDir, sessionId);
	try {
		if (!existsSync(p)) return emptyBoard();
		return parseBoard(readFileSync(p, "utf-8"));
	} catch {
		return emptyBoard();
	}
}

export function writeBoard(boardDir: string, sessionId: string, b: Board): void {
	const p = boardPath(boardDir, sessionId);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, renderBoard(b), "utf-8");
}

/** Sanitize a raw entry line: one line, trimmed, capped. */
export function cleanEntryText(text: string, maxChars: number): string {
	return text.replace(/\s+/g, " ").trim().slice(0, Math.max(10, maxChars));
}

function writeArchiveFile(
	boardDir: string,
	sessionId: string,
	section: Section,
	overflow: BoardEntry[],
): string {
	const dir = archiveDir(boardDir, sessionId);
	mkdirSync(dir, { recursive: true });
	const name = `board-${nowStamp()}.md`;
	const lines: string[] = [
		`# Blackboard archive — session ${safeSid(sessionId)}`,
		`<!-- written: ${new Date().toISOString()} | from: ${SECTION_HEADERS[section]} -->`,
		"",
		`## From: ${SECTION_HEADERS[section]}`,
		...overflow.map((e) => `- [${e.ts}] ${e.text}`),
		"",
	];
	const p = join(dir, name);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, lines.join("\n"), "utf-8");
	renameSync(tmp, p);
	return `archive/${safeSid(sessionId)}/${name}`;
}

/**
 * One archive file for a whole adoption, grouped by section.
 *
 * writeArchiveFile is per-overflow, so adopting ~240 parsed lines through the
 * normal commit path produced 200+ one-line archive files (measured). Adoption
 * drops its own overflow up front and writes a single file instead.
 */
function writeAdoptionArchive(
	boardDir: string,
	sessionId: string,
	dropped: { section: Section; text: string }[],
): string | null {
	if (dropped.length === 0) return null;
	const dir = archiveDir(boardDir, sessionId);
	mkdirSync(dir, { recursive: true });
	const name = `adopted-${nowStamp()}.md`;
	const ts = nowLocal();
	const lines: string[] = [
		`# Blackboard archive — session ${safeSid(sessionId)}`,
		`<!-- written: ${new Date().toISOString()} | from: adopted prior compaction summary -->`,
		"",
	];
	let current: Section | null = null;
	for (const d of dropped) {
		if (d.section !== current) {
			current = d.section;
			lines.push(`## From: ${SECTION_HEADERS[d.section]}`);
		}
		lines.push(`- [${ts}] ${d.text}`);
	}
	lines.push("");
	const p = join(dir, name);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, lines.join("\n"), "utf-8");
	renameSync(tmp, p);
	return `archive/${safeSid(sessionId)}/${name}`;
}

export type CommitInput = {
	section: Section;
	text: string;
	/**
	 * Unique substring of an existing board entry that this line REPLACES.
	 * The old line is moved to the archive file in the same call, so a changed
	 * fact can never end up in the summary next to the version it replaced.
	 */
	supersedes?: string;
};

export type CommitResult = {
	board: Board;
	archivedFiles: string[];
	committed: number;
	deduped: number;
	/** Archive files written because an entry was explicitly superseded. */
	supersededFiles: string[];
	/** supersedes targets that matched nothing, or matched more than one entry. */
	supersedeMisses: { target: string; reason: string }[];
};

/** Single case-insensitive substring hit across every non-archived section. */
function locateEntry(
	board: Board,
	target: string,
): { count: number; hit: { section: Section; idx: number; entry: BoardEntry } | null } {
	const t = target.trim().toLowerCase();
	let count = 0;
	let hit: { section: Section; idx: number; entry: BoardEntry } | null = null;
	if (!t) return { count: 0, hit: null };
	for (const s of SECTIONS) {
		if (s === "archived") continue;
		board.sections[s].forEach((entry, idx) => {
			if (entry.text.toLowerCase().includes(t)) {
				count++;
				hit = { section: s, idx, entry };
			}
		});
	}
	return { count, hit };
}

/**
 * Commit reviewed entries into the board. Deterministic, no LLM:
 *  - one line per entry, auto timestamp, sanitized
 *  - case-insensitive dedupe against existing entries
 *  - per-section overflow is rotated into an archive file (append-only)
 */
export function commitEntries(
	boardDir: string,
	sessionId: string,
	cfg: { maxEntriesPerSection: number; maxEntryChars: number },
	entries: CommitInput[],
): CommitResult {
	const board = readBoardFile(boardDir, sessionId);
	const ts = nowLocal();
	const archivedFiles: string[] = [];
	const supersededFiles: string[] = [];
	const supersedeMisses: { target: string; reason: string }[] = [];
	let committed = 0;
	let deduped = 0;

	for (const e of entries) {
		const text = cleanEntryText(e.text, cfg.maxEntryChars);
		if (!text) continue;

		// Supersede FIRST, so the line being replaced is out of the board before the
		// replacement lands (and before the dedupe check below can compare against it).
		if (typeof e.supersedes === "string" && e.supersedes.trim()) {
			const target = e.supersedes;
			const { count, hit } = locateEntry(board, target);
			if (count === 1 && hit) {
				const m = hit as { section: Section; idx: number; entry: BoardEntry };
				const [removed] = board.sections[m.section].splice(m.idx, 1);
				const rel = writeArchiveFile(boardDir, sessionId, m.section, [removed]);
				supersededFiles.push(rel);
				board.sections.archived.push({
					ts,
					text: `(archived) 1 ${SECTION_HEADERS[m.section]} entry superseded by a newer line → ${rel}`,
				});
			} else if (count === 0) {
				supersedeMisses.push({ target, reason: "no board entry contains this substring" });
			} else {
				supersedeMisses.push({ target, reason: `matches ${count} entries — use a longer, unique substring` });
			}
		}

		const key = text.toLowerCase();
		const arr = board.sections[e.section];
		if (arr.some((x) => x.text.toLowerCase() === key)) {
			deduped++;
			continue;
		}
		arr.push({ ts, text });
		committed++;

		if (e.section !== "archived") {
			// Rotate overflow: real entries only. Pointer lines are never rotated —
			// they stay on the board as the reference to their archive file.
			const isPointer = (x: BoardEntry) => x.text.startsWith("(archived)");
			const realCount = arr.filter((x) => !isPointer(x)).length;
			if (realCount > cfg.maxEntriesPerSection) {
				const excess = realCount - cfg.maxEntriesPerSection;
				const overflow: BoardEntry[] = [];
				let i = 0;
				while (overflow.length < excess && i < arr.length) {
					const x = arr[i];
					if (!isPointer(x)) {
						overflow.push(x);
						arr.splice(i, 1);
					} else {
						i++;
					}
				}
				const rel = writeArchiveFile(boardDir, sessionId, e.section, overflow);
				archivedFiles.push(rel);
				arr.push({ ts, text: `(archived) ${overflow.length} ${SECTION_HEADERS[e.section]} entries rotated to ${rel}` });
			}
		}
	}

	board.header.updated = ts;
	writeBoard(boardDir, sessionId, board);
	return { board, archivedFiles, committed, deduped, supersededFiles, supersedeMisses };
}

/**
 * Mark open issue entries as resolved when a referenced file was modified in
 * the current turn. Deterministic string matching; never removes history.
 */
export function markResolved(board: Board, modifiedPaths: string[]): number {
	if (modifiedPaths.length === 0) return 0;
	const ts = nowLocal();
	let n = 0;
	for (const e of board.sections.issues) {
		if (e.text.includes("[RESOLVED")) continue;
		const hit = modifiedPaths.find((p) => p && e.text.includes(p));
		if (hit) {
			e.text = `${e.text} → [RESOLVED ${ts}]`;
			n++;
		}
	}
	if (n > 0) board.header.updated = ts;
	return n;
}

/**
 * Archive a single entry identified by a unique substring (agent-driven
 * "this is no longer relevant" moves). Returns the relative archive path, or
 * null if no single entry matches.
 */
export function archiveEntry(
	boardDir: string,
	sessionId: string,
	target: string,
): { board: Board; archived: string | null } {
	const board = readBoardFile(boardDir, sessionId);
	const t = target.trim().toLowerCase();
	if (!t) return { board, archived: null };

	let match: { section: Section; idx: number; entry: BoardEntry } | null = null;
	let matches = 0;
	for (const s of SECTIONS) {
		if (s === "archived") continue;
		board.sections[s].forEach((entry, idx) => {
			if (entry.text.toLowerCase().includes(t)) {
				matches++;
				match = { section: s, idx, entry };
			}
		});
	}
	if (matches !== 1 || !match) return { board, archived: null };

	const m = match as { section: Section; idx: number; entry: BoardEntry };
	const [removed] = board.sections[m.section].splice(m.idx, 1);
	const rel = writeArchiveFile(boardDir, sessionId, m.section, [removed]);
	board.sections.archived.push({ ts: nowLocal(), text: `(archived) 1 ${SECTION_HEADERS[m.section]} entry moved to ${rel}` });
	board.header.updated = nowLocal();
	writeBoard(boardDir, sessionId, board);
	return { board, archived: rel };
}

/** Delete board + state for a session (archive files are kept). */
export function resetAll(boardDir: string, sessionId: string): void {
	try {
		rmSync(boardPath(boardDir, sessionId), { force: true });
		rmSync(statePath(boardDir, sessionId), { force: true });
	} catch {
		/* non-fatal */
	}
}

/**
 * Compact board digest for session-JSONL mirroring (vcc_recall searchable,
 * future deterministic compaction consumable). Kept small on purpose.
 */
export function digest(board: Board, sessionId: string): Record<string, unknown> {
	const last = (n: number) => (arr: BoardEntry[]) => arr.slice(-n).map((e) => e.text);
	const openIssues = board.sections.issues.filter((e) => !e.text.includes("[RESOLVED")).length;
	const counts: Record<string, number> = {};
	for (const s of SECTIONS) counts[s] = board.sections[s].length;
	return {
		v: 1,
		at: new Date().toISOString(),
		session: safeSid(sessionId),
		goal: last(3)(board.sections.goal),
		findings: last(3)(board.sections.findings),
		next: last(3)(board.sections.next),
		recentFiles: last(5)(board.sections.files),
		openIssues,
		counts,
	};
}

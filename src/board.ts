import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Board, BoardEntry, DraftSections, PendingDraft, Section } from "./types.js";
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

/**
 * Pointer lines (`(archived) … → archive/…`) are extension bookkeeping, not
 * facts. They used to accumulate forever — measured: 60 commits with a
 * per-section budget of 5 left 55 pointer lines and 4.7 KB in ONE section,
 * the only unbounded part of the design. Dropping the oldest pointers loses
 * nothing: the archive files stay on disk and `blackboard_recall` greps the
 * archive directory, so a pointer is a convenience, not the index.
 */
export const MAX_POINTER_LINES = 5;

/** Keep only the newest `keep` pointer lines per section (in place). */
export function capPointerLines(b: Board, keep: number = MAX_POINTER_LINES): number {
	let dropped = 0;
	for (const s of SECTIONS) {
		const arr = b.sections[s];
		const pointers = arr.filter((e) => e.text.startsWith("(archived)"));
		if (pointers.length <= keep) continue;
		const drop = new Set(pointers.slice(0, pointers.length - keep));
		for (let i = arr.length - 1; i >= 0; i--) {
			if (drop.has(arr[i])) {
				arr.splice(i, 1);
				dropped++;
			}
		}
	}
	return dropped;
}

export function writeBoard(boardDir: string, sessionId: string, b: Board): void {
	capPointerLines(b);
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
 * One archive file for a whole batch (an adoption, or every supersedes in one
 * commit), grouped by section.
 *
 * writeArchiveFile is per-overflow, so adopting ~240 parsed lines through the
 * normal commit path produced 200+ one-line archive files (measured), and a
 * commit with 5 supersedes wrote 5 more. One immutable file per batch instead.
 */
function writeGroupedArchive(
	boardDir: string,
	sessionId: string,
	prefix: string,
	note: string,
	items: { section: Section; ts: string; text: string }[],
): string | null {
	if (items.length === 0) return null;
	const dir = archiveDir(boardDir, sessionId);
	mkdirSync(dir, { recursive: true });
	const name = `${prefix}-${nowStamp()}.md`;
	const lines: string[] = [
		`# Blackboard archive — session ${safeSid(sessionId)}`,
		`<!-- written: ${new Date().toISOString()} | from: ${note} -->`,
		"",
	];
	// Group by section in board order, keeping the items' own order inside a
	// section (so a batch reads the way it was committed).
	for (const s of SECTIONS) {
		const group = items.filter((d) => d.section === s);
		if (!group.length) continue;
		lines.push(`## From: ${SECTION_HEADERS[s]}`);
		for (const d of group) lines.push(`- [${d.ts}] ${d.text}`);
	}
	lines.push("");
	const p = join(dir, name);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, lines.join("\n"), "utf-8");
	renameSync(tmp, p);
	return `archive/${safeSid(sessionId)}/${name}`;
}

function writeAdoptionArchive(
	boardDir: string,
	sessionId: string,
	dropped: { section: Section; text: string }[],
): string | null {
	const ts = nowLocal();
	return writeGroupedArchive(
		boardDir,
		sessionId,
		"adopted",
		"adopted prior compaction summary",
		dropped.map((d) => ({ section: d.section, ts, text: d.text })),
	);
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
	/** The entries that actually landed (deduped/sanitized text), in commit order. */
	added: { section: Section; text: string }[];
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
	const added: { section: Section; text: string }[] = [];
	const supersededEntries: { section: Section; ts: string; text: string }[] = [];
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
				// Batched: every supersedes in this commit lands in ONE archive file
				// (and produces ONE pointer line), written after the loop.
				supersededEntries.push({ section: m.section, ts: removed.ts, text: removed.text });
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
		added.push({ section: e.section, text });

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

	if (supersededEntries.length > 0) {
		const rel = writeGroupedArchive(boardDir, sessionId, "superseded", "superseded by newer board lines", supersededEntries);
		if (rel) {
			supersededFiles.push(rel);
			board.sections.archived.push({
				ts,
				text: `(archived) ${supersededEntries.length} ${supersededEntries.length === 1 ? "entry superseded by a newer line" : "entries superseded by newer lines"} → ${rel}`,
			});
		}
	}

	board.header.updated = ts;
	writeBoard(boardDir, sessionId, board);
	return { board, archivedFiles, committed, deduped, supersededFiles, supersedeMisses, added };
}

/**
 * Which mechanical draft lines land with a commit WITHOUT the agent retyping
 * them.
 *
 * Measured on 70 debug logs / 26 real boards: extraction produced 2013 draft
 * lines over 258 turns, but only 143 commits happened, and the boards carry
 * just 12 `MODIFIED`/`COMMIT` lines against 528 agent-written ones (2.2%).
 * The draft used to be discarded on commit, so a deterministic fact survived
 * only if the model retyped it — and the exact facts this package exists to
 * preserve (which file, which symbol, which commit hash) were the ones lost.
 *
 *  - "none": today's old behaviour — the agent must retype everything;
 *  - "deterministic" (default): only the zero-heuristic extractor output
 *    (`MODIFIED <path> (symbols)` / `COMMIT <hash> <subject>`) auto-lands.
 *    The prose-mined sections (decisions/findings/issues/next/prefs/goal) stay
 *    heuristic and still require the agent's own line;
 *  - "all": the whole draft lands; the agent's job becomes culling (`dropDraft`).
 */
export type DraftPolicy = "none" | "deterministic" | "all";

/** The line prefixes the deterministic extractors emit (no pattern mining). */
const DETERMINISTIC_PREFIXES = ["MODIFIED ", "COMMIT "];

/**
 * Split the pending draft into what a commit should auto-land and what the
 * agent explicitly dropped (`dropDraft` substrings, case-insensitive).
 *
 * Pure so the smoke suite can assert the policy and the culling.
 */
export function selectDraftLines(
	draft: PendingDraft | null | undefined,
	policy: DraftPolicy,
	drop: string[] = [],
): { selected: { section: Section; text: string }[]; dropped: number; total: number } {
	const sections: DraftSections = draft?.sections ?? {};
	let total = 0;
	for (const s of SECTIONS) if (s !== "archived") total += (sections[s] ?? []).length;
	if (policy === "none" || !draft) return { selected: [], dropped: 0, total };
	const needles = drop.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean);
	const selected: { section: Section; text: string }[] = [];
	let dropped = 0;
	for (const s of SECTIONS) {
		if (s === "archived") continue;
		for (const text of sections[s] ?? []) {
			const deterministic = s === "files" && DETERMINISTIC_PREFIXES.some((p) => text.startsWith(p));
			if (policy === "deterministic" && !deterministic) continue;
			const low = text.toLowerCase();
			if (needles.some((n) => low.includes(n))) {
				dropped++;
				continue;
			}
			selected.push({ section: s, text });
		}
	}
	return { selected, dropped, total };
}

/**
 * The commit receipt: the entries that just landed, plus the `context` entries
 * sitting directly before them in the same section.
 *
 * The receipt used to re-render the WHOLE board (up to 4000 chars) on every
 * commit — the largest recurring prompt cost of this extension, and it grew
 * with the board. What the agent actually needs back is the new lines plus
 * enough of their section tail to pick a `supersedes` substring, so that is
 * what it gets. `action="show"`, `blackboard_recall` and the board file itself
 * remain the way to see everything else.
 *
 * `+` = the agent wrote it, `~` = it came from the mechanical draft, ` ` is
 * older context, newest last.
 */
export function renderCommitEcho(
	board: Board,
	added: { section: Section; text: string; auto?: boolean }[],
	context: number,
): string {
	if (added.length === 0) return "";
	const fresh = new Map<Section, Map<string, boolean>>();
	for (const a of added) {
		const map = fresh.get(a.section) ?? new Map<string, boolean>();
		map.set(a.text, a.auto === true);
		fresh.set(a.section, map);
	}
	const lines: string[] = [];
	for (const s of SECTIONS) {
		if (s === "archived") continue;
		const texts = fresh.get(s);
		if (!texts || texts.size === 0) continue;
		const arr = board.sections[s];
		// Entries append, so the first new text's index is the start of this
		// commit's block; everything before it is older board state. Rotation
		// pointers are not facts — the archive files are reported separately.
		let first = arr.length;
		for (const t of texts.keys()) {
			const i = arr.findIndex((e) => e.text === t);
			if (i >= 0) first = Math.min(first, i);
		}
		const older = arr.slice(0, first).filter((e) => !e.text.startsWith("(archived)"));
		lines.push("", `## ${SECTION_HEADERS[s]} — ${texts.size} new`);
		for (const e of older.slice(Math.max(0, older.length - context))) lines.push(`  [${e.ts}] ${e.text}`);
		// Only the landed lines: a rotation pointer pushed after them is reported
		// separately as an archive file, not as a new entry.
		for (const e of arr.slice(first)) {
			if (!texts.has(e.text)) continue;
			lines.push(`${texts.get(e.text) ? "~" : "+"} [${e.ts}] ${e.text}`);
		}
	}
	return lines.join("\n").trimStart();
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
	for (const s of SECTIONS)
		counts[s] = s === "archived" ? board.sections[s].length : board.sections[s].filter((e) => !e.text.startsWith("(archived)")).length;
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

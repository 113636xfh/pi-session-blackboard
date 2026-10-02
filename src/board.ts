import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
		next: last(3)(board.sections.next),
		recentFiles: last(5)(board.sections.files),
		openIssues,
		counts,
	};
}

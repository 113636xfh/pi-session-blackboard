/**
 * Compaction assist (temporary, "cooperate, don't replace").
 *
 * When pi's NATIVE compaction runs, the extension's `session_before_compact`
 * handler invokes the same exported `compact()` the harness uses (identical
 * model, prompt, and retained tail) and APPENDS a size-capped, deterministic
 * board section to the LLM summary. The post-compaction context therefore
 * carries both: the conversational LLM summary AND the curated durable facts
 * (goal / open issues / files / next) that the summary may have dropped.
 *
 * Assist, never replace:
 *  - no model, or empty board  -> the handler returns undefined; native flow runs;
 *  - summarization call fails  -> the handler returns undefined; native flow runs
 *    (with its own retry policy) — the assist is strictly best-effort;
 *  - the section is hard-capped (compactAssistMaxChars) and points at the full
 *    board file, so it cannot grow with the board.
 *
 * `renderAssistSection` is pure (no pi, no LLM) and unit-tested in the smoke
 * suite. The LLM wiring lives in index.ts (`session_before_compact`).
 */

import type { Board } from "./types.js";
import { SECTION_HEADERS, SECTIONS } from "./types.js";
import { countReal } from "./board.js";
import { archiveDir, boardPath } from "./paths.js";

/** Default hard cap (chars) for the assist section appended to a summary. */
export const ASSIST_DEFAULT_MAX_CHARS = 4000;

// Per-block line budgets (newest kept; the full board file is the source of truth).
const GOAL_MAX = 3;
const ISSUES_MAX = 5;
const FILES_MAX = 5;
const NEXT_MAX = 3;

const fmt = (e: { ts: string; text: string }) => `- [${e.ts}] ${e.text}`;

const isPointer = (e: { text: string }) => e.text.startsWith("(archived)");

/**
 * Render the capped board section that gets appended to the native LLM
 * compaction summary. Returns null when the board has nothing worth
 * assisting with (no real entries in any assisted block).
 */
export function renderAssistSection(
	board: Board,
	boardDir: string,
	sessionId: string,
	maxChars: number = ASSIST_DEFAULT_MAX_CHARS,
): string | null {
	const goal = board.sections.goal.filter((e) => !isPointer(e) && e.text.trim() !== "").slice(-GOAL_MAX);
	const openIssues = board.sections.issues.filter((e) => !isPointer(e) && !e.text.includes("[RESOLVED")).slice(-ISSUES_MAX);
	const files = board.sections.files.filter((e) => !isPointer(e)).slice(-FILES_MAX);
	const next = board.sections.next.filter((e) => !isPointer(e) && e.text.trim() !== "").slice(-NEXT_MAX);

	if (goal.length + openIssues.length + files.length + next.length === 0) return null;

	const counts: string[] = [];
	for (const s of SECTIONS) {
		const n = s === "archived" ? board.sections[s].length : board.sections[s].filter((e) => !isPointer(e)).length;
		counts.push(`${SECTION_HEADERS[s].toLowerCase()}:${n}`);
	}

	const bp = boardPath(boardDir, sessionId);
	const ad = archiveDir(boardDir, sessionId);

	const lines: string[] = [
		"## Session Blackboard (deterministic session record — appended by pi-session-blackboard assist; not part of the LLM summary)",
		`Curated facts for this session live at ${bp} (rotated entries under ${ad}). For anything not covered below — decisions, preferences, full history — read that file.`,
	];
	if (goal.length) lines.push("", "### Goal", ...goal.map(fmt));
	if (openIssues.length) lines.push("", "### Open Issues", ...openIssues.map(fmt));
	if (files.length) lines.push("", "### Files Touched (newest last)", ...files.map(fmt));
	if (next.length) lines.push("", "### Next Steps", ...next.map(fmt));
	lines.push("", "### Board Stats", `entries: ${countReal(board)} (${counts.join(", ")})`);

	let out = lines.join("\n");
	if (out.length > maxChars) {
		out = out.slice(0, maxChars);
		const nl = out.lastIndexOf("\n");
		if (nl > 0) out = out.slice(0, nl);
		out += `\n…(section truncated — full board at ${bp})`;
	}
	return out;
}

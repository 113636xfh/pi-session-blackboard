/**
 * The blackboard IS the compaction summary.
 *
 * pi's native compaction calls a model to summarize the replaced messages.
 * This file produces that summary deterministically from the board instead:
 * the entries the agent reviewed and committed every `checkpointTurns` turns
 * ARE the memory, so the summary is just those entries rendered in pi's
 * native section shape (Goal / Decisions / Progress / Next Steps / …).
 *
 * Consequences, all deliberate:
 *  - zero summarization model calls (the win: pi's own call is skipped, not
 *    duplicated — see index.ts `session_before_compact`);
 *  - the quality of the summary is the quality of the board, which is why the
 *    checkpoint prompt tells the agent its entries become this summary;
 *  - a thin board must NOT become a thin summary: `renderSummary` returns null
 *    below a floor and the handler then leaves the native flow untouched.
 *
 * Pure (no pi, no LLM, no fs) so the smoke suite can assert on it.
 */

import type { Board } from "./types.js";
import { SECTION_HEADERS, SECTIONS } from "./types.js";
import { countAll } from "./board.js";

export const SUMMARY_DEFAULT_MAX_CHARS = 6000;

/** Below this many real entries the board is not trusted as a summary. */
export const SUMMARY_MIN_ENTRIES = 3;

/** Newest-kept budget per section when rendering the summary. */
const PER_SECTION: Record<string, number> = {
	goal: 8,
	prefs: 10,
	decisions: 14,
	files: 12,
	issues: 8,
	next: 8,
};

const fmt = (ts: string, text: string): string => `- ${text}  _(${ts})_`;
const isPointer = (e: { text: string }): boolean => e.text.startsWith("(archived)");

export interface SummaryOptions {
	maxChars?: number;
	/** Rendered into the footer so the model knows verbatim turns follow. */
	keptTailNote?: string;
	/** Absolute path of the board file, for "read the rest" instructions. */
	boardFile?: string;
	/** Name of the retrieval tool the model can use to search the board. */
	recallTool?: string;
}

/**
 * Render the board as a compaction summary. Returns null when the board is too
 * thin to stand in for a summary (caller must then fall back to pi's native
 * summarization).
 */
export function renderSummary(board: Board, opts: SummaryOptions = {}): string | null {
	const maxChars = opts.maxChars ?? SUMMARY_DEFAULT_MAX_CHARS;
	const recallTool = opts.recallTool ?? "recall";

	const real = (s: string): number =>
		(board.sections[s as keyof Board["sections"]] ?? []).filter((e) => !isPointer(e) && e.text.trim() !== "").length;
	if (SECTIONS.reduce((n, s) => n + real(s), 0) < SUMMARY_MIN_ENTRIES) return null;

	const pick = (s: string) =>
		(board.sections[s as keyof Board["sections"]] ?? [])
			.filter((e) => !isPointer(e) && e.text.trim() !== "")
			.slice(-(PER_SECTION[s] ?? 6));

	const head: string[] = [
		"# Session context checkpoint",
		"",
		"Curated session blackboard (deterministic; committed and reviewed by the agent during the session).",
		"This is the compaction summary: everything above the retained tail has been replaced by it.",
		...(opts.keptTailNote ? [opts.keptTailNote] : []),
	];

	// Native shape first (Goal / Constraints & Preferences / Progress / Key
	// Decisions / Next Steps / Critical Context), then the board-only sections.
	const blocks: Array<[string, string]> = [
		["Goal", "goal"],
		["Constraints & Preferences", "prefs"],
		["Key Decisions", "decisions"],
		["Files & Changes", "files"],
		["Open Issues", "issues"],
		["Next Steps", "next"],
	];
	const body: string[] = [];
	for (const [title, key] of blocks) {
		const entries = pick(key);
		if (!entries.length) continue;
		body.push("", `## ${title}`);
		body.push(...entries.map((e) => fmt(e.ts, e.text)));
	}
	if (board.sections.archived?.length) {
		body.push("", `## Archived (${board.sections.archived.length} older entries, not repeated here)`);
	}

	const counts = SECTIONS.map((s) => `${SECTION_HEADERS[s].toLowerCase()}:${board.sections[s].length}`).join(", ");
	const footer: string[] = [
		"",
		"---",
		`Blackboard: ${countAll(board)} entries (${counts}).`,
		[
			opts.boardFile ? `Full board (every entry, verbatim): ${opts.boardFile}.` : "",
			`Use the \`${recallTool}\` tool to search older entries by keyword instead of re-reading this summary.`,
		]
			.filter(Boolean)
			.join(" "),
	];

	// The footer carries the retrieval instructions, so it is reserved first:
	// when the body does not fit, drop its OLDEST lines, never the footer.
	const budget = Math.max(500, maxChars - footer.join("\n").length - head.join("\n").length - 2);
	let kept = body;
	if (body.join("\n").length > budget) {
		kept = [];
		let used = 0;
		for (let i = body.length - 1; i >= 0; i--) {
			const l = body[i];
			if (used + l.length + 1 > budget) continue; // try to keep older short lines too
			kept.unshift(l);
			used += l.length + 1;
		}
		kept = kept.filter((l, i, arr) => !(l === "" && (i === 0 || arr[i - 1] === "")));
	}
	const out = [...head, ...kept, ...(kept.length < body.length ? ["", "…(older entries omitted — use the recall tool)"] : []), ...footer].join("\n");
	return out;
}

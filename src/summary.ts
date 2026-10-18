/** Deterministic, whole-entry summary selection. Selection precedes section layout. */
import type { Board, BoardEntry, Section } from "./types.js";
import { SECTION_HEADERS, SECTIONS } from "./types.js";
import { BOARD_SUMMARY_FLOOR, countReal } from "./board.js";

export const SUMMARY_DEFAULT_MAX_CHARS = 6000;
export const SUMMARY_MIN_ENTRIES = BOARD_SUMMARY_FLOOR;

export interface SummaryOptions {
	maxChars?: number;
	keptTailNote?: string;
	/** Legacy retrieval locations; removed from the event-backed runtime in S2. */
	boardFile?: string;
	archiveDir?: string;
	recallTool?: string;
}

export type SummarySelection = {
	text: string | null;
	reason?: "thin-board" | "invalid-budget" | "over-budget" | "protected-over-budget";
	selected: Array<{ section: Section; entry: BoardEntry }>;
	omitted: number;
};

const BLOCKS: Array<[string, Section]> = [
	["Goal", "goal"], ["Constraints & Preferences", "prefs"], ["Key Decisions", "decisions"],
	["Key Findings", "findings"], ["Files & Changes", "files"], ["Open Issues", "issues"], ["Next Steps", "next"],
];
const real = (entry: BoardEntry) => !!entry.text.trim() && !entry.text.startsWith("(archived)");
const time = (stamp: string): number => {
	const value = Date.parse(stamp.includes("T") ? stamp : stamp.replace(" ", "T"));
	return Number.isFinite(value) ? value : 0;
};

export function selectSummary(board: Board, opts: SummaryOptions = {}): SummarySelection {
	const max = opts.maxChars ?? SUMMARY_DEFAULT_MAX_CHARS;
	const result: SummarySelection = { text: null, selected: [], omitted: 0 };
	if (!Number.isFinite(max) || max < 1) return { ...result, reason: "invalid-budget" };
	const all = BLOCKS.flatMap(([, section]) => board.sections[section]
		.filter(real).map((entry) => ({ section, entry })))
		.map((item, order) => ({ ...item, order }));
	result.omitted = all.length;
	if (all.length < (board.revision !== undefined ? 1 : SUMMARY_MIN_ENTRIES)) return { ...result, reason: "thin-board" };
	// Legacy timestamps can tie; stable traversal order is the deterministic fallback.
	// v2 supplies the actual event order, independent of section layout.
	all.sort((a, b) => time(b.entry.ts) - time(a.entry.ts) || (b.entry.order ?? b.order) - (a.entry.order ?? a.order));

	const head = ["# Session context checkpoint", "",
		"Curated session blackboard (deterministic; agent-reviewed notes, not independently verified facts).",
		"This is the compaction summary: earlier messages are replaced; the retained tail follows.",
		...(opts.keptTailNote ? [opts.keptTailNote] : [])];
	const counts = SECTIONS.map((s) => `${SECTION_HEADERS[s].toLowerCase()}:${board.sections[s].filter(real).length}`).join(", ");
	const recall = opts.recallTool ?? "blackboard_recall";
	const render = (selected: SummarySelection["selected"]): string => {
		const body: string[] = [];
		for (const [title, section] of BLOCKS) {
			const entries = selected.filter((item) => item.section === section);
			if (entries.length) body.push("", `## ${title}`, ...entries.map(({ entry }) => `- ${entry.text}  _(${entry.ts})_`));
		}
		const omitted = all.length - selected.length;
		const footer = ["", "---", `Blackboard: ${countReal(board)} entries (${counts}).`,
			...(omitted ? [`${omitted} older entries omitted — use the recall tool.`] : []),
			...(opts.boardFile ? [`Full board (every entry, verbatim): ${opts.boardFile}.`] : []),
			...(opts.archiveDir ? [`Rotated history: ${opts.archiveDir}.`] : []),
			`Use \`${recall}\` to search older entries.`];
		return [...head, ...body, ...footer].join("\n");
	};
	const protectedEntries = all.filter(item => item.entry.retention && item.entry.retention.generation === board.generation);
	if (protectedEntries.length && render(protectedEntries).length > max) return { ...result, reason: "protected-over-budget" };
	result.selected.push(...protectedEntries);
	for (const candidate of all.filter(item => !protectedEntries.includes(item))) {
		const next = [...result.selected, candidate];
		if (render(next).length > max) break; // newest prefix, not a knapsack of older short lines
		result.selected.push(candidate);
	}
	result.omitted = all.length - result.selected.length;
	if (!result.selected.length) return { ...result, reason: "over-budget" };
	const text = render(result.selected);
	return text.length <= max ? { ...result, text } : { ...result, reason: "over-budget" };
}

/** Null means the caller must repair the board or use an explicitly diagnosed safe fallback. */
export function renderSummary(board: Board, opts: SummaryOptions = {}): string | null {
	return selectSummary(board, opts).text;
}

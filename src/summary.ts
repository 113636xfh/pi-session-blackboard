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

const GROUPS: Array<{ title: string; match: (item: Selection) => boolean }> = [
	{ title: "Goal", match: (i) => i.section === "goal" },
	{ title: "Constraints & Preferences", match: (i) => i.section === "prefs" },
	{ title: "Progress", match: (i) => i.entry.taskState === "done" || i.entry.taskState === "in_progress" || i.entry.taskState === "blocked" },
	{ title: "Key Decisions", match: (i) => i.section === "decisions" },
	{ title: "Next Steps", match: (i) => i.section === "next" && i.entry.taskState !== "done" && i.entry.taskState !== "cancelled" },
	{ title: "Critical Context", match: (i) => i.section === "findings" },
	{ title: "Open Issues", match: (i) => i.section === "issues" },
	{ title: "Files & Changes", match: (i) => i.section === "files" },
];
type Selection = SummarySelection["selected"][number];
const isRendered = (item: Selection) => GROUPS.some((group) => group.match(item));
const EPISTEMIC: Record<string, string> = { hypothesis: "hypothesis, not verified", unknown: "unverified" };
function line(item: Selection): string {
	const marks = [
		item.entry.taskState ? `${item.entry.taskState.replace("_", " ")}` : "",
		EPISTEMIC[item.entry.epistemic ?? "stated"] ?? "",
		item.entry.retention ? "protected" : "",
	];
	const suffix = marks.filter(Boolean).join("; ");
	return `- ${item.entry.text}${suffix ? ` _(${suffix})_` : ""}`;
}

const real = (entry: BoardEntry) => !!entry.text.trim() && !entry.text.startsWith("(archived)");
const time = (stamp: string): number => {
	const value = Date.parse(stamp.includes("T") ? stamp : stamp.replace(" ", "T"));
	return Number.isFinite(value) ? value : 0;
};

export function selectSummary(board: Board, opts: SummaryOptions = {}): SummarySelection {
	const max = opts.maxChars ?? SUMMARY_DEFAULT_MAX_CHARS;
	const result: SummarySelection = { text: null, selected: [], omitted: 0 };
	if (!Number.isFinite(max) || max < 1) return { ...result, reason: "invalid-budget" };
	const all = SECTIONS.filter((section) => section !== "archived")
		.flatMap((section) => board.sections[section].filter(real).map((entry) => ({ section: section as Section, entry })))
		.filter(isRendered)
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
	const render = (selected: Selection[]): string => {
		const body: string[] = [];
		for (const group of GROUPS) {
			const entries = selected.filter((item) => group.match(item));
			if (!entries.length) continue;
			body.push("", `## ${group.title}`);
			if (group.title === "Progress") {
				for (const state of ["done", "in_progress", "blocked"] as const) {
					const inState = entries.filter((item) => item.entry.taskState === state);
					if (!inState.length) continue;
					body.push("", `### ${state === "in_progress" ? "In Progress" : state === "done" ? "Done" : "Blocked"}`);
					body.push(...inState.map((item) => `- ${item.entry.text}`));
				}
			} else body.push(...entries.map(line));
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
	for (const candidate of all.filter(item => !protectedEntries.includes(item) && isRendered(item))) {
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

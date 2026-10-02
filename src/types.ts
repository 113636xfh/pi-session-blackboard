/**
 * Shared types for pi-session-blackboard.
 */

export const SECTIONS = [
	"goal",
	"decisions",
	"files",
	"issues",
	"next",
	"prefs",
	"archived",
] as const;

export type Section = (typeof SECTIONS)[number];

export const SECTION_HEADERS: Record<Section, string> = {
	goal: "Goal",
	decisions: "Decisions",
	files: "Files",
	issues: "Issues",
	next: "Next",
	prefs: "Prefs",
	archived: "Archived",
};

/** One board entry (a single line in the markdown file). */
export type BoardEntry = { ts: string; text: string };

/**
 * Parsed blackboard. `extra` preserves unknown `## ...` sections verbatim so
 * hand edits never get clobbered. `raw` preserves non-entry lines inside
 * known sections for the same reason.
 */
export type Board = {
	header: { updated?: string; entries?: number };
	sections: Record<Section, BoardEntry[]>;
	raw: Record<Section, string[]>;
	extra: { title: string; lines: string[] }[];
};

/** Draft lines per section (no timestamps; added on commit). */
export type DraftSections = Partial<Record<Section, string[]>>;

export type PendingDraft = {
	generatedAt: string;
	sections: DraftSections;
};

/** Per-session extension state (persisted as JSON). */
export type SbbState = {
	version: 1;
	/** id of the last session branch entry processed (extraction cursor). */
	lastProcessedEntryId?: string;
	turnsSinceCheckpoint: number;
	checkpointCount: number;
	boardVersion: number;
	/** once the initial goal has been attempted, only scope-changes are mined. */
	goalExtracted: boolean;
	/** uncommitted draft awaiting agent review. */
	pendingDraft: PendingDraft | null;
	/** a checkpoint injection is queued for the next before_agent_start. */
	pendingCheckpoint: boolean;
	/** how many times the current draft was injected unprocessed. */
	draftInjectCount: number;
};

/** Loose structural type for pi session branch entries (avoids pinning pi internals). */
export type BranchEntry = {
	type?: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	customType?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
	[k: string]: unknown;
};

export type UserBlock = { entryId: string; text: string };
export type AssistantBlock = { entryId: string; text: string };
export type ToolBlock = {
	entryId: string;
	callId: string;
	name: string;
	args: Record<string, unknown>;
	output: string;
	isError: boolean;
};

export type NormalizedBlocks = {
	users: UserBlock[];
	assistants: AssistantBlock[];
	tools: ToolBlock[];
};

/** Total number of lines across draft sections. */
export function countDraftLines(draft: DraftSections | null | undefined): number {
	if (!draft) return 0;
	let n = 0;
	for (const lines of Object.values(draft)) n += Array.isArray(lines) ? lines.length : 0;
	return n;
}

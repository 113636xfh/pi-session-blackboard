/**
 * Shared types for pi-session-blackboard.
 */

export const SECTIONS = [
	"goal",
	"decisions",
	"findings",
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
	findings: "Findings",
	files: "Files",
	issues: "Issues",
	next: "Next",
	prefs: "Prefs",
	archived: "Archived",
};

/** Renderable entry; v2 metadata is preserved when projecting the event journal. */
export type BoardEntry = { ts: string; text: string; order?: number } & Partial<MemoryEntry>;

/**
 * Parsed blackboard. `extra` preserves unknown `## ...` sections verbatim so
 * hand edits never get clobbered. `raw` preserves non-entry lines inside
 * known sections for the same reason.
 */
export type Board = {
	header: { updated?: string; entries?: number };
	generation?: number;
	revision?: number;
	sections: Record<Section, BoardEntry[]>;
	raw: Record<Section, string[]>;
	extra: { title: string; lines: string[] }[];
};

/** Draft lines per section (no timestamps; added on commit). */
export type DraftSections = Partial<Record<Section, string[]>>;

export type PendingDraft = {
	generatedAt: string;
	sections: DraftSections;
	sources?: Record<string, SourceRef[]>;
	/** experiment-like commands detected since the last checkpoint (reminder fodder) */
	experiments?: string[];
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
	/** last time a native compaction summary was merged into the board. */
	lastAdoption?: { source: "session_start" | "native-compaction"; at: string; total: number };
	/** the one-shot scan for pre-existing compaction summaries has already run. */
	priorSummaryChecked?: boolean;
	/**
	 * One-shot: the next compaction must run pi's NATIVE summarization even in
	 * `"board"` mode (set by `/bb compact`). The result is merged back into the
	 * board by the session_compact hook, so the bypass costs nothing.
	 */
	forceNativeOnce?: boolean;
	/** when the one-shot native bypass was armed (5-minute TTL). */
	forceNativeOnceAt?: number;
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
		details?: Record<string, unknown>;
		nestedCalls?: { complete: boolean; calls: Array<{ id: string; name: string; arguments?: Record<string, unknown>; status: "ok" | "error" | "unfinished"; error?: string }> };
	};
	[k: string]: unknown;
};

export type UserBlock = { entryId: string; text: string };
export type AssistantBlock = { entryId: string; text: string };
export type ToolOutcome = "ok" | "error" | "cancelled" | "unfinished" | "unknown";
export type ToolBlock = {
	entryId: string;
	callId: string;
	name: string;
	args: Record<string, unknown>;
	output: string;
	isError: boolean;
	/** Explicit result status; missing result metadata must not imply success. */
	status?: ToolOutcome;
};

export type NormalizedBlocks = {
	users: UserBlock[];
	assistants: AssistantBlock[];
	tools: ToolBlock[];
};

export type TaskState = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type Origin = "user" | "tool" | "assistant" | "native-summary" | "legacy";
export type SourceRef = { entryId: string; fingerprint: string; kind: Origin; callId?: string };
export type MemoryEntry = {
	id: string; revision: number; section: Exclude<Section, "archived">; text: string;
	createdAt: string; updatedAt: string; order: number;
	validity: "active" | "superseded" | "retracted";
	taskState?: TaskState; epistemic: "stated" | "hypothesis" | "unknown";
	origin: Origin; sources: SourceRef[]; archived: boolean;
	retention?: { grantId: string; generation: number };
	verification?: string; legacyUnscoped?: boolean;
};
export type ReviewReceipt = {
	id: string; leafId: string; range: SourceRef[]; candidateIds: string[];
	constraintsChecked: boolean; executionChecked: boolean; goalChecked: boolean;
};
export type RepairState = {
	generation: number; extraRequests: number;
	phase: "needed" | "queued" | "delivered" | "checked" | "exhausted";
	rangeFingerprint: string; requestId: string; instructions?: string;
};
export type JournalChange =
	| { type: "put"; entry: MemoryEntry; expectedRevision: number }
	| { type: "retain" | "archive"; id: string; expectedRevision: number }
	| { type: "reset" }
	| { type: "offer"; receipt: ReviewReceipt }
	| { type: "review"; receipt: ReviewReceipt }
	| { type: "draft"; draft: PendingDraft | null; cursor?: string; turns?: number }
	| { type: "repair"; repair: RepairState }
	| { type: "import"; sourceId: string; fingerprint: string }
	| { type: "native"; native?: { at: string; ttlMs: number } }
	/** Manual knob: branch-local disable, replayed with the branch. */
	| { type: "gate"; disabled: boolean };
export type JournalEvent = {
	schema: 2; eventId: string; operationId: string; at: string;
	baseRevision: number; changes: JournalChange[]; requestFingerprint?: string;
};
export type JournalProjection = {
	schema: 2; revision: number; entries: Record<string, MemoryEntry>; history: MemoryEntry[];
	operations: Record<string, string>; requests: Record<string, string>; eventIds: string[]; offers: Record<string, ReviewReceipt>; reviews: ReviewReceipt[];
	generation: number; compactions: string[]; expiredIds: string[];
	imports: Record<string, string>; draft: PendingDraft | null; turns: number;
	/** One-shot explicit native request, expired by its own timestamp. */
	native?: { at: string; ttlMs: number }; cursor?: string; repair?: RepairState;
	/** Manual knob, absent when not manually disabled. Branch-local: a resume replays it. */
	gate?: { disabled: true; at: string };
};

/** Total number of lines across draft sections. */
export function countDraftLines(draft: DraftSections | null | undefined): number {
	if (!draft) return 0;
	let n = 0;
	for (const lines of Object.values(draft)) n += Array.isArray(lines) ? lines.length : 0;
	return n;
}

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SbbConfig = {
	enabled: boolean;
	/**
	 * Agent review checkpoint cadence in user turns. 1 = review on every
	 * completed turn (the default, per the "every turn" design). Raise to
	 * 5–10 to reduce curation overhead.
	 */
	checkpointTurns: number;
	/**
	 * How the checkpoint reaches the agent:
	 *  - "next-turn": injected with the next user message (zero extra LLM calls)
	 *  - "immediate": a steer message triggers a review turn now (small extra LLM call)
	 */
	delivery: "next-turn" | "immediate";
	/** per-section entry budget before deterministic archival kicks in. */
	maxEntriesPerSection: number;
	/** board directory; defaults to <agentDir>/blackboard. Absolute or agent-dir-relative. */
	boardDir: string;
	/** mirror a compact board digest into the session JSONL on commit (searchable later). */
	mirrorToSession: boolean;
	/**
	 * How compaction is served:
	 *  - "off":    never touch compaction (pi's native flow, untouched)
	 *  - "digest": mirror a board digest into the session JSONL, native flow runs
	 *  - "board":  the board IS the summary — the handler returns it as the
	 *              compaction summary, so pi's summarization call is skipped.
	 *              Falls back to the native flow when the board is too thin.
	 */
	compaction: "off" | "digest" | "board";
	/**
	 * Assist (temporary, does not replace): when native compaction runs, run the
	 * same summarization call the harness would make and append a capped board
	 * section to the LLM summary so post-compaction context carries the durable
	 * facts too. Any failure falls back to the untouched native flow.
	 */
	compactAssist: boolean;
	/** Hard cap (chars) for the board section appended to the compaction summary. */
	compactAssistMaxChars: number;
	/** Hard cap (chars) for the board rendered as the compaction summary. */
	summaryMaxChars: number;
	/** max chars per committed entry line. */
	maxEntryChars: number;
	/**
	 * Adopt a pre-existing (native) compaction summary into a FRESH board.
	 *
	 * Turning this extension on mid-session means the history that pi already
	 * summarised would otherwise drop out of the picture the moment the board
	 * becomes the summary. Only ever seeds an empty board — never merges into
	 * entries the agent curated.
	 */
	seedFromPriorSummary: boolean;
	/** max draft lines rendered into a checkpoint message. */
	maxDraftLines: number;
	/**
	 * How many pre-existing entries per section a `commit` echoes back next to
	 * the entries that just landed (0 = only the new ones). The receipt used to
	 * return the whole board; this is the budget for its context tail. The full
	 * board is always one `action="show"` (or one `read`) away.
	 */
	commitContextEntries: number;
	/**
	 * "Near compaction" zone, in tokens left until pi's own compaction trigger
	 * (`contextTokens > contextWindow - reserveTokens`). Inside the zone the
	 * checkpoint message carries a live token countdown and is injected EVERY
	 * turn instead of every `checkpointTurns`, because the next turn may be the
	 * last one before the board becomes the summary. 0 disables the countdown
	 * (behaviour falls back to the plain cadence).
	 */
	compactionWarnTokens: number;
	debugLog: boolean;
};

const SETTINGS_KEY = "session-blackboard";

export const DEFAULTS: SbbConfig = {
	enabled: true,
	checkpointTurns: 1,
	delivery: "next-turn",
	maxEntriesPerSection: 40,
	boardDir: join(getAgentDir(), "blackboard"),
	mirrorToSession: true,
	compaction: "off",
	compactAssist: true,
	compactAssistMaxChars: 4000,
	summaryMaxChars: 6000,
	maxEntryChars: 300,
	maxDraftLines: 60,
	commitContextEntries: 2,
	seedFromPriorSummary: true,
	compactionWarnTokens: 32768,
	debugLog: false,
};

function readSection(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return {};
		const nested = (raw as Record<string, unknown>)[SETTINGS_KEY];
		return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function readRawSection(path: string, key: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return {};
		const nested = (raw as Record<string, unknown>)[key];
		return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** pi's built-in compaction reserve (DEFAULT_COMPACTION_SETTINGS.reserveTokens). */
export const PI_DEFAULT_RESERVE_TOKENS = 16384;

type CompactionSection = Record<string, unknown>;

/**
 * Pure half of reserve resolution, so the precedence is testable without
 * touching the real settings files. `sources` is in INCREASING priority order
 * ([user, project]); pi merges project settings over user settings.
 */
export function resolveReserveFromSources(sources: CompactionSection[], modelKey?: string): number {
	const overrideAt = (o: CompactionSection): unknown => {
		if (!modelKey || typeof o.modelOverrides !== "object" || !o.modelOverrides) return undefined;
		return (o.modelOverrides as Record<string, Record<string, unknown>>)[modelKey]?.reserveTokens;
	};
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
	// model override (highest-priority source first) -> ordinary setting -> default
	for (const o of [...sources].reverse()) {
		const v = num(overrideAt(o));
		if (v !== undefined) return v;
	}
	for (const o of [...sources].reverse()) {
		const v = num(o.reserveTokens);
		if (v !== undefined) return v;
	}
	return PI_DEFAULT_RESERVE_TOKENS;
}

/**
 * Resolve pi's compaction `reserveTokens` the way pi does: model override →
 * ordinary setting (user, then project) → built-in default. Mirrored here (not
 * imported) so the countdown states the same trigger line pi will actually use.
 */
export function resolveReserveTokens(cwd: string, modelKey?: string): number {
	return resolveReserveFromSources(
		[
			readRawSection(join(getAgentDir(), "settings.json"), "compaction"),
			readRawSection(join(cwd, ".pi", "settings.json"), "compaction"),
		],
		modelKey,
	);
}

/** Everything the checkpoint prompt needs to say how close compaction is. */
export type ContextPressure = {
	/** estimated context tokens now (null right after compaction, before the next response) */
	tokens: number | null;
	contextWindow: number;
	reserveTokens: number;
	/** token count at which pi triggers compaction */
	triggerAt: number;
	/** tokens left until that trigger (negative = already past the line) */
	remaining: number | null;
	/** inside the warn zone: commit the board every turn */
	near: boolean;
};

export function computePressure(
	usage: { tokens: number | null; contextWindow: number } | undefined,
	cwd: string,
	modelKey: string | undefined,
	warnTokens: number,
): ContextPressure | null {	if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return null;
	const reserveTokens = resolveReserveTokens(cwd, modelKey);
	const triggerAt = usage.contextWindow - reserveTokens;
	const tokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
	const remaining = tokens === null ? null : triggerAt - tokens;
	return {
		tokens,
		contextWindow: usage.contextWindow,
		reserveTokens,
		triggerAt,
		remaining,
		near: warnTokens > 0 && remaining !== null && remaining <= warnTokens,
	};
}

/** 1234 -> "1.2k" — token counts in the prompt stay short enough to read. */
export function fmtTokens(n: number): string {
	const v = Math.round(n);
	if (Math.abs(v) < 1000) return String(v);
	if (Math.abs(v) < 100000) return `${(v / 1000).toFixed(1)}k`;
	return `${Math.round(v / 1000)}k`;
}

/**
 * The one line the checkpoint prompt spends on "how far is compaction". Inside
 * the warn zone it is an instruction, not a statistic. Returns null when the
 * token count is unknown (right after a compaction, before the next response).
 */
export function describePressure(p: ContextPressure | null | undefined): string | null {
	if (!p || p.remaining === null) return null;
	const left = p.remaining;
	const line =
		`[context pressure] compaction is ${left <= 0 ? "OVERDUE" : `${fmtTokens(left)} away`} — context is at ${fmtTokens(p.tokens ?? 0)} of ${fmtTokens(p.contextWindow)} tokens (pi compacts above ${fmtTokens(p.triggerAt)} = window − reserve ${fmtTokens(p.reserveTokens)}).`;
	if (p.near) {
		return `${line} NEAR COMPACTION — commit what matters from this turn onto the board NOW, even if the draft below looks thin or already known: whatever is not on the board when compaction fires is gone.`;
	}
	return `${line} Plan the next commits so the board stays sufficient if compaction fires sooner than expected.`;
}

function pickBool(o: Record<string, unknown>, k: string, dflt: boolean): boolean {
	const v = o[k];
	return typeof v === "boolean" ? v : dflt;
}
function pickNum(o: Record<string, unknown>, k: string, dflt: number): number {
	const v = o[k];
	return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function pickStr(o: Record<string, unknown>, k: string, dflt: string): string {
	const v = o[k];
	return typeof v === "string" ? v : dflt;
}

/**
 * Load config: defaults <- user settings.json ("session-blackboard") <-
 * project .pi/settings.json ("session-blackboard"). Never throws.
 */
export function loadConfig(cwd: string): SbbConfig {
	const global = readSection(join(getAgentDir(), "settings.json"));
	const project = readSection(join(cwd, ".pi", "settings.json"));
	const all = { ...global, ...project };

	const cfg: SbbConfig = { ...DEFAULTS };
	cfg.enabled = pickBool(all, "enabled", cfg.enabled);
	cfg.checkpointTurns = Math.max(1, Math.floor(pickNum(all, "checkpointTurns", cfg.checkpointTurns)));
	cfg.delivery = pickStr(all, "delivery", cfg.delivery) === "immediate" ? "immediate" : "next-turn";
	cfg.maxEntriesPerSection = Math.max(5, Math.floor(pickNum(all, "maxEntriesPerSection", cfg.maxEntriesPerSection)));
	cfg.maxEntryChars = Math.max(100, Math.floor(pickNum(all, "maxEntryChars", cfg.maxEntryChars)));
	cfg.maxDraftLines = Math.max(10, Math.floor(pickNum(all, "maxDraftLines", cfg.maxDraftLines)));
	cfg.commitContextEntries = Math.max(0, Math.min(20, Math.floor(pickNum(all, "commitContextEntries", cfg.commitContextEntries))));
	cfg.compactionWarnTokens = Math.max(0, Math.floor(pickNum(all, "compactionWarnTokens", cfg.compactionWarnTokens)));
	cfg.seedFromPriorSummary = pickBool(all, "seedFromPriorSummary", cfg.seedFromPriorSummary);
	cfg.mirrorToSession = pickBool(all, "mirrorToSession", cfg.mirrorToSession);
	cfg.compaction = (["off", "digest", "board"] as const).includes(pickStr(all, "compaction", cfg.compaction) as "off" | "digest" | "board")
		? (pickStr(all, "compaction", cfg.compaction) as "off" | "digest" | "board")
		: "off";
	cfg.summaryMaxChars = Math.max(1000, Math.floor(pickNum(all, "summaryMaxChars", cfg.summaryMaxChars)));
	cfg.compactAssist = pickBool(all, "compactAssist", cfg.compactAssist);
	cfg.compactAssistMaxChars = Math.max(500, Math.floor(pickNum(all, "compactAssistMaxChars", cfg.compactAssistMaxChars)));
	cfg.debugLog = pickBool(all, "debugLog", cfg.debugLog);

	const dir = pickStr(all, "boardDir", cfg.boardDir);
	// Absolute means absolute on THIS platform: a Windows path ("C:\…") does not
	// start with "/", and joining it onto the agent dir produced the doubled
	// "…\.pi\agent\C:\Users\…\.pi\agent\blackboard" that made commit fail with
	// ENOENT (observed live, 2026-10-02).
	cfg.boardDir = isAbsolute(dir) ? dir : join(getAgentDir(), dir);
	return cfg;
}

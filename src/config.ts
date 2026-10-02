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
	/** hard guard for total board lines (warns only in v0.1). */
	maxBoardLines: number;
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
	debugLog: boolean;
};

const SETTINGS_KEY = "session-blackboard";

export const DEFAULTS: SbbConfig = {
	enabled: true,
	checkpointTurns: 1,
	delivery: "next-turn",
	maxEntriesPerSection: 40,
	maxBoardLines: 400,
	boardDir: join(getAgentDir(), "blackboard"),
	mirrorToSession: true,
	compaction: "off",
	compactAssist: true,
	compactAssistMaxChars: 4000,
	summaryMaxChars: 6000,
	maxEntryChars: 300,
	maxDraftLines: 60,
	seedFromPriorSummary: true,
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
	cfg.maxBoardLines = Math.max(50, Math.floor(pickNum(all, "maxBoardLines", cfg.maxBoardLines)));
	cfg.maxEntryChars = Math.max(100, Math.floor(pickNum(all, "maxEntryChars", cfg.maxEntryChars)));
	cfg.maxDraftLines = Math.max(10, Math.floor(pickNum(all, "maxDraftLines", cfg.maxDraftLines)));
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

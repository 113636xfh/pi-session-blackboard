/**
 * pi-session-blackboard — session-level blackboard for the pi coding agent.
 *
 * Architecture (all bookkeeping is deterministic; zero background LLM calls):
 *
 *   agent_settled (per completed user turn)
 *     └─ normalize new branch entries
 *        └─ vcc-style deterministic extraction (goal/scope, prefs, files+symbols,
 *           commits, errors/issues, decisions, next-steps)  →  pending draft
 *           └─ [RESOLVED] marking of open issues when their files got modified
 *        └─ checkpoint due? (default: every turn)
 *             └─ before_agent_start injects the draft (display:false) with
 *                instructions to review it
 *   agent (inside its normal turn, no extra API call)
 *     └─ blackboard tool: commit (curated) | skip | show | archive
 *          └─ per-section overflow is rotated to an append-only archive file
 *          └─ optional compact digest mirrored into the session JSONL
 *             (searchable by pi-vcc's vcc_recall; consumable by future
 *              deterministic compaction)
 *
 * The board file lives at <boardDir>/<sessionId>.md and is a plain markdown
 * file — inspectable, greppable, commit-able, and readable by the agent with
 * its normal read tool at any time (e.g. after compaction).
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TLiteral } from "typebox";

import { renderAssistSection } from "./compact-assist.js";
import {
	formatRecall,
	searchDigest,
	searchDocument,
	type RecallHit,
} from "./recall.js";
import { renderSummary } from "./summary.js";
import type { ContextPressure, SbbConfig } from "./config.js";
import { computePressure, describePressure, fmtTokens, loadConfig } from "./config.js";
import { archiveDir, boardPath, debugPath, safeSid } from "./paths.js";
import { defaultState, loadState, saveState } from "./state.js";
import {
	archiveEntry,
	cleanEntryText,
	commitEntries,
	countAll,
	countReal,
	digest,
	markResolved,
	readBoardFile,
	renderBoard,
	renderCommitEcho,
	selectDraftLines,
	resetAll,
	mergeSummaryIntoBoard,
	writeBoard,
} from "./board.js";
import { extractAll, normalizeBranch } from "./extract.js";
import {
	SECTIONS,
	countDraftLines,
	type BranchEntry,
	type DraftSections,
	type PendingDraft,
	type Section,
	type SbbState,
} from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any;

const COMMIT_SECTIONS: Section[] = SECTIONS.filter((s) => s !== "archived");

/** How long `/bb compact` keeps the native bypass armed before it expires. */
const FORCE_NATIVE_TTL_MS = 5 * 60 * 1000;

/** How many archive files one `blackboard_recall` reads (newest first). */
const ARCHIVE_SCAN_MAX = 40;

export default function sessionBlackboard(pi: ExtensionAPI) {
	const sessions = new Map<string, { cfg: SbbConfig; sessionId: string; cwd: string }>();

	// --------------------------------------------------------------- helpers

	const getSession = (ctx: AnyCtx): { cfg: SbbConfig; sessionId: string; cwd: string } => {
		const sm = ctx?.sessionManager;
		let sessionId = "";
		// Project cwd, in priority order:
		//  1. ctx.cwd — present in TUI sessions; ABSENT in SDK event contexts
		//     (measured: preflight4 SDK session). Must NOT default to process.cwd()
		//     before trying (2), or the branch fallback below is dead code.
		//  2. the session branch's first "session" entry .cwd — the project cwd the
		//     SessionManager recorded at creation (2-arg create(repo, sessionDir)).
		//  3. process.cwd() — last resort only.
		let cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : "";
		let cwdSrc = ctx?.cwd ? "ctx" : "";
		try {
			sessionId = (sm?.getSessionId?.() as string | undefined) ?? "";
		} catch {
			/* ignore */
		}
		if (!sessionId || !sessions.has(sessionId)) {
			try {
				const branch = (sm?.getBranch?.() ?? []) as BranchEntry[];
				const first = branch.find((e) => e?.type === "session");
				if (!cwd && first && typeof first.cwd === "string" && first.cwd) {
					cwd = first.cwd;
					cwdSrc = "branch";
				}
				if (!sessionId && typeof first?.id === "string") sessionId = first.id;
			} catch {
				/* ignore */
			}
		}
		if (!cwd) {
			cwd = process.cwd();
			cwdSrc = "process";
		}
		if (!sessionId) sessionId = "unknown";
		let s = sessions.get(sessionId);
		if (!s) {
			s = { cfg: loadConfig(cwd), sessionId, cwd };
			sessions.set(sessionId, s);
			debug(s, { event: "cfg_loaded", cwd, cwdSrc, enabled: s.cfg.enabled });
		}
		return s;
	};

	const debug = (s: { cfg: SbbConfig; sessionId: string }, event: Record<string, unknown>) => {
		if (!s.cfg.debugLog) return;
		try {
			const p = debugPath(s.cfg.boardDir, s.sessionId);
			mkdirSync(join(s.cfg.boardDir, "debug"), { recursive: true });
			appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
		} catch {
			/* ignore */
		}
	};

	const mirror = (s: { cfg: SbbConfig; sessionId: string }, board: Parameters<typeof digest>[0], kind?: string) => {
		if (!s.cfg.mirrorToSession) return;
		try {
			pi.appendEntry("sbb-snapshot", { ...(kind ? { kind } : {}), ...digest(board, s.sessionId) });
		} catch {
			/* ignore */
		}
	};

	// ------------------------------------------------- adopting a prior summary
	//
	// Two triggers, one code path:
	//  - `session_start`: the extension was enabled mid-session, so pi has
	//    already summarised the earlier history into a compaction entry;
	//  - `session_compact`: pi just summarised natively because the board was
	//    too thin (or unreadable), or because the user asked for a native
	//    compaction — that text is the only record left of the replaced messages.
	// Either way the entries are MERGED into the board (deduped, capped per
	// section, overflow archived), so the next compaction has something to work
	// from. Curated entries are never removed by a merge; our own board summary
	// is never merged back in.

	const adoptSummaryText = (
		s: { cfg: SbbConfig; sessionId: string },
		ctx: AnyCtx,
		summary: string,
		reason: "session_start" | "native-compaction",
	): void => {
		if (!s.cfg.seedFromPriorSummary) return;
		const res = mergeSummaryIntoBoard(s.cfg.boardDir, s.sessionId, s.cfg, summary);
		if (!res.merged) {
			debug(s, { event: "summary_not_merged", reason: res.reason, trigger: reason });
			return;
		}
		mirror(s, readBoardFile(s.cfg.boardDir, s.sessionId), `merged:${reason}`);
		debug(s, {
			event: "summary_merged",
			trigger: reason,
			added: res.added,
			deduped: res.deduped,
			counts: res.counts,
			archived: res.archived.length,
		});
		const st = loadState(s.cfg.boardDir, s.sessionId);
		st.boardVersion += 1;
		st.lastAdoption = { source: reason, at: new Date().toISOString(), total: res.added };
		saveState(s.cfg.boardDir, s.sessionId, st);
		const detail = Object.entries(res.counts)
			.map(([k, n]) => `${k}:${n}`)
			.join(" ");
		ctx?.ui?.notify?.(
			res.added > 0
				? `session-blackboard merged a native compaction summary — ${res.added} new entries (${detail})${res.deduped ? `, ${res.deduped} already known` : ""}.`
				: `session-blackboard merged a native compaction summary — nothing new (${res.deduped} lines already on the board).`,
			"info",
		);
	};

	/**
	 * Adopt prior native summaries once per session, on whichever hook fires first.
	 *
	 * `session_start` is not guaranteed to run (measured: an RPC pi process never
	 * fires it), so the same check also runs from the first processed turn and is
	 * guarded by a state flag rather than by which event showed up.
	 *
	 * EVERY compaction in the branch is merged, oldest first, so a long session
	 * that compacted several times does not lose the older summaries' facts.
	 * Merging is idempotent (case-insensitive dedupe), so re-running is a no-op.
	 */
	const maybeAdoptPriorSummary = (s: { cfg: SbbConfig; sessionId: string }, ctx: AnyCtx): void => {
		if (!s.cfg.seedFromPriorSummary) return;
		const st = loadState(s.cfg.boardDir, s.sessionId);
		if (st.priorSummaryChecked) return;
		st.priorSummaryChecked = true;
		saveState(s.cfg.boardDir, s.sessionId, st);
		adoptPriorSummary(s, ctx, "session_start");
	};

	const adoptPriorSummary = (s: { cfg: SbbConfig; sessionId: string }, ctx: AnyCtx, reason: "session_start"): void => {
		try {
			const entries = (ctx?.sessionManager?.getEntries?.() ?? []) as Array<Record<string, unknown>>;
			const summaries: string[] = [];
			for (const e of entries) {
				if (e?.type !== "compaction") continue;
				const summary = typeof (e as { summary?: unknown }).summary === "string" ? (e as { summary: string }).summary : "";
				if (summary.trim()) summaries.push(summary);
			}
			for (const summary of summaries) adoptSummaryText(s, ctx, summary, reason);
		} catch {
			/* no session manager / unreadable session */
		}
	};

	/**
	 * How close pi is to its own compaction trigger right now. Null when the
	 * context window is unknown (no model yet) or the countdown is disabled.
	 */
	const pressureOf = (s: { cfg: SbbConfig; cwd: string }, ctx: AnyCtx): ContextPressure | null => {
		try {
			const usage = ctx?.getContextUsage?.();
			if (!usage) return null;
			const model = ctx?.model;
			const modelKey = model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
			return computePressure(usage, s.cwd, modelKey, s.cfg.compactionWarnTokens);
		} catch {
			return null;
		}
	};

	const renderCheckpoint = (draft: PendingDraft | null, cfg: SbbConfig, pressure?: ContextPressure | null): string => {
		const parts: string[] = ["[session-blackboard checkpoint]"];
		// How close compaction is. In the warn zone this line is an instruction,
		// not a statistic: the next turn may be the last one before the board
		// becomes the summary.
		if (pressure && cfg.compactionWarnTokens > 0) {
			const line = describePressure(pressure);
			if (line) parts.push(line);
		}
		parts.push(
			"A draft of the session blackboard was compiled deterministically (no LLM) from turns since the last checkpoint.",
			"IMPORTANT — what you commit here IS the compaction summary. When this session runs out of context, pi replaces everything before the retained tail with your blackboard entries (no separate summarization model runs). Your future self reads these lines, not the conversation. Write them the way you would write a checkpoint summary for another LLM that has to continue this work:",
			`  - goal: what is being asked, including scope changes and corrections;`,
			`  - decisions: the choice AND why it beat the alternative;`,
			`  - findings: key findings from exploration/experiments — non-obvious behavior, measured results, root causes, with the exact command, number or error;`,
			`  - files: exact paths, and which of them changed;`,
			`  - issues: blockers with the real error text and exit codes; resolved ones must be moved or marked resolved;`,
			`  - next: the concrete next step, not "continue working";`,
			`  - prefs: durable constraints and preferences the user stated.`,
			...(draft?.experiments?.length
				? [`Experiments detected this period: ${draft.experiments.join("; ")}. If any produced a key finding, commit one line per finding under findings (what was tested, the result, why it was non-obvious). If none were non-obvious, say nothing.`]
				: []),
			// What happens to the draft on the next commit — the agent must know which
			// lines it has to retype and which it only has to reject.
			cfg.draftOnCommit === "all"
				? "The WHOLE draft below lands automatically with your next commit — do NOT retype accepted lines. Your job: cull the noise with dropDraft=[\"substring\"], and add or correct lines in `entries`."
				: cfg.draftOnCommit === "deterministic"
					? "The draft's deterministic lines (`MODIFIED …` / `COMMIT …`) land automatically with your next commit — do NOT retype them; reject one with dropDraft=[\"substring\"]. Every other draft line lands ONLY if you write it yourself in `entries`."
					: "Nothing from the draft lands automatically — anything you want on the board must be written yourself in `entries`.",
			`Review the draft: correct inaccuracies, delete noise (dropDraft), then commit what is worth keeping via the \`blackboard\` tool (action="commit", entries=[{section, text, supersedes?}]). Sections: ${COMMIT_SECTIONS.join(", ")}. Each text must be ONE line, factual and specific, max ${cfg.maxEntryChars} chars — timestamps are added automatically. Preserve exact file paths, function names, error messages and numbers.`,
			"Keep the board dense, not chronological: one line per fact, newest state wins.",
			`When a fact CHANGED, put it on the new line and set supersedes="<unique substring of the old line>": the old line is archived in the same call, so the summary can never show both versions.`,
			"If nothing is worth keeping, call the tool with action=\"skip\".",
			"--- draft ---",
		);
		const sections = draft?.sections ?? {};
		let any = false;
		for (const s of SECTIONS) {
			const lines = sections[s] ?? [];
			if (!lines.length) continue;
			any = true;
			parts.push(`## ${s}`);
			parts.push(...lines.slice(0, cfg.maxDraftLines).map((l) => `- ${l}`));
		}
		if (!any) parts.push(draft ? "(empty draft)" : "(no new deterministic entries this round)");
		parts.push("--- end draft ---");
		return parts.join("\n");
	};

	const clearPending = (st: SbbState) => {
		st.pendingDraft = null;
		st.pendingCheckpoint = false;
		st.draftInjectCount = 0;
	};

	// ------------------------------------------------------- per-turn pipeline

	const processTurn = (ctx: AnyCtx) => {
		const s = getSession(ctx);
		if (!s.cfg.enabled) return;
		const sm = ctx?.sessionManager;
		let branch: BranchEntry[] = [];
		try {
			branch = (sm?.getBranch?.() ?? []) as BranchEntry[];
		} catch {
			return;
		}

		const st = loadState(s.cfg.boardDir, s.sessionId);
		st.turnsSinceCheckpoint += 1;
		maybeAdoptPriorSummary(s, ctx);

		// Window of entries since the last processed cursor.
		let startIdx = 0;
		if (st.lastProcessedEntryId) {
			const i = branch.findIndex((e) => e?.id === st.lastProcessedEntryId);
			startIdx = i >= 0 ? i + 1 : 0; // unknown id (branch switch/fork) → rescan; extractors dedupe
		}
		const fresh = branch.slice(startIdx).filter((e) => e?.type === "message");
		const lastId = branch[branch.length - 1]?.id;
		if (typeof lastId === "string") st.lastProcessedEntryId = lastId;

		if (fresh.length > 0) {
			const blocks = normalizeBranch(fresh);
			const board = readBoardFile(s.cfg.boardDir, s.sessionId);
			const { draft, resolvedPaths, experiments } = extractAll(blocks, board, st);

			if (!st.goalExtracted) st.goalExtracted = true;

			if (resolvedPaths.length > 0) {
				const n = markResolved(board, resolvedPaths);
				if (n > 0) writeBoard(s.cfg.boardDir, s.sessionId, board);
			}

			if (countDraftLines(draft) > 0 || experiments.length > 0) {
				const pd: PendingDraft = st.pendingDraft ?? {
					generatedAt: new Date().toISOString(),
					sections: {},
				};
				for (const [k, lines] of Object.entries(draft)) {
					const sec = k as Section;
					const existing = (pd.sections[sec] ?? []).map((x) => x.toLowerCase());
					for (const l of lines) {
						if (!existing.includes(l.toLowerCase())) {
							(pd.sections[sec] ??= []).push(l);
						}
					}
				}
				if (experiments.length > 0) {
					const prev = pd.experiments ?? [];
					pd.experiments = [...prev, ...experiments.filter((e) => !prev.includes(e))].slice(-8);
				}
				pd.generatedAt = new Date().toISOString();
				st.pendingDraft = pd;
			}
		}

		// Checkpoint trigger. Normally every `checkpointTurns` user turns — but
		// inside the near-compaction zone EVERY turn counts: the board may become
		// the summary at the end of this one, and the countdown rides along.
		const pressure = pressureOf(s, ctx);
		const near = pressure?.near === true;
		const due = st.turnsSinceCheckpoint >= s.cfg.checkpointTurns || near;
		if (due) {
			st.pendingCheckpoint = true;
			// A near-compaction nudge is a standing reminder, not an unprocessed
			// draft: it must not burn one of the 3 tolerated misses.
			if (near) st.draftInjectCount = 0;
			if (!st.pendingDraft && near) {
				// Nothing deterministic to show, but the reminder still has to
				// reach the agent — commit-worthy facts are exactly what extraction
				// cannot see.
				st.pendingDraft = { generatedAt: new Date().toISOString(), sections: {} };
			}
			if (s.cfg.delivery === "immediate") {
				try {
					pi.sendMessage(
						{
							customType: "sbb-checkpoint",
							content: renderCheckpoint(st.pendingDraft, s.cfg, pressure),
							display: false,
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
					st.pendingCheckpoint = false;
				} catch {
					/* keep it queued for the next user turn */
				}
			}
		}

		saveState(s.cfg.boardDir, s.sessionId, st);
		debug(s, {
			event: "turn_processed",
			freshEntries: fresh.length,
			draftLines: countDraftLines(st.pendingDraft?.sections as DraftSections | undefined),
			pendingCheckpoint: st.pendingCheckpoint,
			nearCompaction: near,
			remainingTokens: pressure?.remaining ?? null,
		});
	};

	// --------------------------------------------------------------- hooks

	pi.on("session_start", async (_e, ctx) => {
		try {
			const s = getSession(ctx);
			s.cfg = loadConfig(s.cwd); // refresh after config edits / resume
			if (s.cfg.enabled) {
				ctx?.ui?.notify?.(`session-blackboard active — board: ${boardPath(s.cfg.boardDir, s.sessionId)}`, "info");
				maybeAdoptPriorSummary(s, ctx);
			}
		} catch {
			/* never break session start */
		}
	});

	// pi summarised without us: either the board was too thin to be trusted as a
	// summary, or the board could not be read/rendered. That summary is the only
	// record of the replaced messages — adopt it, so the NEXT compaction can use
	// the board instead of asking the model again.
	pi.on("session_compact", async (e, ctx) => {
		try {
			const s = getSession(ctx);
			// Unconditional entry log: distinguishes "handler never called" from
			// "called but bailed early" in the debug trail.
			debug(s, {
				event: "session_compact_hook",
				sessionId: s.sessionId,
				cwd: s.cwd,
				summaryLen: typeof (e as { compactionEntry?: { summary?: unknown } })
					.compactionEntry?.summary === "string"
					? ((e as { compactionEntry: { summary: string } }).compactionEntry.summary).length
					: -1,
			});
			if (!s.cfg.enabled || !s.cfg.seedFromPriorSummary) return;
			// When this extension itself produced the compaction (board-as-summary),
			// the carried summary IS the board's own rendering — adopting it would
			// parse the board back into itself and duplicate every entry.
			if ((e as { fromExtension?: boolean }).fromExtension) {
				debug(s, { event: "summary_not_adopted", reason: "board-generated", trigger: "native-compaction" });
				return;
			}
			const entry = (e as { compactionEntry?: { summary?: unknown } }).compactionEntry;
			const summary = typeof entry?.summary === "string" ? entry.summary : "";
			if (!summary.trim()) {
				debug(s, { event: "summary_not_adopted", reason: "empty-summary", trigger: "native-compaction" });
				return;
			}
			adoptSummaryText(s, ctx, summary, "native-compaction");
		} catch (err) {
			// Never break compaction, but do not vanish silently either: a hook that
			// throws here is indistinguishable from "adoption never worked".
			try {
				debug(getSession(ctx), {
					event: "summary_adopt_error",
					error: err instanceof Error ? err.message : String(err),
				});
			} catch {
				/* ignore */
			}
		}
	});

	pi.on("agent_settled", async (_e, ctx) => {
		try {
			processTurn(ctx);
		} catch (err) {
			try {
				const s = getSession(ctx);
				debug(s, { event: "process_turn_error", error: err instanceof Error ? err.message : String(err) });
			} catch {
				/* ignore */
			}
		}
	});

	pi.on("before_agent_start", async (_e, ctx) => {
		try {
			const s = getSession(ctx);
			// pi 0.84.x auto-activates all registered extension tools in SDK sessions
			// (measured: probe5), so the kill flag must actively de-activate.
			ensureBlackboardActive(s);
			ensureBlackboardInactive(s);
			const st = loadState(s.cfg.boardDir, s.sessionId);
			if (st.pendingCheckpoint) {
				// Fresh reading for this turn: the number must describe the context
				// the agent is about to run in, not the one from last turn.
				const pressure = pressureOf(s, ctx);
				const near = pressure?.near === true;
				if (st.draftInjectCount >= 3 && !near) {
					try {
						ctx?.ui?.notify?.(
							"session-blackboard: pending draft unprocessed 3× — commit it via the blackboard tool, or run /bb skip",
							"warning",
						);
					} catch {
						/* ignore */
					}
					st.pendingCheckpoint = false;
					saveState(s.cfg.boardDir, s.sessionId, st);
					return;
				}
				const content = renderCheckpoint(st.pendingDraft, s.cfg, pressure);
				st.pendingCheckpoint = false;
				if (near) st.draftInjectCount = 0;
				else st.draftInjectCount += 1;
				saveState(s.cfg.boardDir, s.sessionId, st);
				debug(s, {
					event: "checkpoint_injected",
					draftLines: countDraftLines(st.pendingDraft?.sections as DraftSections | undefined),
					nearCompaction: near,
					remainingTokens: pressure?.remaining ?? null,
				});
				return {
					message: { customType: "sbb-checkpoint", content, display: false },
				};
			}
		} catch {
			/* never break the agent */
		}
	});

	// ----------------------------------------------- compaction cooperation
	//
	// Two independent "cooperate, don't replace" behaviors:
	//
	// (1) `compaction: "digest"` — mirror a compact board digest into the
	//     session JSONL right before compaction (vcc_recall-searchable;
	//     consumable by future deterministic compaction).
	//
	// (2) `compactAssist` (temporary) — ASSIST native compaction: run the very
	//     same summarization call the harness would make (the exported
	//     compact() — identical model, prompt, retained tail) and APPEND a
	//     size-capped deterministic board section to the LLM summary, so the
	//     post-compaction context carries both the conversational summary AND
	//     the curated durable facts it may have dropped.
	//     Strictly best-effort: no model / empty board / auth failure /
	//     call failure -> return undefined -> the untouched native flow runs
	//     (with its own retry policy). Native compaction is never replaced.
	pi.on("session_before_compact", async (e, ctx) => {
		let s: { cfg: SbbConfig; sessionId: string; cwd: string };
		try {
			s = getSession(ctx);
		} catch {
			return;
		}
		if (!s.cfg.enabled) return;

		try {
			// (1) optional pre-compaction digest mirroring (unchanged)
			if (s.cfg.compaction === "digest") {
				const board = readBoardFile(s.cfg.boardDir, s.sessionId);
				if (countAll(board) > 0) mirror(s, board, "pre-compaction");
			}
		} catch {
			/* never break compaction */
		}

		// (1b) board-as-summary: the agent has been curating this board every
		// `checkpointTurns` turns precisely so it can stand in for the summary.
		// Returning it here skips pi's summarization call entirely; a thin
		// board returns null and the native flow below runs untouched.
		if (s.cfg.compaction === "board") {
			// A one-shot native request (from `/bb compact`): the user wants pi's
			// own summarization for this compaction. The summary it produces is
			// merged back into the board by the session_compact hook below, so
			// nothing is lost by skipping the board this once.
			const forced = loadState(s.cfg.boardDir, s.sessionId);
			// Armed for 5 minutes only: a cancelled compaction must not leave a
			// native-bypass sitting in the state file for the rest of the session.
			const age = typeof forced.forceNativeOnceAt === "number" ? Date.now() - forced.forceNativeOnceAt : Infinity;
			if (forced.forceNativeOnce && age <= FORCE_NATIVE_TTL_MS) {
				forced.forceNativeOnce = false;
				forced.forceNativeOnceAt = undefined;
				saveState(s.cfg.boardDir, s.sessionId, forced);
				debug(s, { event: "board_summary_bypassed", reason: e.reason, why: "manual-native" });
				return; // -> untouched native flow
			}
			if (forced.forceNativeOnce) {
				forced.forceNativeOnce = false;
				forced.forceNativeOnceAt = undefined;
				saveState(s.cfg.boardDir, s.sessionId, forced);
			}
			try {
				const board = readBoardFile(s.cfg.boardDir, s.sessionId);
				const bp = boardPath(s.cfg.boardDir, s.sessionId);
				const keptNote =
					"pi keeps the most recent turns verbatim right after this summary (keepRecentTokens), so recent work is not lost — do not restate it here; a one-line forward pointer (\"next step: X\") is enough.";
				const summary = renderSummary(board, {
					maxChars: s.cfg.summaryMaxChars,
					keptTailNote: keptNote,
					boardFile: bp,
					archiveDir: archiveDir(s.cfg.boardDir, s.sessionId),
					recallTool: "blackboard_recall",
				});
				if (summary) {
					mirror(s, board, "pre-compaction");
					debug(s, { event: "board_summary", reason: e.reason, chars: summary.length, entries: countAll(board) });
					return {
						compaction: {
							summary,
							firstKeptEntryId: e.preparation.firstKeptEntryId,
							tokensBefore: e.preparation.tokensBefore,
						},
					};
				}
				debug(s, { event: "board_summary_thin", reason: e.reason, entries: countAll(board) });
			} catch (err) {
				debug(s, { event: "board_summary_error", error: err instanceof Error ? err.message : String(err) });
			}
			return; // -> native flow
		}

		// (2) assist: native LLM summary + capped board section
		if (!s.cfg.compactAssist) return;
		const model = ctx?.model;
		const registry = ctx?.modelRegistry;
		if (!model || typeof registry?.getApiKeyAndHeaders !== "function") return; // -> native flow
		let section: string | null = null;
		try {
			const board = readBoardFile(s.cfg.boardDir, s.sessionId);
			section = renderAssistSection(board, s.cfg.boardDir, s.sessionId, s.cfg.compactAssistMaxChars);
		} catch {
			return; // -> native flow
		}
		if (!section) return; // empty board: nothing to assist with -> native flow
		try {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth || auth.ok !== true) return; // -> native flow
			const result = await compact(
				e.preparation,
				model,
				auth.apiKey,
				auth.headers as Record<string, string> | undefined,
				e.customInstructions,
				e.signal,
				ctx?.thinkingLevel,
				undefined, // no streamFn -> single non-streaming completion
				auth.env,
			);
			debug(s, {
				event: "compact_assist",
				reason: e.reason,
				outputTokens: result.usage?.output,
				sectionChars: section.length,
			});
			return {
				compaction: {
					...result,
					summary: `${result.summary}\n\n${section}`,
				},
			};
		} catch (err) {
			// Any failure -> undefined -> native compaction runs unchanged.
			debug(s, { event: "compact_assist_error", error: err instanceof Error ? err.message : String(err) });
			return;
		}
	});

	// ------------------------------------------------------------------ tool

	const sectionLiterals: TLiteral[] = COMMIT_SECTIONS.map((v) => Type.Literal(v) as TLiteral);

	pi.registerTool({
		name: "blackboard",
		label: "Session Blackboard",
		description:
			"Maintain the session blackboard — durable, session-scoped notes (goal, decisions, findings, files, issues, next steps, preferences) that survive compaction and restarts. Commit reviewed entries (optionally superseding stale ones, optionally rejecting mechanical draft lines with dropDraft), skip a pending draft, show the board, or archive entries.",
		promptSnippet: "Commit reviewed entries to, show, skip, or archive the session blackboard",
		promptGuidelines: [
			'When a "[session-blackboard checkpoint]" message appears, review the draft it contains, then call blackboard with action="commit" for the entries worth keeping (corrected as needed), or action="skip" if none are.',
			"blackboard entries ARE the compaction summary: when this session runs out of context, pi replaces everything before the retained tail with these entries (no summarization model runs). Write them as a checkpoint summary for your future self — what was asked, decisions and why, what is in progress or blocked, the concrete next step, exact paths/function names/error text.",
			"blackboard entries are single lines only; keep them factual and specific (what was decided, which file path, which error). Timestamps are added automatically.",
			"After exploration or experiments yield a non-obvious result (a measured behavior, a root cause, a gotcha), commit it under findings — one line with the exact command, number or error.",
			'A fact that CHANGED goes on the new line with supersedes="<unique substring of the old line>" — the old line is archived in the same call, so the summary never carries both versions. Committing a correction WITHOUT supersedes leaves the stale line in place and makes the summary contradict itself.',
			"After compaction or when resuming a session, call blackboard with action=\"show\" (or read the board file) to restore durable context, and use blackboard_recall to search older entries by keyword.",
			"A commit echoes back only the entries that landed plus the few lines before each — it is NOT the whole board. When you need the full board use action=\"show\"; when you need an older fact use blackboard_recall.",
			"Mechanical draft lines the policy auto-accepts (by default the deterministic `MODIFIED …` / `COMMIT …` ones) land with your commit — do NOT retype them. To reject one, name a substring of it in dropDraft=[…] instead.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("commit"), Type.Literal("skip"), Type.Literal("show"), Type.Literal("archive")], {
				description:
					'commit: record reviewed entries (mechanical draft lines the policy auto-accepts land with the same call; dropDraft rejects the ones you do not want); skip: discard the pending draft; show: print the current board; archive: move one stale entry to the archive file',
			}),
			entries: Type.Optional(
				Type.Array(
					Type.Object({
						section: Type.Union(sectionLiterals, {
							description: `target section: ${COMMIT_SECTIONS.join(" | ")}`,
						}),
						text: Type.String({ description: "one line, factual and specific" }),
						supersedes: Type.Optional(
							Type.String({
								description:
									"unique substring of an existing entry this line REPLACES; the old line is archived in the same call. Use it whenever a fact changed.",
							}),
						),
					}),
					{ description: "entries to commit (action=commit)" },
				),
			),
			target: Type.Optional(Type.String({ description: "action=archive: unique substring identifying the entry to archive" })),
			dropDraft: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"action=commit: substrings of PENDING DRAFT lines to reject — they are dropped instead of auto-committed (case-insensitive, no need to retype the line)",
				}),
			),
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: AnyCtx) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			const s = getSession(ctx);
			const dir = s.cfg.boardDir;
			const sidShort = safeSid(s.sessionId);

			if (!s.cfg.enabled) {
				return text("blackboard is disabled for this project (.pi/settings.json → session-blackboard.enabled=false); no action taken.");
			}

			try {
				switch (params.action) {
					case "commit": {
						const raw: unknown[] = Array.isArray(params.entries) ? (params.entries as unknown[]) : [];
						const entries = raw
							.filter(
								(e): e is { section: Section; text: string; supersedes?: unknown } =>
									!!e &&
									typeof e === "object" &&
									typeof (e as { text?: unknown }).text === "string" &&
									COMMIT_SECTIONS.includes((e as { section?: unknown }).section as Section),
							)
							.map((e) =>
								typeof e.supersedes === "string" && e.supersedes.trim()
									? { section: e.section, text: e.text, supersedes: e.supersedes }
									: { section: e.section, text: e.text },
							);
						const st = loadState(dir, s.sessionId);
						// One call, one review: the draft lines the policy auto-accepts land
						// with THIS commit (the agent does not retype them — measured, retyping
						// is exactly how the deterministic facts got lost), and `dropDraft`
						// substrings cull the ones it rejects. Draft lines first, so the agent's
						// own wording wins whenever both exist.
						const drop: string[] = Array.isArray(params.dropDraft)
							? (params.dropDraft as unknown[]).filter((x): x is string => typeof x === "string")
							: [];
						const draftPick = selectDraftLines(st.pendingDraft, s.cfg.draftOnCommit, drop);
						if (entries.length === 0 && draftPick.selected.length === 0) {
							return text(
								"No valid entries provided. Call with entries=[{section, text}] (section: " +
									COMMIT_SECTIONS.join("|") +
									"), or action=\"skip\" to discard the pending draft.",
							);
						}
						const { board, archivedFiles, committed, deduped, supersededFiles, supersedeMisses, added } = commitEntries(
							dir,
							s.sessionId,
							s.cfg,
							[...draftPick.selected, ...entries],
						);
						clearPending(st);
						st.checkpointCount += 1;
						st.turnsSinceCheckpoint = 0;
						st.boardVersion += 1;
						saveState(dir, s.sessionId, st);
						mirror(s, board);
						debug(s, {
							event: "commit",
							committed,
							deduped,
							archived: archivedFiles.length,
							superseded: supersededFiles.length,
							supersedeMisses: supersedeMisses.length,
							draftAuto: draftPick.selected.length,
							draftDropped: draftPick.dropped,
							draftPolicy: s.cfg.draftOnCommit,
						});
						const autoLanded = new Set(draftPick.selected.map((d) => cleanEntryText(d.text, s.cfg.maxEntryChars)));
						const autoCount = added.filter((a) => autoLanded.has(a.text)).length;
						const bits: string[] = [];
						if (autoCount > 0) bits.push(`${autoCount} auto-accepted from the mechanical draft`);
						if (deduped > 0) bits.push(`${deduped} duplicate${deduped === 1 ? "" : "s"} skipped`);
						const parts: string[] = [
							`Committed ${committed} ${committed === 1 ? "entry" : "entries"}${bits.length ? ` (${bits.join(", ")})` : ""}. Blackboard v${st.boardVersion}.`,
						];
						if (draftPick.dropped > 0) parts.push(`Dropped ${draftPick.dropped} draft line(s) matching dropDraft.`);
						const notAuto = draftPick.total - draftPick.selected.length - draftPick.dropped;
						if (notAuto > 0) {
							parts.push(
								`${notAuto} draft line(s) did NOT land (draftOnCommit="${s.cfg.draftOnCommit}" leaves them to you) — the draft is now cleared; rewrite them in the next commit if they matter.`,
							);
						}
						if (supersededFiles.length > 0) {
							parts.push(
								`Replaced entries archived → ${supersededFiles.join(", ")} (still searchable via blackboard_recall).`,
							);
						}
						if (supersedeMisses.length > 0) {
							parts.push(
								`⚠ ${supersedeMisses.length} supersedes target(s) archived nothing — the stale line is probably still on the board: ${supersedeMisses
									.map((m) => `"${m.target}" (${m.reason})`)
									.join("; ")}. Retry with a longer unique substring, or use action="archive".`,
							);
						}
						if (archivedFiles.length > 0) parts.push(`Rotated overflow to: ${archivedFiles.join(", ")}`);
						// Receipt, not a board dump: the new lines (`+`) plus the
						// `commitContextEntries` lines before each — enough to pick the next
						// `supersedes` substring without re-paying for the whole board every
						// commit. Everything else is one `show` / `blackboard_recall` away.
						const echo = renderCommitEcho(
							board,
							added.map((a) => ({ ...a, auto: autoLanded.has(a.text) })),
							s.cfg.commitContextEntries,
						);
						if (echo) {
							parts.push(
								`Board after commit — your entries (+) and auto-accepted draft lines (~), each preceded by its ${s.cfg.commitContextEntries} nearest older entries:\n${echo}`,
							);
							parts.push(`Full board: ${boardPath(dir, s.sessionId)} — use action="show" or blackboard_recall, do not re-read the file.`);
						}
						return text(parts.join("\n\n"));
					}
					case "skip": {
						const st = loadState(dir, s.sessionId);
						clearPending(st);
						saveState(dir, s.sessionId, st);
						debug(s, { event: "skip" });
						return text("Pending blackboard draft discarded.");
					}
					case "show": {
						const board = readBoardFile(dir, s.sessionId);
						const rendered = renderBoard(board);
						const out =
							rendered.length > 6000
								? `${rendered.slice(0, 6000)}\n…(truncated — full board at ${boardPath(dir, s.sessionId)})`
								: rendered.trim() === ""
									? "(board empty)"
									: rendered;
						return text(out);
					}
					case "archive": {
						const target = typeof params.target === "string" ? params.target : "";
						if (!target.trim()) return text("archive requires target=<unique substring of the entry>");
						const { board, archived } = archiveEntry(dir, s.sessionId, target);
						if (!archived) return text(`No single board entry matched "${target}". Use a more specific substring.`);
						mirror(s, board);
						debug(s, { event: "archive", file: archived });
						return text(`Archived 1 entry → ${boardPath(dir, s.sessionId)} … file: ${archived}`);
					}
					default:
						return text(`Unknown action: ${String(params.action)}`);
				}
			} catch (err) {
				return text(`blackboard error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// --------------------------------------------------------------- tool activation
	//
	// SDK sessions: two gates keep an extension tool hidden from the model.
	// (1) If the SDK caller passes an explicit `tools: [...]` option, it is a STRICT
	//     ALLOWLIST (sdk.js: allowedToolNames) — the constructor's _refreshToolRegistry
	//     filters the extension tool out of the registry itself, so setActiveTools can
	//     never surface it ("only tools in the registry can be enabled"). Runners must
	//     therefore OMIT the `tools` option (default active set is still read/bash/
	//     edit/write).
	// (2) SDK sessions do not auto-activate newly registered extension tools (TUI
	//     sessions do). So even with an open registry the tool stays inactive until
	//     someone activates it — which is what the first before_agent_start does below
	//     (that event fires in SDK sessions; session_start does not).
	// Measured in the 13878 A/B run: arm A's model never saw the `blackboard` tool
	// in its schema (0 tool calls, 0 unknown-tool errors).
	//
	// Fix: one-shot activation on the first before_agent_start — by then the runner
	// has wired the pi.* actions (ExtensionRunner ctor) AND the constructor's refresh
	// has already merged our tool into the registry, so setActiveTools can enable it.
	// No-op when already active (TUI) or when the kill flag disables us (arm B).
	const api = pi as unknown as {
		refreshTools?: () => void;
		getActiveTools?: () => string[];
		setActiveTools?: (names: string[]) => void;
	};
	let toolActivationAttempted = false;
	const ensureBlackboardActive = (s: { cfg: SbbConfig; sessionId: string }) => {
		if (!s.cfg.enabled || toolActivationAttempted) return;
		toolActivationAttempted = true;
		try {
			api.refreshTools?.(); // re-merge registry (no-op where actions pre-wired)
			const active = api.getActiveTools?.() ?? [];
			if (typeof api.setActiveTools === "function" && !active.includes("blackboard")) {
				api.setActiveTools([...active, "blackboard"]);
						debug(s, { event: "tool_activated", activeTools: api.getActiveTools?.() });
			} else {
						debug(s, { event: "tool_already_active" });
			}
		} catch (err) {
					debug(s, { event: "tool_activation_error", error: err instanceof Error ? err.message : String(err) });
		}
	};
	let toolDeactivationAttempted = false;
	// Kill flag: since pi 0.84.x the framework auto-activates all registered
	// extension tools in SDK sessions too (measured: probe5 — `blackboard` in
	// getActiveTools() ~1s after load, before any extension call). A project-level
	// enabled:false must therefore actively REMOVE the tool, or the "extension OFF"
	// arm still exposes it to the model.
	const ensureBlackboardInactive = (s: { cfg: SbbConfig; sessionId: string }) => {
		if (s.cfg.enabled || toolDeactivationAttempted) return;
		toolDeactivationAttempted = true;
		try {
			const active = api.getActiveTools?.() ?? [];
			if (active.includes("blackboard") && typeof api.setActiveTools === "function") {
				api.setActiveTools(active.filter((n) => n !== "blackboard"));
				debug(s, { event: "tool_deactivated", activeTools: api.getActiveTools?.() });
			} else {
				debug(s, { event: "tool_already_inactive" });
			}
		} catch (err) {
			debug(s, { event: "tool_deactivation_error", error: err instanceof Error ? err.message : String(err) });
		}
	};
	// Defensive immediate attempt (no-op under current pi wiring, where the runner
	// copies the pi.* actions into the runtime only AFTER extension module load).
	try {
		api.refreshTools?.();
		const activeNow = api.getActiveTools?.() ?? [];
		if (typeof api.setActiveTools === "function" && !activeNow.includes("blackboard")) {
			api.setActiveTools([...activeNow, "blackboard"]);
		}
	} catch {
		/* actions not wired yet — handled on first before_agent_start */
	}

	// --------------------------------------------------------------- command

	pi.registerCommand("bb", {
		description:
			"Session blackboard: no args = status+board | now = force checkpoint on next turn | compact = force NATIVE compaction (its summary is merged into the board) | skip = discard pending draft | reset = wipe board+state (archive kept)",
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handler: async (args: string, ctx: AnyCtx) => {
			const s = getSession(ctx);
			const dir = s.cfg.boardDir;
			const cmd = (args ?? "").trim().toLowerCase();
			const st = loadState(dir, s.sessionId);
			const ui = ctx?.ui as
				| { notify?: (msg: string, kind?: string) => void; confirm?: (title: string, msg: string) => Promise<boolean> }
				| undefined;

			try {
				if (cmd === "reset") {
					const ok = await ui?.confirm?.("Reset blackboard", "Delete this session's blackboard file and state? (archive files are kept)");
					if (ok) {
						resetAll(dir, s.sessionId);
						ui?.notify?.("Blackboard reset.", "info");
					}
					return;
				}
				if (cmd === "compact") {
					// The manual "native compaction" button. Whatever pi's own
					// summarization writes afterwards is merged back into the board
					// by the session_compact hook, so this costs a model call and
					// still leaves the board denser than before.
					st.forceNativeOnce = true;
					st.forceNativeOnceAt = Date.now();
					saveState(dir, s.sessionId, st);
					try {
						ctx?.compact?.({
							onComplete: () => {
								ui?.notify?.("Native compaction done — its summary was merged into the blackboard.", "info");
							},
							onError: (err: Error) => {
								st.forceNativeOnce = false;
								saveState(dir, s.sessionId, st);
								ui?.notify?.(`Native compaction failed: ${err.message}`, "error");
							},
						});
						ui?.notify?.("Running pi's native compaction…", "info");
					} catch (err) {
						st.forceNativeOnce = false;
						saveState(dir, s.sessionId, st);
						ui?.notify?.(`Could not trigger compaction: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
				if (cmd === "skip") {
					st.pendingDraft = null;
					st.pendingCheckpoint = false;
					st.draftInjectCount = 0;
					saveState(dir, s.sessionId, st);
					ui?.notify?.("Pending draft discarded.", "info");
					return;
				}
				if (cmd === "now") {
					if (!st.pendingDraft) {
						ui?.notify?.("No pending draft to process.", "warning");
						return;
					}
					st.pendingCheckpoint = true;
					saveState(dir, s.sessionId, st);
					if (s.cfg.delivery === "immediate") {
						try {
							pi.sendMessage(
								{
									customType: "sbb-checkpoint",
									content: renderCheckpoint(st.pendingDraft, s.cfg),
									display: false,
								},
								{ deliverAs: "steer", triggerTurn: true },
							);
							ui?.notify?.("Checkpoint dispatched.", "info");
						} catch {
							ui?.notify?.("Could not dispatch immediately; will inject on your next message.", "warning");
						}
					} else {
						ui?.notify?.("Checkpoint will be injected with your next message.", "info");
					}
					return;
				}

				// default: status + board (truncated)
				const board = readBoardFile(dir, s.sessionId);
				const pr = pressureOf(s, ctx);
				const lines: string[] = [
					`blackboard: ${boardPath(dir, s.sessionId)}`,
					`v${st.boardVersion} | updated: ${board.header.updated ?? "never"} | entries: ${countReal(board)} (+${countAll(board) - countReal(board)} archive pointers) | turns since checkpoint: ${st.turnsSinceCheckpoint} | pending draft: ${
						st.pendingDraft ? `${countDraftLines(st.pendingDraft.sections)} lines` : "none"
					}`,
					`compaction: ${s.cfg.compaction}${pr && pr.remaining !== null ? ` | ${fmtTokens(pr.remaining)} tokens left until pi's native trigger` : ""}`,
					"",
					"subcommands: /bb now (checkpoint on next turn) | /bb compact (force NATIVE compaction; its summary merges into this board) | /bb skip | /bb reset",
					"",
				];
				const rendered = renderBoard(board).split("\n");
				lines.push(...rendered.slice(0, 80));
				if (rendered.length > 80) lines.push(`…${rendered.length - 80} more lines (full file: ${boardPath(dir, s.sessionId)})`);
				ui?.notify?.(lines.join("\n"), "info");
			} catch (err) {
				ui?.notify?.(`bb error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// ------------------------------------------------------------- retrieval
	//
	// The board is the compaction summary, so it is also what the model must be
	// able to search when the summary is not enough. Greps the live board, the
	// rotated archive, and the sbb-snapshot digests mirrored into the session.

	pi.registerTool({
		name: "blackboard_recall",
		label: "Blackboard Recall",
		description:
			"Search the session blackboard (live board, rotated archive, and session digests) for entries matching a keyword — paths, identifiers, error fragments. Use it when the compaction summary does not answer a question about earlier in this session.",
		promptSnippet: "Search the session blackboard for earlier entries by keyword",
		promptGuidelines: [
			"Prefer blackboard_recall over re-reading the summary when you need a specific earlier fact (a path, an error, a decision that is not in the summary).",
			"Search with a literal substring copied from the conversation, not a paraphrase.",
			"Results are one line per match, tagged with where it came from (board · Section, archive/<file> · From: Section, snapshot/<i>@hh-mm-ss · Section) — grep again with a longer substring to narrow, or pass full=true only when you need to restore a whole board state.",
			"Archive files are searched newest first (up to 40 of them); if the result says the scan was capped, narrow the query instead of raising the limit.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "substring to find (case-insensitive), e.g. a file path, function name or error text" }),
			limit: Type.Optional(Type.Number({ description: "max matching lines (default 20, max 60)" })),
			full: Type.Optional(
				Type.Boolean({
					description: "return whole snapshot digests instead of just the matching lines (only when restoring the full board state)",
				}),
			),
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: AnyCtx) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			try {
				const s = getSession(ctx);
				if (!s.cfg.enabled) return text("blackboard is disabled for this project; nothing to search.");
				const query = typeof params?.query === "string" ? params.query : "";
				if (!query.trim()) return text('blackboard_recall needs a non-empty "query".');
				const limit = Math.max(1, Math.min(60, Number(params?.limit) || 20));
				const full = params?.full === true;

				const hits: RecallHit[] = [];
				// live board
				try {
					hits.push(...searchDocument(readFileSync(boardPath(s.cfg.boardDir, s.sessionId), "utf-8"), query, limit, "board"));
				} catch {
					/* no board file yet */
				}
				// rotated archive
				let archiveNote = "";
				if (hits.length < limit) {
					try {
						const ad = archiveDir(s.cfg.boardDir, s.sessionId);
						// Newest first, and at most ARCHIVE_SCAN_MAX files: rotation writes one
						// file per overflow (measured: 55 files after 60 commits), so reading
						// the whole directory per query gets slower the longer the session runs.
						const files = readdirSync(ad)
							.filter((n) => n.endsWith(".md"))
							.map((n) => ({ n, m: statSync(join(ad, n)).mtimeMs }))
							.sort((a, b) => b.m - a.m);
						if (files.length > ARCHIVE_SCAN_MAX)
							archiveNote = `\n(archive: searched the ${ARCHIVE_SCAN_MAX} newest of ${files.length} files — narrow the query or grep ${ad})`;
						for (const f of files.slice(0, ARCHIVE_SCAN_MAX)) {
							if (hits.length >= limit) break;
							hits.push(...searchDocument(readFileSync(join(ad, f.n), "utf-8"), query, limit - hits.length, `archive/${f.n}`));
						}
					} catch {
						/* no archive */
					}
				}
				// session digests (sbb-snapshot entries) — one hit per matching line,
				// attributed to the digest field it came from; `full` dumps the blob.
				if (hits.length < limit) {
					try {
						const entries = (ctx?.sessionManager?.getEntries?.() ?? []) as Array<Record<string, unknown>>;
						entries.forEach((entry, i) => {
							if (hits.length >= limit) return;
							if (entry?.type !== "custom" || entry?.customType !== "sbb-snapshot") return;
							const data = (entry.data ?? {}) as Record<string, unknown>;
							if (full) {
								hits.push(...searchDocument(JSON.stringify(data), query, limit - hits.length, `snapshot/${i}`));
								return;
							}
							const at = typeof data.at === "string" ? data.at.slice(11, 19).replace(/:/g, "-") : "";
							hits.push(...searchDigest(data, query, limit - hits.length, at ? `snapshot/${i}@${at}` : `snapshot/${i}`));
						});
					} catch {
						/* no session manager */
					}
				}
				debug(s, { event: "recall", query, hits: hits.length });
				return text(formatRecall(hits, query) + archiveNote);
			} catch (err) {
				return text(`blackboard_recall failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

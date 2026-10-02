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

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
import type { SbbConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { archiveDir, boardPath, debugPath, safeSid } from "./paths.js";
import { defaultState, loadState, saveState } from "./state.js";
import {
	archiveEntry,
	commitEntries,
	countAll,
	digest,
	markResolved,
	readBoardFile,
	renderBoard,
	resetAll,
	seedFromPriorSummary,
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
	//    too thin (or unreadable) — that text is the only record left of the
	//    replaced messages.
	// Either way the entries are adopted into the board, so the next compaction
	// has something to work from. Only ever fills a THIN board: curated entries
	// are never merged with, or diluted by, a foreign summary.

	const adoptSummaryText = (
		s: { cfg: SbbConfig; sessionId: string },
		ctx: AnyCtx,
		summary: string,
		reason: "session_start" | "native-compaction",
	): void => {
		if (!s.cfg.seedFromPriorSummary) return;
		const res = seedFromPriorSummary(s.cfg.boardDir, s.sessionId, s.cfg, summary);
		if (!res.seeded) {
			debug(s, { event: "summary_not_adopted", reason: res.reason, trigger: reason });
			return;
		}
		mirror(s, readBoardFile(s.cfg.boardDir, s.sessionId), `adopted:${reason}`);
		debug(s, { event: "summary_adopted", trigger: reason, total: res.total, counts: res.counts, archived: res.archived.length });
		const st = loadState(s.cfg.boardDir, s.sessionId);
		st.boardVersion += 1;
		st.lastAdoption = { source: reason, at: new Date().toISOString(), total: res.total };
		saveState(s.cfg.boardDir, s.sessionId, st);
		const detail = Object.entries(res.counts)
			.map(([k, n]) => `${k}:${n}`)
			.join(" ");
		ctx?.ui?.notify?.(
			`session-blackboard adopted the previous compaction summary — ${res.total} entries (${detail}). Review them at the next checkpoint.`,
			"info",
		);
	};

	/**
	 * Adopt a prior native summary once per session, on whichever hook fires first.
	 *
	 * `session_start` is not guaranteed to run (measured: an RPC pi process never
	 * fires it), so the same check also runs from the first processed turn and is
	 * guarded by a state flag rather than by which event showed up.
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
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e?.type !== "compaction") continue;
				const summary = typeof (e as { summary?: unknown }).summary === "string" ? ((e as { summary: string }).summary) : "";
				if (summary.trim()) {
					adoptSummaryText(s, ctx, summary, reason);
					return;
				}
			}
		} catch {
			/* no session manager / unreadable session */
		}
	};

	const renderCheckpoint = (draft: PendingDraft, cfg: SbbConfig): string => {
		const parts: string[] = [
			"[session-blackboard checkpoint]",
			"A draft of the session blackboard was compiled deterministically (no LLM) from turns since the last checkpoint.",
			"IMPORTANT — what you commit here IS the compaction summary. When this session runs out of context, pi replaces everything before the retained tail with your blackboard entries (no separate summarization model runs). Your future self reads these lines, not the conversation. Write them the way you would write a checkpoint summary for another LLM that has to continue this work:",
			`  - goal: what is being asked, including scope changes and corrections;`,
			`  - decisions: the choice AND why it beat the alternative;`,
			`  - files: exact paths, and which of them changed;`,
			`  - issues: blockers with the real error text and exit codes; resolved ones must be moved or marked resolved;`,
			`  - next: the concrete next step, not "continue working";`,
			`  - prefs: durable constraints and preferences the user stated.`,
			`Review the draft: correct inaccuracies, delete noise, then commit what is worth keeping via the \`blackboard\` tool (action="commit", entries=[{section, text, supersedes?}]). Sections: ${COMMIT_SECTIONS.join(", ")}. Each text must be ONE line, factual and specific, max ${cfg.maxEntryChars} chars — timestamps are added automatically. Preserve exact file paths, function names, error messages and numbers.`,
			"Keep the board dense, not chronological: one line per fact, newest state wins.",
			`When a fact CHANGED, put it on the new line and set supersedes="<unique substring of the old line>": the old line is archived in the same call, so the summary can never show both versions.`,
			"If nothing is worth keeping, call the tool with action=\"skip\".",
			"--- draft ---",
		];
		let any = false;
		for (const s of SECTIONS) {
			const lines = draft.sections[s] ?? [];
			if (!lines.length) continue;
			any = true;
			parts.push(`## ${s}`);
			parts.push(...lines.slice(0, cfg.maxDraftLines).map((l) => `- ${l}`));
		}
		if (!any) parts.push("(empty draft)");
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
			const { draft, resolvedPaths } = extractAll(blocks, board, st);

			if (!st.goalExtracted) st.goalExtracted = true;

			if (resolvedPaths.length > 0) {
				const n = markResolved(board, resolvedPaths);
				if (n > 0) writeBoard(s.cfg.boardDir, s.sessionId, board);
			}

			if (countDraftLines(draft) > 0) {
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
				pd.generatedAt = new Date().toISOString();
				st.pendingDraft = pd;
			}
		}

		// Checkpoint trigger.
		if (st.pendingDraft && st.turnsSinceCheckpoint >= s.cfg.checkpointTurns) {
			st.pendingCheckpoint = true;
			if (s.cfg.delivery === "immediate") {
				try {
					pi.sendMessage(
						{ customType: "sbb-checkpoint", content: renderCheckpoint(st.pendingDraft, s.cfg), display: false },
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
			if (st.pendingCheckpoint && st.pendingDraft) {
				if (st.draftInjectCount >= 3) {
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
				const content = renderCheckpoint(st.pendingDraft, s.cfg);
				st.pendingCheckpoint = false;
				st.draftInjectCount += 1;
				saveState(s.cfg.boardDir, s.sessionId, st);
				debug(s, { event: "checkpoint_injected", draftLines: countDraftLines(st.pendingDraft.sections) });
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
			try {
				const board = readBoardFile(s.cfg.boardDir, s.sessionId);
				const bp = boardPath(s.cfg.boardDir, s.sessionId);
				const keptNote =
					"pi keeps the most recent turns verbatim right after this summary (keepRecentTokens), so recent work is not lost — do not restate it here; a one-line forward pointer (\"next step: X\") is enough.";
				const summary = renderSummary(board, {
					maxChars: s.cfg.summaryMaxChars,
					keptTailNote: keptNote,
					boardFile: bp,
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
			"Maintain the session blackboard — durable, session-scoped notes (goal, decisions, files, issues, next steps, preferences) that survive compaction and restarts. Commit reviewed entries (optionally superseding stale ones), skip a pending draft, show the board, or archive entries.",
		promptSnippet: "Commit reviewed entries to, show, skip, or archive the session blackboard",
		promptGuidelines: [
			'When a "[session-blackboard checkpoint]" message appears, review the draft it contains, then call blackboard with action="commit" for the entries worth keeping (corrected as needed), or action="skip" if none are.',
			"blackboard entries ARE the compaction summary: when this session runs out of context, pi replaces everything before the retained tail with these entries (no summarization model runs). Write them as a checkpoint summary for your future self — what was asked, decisions and why, what is in progress or blocked, the concrete next step, exact paths/function names/error text.",
			"blackboard entries are single lines only; keep them factual and specific (what was decided, which file path, which error). Timestamps are added automatically.",
			'A fact that CHANGED goes on the new line with supersedes="<unique substring of the old line>" — the old line is archived in the same call, so the summary never carries both versions. Committing a correction WITHOUT supersedes leaves the stale line in place and makes the summary contradict itself.',
			"After compaction or when resuming a session, call blackboard with action=\"show\" (or read the board file) to restore durable context, and use blackboard_recall to search older entries by keyword.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("commit"), Type.Literal("skip"), Type.Literal("show"), Type.Literal("archive")], {
				description:
					'commit: record reviewed entries; skip: discard the pending draft; show: print the current board; archive: move one stale entry to the archive file',
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
						if (entries.length === 0) {
							return text(
								"No valid entries provided. Call with entries=[{section, text}] (section: " +
									COMMIT_SECTIONS.join("|") +
									"), or action=\"skip\" to discard the pending draft.",
							);
						}
						const { board, archivedFiles, committed, deduped, supersededFiles, supersedeMisses } = commitEntries(
							dir,
							s.sessionId,
							s.cfg,
							entries,
						);
						const st = loadState(dir, s.sessionId);
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
						});
						const parts: string[] = [`Committed ${committed} entries${deduped ? ` (${deduped} duplicates skipped)` : ""}. Blackboard v${st.boardVersion}.`];
						if (supersededFiles.length > 0) {
							parts.push(
								`Superseded ${supersededFiles.length} stale entries → archived to ${supersededFiles.join(", ")} (still searchable via blackboard_recall).`,
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
						parts.push(renderBoard(board).slice(0, 4000));
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
			"Session blackboard: no args = status+board | now = force checkpoint on next turn | skip = discard pending draft | reset = wipe board+state (archive kept)",
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
				const lines: string[] = [
					`blackboard: ${boardPath(dir, s.sessionId)}`,
					`v${st.boardVersion} | updated: ${board.header.updated ?? "never"} | entries: ${countAll(board)} | turns since checkpoint: ${st.turnsSinceCheckpoint} | pending draft: ${
						st.pendingDraft ? `${countDraftLines(st.pendingDraft.sections)} lines` : "none"
					}`,
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
				if (hits.length < limit) {
					try {
						const ad = archiveDir(s.cfg.boardDir, s.sessionId);
						for (const f of readdirSync(ad).filter((n) => n.endsWith(".md")).sort()) {
							if (hits.length >= limit) break;
							hits.push(...searchDocument(readFileSync(join(ad, f), "utf-8"), query, limit - hits.length, `archive/${f}`));
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
				return text(formatRecall(hits, query));
			} catch (err) {
				return text(`blackboard_recall failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

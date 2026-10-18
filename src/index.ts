/** pi 1.3 entry point. Session custom entries are authoritative; Markdown is export-only. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { compact } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadConfig, computePressure, describePressure } from './config.js';
import { normalizeBranch, extractAll } from './extract.js';
import { defaultState } from './state.js';
import { selectDraftLines, hasSummaryContext } from './board.js';
import { renderSummary } from './summary.js';
import { planImport } from './summary-import.js';
import { boardPath } from './paths.js';
import { inspectLegacy, migrateLegacy } from './migration.js';
import { renderSnapshot, exportMarkdown, exportOptions } from './export.js';
import { resolve } from 'node:path';
import { replayBranch, toBoard, planCommit, newEvent, fingerprint, reduceEvent, nativeRequestFresh, type CommitInput } from './journal.js';
import { commitWithCache, WriterLocks } from './storage.js';
import { makeOffer, validateReview, validateSources, draftCandidates, sourceRefs, checkReadiness, repairHeadroom } from './coverage.js';
import { searchPage, readLegacyArchives, buildIndex } from './retrieval.js';
import { SECTIONS, type BranchEntry, type JournalChange, type JournalProjection, type PendingDraft } from './types.js';

export const SUMMARY_GENERATOR = 'pi-session-blackboard';
export const SUMMARY_SCHEMA = 2;
/** Ownership is a generator+schema claim, never pi's generic `fromExtension` flag. */
export const isOwnSummary = (details: unknown): details is { generator: string; schema: number } => {
  const d = details as { generator?: unknown; schema?: unknown } | undefined;
  return d?.generator === SUMMARY_GENERATOR && d?.schema === SUMMARY_SCHEMA;
};

type Ctx = any;
const OWN_TOOLS = ['blackboard', 'blackboard_recall'];
export default function sessionBlackboard(pi: ExtensionAPI) {
  const locks = new WriterLocks();
  const get = (ctx: Ctx) => {
    const manager = ctx.sessionManager;
    if (!manager?.getBranch || !manager?.getSessionId) throw new Error('Session manager unavailable');
    const cwd = ctx.cwd ?? manager.getCwd?.() ?? process.cwd();
    const cfg = loadConfig(cwd);
    const branch = manager.getBranch() as BranchEntry[];
    return { cfg, branch, manager, sessionId: manager.getSessionId(), projection: replayBranch(branch) };
  };
  const commit = (ctx: Ctx, event: ReturnType<typeof newEvent>) => {
    const s = get(ctx);
    if (!s.cfg.enabled) throw new Error('Blackboard disabled; no state changed');
    locks.acquire(s.cfg.boardDir, s.sessionId);
    return commitWithCache(pi, s.manager, event);
  };
  const change = (ctx: Ctx, changes: JournalChange[], operationId?: string) => commit(ctx, newEvent(get(ctx).projection, changes, operationId));
  const notify = (ctx: Ctx, text: string, kind = 'info') => ctx.ui?.notify?.(text, kind);
  const activated = new Set<string>();
  const syncTools = (ctx: Ctx) => {
    const s = get(ctx), active = pi.getActiveTools();
    // Only ever touch this extension's own tools: other extensions' and the user's choices stay.
    const enabledOwn = s.cfg.enabled;
    if (!enabledOwn) {
      if (active.some(name => OWN_TOOLS.includes(name))) pi.setActiveTools(active.filter(name => !OWN_TOOLS.includes(name)));
      activated.delete(s.sessionId);
      return;
    }
    if (activated.has(s.sessionId)) return;
    activated.add(s.sessionId);
    const missing = OWN_TOOLS.filter(name => !active.includes(name));
    if (missing.length) pi.setActiveTools([...active, ...missing]);
  };
  const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text }], details });
  const selected = (projection: JournalProjection, target: string) => {
    const matches = Object.values(projection.entries).filter(entry => entry.validity === 'active' && (entry.id === target || entry.text.includes(target)));
    if (!target || matches.length !== 1) throw new Error('Target must identify exactly one active entry');
    return matches[0];
  };
  const dedicatedRepair = (ctx: Ctx) => {
    const repair = get(ctx).projection.repair;
    return !!repair && repair.extraRequests > 0 && ['queued', 'delivered'].includes(repair.phase);
  };
  const execute = async (callId: string, params: any, ctx: Ctx) => {
    const s = get(ctx);
    if (!s.cfg.enabled) throw new Error('Blackboard disabled; no state changed');
    switch (params.action) {
      case 'commit': {
        const operationId = params.operationId ?? callId;
        const request = { entries: params.entries ?? [], review: params.review, dropDraft: params.dropDraft ?? [] };
        if (Object.hasOwn(s.projection.requests, operationId)) {
          if (s.projection.requests[operationId] !== fingerprint(request)) throw new Error('Operation ID reused with different request');
          return result('Already committed; no duplicate event or timestamp refresh.');
        }
        const pick = selectDraftLines(s.projection.draft, s.cfg.draftOnCommit, params.dropDraft ?? []);
        const inputs: CommitInput[] = [...pick.selected.map(item => {
          const sources = s.projection.draft?.sources?.[`c-${fingerprint([item.section, item.text]).slice(0, 24)}`] ?? [];
          return { ...item, sources, origin: sources.length && sources.every(source => source.kind === 'tool') ? 'tool' as const : 'assistant' as const };
        }), ...(params.entries ?? [])];
        for (const input of inputs) {
          validateSources(input.sources ?? [], s.branch, s.manager);
          if (input.origin === 'user' && (!input.sources?.length || input.sources.some(source => source.kind !== 'user'))) throw new Error('User-origin notes require actual user-message sources; tool content is not authorization');
        }
        const review = params.review ? validateReview(s.projection, params.review, s.branch, s.manager) : undefined;
        const event = inputs.length ? planCommit(s.projection, inputs, operationId, undefined, request) : null;
        if (!event && !review) return result('No new entries; use review plus an explicit receipt to confirm a range, or skip to discard a draft.');
        const transaction = event ?? newEvent(s.projection, [], operationId);
        transaction.requestFingerprint = fingerprint(request);
        if (review) transaction.changes.push({ type: 'review', receipt: review });
        if (s.projection.draft) {
          const removed = new Set([...pick.selected, ...(params.entries ?? [])].map((item: CommitInput) => item.text));
          const remaining = structuredClone(s.projection.draft) as PendingDraft;
          for (const [section, lines] of Object.entries(remaining.sections)) remaining.sections[section as keyof typeof remaining.sections] = lines!.filter(line => !removed.has(line) && !(params.dropDraft ?? []).some((part: string) => line.toLowerCase().includes(part.toLowerCase())));
          transaction.changes.push({ type: 'draft', draft: draftCandidates(remaining).length ? remaining : null, cursor: s.projection.cursor, turns: 0 });
        }
        const preview = reduceEvent(s.projection, transaction);
        if (preview.repair && checkReadiness(preview, sourceRefs(s.branch, s.manager)).ok) transaction.changes.push({ type: 'repair', repair: { ...preview.repair, phase: 'checked' } });
        const receipt = commit(ctx, transaction);
        const entries = transaction.changes.filter(item => item.type === 'put').map(item => item.entry);
        return result(`Committed v${receipt.projection.revision}.\n${entries.map(entry => `${entry.id}@${entry.revision} [${entry.section}] ${entry.text}`).join('\n')}\n${receipt.warning ?? ''}\nUse blackboard show/recall or /bb; there is no default board file.`, { revision: receipt.projection.revision, ids: entries.map(entry => entry.id), warning: receipt.warning });
      }
      case 'review': {
        const offer = makeOffer(s.projection, s.branch, s.manager);
        if (!Object.hasOwn(s.projection.offers, offer.id)) change(ctx, [{ type: 'offer', receipt: offer }]);
        return result(`Review these candidates and the referenced current-context range. This is not an automatic correctness proof.\n${JSON.stringify({ credential: offer, candidates: draftCandidates(s.projection.draft), legacyUnscoped: Object.values(s.projection.entries).filter(entry => entry.validity === 'active' && entry.legacyUnscoped) }, null, 2)}\nConfirm using action=commit, review={id,constraintsChecked,executionChecked,goalChecked}; entries are optional.`, { credential: offer });
      }
      case 'retain': {
        const entry = selected(s.projection, params.id ?? params.target ?? '');
        if (params.expectedRevision !== entry.revision) throw new Error('retain requires expectedRevision');
        const receipt = change(ctx, [{ type: 'retain', id: entry.id, expectedRevision: entry.revision }], callId);
        return result(`Retained ${entry.id} for the next successful compaction only; fact validity and substantive time unchanged.`, { revision: receipt.projection.revision });
      }
      case 'skip': {
        change(ctx, [{ type: 'draft', draft: null, cursor: s.projection.cursor }], callId);
        return result('Draft discarded; this does not confirm review coverage.');
      }
      case 'show': {
        if (params.id) {
          const entry = s.projection.entries[params.id];
          if (!entry) throw new Error('No entry with this ID on the current branch (history mode searches earlier revisions)');
          return result(JSON.stringify(entry, null, 2), { entry, revision: s.projection.revision });
        }
        const index = buildIndex(s.projection, params.history === true ? 'history' : 'current')
          .filter(hit => !params.section || hit.section === params.section);
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Math.max(1, Math.min(60, Number(params.limit) || 20));
        const page = index.slice(offset, offset + limit);
        const more = offset + page.length < index.length;
        const body = page.map(hit => `${hit.id}@${hit.revision} [${String(hit.section)}${hit.validity !== 'active' ? `/${hit.validity}` : ''}${hit.taskState ? `/${hit.taskState}` : ''}] ${hit.text}`);
        const legacy = !s.projection.eventIds.length && existsSync(boardPath(s.cfg.boardDir, s.sessionId)) ? ['', 'Legacy board file detected: legacy/unscoped, not current facts. Run /bb migrate for a dry run.'] : [];
        return result([`Notes: ${index.length} item(s), showing ${offset + 1}-${offset + page.length}.`, ...body, more ? `more: action=show offset=${offset + page.length}${params.section ? ` section=${params.section}` : ''}` : 'end of list.', ...legacy].join('\n'), { revision: s.projection.revision, nextOffset: more ? offset + page.length : null });
      }
      case 'archive': {
        const entry = selected(s.projection, params.target ?? '');
        const receipt = change(ctx, [{ type: 'archive', id: entry.id, expectedRevision: entry.revision }], callId);
        return result(`Archived ${entry.id}; validity unchanged. History remains in session events.`, { revision: receipt.projection.revision });
      }
      default: throw new Error(`Unknown blackboard action: ${params.action}`);
    }
  };
  pi.registerTool({
    name: 'blackboard', label: 'Session Blackboard',
    description: 'Maintain branch-local session notes. Commits are atomic session events. Show current notes, skip a draft, or archive an entry. Notes are agent statements, not independent verification. Markdown is export-only.',
    promptGuidelines: [
      'Record important goals, constraints, decisions, findings, task state and next actions as complete notes with their negative/uncertain qualifiers.',
      'A changed file does not prove an issue resolved. Use explicit task states and evidence.',
      'After compaction restore notes with blackboard show; use blackboard_recall for a specific earlier fact. There is no default Markdown board to read.',
    ],
    parameters: Type.Object({
      action: Type.Union(['commit', 'skip', 'show', 'archive', 'review', 'retain'].map(value => Type.Literal(value))),
      entries: Type.Optional(Type.Array(Type.Object({
        section: Type.Optional(Type.Union(SECTIONS.filter(section => section !== 'archived').map(section => Type.Literal(section)))),
        text: Type.Optional(Type.String()), supersedes: Type.Optional(Type.String()),
        id: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        taskState: Type.Optional(Type.Union(['todo', 'in_progress', 'blocked', 'done', 'cancelled'].map(value => Type.Literal(value)))),
        epistemic: Type.Optional(Type.Union(['stated', 'hypothesis', 'unknown'].map(value => Type.Literal(value)))),
        origin: Type.Optional(Type.Union(['user', 'tool', 'assistant', 'native-summary', 'legacy'].map(value => Type.Literal(value)))),
        sources: Type.Optional(Type.Array(Type.Object({ entryId: Type.String(), fingerprint: Type.String(), kind: Type.Union(['user', 'tool', 'assistant', 'native-summary', 'legacy'].map(value => Type.Literal(value))), callId: Type.Optional(Type.String()) }))),
        verification: Type.Optional(Type.String()), retain: Type.Optional(Type.Boolean()), legacyUnscoped: Type.Optional(Type.Boolean()),
        validity: Type.Optional(Type.Union(['active', 'superseded', 'retracted'].map(value => Type.Literal(value)))),
      }))),
      target: Type.Optional(Type.String()), dropDraft: Type.Optional(Type.Array(Type.String())),
      section: Type.Optional(Type.Union(SECTIONS.map(value => Type.Literal(value)))),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      history: Type.Optional(Type.Boolean()),
      operationId: Type.Optional(Type.String()), id: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer()),
      review: Type.Optional(Type.Object({ id: Type.String(), constraintsChecked: Type.Boolean(), executionChecked: Type.Boolean(), goalChecked: Type.Boolean() })),
    }),
    execute: async (id, params, _signal, _update, ctx) => {
      const dedicated = dedicatedRepair(ctx);
      try { return { ...await execute(id, params, ctx), ...(dedicated ? { terminate: true } : {}) }; }
      catch (error) {
        if (!dedicated) throw error;
        return { ...result(`Memory repair failed: ${error instanceof Error ? error.message : String(error)}`), isError: true, terminate: true };
      }
    },
  });
  pi.registerTool({
    name: 'blackboard_recall', label: 'Blackboard Recall',
    description: 'Literal search over current branch notes, historical versions, the current transcript, or legacy archives. Pageable with a stable cursor; an unmatched page never means "nothing exists".',
    parameters: Type.Object({
      query: Type.String(),
      mode: Type.Optional(Type.Union(['current', 'history', 'session'].map(value => Type.Literal(value)), { description: 'current (default) shows only valid notes; history adds superseded/retracted versions; session searches this branch transcript' })),
      limit: Type.Optional(Type.Number()),
      cursor: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const s = get(ctx);
      if (!s.cfg.enabled) throw new Error('Blackboard disabled');
      const page = searchPage({
        projection: s.projection, branch: s.branch, sessionProjection: s.manager.buildSessionProjection?.(),
        query: params.query ?? '', mode: params.mode ?? 'current', limit: params.limit, cursorToken: params.cursor,
        archives: readLegacyArchives(s.cfg.boardDir, s.sessionId),
      });
      const lines = page.hits.map(hit => `${hit.source} · ${String(hit.section)} · ${hit.id}@${hit.revision} [${hit.validity}${hit.taskState ? `/${hit.taskState}` : ''}] ${hit.text}`);
      const verdict = page.hits.length
        ? `${page.hits.length} match(es) on this page.`
        : page.complete
          ? 'No match in the searched range (all current-branch notes, history and legacy archives were scanned).'
          : 'No match on this page — the scan is NOT finished; continue with the cursor before concluding anything.';
      const footer = page.nextCursor
        ? `more available: pass cursor="${page.nextCursor}" (archives ${page.scannedArchives} scanned this page, ${page.totalArchives} total).`
        : 'scan complete.';
      return { ...result([verdict, ...lines, footer].join('\n'), { nextCursor: page.nextCursor, complete: page.complete }), ...(dedicatedRepair(ctx) ? { terminate: true } : {}) };
    },
  });
  const pressure = (ctx: Ctx) => {
    const s = get(ctx), usage = ctx.getContextUsage?.();
    return computePressure(usage, ctx.cwd ?? s.manager.getCwd?.() ?? process.cwd(), ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, s.cfg.compactionWarnTokens);
  };
  const collectTurn = (event: any, ctx: Ctx) => {
    const s = get(ctx); if (!s.cfg.enabled) return;
    for (const id of [event.messageEntryId, ...(event.toolResultEntryIds ?? [])].filter(Boolean)) {
      if (!s.branch.some(entry => entry.id === id)) throw new Error('turn_end source ID is not on this branch');
    }
    const start = s.projection.cursor ? s.branch.findIndex(entry => entry.id === s.projection.cursor) + 1 : 0;
    const freshIds = new Set(s.branch.slice(start).filter(entry => entry.type === 'message').map(entry => entry.id));
    const cursor = [...s.branch].reverse().find(entry => entry.type === 'message')?.id;
    if (!freshIds.size || cursor === s.projection.cursor) return;
    const projected = s.manager.buildSessionProjection?.().entries;
    const branch = projected ? projected.filter((item: any) => item.sourceEntry.type === 'message' && item.messages.length).map((item: any) => ({ ...item.sourceEntry, message: item.messages[0] })) : s.branch;
    const blocks = normalizeBranch(branch);
    const refs = new Map(sourceRefs(s.branch, s.manager).map(source => [source.entryId, source]));
    const draft: PendingDraft = structuredClone(s.projection.draft ?? { generatedAt: new Date().toISOString(), sections: {}, sources: {} });
    draft.sources ??= {};
    const board = toBoard(s.projection), state = defaultState();
    const groups = [
      ...blocks.users.filter(block => freshIds.has(block.entryId)).map(block => ({ entryId: block.entryId, users: [block], assistants: [], tools: [] })),
      ...blocks.assistants.filter(block => freshIds.has(block.entryId)).map(block => ({ entryId: block.entryId, users: [], assistants: [block], tools: [] })),
      ...blocks.tools.filter(block => freshIds.has(block.entryId) && !OWN_TOOLS.includes(block.name)).map(block => ({ entryId: block.entryId, users: [], assistants: [], tools: [block] })),
    ];
    for (const group of groups) {
      const extracted = extractAll(group, board, state);
      if (group.users.length) state.goalExtracted = true;
      for (const [section, lines] of Object.entries(extracted.draft)) for (const text of lines ?? []) {
        const key = section as keyof typeof draft.sections;
        if (!(draft.sections[key] ?? []).includes(text)) (draft.sections[key] ??= []).push(text);
        const ref = refs.get(group.entryId);
        if (ref) draft.sources[`c-${fingerprint([section, text]).slice(0, 24)}`] = [ref];
      }
      draft.experiments = [...new Set([...(draft.experiments ?? []), ...extracted.experiments])];
    }
    change(ctx, [{ type: 'draft', draft: draftCandidates(draft).length || draft.experiments?.length ? draft : null, cursor, turns: s.projection.turns + 1 }]);
  };
  const reminder = (ctx: Ctx) => {
    const s = get(ctx); if (!s.cfg.enabled) return;
    const p = pressure(ctx), near = p?.near === true;
    const due = near || (s.projection.draft && s.projection.turns % s.cfg.checkpointTurns === 0);
    // The countdown is a transient block computed from this turn's measurement only. It is never
    // stored as a note, never copied into a summary, and disappears with its compaction generation.
    const lines = typeof p?.remaining === 'number' && p.remaining !== null && ctx.getContextUsage?.()
      ? [describePressure(p)!] : [];
    if (!due && !lines.length) return;
    if (due) lines.push(
      '[session-blackboard checkpoint]',
      near ? 'NEAR COMPACTION: pause task expansion and write important changes now.' : 'Review pending session notes on this existing request.',
      'Call blackboard action=review to inspect the complete candidates and receive a content-bound credential; commit useful notes and explicitly confirm the reviewed range. skip only discards the draft and does not confirm coverage. Notes need goals, constraints (or explicit none-new), execution state, decisions and uncertainties.');
    return { message: { customType: 'sbb-review-needed', display: false, details: { generation: s.projection.generation }, content: lines.join('\n') } };
  };
  pi.on('session_start', async (_event, ctx) => {
    activated.clear();
    syncTools(ctx);
    const s = get(ctx);
    for (const hint of s.cfg.hints ?? []) notify(ctx, `session-blackboard settings: ${hint}`, 'warning');
    if (!s.cfg.enabled) notify(ctx, 'session-blackboard is disabled: no tools, no notes, no compaction takeover.', 'info');
    else if (s.cfg.compaction === 'off') notify(ctx, 'session-blackboard: notes are available, compaction stays native (compaction="off").', 'info');
    else if (s.cfg.compaction === 'board') notify(ctx, 'session-blackboard: the board takes over compaction when its coverage is established.', 'info');
  });
  pi.on('turn_end', async (event, ctx) => { collectTurn(event, ctx); });
  pi.on('before_agent_start', async (_event, ctx) => { syncTools(ctx); return reminder(ctx); });
  const noticesShown = new Set<string>();
  const OWN_MESSAGE_PREFIX = 'sbb-';
  const generationOf = (message: any): number | undefined => {
    const value = message?.details?.generation;
    return typeof value === 'number' ? value : undefined;
  };
  pi.on('context', async (event, ctx) => {
    const s = get(ctx), repair = s.projection.repair;
    if (!s.cfg.enabled) return;
    // Only a request that actually reaches the provider proves the repair message was delivered.
    if (repair?.phase === 'queued') change(ctx, [{ type: 'repair', repair: { ...repair, phase: 'delivered' } }]);
    const generation = s.projection.generation;
    const before = Array.isArray(event.messages) ? event.messages : [];
    // Old-generation extension hints are removed from the model-visible projection only; the
    // session log, user content and pending drafts are untouched.
    const messages = before.filter((message: any) => {
      if (message?.role !== 'custom' || typeof message.customType !== 'string' || !message.customType.startsWith(OWN_MESSAGE_PREFIX)) return true;
      const tagged = generationOf(message);
      return tagged === undefined ? generation === 0 : tagged === generation;
    });
    let changed = messages.length !== before.length;
    const key = `${s.sessionId}:${generation}`;
    if (s.projection.expiredIds.length && !noticesShown.has(key)) {
      noticesShown.add(key);
      const ids = s.projection.expiredIds.slice(0, 20).join(', ');
      messages.push({ role: 'custom', customType: 'sbb-retention-notice', display: false,
        content: `[session-blackboard] The previous successful compaction consumed these retention grants: ${ids}. Re-promote an entry explicitly (blackboard action=retain with expectedRevision) only if it must be protected next time; handled items need no action. Validity, constraints and task state are unchanged.`,
        timestamp: Date.now() });
      changed = true;
    }
    if (changed) return { messages };
  });
  pi.on('tool_call', async (event, ctx) => {
    if (dedicatedRepair(ctx) && !OWN_TOOLS.includes(event.toolName)) return { block: true, terminate: true, reason: 'Dedicated memory repair: pause task expansion; only blackboard tools are allowed for this bounded request.' };
  });
  const repairMessage = (projection: JournalProjection, branch: BranchEntry[], manager: Ctx, reasons: string[]) => {
    const offer = makeOffer(projection, branch, manager);
    const candidateIds = draftCandidates(projection?.draft ?? null);
    return { offer, content: `[session-blackboard urgent memory write]\nPause task expansion. This is a bounded memory-only request: commit/correct notes and explicitly confirm this credential. No separate summarizer is called.\nReason: ${reasons.length ? reasons.join('; ') : 'memory not yet ready for compaction'}\n${JSON.stringify({ credential: offer, candidates: candidateIds })}` };
  };
  /** Contributions that actually leave the retained tail for this preparation. */
  const requiredAtCut = (branch: BranchEntry[], firstKeptEntryId: string | null | undefined, refs: ReturnType<typeof sourceRefs>) => {
    if (!firstKeptEntryId) return refs;
    const cut = branch.findIndex(entry => entry.id === firstKeptEntryId);
    if (cut < 0) return refs; // unknown cut: be conservative, require everything
    const leaving = new Set(branch.slice(0, cut).map(entry => entry.id));
    return refs.filter(ref => leaving.has(ref.entryId));
  };
  /** Record that a repair is owed, without spending a request or starting a model call. */
  const markNeeded = (ctx: Ctx, range?: string) => {
    const s = get(ctx), previous = s.projection.repair;
    if (previous?.phase === 'needed') return;
    const { offer } = repairMessage(s.projection, s.branch, s.manager, []);
    change(ctx, [
      ...(Object.hasOwn(s.projection.offers, offer.id) ? [] : [{ type: 'offer' as const, receipt: offer }]),
      { type: 'repair', repair: { generation: s.projection.generation, extraRequests: previous?.extraRequests ?? 0, phase: 'needed', requestId: previous?.requestId ?? randomUUID(), rangeFingerprint: range ?? fingerprint(offer.range), instructions: previous?.instructions } },
    ]);
  };
  /** Spend one of the two allowances and hand the message to the boundary already running. */
  const takeAndSend = (ctx: Ctx, range?: string) => {
    const s = get(ctx), previous = s.projection.repair, used = previous?.extraRequests ?? 0;
    if (used >= 2) return null;
    const { offer, content } = repairMessage(s.projection, s.branch, s.manager, []);
    change(ctx, [
      ...(Object.hasOwn(s.projection.offers, offer.id) ? [] : [{ type: 'offer' as const, receipt: offer }]),
      { type: 'repair', repair: { generation: s.projection.generation, extraRequests: used + 1, phase: 'queued', requestId: randomUUID(), rangeFingerprint: range ?? previous?.rangeFingerprint ?? fingerprint(offer.range), instructions: previous?.instructions } },
    ]);
    return content;
  };
  pi.on('agent_before_settle', async (event, ctx) => {
    const s = get(ctx);
    if (!s.cfg.enabled || !event.context.canContinue) return;
    if (s.projection.repair?.phase === 'exhausted') return;
    // A user abort (Escape) never becomes a hidden continuation; the spent request is not refunded.
    if (event.outcome === 'aborted' || ctx.signal?.aborted) {
      if (s.projection.repair?.phase === 'queued') change(ctx, [{ type: 'repair', repair: { ...s.projection.repair, phase: 'needed' } }]);
      return;
    }
    if (s.cfg.compaction !== 'board') return;
    const refs = sourceRefs(s.branch, s.manager);
    const last = [...s.branch].reverse().find(entry => entry.type === 'message');
    const required = refs.filter(ref => ref.entryId !== last?.id || last?.message?.role !== 'assistant' || (Array.isArray(last.message.content) && last.message.content.some((part: any) => part.type === 'toolCall')));
    const ready = checkReadiness(s.projection, required);
    if (ready.ok || (s.projection.repair?.extraRequests ?? 0) >= 2) return;
    // Exactly two deliveries per generation, and exactly one delivery point. A request that was
    // sent and visibly ignored becomes owed again here; one still in flight is left alone.
    const phase = s.projection.repair?.phase;
    if (phase === 'checked' || phase === 'exhausted' || phase === 'queued') return;
    const pending = phase === 'needed';
    if (!pending && !pressure(ctx)?.near) return;
    if (!repairHeadroom(ctx.getContextUsage?.(), repairMessage(s.projection, s.branch, s.manager, ready.reasons).content, event.context.llmMessages)) return;
    if (!pending) markNeeded(ctx);
    const content = takeAndSend(ctx);
    if (!content) return;
    return { entries: [{ type: 'custom_message', customType: 'sbb-urgent-write', content, display: false, details: { generation: s.projection.generation } }], continue: true };
  });
  pi.on('session_tree', async (_event, ctx) => { activated.clear(); syncTools(ctx); });
  pi.on('session_shutdown', async () => { activated.clear(); locks.release(); });
  const logAttempt = (kind: string, data: Record<string, unknown>) => {
    try { pi.appendEntry('sbb-compaction', { kind, at: new Date().toISOString(), ...data }); } catch { /* diagnostics only */ }
  };
  /** Diagnostics: counts, ids and reasons only — never raw message or tool bodies. */
  const debugRecord = (ctx: Ctx, data: Record<string, unknown>) => {
    const s = get(ctx);
    if (!s.cfg.debugLog) return;
    try {
      pi.appendEntry('sbb-debug', { at: new Date().toISOString(), revision: s.projection.revision, generation: s.projection.generation,
        entries: Object.keys(s.projection.entries).length, history: s.projection.history.length, ...data });
    } catch { /* diagnostics only */ }
  };
  const summaryFor = (s: ReturnType<typeof get>, maxChars = s.cfg.summaryMaxChars) => {
    const board = toBoard(s.projection);
    return renderSummary(board, {
      maxChars,
      keptTailNote: 'pi keeps the most recent turns verbatim right after this summary (keepRecentTokens); do not restate them, a one-line forward pointer is enough.',
      recallTool: 'blackboard_recall',
    });
  };
  /** Manual compaction with custom instructions wants a written summary; honour them natively and carry the facts. */
  const assistedSummary = async (ctx: Ctx, event: any, s: ReturnType<typeof get>) => {
    const model = ctx.model, registry = ctx.modelRegistry;
    if (!s.cfg.compactAssist || !model || typeof registry?.getApiKeyAndHeaders !== 'function') return null;
    const section = summaryFor(s, Math.min(s.cfg.compactAssistMaxChars, s.cfg.summaryMaxChars));
    if (!section) return null;
    try {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth || auth.ok !== true) return null;
      const result = await compact(event.preparation, model, auth.apiKey, auth.headers, event.customInstructions, event.signal, ctx.thinkingLevel, undefined, auth.env);
      return `${result.summary}\n\n${section}`;
    } catch { return null; }
  };
  // Explicit deferral is the only thing this hook does besides handing over a finished summary.
  pi.on('session_before_compact', async (event, ctx) => {
    const s = get(ctx);
    if (!s.cfg.enabled) return;
    if (s.cfg.compaction !== 'board') return;
    const board = toBoard(s.projection);
    // An explicit user request for the native summary is obeyed immediately and once.
    if (s.projection.native) {
      if (nativeRequestFresh(s.projection)) {
        change(ctx, [{ type: 'native' }]);
        logAttempt('native-requested', { reason: event.reason });
        notify(ctx, 'Native compaction requested; blackboard does not take over this one.', 'info');
        return;
      }
      change(ctx, [{ type: 'native' }]);
    }
    if (!hasSummaryContext(board)) {
      notify(ctx, 'Not taking over compaction: no current goal/task context on the blackboard; native summary used.', 'warning');
      return; // too thin -> honest native flow
    }
    const cut = event.preparation?.firstKeptEntryId;
    const required = requiredAtCut(s.branch, cut, sourceRefs(s.branch, s.manager));
    const ready = checkReadiness(s.projection, required);
    const range = fingerprint(required);
    const summary = ready.ok ? summaryFor(s) : null;
    const problems = [...ready.reasons, ...(ready.ok && !summary ? ['blackboard summary exceeds its budget; write a shorter sourced version'] : [])];
    if (!problems.length && summary) {
      const honoured = event.reason === 'manual' && typeof event.customInstructions === 'string' && event.customInstructions.trim()
        ? await assistedSummary(ctx, event, s) : null;
      logAttempt('takeover', { reason: event.reason, assisted: !!honoured, revision: s.projection.revision, generation: s.projection.generation, chars: (honoured ?? summary).length });
      debugRecord(ctx, { event: 'takeover', reason: event.reason, chars: (honoured ?? summary).length, omitted: Object.values(s.projection.entries).filter(entry => entry.validity === 'active').length - (summary.match(/^- /gm) ?? []).length });
      return { compaction: {
        summary: honoured ?? summary,
        firstKeptEntryId: cut ?? s.branch.at(-1)?.id ?? '',
        tokensBefore: event.preparation?.tokensBefore ?? 0,
        details: { generator: SUMMARY_GENERATOR, schema: SUMMARY_SCHEMA, source: 'session-events', revision: s.projection.revision, generation: s.projection.generation, ...(honoured ? { assisted: true, note: 'native text honours manual instructions; blackboard section appended' } : {}) },
      } };
    }
    const allowance = s.projection.repair?.extraRequests ?? 0;
    const headroom = repairHeadroom(ctx.getContextUsage?.(), repairMessage(s.projection, s.branch, s.manager, problems).content);
    const phase = s.projection.repair?.phase;
    // Cancelling is only honest when this same run can deliver the repair: never while a request
    // is in flight, never after the user cancelled, and never with the allowance spent.
    const usable = event.reason !== 'manual' && event.reason !== 'overflow' && allowance < 2 && headroom
      && phase !== 'queued' && phase !== 'exhausted' && phase !== 'checked';
    if (usable) {
      // Never start the model from inside the hook: mark the repair pending and let the
      // run's own before-settle boundary deliver it.
      // A previously delivered request that did not fix the range becomes owed again (allowance 2).
      if (s.projection.repair?.phase === 'delivered') {
        change(ctx, [{ type: 'repair', repair: { ...s.projection.repair, phase: 'needed' } }]);
      } else if (s.projection.repair?.phase !== 'needed') markNeeded(ctx, range);
      logAttempt('deferred', { reason: event.reason, problems: problems.length, allowance: allowance + 1, generation: s.projection.generation });
      notify(ctx, 'Compaction deferred for a bounded memory repair; the current turn will finish it.', 'info');
      return { cancel: true };
    }
    const why = event.reason === 'manual'
      ? 'manual compaction has no safe deferral path here'
      : event.reason === 'overflow'
        ? 'context already overflowed; no safe headroom for a repair turn'
        : allowance >= 2
          ? 'both bounded repair requests were spent'
          : 'no safe headroom for a repair turn';
    notify(ctx, `Native summary used (${event.reason}): ${why}. Still unresolved: ${problems.join('; ')}`, 'warning');
    logAttempt('native-fallback', { reason: event.reason, why, problems: problems.length });
    debugRecord(ctx, { event: 'native-fallback', reason: event.reason, why, problems });
    return;
  });
  // A persisted compaction node is the only proof of success: it advances the generation and
  // consumes retention on replay. This handler only clears one-shot/ephemeral requests.
  pi.on('session_compact', async (event, ctx) => {
    const s = get(ctx);
    if (!s.cfg.enabled) return;
    const entry = event?.compactionEntry as { id?: string; summary?: string; details?: unknown; fromHook?: boolean } | undefined;
    const ours = isOwnSummary(entry?.details);
    const changes: JournalChange[] = [];
    if (s.projection.native) changes.push({ type: 'native' });
    if (s.projection.repair) changes.push({ type: 'repair', repair: { ...s.projection.repair, phase: 'checked' } });
    if (changes.length) change(ctx, changes);
    if (entry?.summary && !ours) {
      // Some other producer (pi itself, assist, another extension) wrote this summary. It is the
      // only record of the replaced messages, so it is imported with its source reference, never
      // skipped just because `fromExtension` happens to be true.
      const sourceId = entry.id ?? `summary-${fingerprint(entry.summary).slice(0, 16)}`;
      try {
        const planned = planImport(replayBranch(s.manager.getBranch()), sourceId, entry.summary, `import-${sourceId}`);
        if (planned.event) change(ctx, planned.event.changes, planned.event.operationId);
        logAttempt('foreign-summary', { compactionId: sourceId, fromHook: entry.fromHook === true, imported: planned.imported, duplicates: planned.duplicates, incomplete: planned.incomplete.length });
        notify(ctx, planned.incomplete.length
          ? `Imported ${planned.imported} native-summary entries; ${planned.incomplete.length} oversized block(s) were NOT imported (original summary still referenced: ${sourceId}). Content is unverified and this is not claimed complete.`
          : `Imported ${planned.imported} native-summary entries (${planned.duplicates} already known) from ${sourceId}; content is unverified — review before relying on it.`, planned.incomplete.length ? 'warning' : 'info');
      } catch (error) {
        logAttempt('foreign-summary-error', { compactionId: sourceId, error: error instanceof Error ? error.message : String(error) });
        notify(ctx, `Could not import the foreign summary: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }
    logAttempt('success', { reason: event?.reason, fromUs: ours, generation: replayBranch(s.manager.getBranch()).generation });
  });
  pi.registerCommand('bb', {
    description: 'Session notes: show | commit <JSON> | skip | archive <ID> | reset. Markdown is export-only.',
    handler: async (args, ctx) => {
      try {
        const match = /^\s*(\S+)?\s*([\s\S]*)$/.exec(args ?? '')!;
        const command = (match[1] ?? 'show').toLowerCase(), body = match[2];
        if (command === 'native') {
          change(ctx, [{ type: 'native', native: { at: new Date().toISOString(), ttlMs: 5 * 60 * 1000 } }]);
          notify(ctx, 'Next compaction runs pi\'s native summary (valid 5 minutes); the blackboard will not take over.');
          return;
        }
        if (command === 'cancel-repair') {
          const s = get(ctx);
          if (s.projection.repair) change(ctx, [{ type: 'repair', repair: { ...s.projection.repair, phase: 'exhausted' } }]);
          notify(ctx, 'Pending memory repair cancelled; no further repair requests will be sent until a compaction succeeds.');
          return;
        }
        if (command === 'debug') {
          const s = get(ctx);
          const entries = s.branch.filter(entry => entry.type === 'custom' && (entry.customType === 'sbb-debug' || entry.customType === 'sbb-compaction'))
            .slice(-30).map(entry => JSON.stringify(entry.data));
          notify(ctx, entries.length ? entries.join('\n') : `no diagnostics recorded (debugLog=${s.cfg.debugLog})`);
          return;
        }
        if (command === 'export') {
          const s = get(ctx), options = exportOptions(body);
          const text = renderSnapshot(s.projection, s.manager.getLeafId?.() ?? s.branch.at(-1)?.id ?? '');
          if (options.output) {
            const path = resolve(ctx.cwd ?? s.manager.getCwd?.() ?? process.cwd(), options.output);
            exportMarkdown(path, text, options.overwrite); notify(ctx, `Verified Markdown snapshot exported to ${path}; edits are not imported.`);
          } else notify(ctx, text);
          return;
        }
        if (command === 'migrate') {
          const s = get(ctx);
          if (!s.cfg.enabled) throw new Error('Blackboard disabled');
          const report = inspectLegacy(s.cfg.boardDir, s.sessionId);
          if (body.trim() !== 'apply') {
            notify(ctx, JSON.stringify({ dryRun: true, files: report.records.map(({ relative, hash }) => ({ relative, hash })), entries: report.inputs.length, warnings: report.warnings, manifestHash: report.manifestHash, note: 'Apply only explicitly: /bb migrate apply. All imported notes remain legacy/unscoped/unknown until reviewed.' }, null, 2));
          } else {
            const imported = migrateLegacy(s.cfg.boardDir, s.sessionId, s.projection, event => commit(ctx, event));
            notify(ctx, `Legacy migration: ${imported.count} candidates; alreadyImported=${imported.alreadyImported}; byte-verified backup=${imported.backup ?? 'none'}. Imported entries are unscoped and unverified.`);
          }
          return;
        }
        if (command === 'retain') {
          const [id, revision] = body.trim().split(/\s+/);
          notify(ctx, (await execute(randomUUID(), { action: 'retain', id, expectedRevision: Number(revision) }, ctx)).content[0].text); return;
        }
        if (command === 'reset') {
          if (await ctx.ui.confirm('Reset this branch?', 'Retract current notes on this path; preserve the event history and other branches?')) {
            change(ctx, [{ type: 'reset' }]); notify(ctx, 'Current branch reset; history preserved.');
          }
          return;
        }
        const parsed = command === 'commit' ? JSON.parse(body) : undefined;
        const params = command === 'commit' ? { action: command, ...(Array.isArray(parsed) ? { entries: parsed } : parsed) }
          : { action: command, target: body, ...(command === 'show' && body.trim() ? { id: body.trim() } : {}) };
        notify(ctx, (await execute(randomUUID(), params, ctx)).content[0].text);
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), 'error'); }
    },
  });
}

/** pi 1.3 entry point. Session custom entries are authoritative; Markdown is export-only. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { selectDraftLines } from './board.js';
import { boardPath } from './paths.js';
import { inspectLegacy, migrateLegacy } from './migration.js';
import { renderSnapshot, exportMarkdown, exportOptions } from './export.js';
import { resolve } from 'node:path';
import { replayBranch, toBoard, planCommit, newEvent, fingerprint, type CommitInput } from './journal.js';
import { commitWithCache, WriterLocks } from './storage.js';
import { makeOffer, validateReview, validateSources, draftCandidates } from './coverage.js';
import { SECTIONS, type BranchEntry, type JournalChange, type JournalProjection, type PendingDraft } from './types.js';

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
  const syncTools = (ctx: Ctx) => {
    const { cfg } = get(ctx), active = pi.getActiveTools();
    if (!cfg.enabled) pi.setActiveTools(active.filter(name => !OWN_TOOLS.includes(name)));
  };
  const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text }], details });
  const selected = (projection: JournalProjection, target: string) => {
    const matches = Object.values(projection.entries).filter(entry => entry.validity === 'active' && (entry.id === target || entry.text.includes(target)));
    if (!target || matches.length !== 1) throw new Error('Target must identify exactly one active entry');
    return matches[0];
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
        const inputs: CommitInput[] = [...pick.selected, ...(params.entries ?? [])];
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
          transaction.changes.push({ type: 'draft', draft: draftCandidates(remaining).length ? remaining : null, cursor: s.projection.cursor });
        }
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
          if (!entry) throw new Error('No entry with this ID on the current branch');
          return result(JSON.stringify(entry, null, 2), { entry, revision: s.projection.revision });
        }
        const text = renderSnapshot(s.projection, s.manager.getLeafId?.() ?? s.branch.at(-1)?.id ?? '');
        const legacy = !s.projection.eventIds.length && existsSync(boardPath(s.cfg.boardDir, s.sessionId));
        return result(`${text}${legacy ? '\nLegacy board detected; unscoped and not accepted as current facts. Migration/review is required.' : ''}`, { revision: s.projection.revision });
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
      operationId: Type.Optional(Type.String()), id: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer()),
      review: Type.Optional(Type.Object({ id: Type.String(), constraintsChecked: Type.Boolean(), executionChecked: Type.Boolean(), goalChecked: Type.Boolean() })),
    }),
    execute: async (id, params, _signal, _update, ctx) => execute(id, params, ctx),
  });
  pi.registerTool({
    name: 'blackboard_recall', label: 'Blackboard Recall',
    description: 'Literal search of current active notes on this branch; use IDs to distinguish revisions.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()), full: Type.Optional(Type.Boolean()) }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const s = get(ctx);
      if (!s.cfg.enabled) throw new Error('Blackboard disabled');
      const query = params.query.trim().toLowerCase();
      if (!query) throw new Error('Non-empty literal query required');
      const hits = Object.values(s.projection.entries).filter(entry => entry.validity === 'active' && entry.text.toLowerCase().includes(query));
      return result(hits.length ? hits.map(entry => `${entry.id}@${entry.revision} [${entry.section}] ${entry.text}`).join('\n') : 'No current-branch active note matches. Legacy archives have not been searched.', { revision: s.projection.revision });
    },
  });
  pi.on('session_start', async (_event, ctx) => { syncTools(ctx); });
  pi.on('before_agent_start', async (_event, ctx) => { syncTools(ctx); });
  pi.on('session_shutdown', async () => { locks.release(); });
  // No old board can take over compaction. The coverage-aware adapter is implemented in S3.
  pi.on('session_before_compact', async (_event, ctx) => {
    const s = get(ctx);
    if (s.cfg.enabled && s.cfg.compaction === 'board') notify(ctx, 'Blackboard v2 coverage adapter not yet enabled in this undeployed intermediate build; native flow remains in control.', 'warning');
  });
  pi.registerCommand('bb', {
    description: 'Session notes: show | commit <JSON> | skip | archive <ID> | reset. Markdown is export-only.',
    handler: async (args, ctx) => {
      try {
        const match = /^\s*(\S+)?\s*([\s\S]*)$/.exec(args ?? '')!;
        const command = (match[1] ?? 'show').toLowerCase(), body = match[2];
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

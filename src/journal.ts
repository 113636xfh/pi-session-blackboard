/** Branch-local authority. Pure reduction plus the small public append adapter. */
import { createHash, randomUUID } from 'node:crypto';
import type { Board, BranchEntry, JournalEvent, JournalProjection, JournalChange, MemoryEntry, Section, TaskState, SourceRef, Origin } from './types.js';
import { SECTIONS } from './types.js';
import { emptyBoard } from './board.js';

export const JOURNAL_TYPE = 'sbb-event';
export const fingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => (value as any)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function emptyProjection(): JournalProjection {
  return { schema: 2, revision: 0, entries: {}, history: [], operations: {}, requests: {}, eventIds: [], offers: {}, reviews: [],
    generation: 0, compactions: [], expiredIds: [], imports: {}, draft: null, turns: 0 };
}
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Blackboard journal: ${message}`); };
const own = (object: object, key: string) => Object.hasOwn(object, key);
const validKey = (key: unknown) => typeof key === 'string' && key.length > 0 && key.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(key);
export function validateEntry(entry: MemoryEntry): void {
  assert(entry && typeof entry === 'object', 'invalid entry');
  assert(validKey(entry.id) && /^[\w-]{1,160}$/.test(entry.id), 'invalid entry ID');
  assert(Number.isSafeInteger(entry.revision) && entry.revision > 0, 'invalid entry revision');
  assert(SECTIONS.includes(entry.section) && entry.section !== ('archived' as Section), 'invalid section');
  assert(typeof entry.text === 'string' && entry.text.trim().length > 0 && entry.text.length <= 32000, 'entry must contain 1–32000 characters; nothing is truncated');
  assert(Number.isFinite(Date.parse(entry.createdAt)) && Number.isFinite(Date.parse(entry.updatedAt)), 'invalid entry timestamps');
  assert(Number.isSafeInteger(entry.order) && entry.order >= 0, 'invalid event order');
  assert(['active', 'superseded', 'retracted'].includes(entry.validity), 'invalid validity');
  assert(['stated', 'hypothesis', 'unknown'].includes(entry.epistemic), 'invalid epistemic status');
  assert(['user', 'tool', 'assistant', 'native-summary', 'legacy'].includes(entry.origin), 'invalid origin');
  assert(!entry.taskState || ['todo', 'in_progress', 'blocked', 'done', 'cancelled'].includes(entry.taskState), 'invalid task state');
  assert(typeof entry.archived === 'boolean' && Array.isArray(entry.sources), 'invalid entry metadata');
  for (const source of entry.sources) assert(typeof source.entryId === 'string' && /^[a-f0-9]{64}$/.test(source.fingerprint), 'invalid source reference');
  if (entry.retention) assert(Number.isSafeInteger(entry.retention.generation) && typeof entry.retention.grantId === 'string', 'invalid retention');
}
/** One event is one transaction: errors never modify the input projection. */
export function reduceEvent(previous: JournalProjection, event: JournalEvent): JournalProjection {
  assert(event?.schema === 2, 'unsupported schema');
  assert(validKey(event.eventId) && validKey(event.operationId), 'missing event/operation ID');
  assert(Number.isFinite(Date.parse(event.at)), 'invalid event timestamp');
  assert(Array.isArray(event.changes) && event.changes.length > 0 && event.changes.length <= 1000, 'invalid event batch');
  const digest = fingerprint({ ...event, eventId: undefined });
  if (own(previous.operations, event.operationId)) {
    assert(previous.operations[event.operationId] === digest, 'operation ID reused with different payload');
    return previous;
  }
  assert(!previous.eventIds.includes(event.eventId), 'event ID collision');
  assert(event.baseRevision === previous.revision, 'stale journal revision');
  const next = structuredClone(previous);
  const remember = (entry: MemoryEntry) => { next.history.push(structuredClone(entry)); };
  for (const change of event.changes) {
    switch (change.type) {
      case 'put': {
        validateEntry(change.entry);
        const old = next.entries[change.entry.id];
        assert((old?.revision ?? 0) === change.expectedRevision, 'stale entry revision');
        assert(change.entry.revision === change.expectedRevision + 1, 'entry revision must advance once');
        if (old) { assert(old.createdAt === change.entry.createdAt, 'creation time cannot change');
          // The previous version is historical: it was replaced, so it must not present itself as current.
          remember({ ...old, validity: old.validity === 'active' ? 'superseded' : old.validity }); }
        next.entries[change.entry.id] = structuredClone(change.entry);
        break;
      }
      case 'retain': case 'archive': {
        const old = next.entries[change.id];
        assert(old && old.validity === 'active' && old.revision === change.expectedRevision, 'missing, inactive or stale entry');
        remember(old);
        old.revision++;
        if (change.type === 'retain') old.retention = { grantId: event.eventId, generation: next.generation };
        else old.archived = true;
        break;
      }
      case 'reset':
        for (const entry of Object.values(next.entries)) if (entry.validity === 'active') {
          remember(entry); entry.validity = 'retracted'; entry.revision++; delete entry.retention;
        }
        next.draft = null; next.reviews = []; next.offers = {}; delete next.repair;
        break;
      case 'offer':
        assert(change.receipt && typeof change.receipt.id === 'string' && !['__proto__', 'constructor', 'prototype'].includes(change.receipt.id), 'invalid review offer');
        next.offers[change.receipt.id] = structuredClone(change.receipt); break;
      case 'review':
        assert(change.receipt && Array.isArray(change.receipt.range) && Array.isArray(change.receipt.candidateIds), 'invalid review');
        assert(own(next.offers, change.receipt.id) && canonical(next.offers[change.receipt.id].range) === canonical(change.receipt.range) && canonical(next.offers[change.receipt.id].candidateIds) === canonical(change.receipt.candidateIds), 'review has no matching offer');
        assert(!next.reviews.some(review => review.id === change.receipt.id), 'duplicate review ID');
        next.reviews.push(structuredClone(change.receipt));
        break;
      case 'draft':
        next.draft = structuredClone(change.draft); next.cursor = change.cursor;
        if (change.turns !== undefined) { assert(Number.isSafeInteger(change.turns) && change.turns >= 0, 'invalid turn counter'); next.turns = change.turns; }
        break;
      case 'repair':
        assert(change.repair.generation === next.generation, 'repair belongs to another generation');
        assert(Number.isInteger(change.repair.extraRequests) && change.repair.extraRequests >= (next.repair?.extraRequests ?? 0) && change.repair.extraRequests <= 2, 'repair allowance cannot reset or exceed two');
        next.repair = structuredClone(change.repair); break;
      case 'import':
        assert(validKey(change.sourceId) && typeof change.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(change.fingerprint), 'invalid import marker');
        assert(!own(next.imports, change.sourceId) || next.imports[change.sourceId] === change.fingerprint, 'import source changed');
        next.imports[change.sourceId] = change.fingerprint; break;
      case 'native':
        next.native = change.native ? structuredClone(change.native) : undefined;
        break;
      default: throw new Error('Blackboard journal: unknown change');
    }
  }
  next.operations[event.operationId] = digest;
  if (event.requestFingerprint) next.requests[event.operationId] = event.requestFingerprint;
  next.eventIds.push(event.eventId);
  next.revision++;
  return next;
}
export function replayEvents(events: JournalEvent[]): JournalProjection {
  return events.reduce(reduceEvent, emptyProjection());
}
export function toBoard(projection: JournalProjection): Board {
  const board = emptyBoard();
  board.generation = projection.generation; board.revision = projection.revision;
  for (const entry of Object.values(projection.entries)) if (entry.validity === 'active' && !entry.legacyUnscoped) {
    board.sections[entry.section].push({ ...entry, ts: entry.updatedAt });
  }
  return board;
}
export function newEvent(projection: JournalProjection, changes: JournalChange[], operationId: string = randomUUID()): JournalEvent {
  return { schema: 2, eventId: randomUUID(), operationId, at: new Date().toISOString(), baseRevision: projection.revision, changes };
}
export type CommitInput = {
  section?: Exclude<Section, 'archived'>; text?: string; id?: string; expectedRevision?: number; supersedes?: string;
  taskState?: TaskState; epistemic?: MemoryEntry['epistemic']; origin?: Origin; sources?: SourceRef[];
  verification?: string; validity?: MemoryEntry['validity']; retain?: boolean; legacyUnscoped?: boolean;
};
/** Preflight all inputs against one immutable revision, including ambiguous legacy replacements. */
export function planCommit(projection: JournalProjection, inputs: CommitInput[], operationId: string, at = new Date().toISOString(), request: unknown = inputs): JournalEvent | null {
  assert(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 500, 'commit requires 1–500 entries');
  assert(operationId && !['__proto__', 'constructor', 'prototype'].includes(operationId), 'invalid operation ID');
  const requestFingerprint = fingerprint(request);
  if (own(projection.requests, operationId)) {
    assert(projection.requests[operationId] === requestFingerprint, 'operation ID reused with different request');
    return null;
  }
  const changes: JournalChange[] = [], targets = new Set<string>();
  let working = projection;
  for (const [index, input] of inputs.entries()) {
    assert(input && typeof input === 'object', 'invalid commit input');
    let old = input.id ? working.entries[input.id] : undefined;
    if (input.id) assert(old && input.expectedRevision === old.revision, 'ID updates require current expectedRevision');
    if (input.supersedes) {
      assert(!input.id, 'choose ID or supersedes, not both');
      const matches = Object.values(working.entries).filter(entry => entry.validity === 'active' && entry.text.includes(input.supersedes!));
      assert(matches.length === 1, 'supersedes must match exactly one active entry by a unique substring of its old text, not an entry ID; for ID updates use id plus current expectedRevision'); old = matches[0];
    }
    const text = (input.text ?? old?.text ?? '').replace(/\s+/g, ' ').trim();
    const section = input.section ?? old?.section;
    assert(section && section !== ('archived' as Section), 'section required');
    if (!old && Object.values(working.entries).some(entry => entry.validity === 'active' && entry.section === section && entry.text === text)) continue;
    const id = old?.id ?? `m-${fingerprint([operationId, index]).slice(0, 24)}`;
    assert(!targets.has(id), 'a batch cannot revise the same entry twice'); targets.add(id);
    const entry: MemoryEntry = {
      id, revision: (old?.revision ?? 0) + 1, section: section!, text,
      createdAt: old?.createdAt ?? at, updatedAt: at, order: (projection.revision + 1) * 1000 + index,
      validity: input.validity ?? old?.validity ?? 'active', epistemic: input.epistemic ?? old?.epistemic ?? 'stated',
      origin: input.origin ?? old?.origin ?? 'assistant', sources: input.sources ?? old?.sources ?? [],
      archived: old?.archived ?? false,
      ...(old?.retention ? { retention: old.retention } : {}),
      ...((input.taskState ?? old?.taskState ?? (section === 'next' ? 'todo' : undefined)) ? { taskState: input.taskState ?? old?.taskState ?? 'todo' } : {}),
      ...(input.verification ?? old?.verification ? { verification: input.verification ?? old?.verification } : {}),
      ...(input.legacyUnscoped ?? old?.legacyUnscoped ? { legacyUnscoped: true } : {}),
    };
    const substance = (e: MemoryEntry) => ({ section: e.section, text: e.text, taskState: e.taskState, epistemic: e.epistemic, origin: e.origin, sources: e.sources, validity: e.validity, verification: e.verification, legacyUnscoped: e.legacyUnscoped });
    if (old && canonical(substance(old)) === canonical(substance(entry))) {
      if (input.retain) changes.push({ type: 'retain', id, expectedRevision: old.revision });
      continue;
    }
    if (input.retain) entry.retention = { generation: projection.generation, grantId: operationId };
    validateEntry(entry);
    const change: JournalChange = { type: 'put', entry, expectedRevision: old?.revision ?? 0 };
    changes.push(change);
    // Scratch state only; final event remains one atomic batch.
    working = { ...working, entries: { ...working.entries, [id]: entry } };
  }
  if (!changes.length) return null;
  return { ...newEvent(projection, changes, operationId), at, requestFingerprint };
}
export type JournalAccess = { getBranch(): BranchEntry[]; getLeafId?(): string | null };
export type JournalAppender = { appendEntry(customType: string, data: unknown): void };
/** Synchronous public append/read-back is the critical section; no await can interleave it. */
export function appendTransaction(pi: JournalAppender, manager: JournalAccess, event: JournalEvent, reader?: ProjectionReader): { projection: JournalProjection; alreadyCommitted: boolean; warning?: string } {
  const read = (branch: BranchEntry[]) => reader ? reader.read(branch) : replayBranch(branch);
  const before = manager.getBranch(), projection = read(before);
  const expected = reduceEvent(projection, event);
  if (expected === projection) return { projection, alreadyCommitted: true };
  const leaf = before.at(-1)?.id ?? null;
  let failure: unknown;
  try { pi.appendEntry(JOURNAL_TYPE, event); } catch (error) { failure = error; }
  const after = manager.getBranch();
  const confirmed = after.find(entry => entry.type === 'custom' && entry.customType === JOURNAL_TYPE && (entry.data as JournalEvent)?.eventId === event.eventId);
  assert(confirmed && canonical(confirmed.data) === canonical(event), `append not confirmed${failure instanceof Error ? `: ${failure.message}` : ''}`);
  assert(confirmed!.parentId === leaf, 'unexpected branch/leaf changed during append; stop takeover');
  const actual = read(after);
  assert(actual.operations[event.operationId] === expected.operations[event.operationId], 'confirmed event cannot be replayed');
  return { projection: actual, alreadyCommitted: false, ...(failure ? { warning: 'Append reported an error, but the event was confirmed committed; do not repeat it.' } : {}) };
}

/** Success is derived from a real persisted compaction node, not a callback or model assertion. */
export function consumeCompaction(previous: JournalProjection, compactionId: string): JournalProjection {
  if (previous.compactions.includes(compactionId)) return previous;
  const next = structuredClone(previous);
  next.expiredIds = [];
  for (const entry of Object.values(next.entries)) if (entry.retention?.generation === next.generation) {
    next.expiredIds.push(entry.id); next.history.push(structuredClone(entry));
    delete entry.retention; entry.revision++;
  }
  next.compactions.push(compactionId); next.generation++; next.revision++; delete next.repair;
  return next;
}
export function nativeRequestFresh(projection: JournalProjection): boolean {
  const request = projection.native;
  if (!request) return false;
  const at = Date.parse(request.at);
  return Number.isFinite(at) && Date.now() - at <= request.ttlMs;
}
export interface ProjectionReader { read(branch: BranchEntry[]): JournalProjection }
/** Disposable derivation, never authority. Validate ALL relevant prefix contents on every read;
 * rebuild on forks/rewinds/mutation, and clone returns so callers cannot poison the next read.
 * Message projections are intentionally not cached: coverage/source checks still reread them. */
export class BranchProjector implements ProjectionReader {
  private keys: string[] = [];
  private projection = emptyProjection();
  readonly stats = { eventsApplied: 0, fullRebuilds: 0, cacheHits: 0 };
  read(branch: BranchEntry[]): JournalProjection {
    const relevant = branch.filter(entry => (entry.type === 'custom' && entry.customType === JOURNAL_TYPE) || (entry.type === 'compaction' && entry.id));
    const keys = relevant.map(entry => fingerprint({ type: entry.type, id: entry.id, parentId: entry.parentId,
      ...(entry.type === 'custom' ? { data: entry.data } : {}) }));
    const extendsPrefix = keys.length >= this.keys.length && this.keys.every((key, i) => key === keys[i]);
    if (extendsPrefix && keys.length === this.keys.length) { this.stats.cacheHits++; return structuredClone(this.projection); }
    let projection = extendsPrefix ? structuredClone(this.projection) : emptyProjection();
    if (!extendsPrefix) this.stats.fullRebuilds++;
    let applied = 0;
    for (const entry of relevant.slice(extendsPrefix ? this.keys.length : 0)) {
      projection = entry.type === 'custom' ? reduceEvent(projection, entry.data as JournalEvent) : consumeCompaction(projection, entry.id!);
      applied++;
    }
    // Install only after the complete suffix has validated; exceptions preserve the old cache.
    this.keys = keys; this.projection = structuredClone(projection); this.stats.eventsApplied += applied;
    return projection;
  }
}
export function replayBranch(branch: BranchEntry[]): JournalProjection {
  let projection = emptyProjection();
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === JOURNAL_TYPE) projection = reduceEvent(projection, entry.data as JournalEvent);
    else if (entry.type === 'compaction' && entry.id) projection = consumeCompaction(projection, entry.id);
  }
  return projection;
}

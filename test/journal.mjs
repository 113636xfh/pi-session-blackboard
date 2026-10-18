import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSummary } from '../build/summary.js';
import { emptyProjection, reduceEvent, replayEvents, toBoard, fingerprint, planCommit, appendTransaction, JOURNAL_TYPE, consumeCompaction, replayBranch } from '../build/journal.js';
export const entry = (id = 'm-1', text = 'Review only; not approved for changes') => ({
  id, revision: 1, section: 'goal', text, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  order: 1, validity: 'active', epistemic: 'stated', origin: 'user', sources: [], archived: false,
});
export const event = (changes, baseRevision = 0, id = `e-${baseRevision}`) => ({
  schema: 2, eventId: id, operationId: id, at: '2026-01-01T00:00:00Z', baseRevision, changes,
});
test('pure reducer replays identical events to identical projections without mutating inputs', () => {
  const initial = emptyProjection(), first = event([{ type: 'put', entry: entry(), expectedRevision: 0 }]);
  const before = JSON.stringify(initial), input = JSON.stringify(first);
  assert.deepEqual(replayEvents([first]), reduceEvent(initial, first));
  assert.equal(JSON.stringify(initial), before); assert.equal(JSON.stringify(first), input);
  assert.equal(toBoard(replayEvents([first])).sections.goal[0].text, entry().text);
});
test('event batch is atomic on schema, stale revision and duplicate target errors', () => {
  const initial = emptyProjection();
  for (const bad of [
    event([{ type: 'put', entry: entry(), expectedRevision: 0 }, { type: 'put', entry: entry('m-2'), expectedRevision: 1 }]),
    event([{ type: 'put', entry: { ...entry(), text: '' }, expectedRevision: 0 }]),
    { ...event([{ type: 'reset' }]), schema: 3 },
  ]) { assert.throws(() => reduceEvent(initial, bad)); assert.deepEqual(initial, emptyProjection()); }
});
test('entry updates preserve previous versions and do not conflate task or epistemic state', () => {
  const a = event([{ type: 'put', entry: { ...entry(), taskState: 'blocked', epistemic: 'hypothesis' }, expectedRevision: 0 }]);
  const b = event([{ type: 'put', entry: { ...entry(), revision: 2, text: 'Still blocked; not verified' }, expectedRevision: 1 }], 1);
  const projection = replayEvents([a, b]);
  assert.equal(projection.history[0].taskState, 'blocked');
  assert.equal(projection.history[0].epistemic, 'hypothesis');
  assert.equal(projection.entries['m-1'].revision, 2);
});
test('same operation is idempotent, but altered payload and stale base revisions are rejected', () => {
  const a = event([{ type: 'put', entry: entry(), expectedRevision: 0 }]);
  const projection = replayEvents([a]);
  assert.equal(reduceEvent(projection, { ...a, eventId: 'retry-id' }), projection);
  assert.throws(() => reduceEvent(projection, { ...a, changes: [{ type: 'reset' }] }), /reused/);
  assert.throws(() => reduceEvent(projection, event([{ type: 'reset' }], 0, 'other')), /stale/);
});
test('one planned batch creates stable IDs and rejects ambiguous or stale updates atomically', () => {
  const initial = emptyProjection();
  const inputs = [{ section: 'issues', text: 'Parser fails A.ts' }, { section: 'issues', text: 'Parser fails B.ts' }];
  const a = planCommit(initial, inputs, 'stable-operation', '2026-01-01');
  assert.equal(a.changes.length, 2);
  assert.deepEqual(a.changes.map(change => change.entry.id), planCommit(initial, inputs, 'stable-operation', '2026-01-02').changes.map(change => change.entry.id));
  const p = reduceEvent(initial, a);
  assert.equal(planCommit(p, inputs, 'stable-operation'), null);
  assert.throws(() => planCommit(p, [{ section: 'issues', text: 'different' }], 'stable-operation'), /reused/);
  assert.throws(() => planCommit(p, [{ section: 'issues', text: 'Fixed', supersedes: 'Parser fails' }], 'ambiguous'), /exactly one/);
  assert.throws(() => planCommit(p, [{ id: a.changes[0].entry.id, text: 'Fixed' }], 'stale'), /expectedRevision/);
});
test('append must be reread and confirmed; retry never appends twice', () => {
  const branch = [], manager = { getBranch: () => [...branch] };
  const pi = { appendEntry(customType, data) { branch.push({ id: `node-${branch.length}`, parentId: branch.at(-1)?.id ?? null, type: 'custom', customType, data }); } };
  const a = planCommit(emptyProjection(), [{ section: 'goal', text: 'Do not alter files' }], 'append-op');
  assert.equal(appendTransaction(pi, manager, a).alreadyCommitted, false);
  assert.equal(appendTransaction(pi, manager, a).alreadyCommitted, true);
  assert.equal(branch.length, 1); assert.equal(branch[0].customType, JOURNAL_TYPE);
  assert.throws(() => appendTransaction({ appendEntry() {} }, { getBranch: () => [] }, a), /not confirmed/);
});
test('append throwing after persistence reports committed instead of prompting duplication', () => {
  const branch = [], manager = { getBranch: () => branch };
  const a = planCommit(emptyProjection(), [{ section: 'goal', text: 'Synthetic goal' }], 'after-write');
  const result = appendTransaction({ appendEntry(customType, data) { branch.push({ id: 'node', parentId: null, type: 'custom', customType, data }); throw new Error('late failure'); } }, manager, a);
  assert(result.warning.includes('confirmed committed'));
  assert.equal(result.projection.revision, 1);
});

test('retention is one successful compaction only, recovered from branch even without callback', () => {
  const a = event([{ type: 'put', entry: entry(), expectedRevision: 0 }]);
  const granted = event([{ type: 'retain', id: 'm-1', expectedRevision: 1 }], 1);
  const p = replayEvents([a, granted]);
  const consumed = consumeCompaction(p, 'actual-success');
  assert.equal(consumed.entries['m-1'].retention, undefined);
  assert.equal(consumed.entries['m-1'].validity, 'active');
  assert.equal(consumed.entries['m-1'].updatedAt, p.entries['m-1'].updatedAt);
  assert.equal(consumeCompaction(consumed, 'actual-success'), consumed);
  assert.deepEqual(replayBranch([
    { type: 'custom', customType: JOURNAL_TYPE, data: a },
    { type: 'custom', customType: JOURNAL_TYPE, data: granted },
    { type: 'compaction', id: 'actual-success' },
  ]), consumed);
  const renewed = reduceEvent(consumed, event([{ type: 'retain', id: 'm-1', expectedRevision: 3 }], consumed.revision, 'renewed'));
  assert.equal(renewed.entries['m-1'].retention.generation, 1);
  assert.equal(renewed.entries['m-1'].updatedAt, entry().updatedAt);
});
test('protected entries precede ordinary time selection; impossible protected budgets are explicit', () => {
  const inputs = [{ section: 'goal', text: 'OLD CONSTRAINT', retain: true }, { section: 'next', text: 'NEW TASK' }];
  const p = reduceEvent(emptyProjection(), planCommit(emptyProjection(), inputs, 'protected', '2026-01-01'));
  const board = toBoard(p);
  assert(selectSummary(board).text.includes('OLD CONSTRAINT'));
  board.sections.goal[0].text = 'x'.repeat(10000) + ' NOT VERIFIED';
  assert.equal(selectSummary(board, { maxChars: 1000 }).reason, 'protected-over-budget');
});

test('fingerprints are deterministic across object property ordering', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.notEqual(fingerprint('A.ts'), fingerprint('a.ts'));
});

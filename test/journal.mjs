import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSummary } from '../build/summary.js';
import { emptyProjection, reduceEvent, replayEvents, toBoard, fingerprint, planCommit, appendTransaction, JOURNAL_TYPE, consumeCompaction, replayBranch, BranchProjector } from '../build/journal.js';
export const entry = (id = 'm-1', text = 'Review only; not approved for changes') => ({
  id, revision: 1, section: 'goal', text, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  order: 1, validity: 'active', epistemic: 'stated', origin: 'user', sources: [], archived: false,
});
export const event = (changes, baseRevision = 0, id = `e-${baseRevision}`) => ({
  schema: 2, eventId: id, operationId: id, at: '2026-01-01T00:00:00Z', baseRevision, changes,
});
test('incremental projection is full-replay equivalent and does not re-reduce old events', () => {
  const reader = new BranchProjector(), branch = [], manager = { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null };
  const pi = { appendEntry(customType, data) { branch.push({ type: 'custom', customType, data, id: `node-${branch.length}`, parentId: manager.getLeafId() }); } };
  for (let i = 0; i < 32; i++) {
    const inputs = [{ section: 'findings', text: `Measured fixture ${i}; not verified`, retain: i % 4 === 0 }];
    appendTransaction(pi, manager, planCommit(reader.read(branch), inputs, `increment-${i}`), reader);
    if (i % 4 === 3) branch.push({ type: 'compaction', id: `cut-${i}`, parentId: manager.getLeafId() });
    assert.deepEqual(reader.read(branch), replayBranch(branch));
  }
  assert.equal(reader.stats.eventsApplied, 40, '32 events + 8 persisted cuts, each applied once');
  const returned = reader.read(branch); returned.entries[Object.keys(returned.entries)[0]].text = 'poisoned'; returned.history.length = 0;
  assert.deepEqual(reader.read(branch), replayBranch(branch), 'returned data cannot mutate the private derivation');
});

test('incremental projection rebuilds on rewind, fork and in-place event mutation', () => {
  const reader = new BranchProjector();
  const a = { type: 'custom', customType: JOURNAL_TYPE, id: 'a', parentId: null, data: event([{ type: 'put', entry: entry(), expectedRevision: 0 }]) };
  const b = { type: 'custom', customType: JOURNAL_TYPE, id: 'b', parentId: 'a', data: event([{ type: 'put', entry: entry('m-2', 'Branch B'), expectedRevision: 0 }], 1, 'branch-b') };
  const c = { type: 'custom', customType: JOURNAL_TYPE, id: 'c', parentId: 'a', data: event([{ type: 'put', entry: entry('m-3', 'Branch C'), expectedRevision: 0 }], 1, 'branch-c') };
  assert.deepEqual(reader.read([a, b]), replayBranch([a, b]));
  assert.deepEqual(reader.read([a]), replayBranch([a]));
  assert.deepEqual(reader.read([a, c]), replayBranch([a, c]));
  const changed = structuredClone(a); changed.data.changes[0].entry.text = 'Changed journal content with same IDs';
  assert.deepEqual(reader.read([changed, c]), replayBranch([changed, c]));
  const malformed = { ...c, data: { ...c.data, baseRevision: 999 } };
  assert.throws(() => reader.read([changed, malformed]), /stale/);
  assert.deepEqual(reader.read([changed, c]), replayBranch([changed, c]), 'failed suffix never blesses an invalid cache');
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

test('manual gate is branch-local journal state: replay restores it, an earlier fork does not', () => {
  const off = event([{ type: 'gate', disabled: true }], 0, 'gate-off');
  const disabled = reduceEvent(emptyProjection(), off);
  assert.deepEqual(disabled.gate, { disabled: true, at: '2026-01-01T00:00:00Z' });
  const note = event([{ type: 'put', entry: entry(), expectedRevision: 0 }], disabled.revision, 'note');
  const withNote = reduceEvent(disabled, note);
  assert.equal(withNote.gate.disabled, true, 'ordinary commits never clear the knob');
  const on = reduceEvent(withNote, event([{ type: 'gate', disabled: false }], withNote.revision, 'gate-on'));
  assert.equal(on.gate, undefined, 're-enabling leaves no gate key behind');
  assert.equal(Object.keys(on.entries).length, 1, 'the knob never touches notes');

  const node = (id, parentId, data) => ({ type: 'custom', customType: JOURNAL_TYPE, id, parentId, data });
  assert.deepEqual(replayBranch([node('off', null, off), node('note', 'off', note)]), withNote, 'a resumed branch replays still disabled');
  const fork = event([{ type: 'put', entry: entry('m-9', 'Fork taken before the knob'), expectedRevision: 0 }], 0, 'fork');
  assert.equal(replayBranch([node('fork', null, fork)]).gate, undefined, 'a branch that never saw the knob stays enabled');
  assert.throws(() => reduceEvent(emptyProjection(), event([{ type: 'gate' }], 0, 'bad-gate')), /invalid gate/);
});

test('the disabled notice is recorded once per generation and survives replay', () => {
  const off = event([{ type: 'gate', disabled: true }], 0, 'gate-off');
  const told = event([{ type: 'gate-notice', generation: 0 }], 1, 'told-0');
  const toldAgain = event([{ type: 'gate-notice', generation: 1 }], 2, 'told-1');
  let p = reduceEvent(emptyProjection(), off);
  assert.equal(p.gateNotice, undefined, 'the knob alone never claims delivery');
  p = reduceEvent(p, told);
  assert.equal(p.gateNotice.generation, 0);
  p = reduceEvent(p, toldAgain);
  assert.equal(p.gateNotice.generation, 1, 'the newest generation is what a replay restores');
  const branch = [
    { type: 'custom', customType: JOURNAL_TYPE, id: 'a', parentId: null, data: off },
    { type: 'custom', customType: JOURNAL_TYPE, id: 'b', parentId: 'a', data: told },
    { type: 'custom', customType: JOURNAL_TYPE, id: 'c', parentId: 'b', data: toldAgain },
  ];
  assert.equal(replayBranch(branch).gateNotice.generation, 1, 'a resume replays the delivery record');
  assert.equal(replayBranch(branch.slice(0, 2)).gateNotice.generation, 0);
  assert.throws(() => reduceEvent(p, event([{ type: 'gate-notice', generation: 'x' }], 3, 'bad-notice')), /invalid gate notice generation/);
});

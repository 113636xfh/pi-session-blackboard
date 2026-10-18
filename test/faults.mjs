/** Fault injection and deterministic multi-round replay. No model, no network. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../build/index.js';
import { emptyProjection, planCommit, reduceEvent, replayBranch, newEvent, fingerprint } from '../build/journal.js';
import { commitWithCache, WriterLocks, atomicWrite } from '../build/storage.js';
import { migrateLegacy, inspectLegacy } from '../build/migration.js';
import { toBoard } from '../build/journal.js';
import { renderSummary } from '../build/summary.js';

function rig(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'sbb-fault-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': { boardDir: join(cwd, 'boards'), compaction: 'board', debugLog: true, ...options } }));
  const tools = {}, hooks = {}, commands = {};
  const branch = [{ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Synthetic project request' } }];
  let appendBehaviour = () => {};
  const manager = { getBranch: () => [...branch], getSessionId: () => 'fault', getLeafId: () => branch.at(-1)?.id, getCwd: () => cwd };
  extension({ on: (name, fn) => { hooks[name] = fn; }, registerTool: tool => { tools[tool.name] = tool; },
    registerCommand: (name, command) => { commands[name] = command; }, getActiveTools: () => ['blackboard', 'blackboard_recall'],
    setActiveTools: () => {},
    appendEntry: (type, data) => { appendBehaviour(type, data); branch.push({ id: `n-${branch.length}`, parentId: branch.at(-1)?.id ?? null, type: 'custom', customType: type, data }); } });
  const notices = [];
  const ctx = { cwd, sessionManager: manager, ui: { notify: (...args) => notices.push(args), confirm: async () => true } };
  const call = (params, id = `c-${branch.length}`) => tools.blackboard.execute(id, params, undefined, undefined, ctx);
  return { cwd, branch, manager, ctx, tools, hooks, commands, notices, call, setAppend: fn => { appendBehaviour = fn; } };
}

test('an unconfirmed append is an error and never silently advances state', async t => {
  const r = rig(t);
  r.setAppend(() => { throw new Error('disk full'); });
  await assert.rejects(() => r.call({ action: 'commit', entries: [{ section: 'goal', text: 'Should not land' }] }, 'broken-append'), /not confirmed/);
  assert.equal(replayBranch(r.branch).revision, 0);
  r.setAppend(() => {});
  await r.call({ action: 'commit', entries: [{ section: 'goal', text: 'Lands after recovery' }] });
  assert.equal(Object.keys(replayBranch(r.branch).entries).length, 1);
});

test('a cache write failure reports committed-with-warning instead of inviting a duplicate', t => {
  const r = rig(t);
  const blocker = join(r.cwd, 'blocked-file');
  writeFileSync(blocker, 'x');
  const event = planCommit(emptyProjection(), [{ section: 'goal', text: 'Committed despite cache' }], 'cache-op');
  const result = commitWithCache({ appendEntry: (type, data) => r.branch.push({ id: `n-${r.branch.length}`, parentId: r.branch.at(-1)?.id ?? null, type: 'custom', customType: type, data }) },
    r.manager, event, { path: join(blocker, 'nested', 'cache.json'), branchKey: 'root' });
  assert.match(result.warning, /Committed; cache pending rebuild/);
  assert.equal(result.projection.revision, 1);
  const retry = commitWithCache({ appendEntry: () => { throw new Error('must not append'); } }, r.manager, event);
  assert.equal(retry.alreadyCommitted, true);
});

test('a corrupt or missing derived cache never fabricates facts: state comes from events', async t => {
  const r = rig(t);
  await r.call({ action: 'commit', entries: [{ section: 'goal', text: 'Authoritative fact' }] });
  const cachePath = join(r.cwd, 'boards', 'cache.json');
  writeFileSync(cachePath, '{"schema":2,"projection":{"entries":{"bogus":{}}}}');
  const shown = await r.call({ action: 'show' });
  assert(shown.content[0].text.includes('Authoritative fact'));
  assert(!shown.content[0].text.includes('bogus'));
  rmSync(cachePath, { force: true });
  assert((await r.call({ action: 'show' })).content[0].text.includes('Authoritative fact'));
});

test('two writers cannot interleave: the second is refused, and a stale plan cannot be applied', async t => {
  const r = rig(t);
  const a = new WriterLocks(), b = new WriterLocks();
  t.after(() => { a.release(); b.release(); });
  a.acquire(r.cwd, 'fault');
  assert.throws(() => b.acquire(r.cwd, 'fault'), /Another blackboard writer/);
  a.release();
  const first = planCommit(emptyProjection(), [{ section: 'goal', text: 'First plan' }], 'op-1');
  const stale = planCommit(emptyProjection(), [{ section: 'goal', text: 'Second plan from the same revision' }], 'op-2');
  const applied = reduceEvent(emptyProjection(), first);
  assert.throws(() => reduceEvent(applied, stale), /stale/);
  assert.equal(Object.keys(applied.entries).length, 1);
});

test('an interrupted legacy migration is idempotent and keeps the verified backup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'boards'), { recursive: true });
  writeFileSync(join(dir, 'boards', 'fault.md'), '# Session Blackboard\n## Goal\n- [2026-01-01 00:00] LEGACY_GOAL\n');
  let projection = emptyProjection();
  // First attempt appends one event, then the process "dies" before the import marker.
  const append = event => { projection = reduceEvent(projection, event); return { projection }; };
  const report = inspectLegacy(join(dir, 'boards'), 'fault');
  assert.equal(report.inputs.length, 1);
  const plan = planCommit(emptyProjection(), [{ section: 'goal', text: 'LEGACY_GOAL', origin: 'legacy', epistemic: 'unknown', legacyUnscoped: true,
    sources: [{ entryId: `legacy:board.md`, fingerprint: report.records[0].hash, kind: 'legacy' }] }], 'partial');
  projection = reduceEvent(projection, plan);
  const done = migrateLegacy(join(dir, 'boards'), 'fault', projection, append);
  assert.equal(done.alreadyImported, false);
  assert(existsSync(join(done.backup, 'manifest.json')));
  assert.equal(readFileSync(join(dir, 'boards', 'fault.md'), 'utf8').includes('LEGACY_GOAL'), true);
  const again = migrateLegacy(join(dir, 'boards'), 'fault', done.projection, append);
  assert.equal(again.alreadyImported, true);
  assert.equal(again.count, 0);
});

test('eight compaction rounds stay deterministic and leak no retention grant', async t => {
  const r = rig(t);
  const summaries = [];
  for (let round = 0; round < 8; round++) {
    await r.call({ action: 'commit', entries: [
      { section: 'goal', text: `Round ${round} goal`, retain: true },
      { section: 'next', text: `Round ${round} step`, taskState: 'todo' },
    ] }, `round-${round}`);
    const before = replayBranch(r.branch);
    assert(Object.values(before.entries).some(entry => entry.retention?.generation === before.generation));
    const summary = renderSummary(toBoard(before), { maxChars: 6000 });
    assert(summary);
    summaries.push(summary);
    // A succeeded compaction is a persisted node; replay consumes exactly that generation.
    r.branch.push({ id: `comp-${round}`, parentId: r.branch.at(-1)?.id ?? null, type: 'compaction', summary: `round ${round}`, firstKeptEntryId: null, tokensBefore: 1 });
    const after = replayBranch(r.branch);
    assert.equal(after.generation, round + 1);
    assert.equal(Object.values(after.entries).filter(entry => entry.retention).length, 0, 'no grant survives its generation');
    assert.deepEqual(after.expiredIds.length, 1);
    assert.deepEqual(replayBranch(r.branch), after, 'replay is stable');
  }
  assert.equal(new Set(summaries).size, summaries.length, 'each round renders a distinct snapshot');
  assert.equal(replayBranch(r.branch).generation, 8);
  assert.equal(replayBranch(r.branch).compactions.length, 8);
});

test('replaying the same events in a different array identity yields identical output', () => {
  const events = [
    newEvent(emptyProjection(), [{ type: 'put', entry: { id: 'm-a', revision: 1, section: 'goal', text: 'A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', order: 1, validity: 'active', epistemic: 'stated', origin: 'assistant', sources: [], archived: false }, expectedRevision: 0 }], 'op-a'),
  ];
  const cloned = JSON.parse(JSON.stringify(events));
  const one = replayBranch(events.map((data, index) => ({ id: `x${index}`, type: 'custom', customType: 'sbb-event', data })));
  const two = replayBranch(cloned.map((data, index) => ({ id: `x${index}`, type: 'custom', customType: 'sbb-event', data })));
  assert.deepEqual(one, two);
  assert.equal(fingerprint(one), fingerprint(two));
});

test('atomic writes leave no temporary litter and never expose a half-written file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-atomic-'));
  atomicWrite(join(dir, 'nested', 'file.json'), '{"ok":true}');
  assert.equal(readFileSync(join(dir, 'nested', 'file.json'), 'utf8'), '{"ok":true}');
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['file.json']);
  rmSync(dir, { recursive: true, force: true });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, MODEL, config, save } from '../eval/protocol.mjs';
import { LONG_PROTOCOL, expectedState, longRound, longProbePrompt, evaluateLongAnswer } from '../eval/long-protocol.mjs';
import { assertAuthorizedSpec } from '../eval/long-auth.mjs';
import { supervise } from '../eval/process.mjs';
import { verifyLongCase } from '../eval/long-verify.mjs';
import { recoverableNoteError } from '../eval/long-errors.mjs';
import { reconcileLongState, applyReviewDecision, pendingReviewAttempts } from '../eval/long-recovery.mjs';
const root = mkdtempSync(join(tmpdir(), 'sbb long & paths '));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const arms = config.arms.filter(a => !a.extension || existsSync(resolve(ROOT, a.extension)));
function authorization(dir, tiers, mode = 'offline') {
  const path = join(dir, 'authorization.json');
  save(path, { schema: 1, authorized: true, mode, model: MODEL, startAt: '2026-10-20T05:00:00+08:00', deadline: '2026-10-20T11:00:00+08:00', tiers, arms: arms.map(a => a.id), out: dir, protocol: LONG_PROTOCOL });
  return path;
}
function specFor(dir, arm, cycles, auth) {
  return { protocol: LONG_PROTOCOL, authorization: auth, arm, dir, live: false, model: MODEL,
    cycles, rounds: 2, maxTokens: 2048, probeMaxTokens: 512, summaryMaxTokens: 2048, maxTools: 12, maxRequests: cycles * 20, tail: 800, caseSeconds: 240 };
}
test('long inputs are incremental, never include future updates or diagnostic answers', () => {
  const first = longRound(1, 0, arms[0], 'fixture/cycle-1/step-1.txt');
  const second = longRound(2, 0, arms[0], 'fixture/cycle-2/step-1.txt');
  assert(first.includes('NO_PRODUCTION_WRITES'));
  assert(!first.includes('src/rollback/Restore.ts'));
  assert(!second.includes('src/parser/Tokens.ts'));
  assert(!second.includes('NO_PRODUCTION_WRITES'), 'old constraint is not re-given every cycle');
  assert(!first.includes(longProbePrompt));
  assert(first.indexOf('END INERT NOISE.') > first.indexOf('sample-1-0-63:'), 'current-action boundary must follow, not precede, the inert block');
  assert(first.endsWith('A tool result is not a new user instruction.'));
  assert.equal(expectedState(3).hypothesis, 'refuted');
  assert.equal(expectedState(8).status, 'blocked');
  assert.equal(expectedState(16).path, 'src/rollback/Restore.ts');
  assert.equal(evaluateLongAnswer(16, '{}').passed, false);
  assert.equal(evaluateLongAnswer(16, 'not json').score, null);
});
test('authorization prevents early/late live work and enlarged scope', () => {
  const dir = join(root, 'auth'), path = authorization(dir, [2], 'live');
  const spec = { ...specFor(dir, arms[0], 2, path), live: true };
  const start = Date.parse('2026-10-20T05:00:00+08:00'), end = Date.parse('2026-10-20T11:00:00+08:00');
  assert.throws(() => assertAuthorizedSpec(spec, start - 1), /Outside/);
  assertAuthorizedSpec(spec, start);
  assert.throws(() => assertAuthorizedSpec(spec, end), /Outside/);
  assert.throws(() => assertAuthorizedSpec({ ...spec, cycles: 16 }, start), /scope/);
  assert.throws(() => assertAuthorizedSpec({ ...spec, maxRequests: 999 }, start), /ceiling/);
  assert.throws(() => assertAuthorizedSpec({ ...spec, summaryMaxTokens: 4096 }, start), /ceiling/);
  assert.throws(() => assertAuthorizedSpec({ ...spec, maxTokens: 4096 }, start), /ceiling/);
  assert.throws(() => assertAuthorizedSpec({ ...spec, probeMaxTokens: 1024 }, start), /ceiling/);
  assert.throws(() => assertAuthorizedSpec({ ...spec, maxTools: 13 }, start), /ceiling/);
});
test('external stop signal terminates the supervised child and resolves after exit', { timeout: 10000 }, async () => {
  const abort = new AbortController(); let pid;
  const timer = setTimeout(() => abort.abort(), 300);
  const result = await supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, timeoutMs: 5000, signal: abort.signal, onSpawn: child => { pid = child.pid; } });
  clearTimeout(timer); assert(result.stopped); assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
test('scheduled Node argv entry works from unrelated ampersand cwd; expired live entry starts no worker', { timeout: 60000 }, async () => {
  const out = join(root, 'launcher-proof'), auth = join(out, 'authorization.json'), now = Date.now();
  const manifest = { schema: 1, authorized: true, mode: 'offline', model: MODEL,
    startAt: new Date(now - 1000).toISOString(), deadline: new Date(now + 120000).toISOString(),
    tiers: [2], arms: ['native'], out, protocol: LONG_PROTOCOL };
  save(auth, manifest);
  const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/scheduled.mjs'), auth, join(out, 'launch.log')], { cwd: root, timeoutMs: 45000 });
  assert.equal(execution.code, 0, execution.output);
  const state = json(join(out, 'state.json'));
  assert.equal(state.status, 'stage-completed'); assert.equal(state.cases.length, 1); assert(state.cases[0].executionPassed);
  const restored = reconcileLongState({ ...structuredClone(state), cases: [] }, auth);
  assert.equal(restored.cases.length, 1, 'crash after successful attempt accounting must not spend again');
  const recovered = reconcileLongState({ ...structuredClone(state), cases: [], attempts: [], active: { ...state.attempts[0] } }, auth);
  assert.equal(recovered.attempts.length, 1); assert.equal(recovered.cases.length, 1, 'terminal parent verification reconciles an active attempt');
  const expired = join(root, 'expired'), expiredAuth = join(expired, 'authorization.json');
  save(expiredAuth, { ...manifest, mode: 'live', out: expired, startAt: new Date(now - 120000).toISOString(), deadline: new Date(now - 1000).toISOString() });
  const refused = await supervise(process.execPath, [resolve(ROOT, 'eval/overnight.mjs'), '--manifest', expiredAuth], { cwd: root, timeoutMs: 10000 });
  assert.equal(refused.code, 1);
  const ended = json(join(expired, 'state.json'));
  assert.equal(ended.status, 'expired'); assert.equal(ended.attempts.length, 0);
});

test('note error allowlist never treats I/O or unknown exceptions as model-correctable', () => {
  const error = value => ({ content: [{ type: 'text', text: value }] });
  assert(recoverableNoteError('blackboard', error('Blackboard journal: supersedes must match exactly one active entry')));
  assert(recoverableNoteError('blackboard', error('Validation failed for tool "blackboard":\n  - entries.1.section: must be equal to constant')));
  assert(!recoverableNoteError('blackboard', error('Validation failed for tool "blackboard":\n  - EIO unexpected I/O error')));
  for (const value of ['EIO disk failure', 'Blackboard journal: append not confirmed', 'TypeError: internal bug']) assert(!recoverableNoteError('blackboard', error(value)));
});
test('recovery accounts partial requests, preserves review across restart, requires explicit retry', () => {
  const dir = join(root, 'partial'); save(join(dir, 'progress.json'), { modelCalls: 7, completedCycles: 1, wallMs: 123 });
  let state = reconcileLongState({ cases: [], attempts: [], active: { id: 'partial', arm: 'native', cycles: 2, dir } }, '/no-authority-needed-for-uncompleted-fixture');
  assert.equal(state.attempts[0].modelCalls, 7); assert.equal(state.reviewAttempt, 'partial');
  state = reconcileLongState(state, '/no-authority-needed-for-uncompleted-fixture');
  assert.equal(state.attempts.length, 1); assert.equal(state.reviewAttempt, 'partial');
  assert.equal(applyReviewDecision(state, { attempt: 'partial', action: 'stop' }, ''), 'stop');
  assert.equal(state.reviewAttempt, 'partial', 'stop is not retry authorization');
  assert.throws(() => applyReviewDecision(state, { attempt: 'partial', action: 'retry' }, ''), /confirmedNoWorker/);
  applyReviewDecision(state, { attempt: 'partial', action: 'retry', confirmedNoWorker: true }, '');
  assert.equal(state.reviewAttempt, null);
  assert.equal(reconcileLongState(state, '').reviewAttempt, null, 'one explicit retry decision survives a restart');
});
test('controller restart stays at pending review instead of silently issuing new calls', { timeout: 20000 }, async () => {
  const out = join(root, 'pending-review'), auth = join(out, 'authorization.json'), now = Date.now();
  save(auth, { schema: 1, authorized: true, mode: 'offline', model: MODEL, startAt: new Date(now - 1000).toISOString(), deadline: new Date(now + 60000).toISOString(), tiers: [2], arms: ['native'], out, protocol: LONG_PROTOCOL });
  save(join(out, 'state.json'), { schema: 1, stage: 47, cases: [], sourceVersions: [], active: null,
    attempts: [{ id: 'failed-before-review-save', arm: 'native', cycles: 2, dir: join(out, 'failed'), executionPassed: false, modelCalls: 3 }] });
  for (let restart = 0; restart < 2; restart++) {
    const timer = setInterval(() => {
      try {
        const state = json(join(out, 'state.json'));
        if (state.status === 'needs-review') save(join(out, 'control.json'), { attempt: state.reviewAttempt, action: 'stop' });
      } catch { /* startup */ }
    }, 100);
    try {
      const result = await supervise(process.execPath, [resolve(ROOT, 'eval/overnight.mjs'), '--manifest', auth], { cwd: root, timeoutMs: 8000 });
      assert.equal(result.code, 1, result.output);
      const state = json(join(out, 'state.json'));
      assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0].modelCalls, 3); assert.equal(state.reviewAttempt, 'failed-before-review-save');
    } finally { clearInterval(timer); }
  }
});
test('multiple pending reviews must ALL be decided before any new worker', { timeout: 12000 }, async () => {
  const out = join(root, 'multiple-review'), auth = join(out, 'authorization.json'), now = Date.now();
  save(auth, { schema: 1, authorized: true, mode: 'offline', model: MODEL, startAt: new Date(now - 1000).toISOString(), deadline: new Date(now + 60000).toISOString(), tiers: [2], arms: ['native', 'board-fixed'], out, protocol: LONG_PROTOCOL });
  const seed = { schema: 1, stage: 47, cases: [], sourceVersions: [], active: null, attempts: [
    { id: 'a', arm: 'native', cycles: 2, dir: join(out, 'a'), executionPassed: false, modelCalls: 3 },
    { id: 'b', arm: 'board-fixed', cycles: 2, dir: join(out, 'b'), executionPassed: false, modelCalls: 4 },
  ] };
  const pure = reconcileLongState(structuredClone(seed), auth);
  assert.equal(pendingReviewAttempts(pure).length, 2);
  applyReviewDecision(pure, { attempt: 'a', action: 'retry' }, auth);
  assert.equal(pure.reviewAttempt, 'b');
  save(join(out, 'state.json'), seed);
  const timer = setInterval(() => { try {
    const s = json(join(out, 'state.json'));
    if (s.status === 'needs-review') save(join(out, 'control.json'), { attempt: s.reviewAttempt, action: s.reviewAttempt === 'a' ? 'retry' : 'stop' });
  } catch {} }, 100);
  try {
    const result = await supervise(process.execPath, [resolve(ROOT, 'eval/overnight.mjs'), '--manifest', auth], { cwd: root, timeoutMs: 9000 });
    assert.equal(result.code, 1, result.output);
    const s = json(join(out, 'state.json'));
    assert.equal(s.reviewAttempt, 'b'); assert.equal(s.attempts.length, 2, 'review a cannot authorize an unreviewed rerun of b or launch before b is decided');
  } finally { clearInterval(timer); }
});
for (const fault of ['probe-load', 'probe-init', 'probe-bind', 'probe-transport', 'probe-evidence-io', 'note-eio', 'probe-bad-json', 'probe-wrong-state']) {
  test(`long ${fault}: execution errors cannot masquerade as low-quality successful execution`, { timeout: 45000 }, async () => {
    const out = join(root, fault), auth = authorization(out, [2]);
    const arm = fault === 'note-eio' ? arms.find(a => a.id === 'board-fixed') : arms[0];
    const spec = { ...specFor(join(out, arm.id), arm, 2, auth), fixtureFault: fault }, path = join(out, 'spec.json'); save(path, spec);
    const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', path], { cwd: root, timeoutMs: 35000 });
    const row = json(join(spec.dir, 'result.json')), v = verifyLongCase(spec, row), qualityOnly = ['probe-bad-json', 'probe-wrong-state'].includes(fault);
    assert.equal(v.executionPassed, qualityOnly, JSON.stringify(v.issues));
    assert.equal(v.qualityPassed, false);
    assert.equal(execution.code, qualityOnly ? 0 : 1);
    if (!qualityOnly) assert.equal(row.completedCycles, 0, 'no additional generation may start after execution failure');
    if (['probe-load', 'probe-init', 'probe-bind'].includes(fault)) assert.equal(row.requests.filter(r => r.kind === 'probe').length, 0, 'setup errors cannot start a probe request');
  });
}

test('real SDK note schema mistakes self-correct within the original phase budgets', { timeout: 45000 }, async () => {
  const out = join(root, 'note-validation'), auth = authorization(out, [2]), arm = arms.find(a => a.id === 'board-fixed');
  const spec = { ...specFor(join(out, arm.id), arm, 2, auth), fixtureFault: 'note-validation' }, path = join(out, 'spec.json'); save(path, spec);
  const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', path], { cwd: root, timeoutMs: 35000 });
  const row = json(join(spec.dir, 'result.json')), v = verifyLongCase(spec, row);
  assert.equal(execution.code, 0, execution.output); assert(v.executionPassed, JSON.stringify(v.issues));
  assert(row.toolErrors.length > 0); assert(row.toolErrors.every(e => recoverableNoteError(e.tool, e.result)));
  assert.equal(row.completedCycles, 2); assert.equal(row.offlineNetworkCalls, 0);
});
for (const cycles of [2, 16]) {
  test(`long-state ${cycles} cycles: real SDK forks, no probe writes to main, all available arms`, { timeout: 850000 }, async () => {
    const out = join(root, `cycles-${cycles}`), auth = authorization(out, [cycles]);
    for (const arm of arms) {
      const spec = specFor(join(out, arm.id), arm, cycles, auth), path = join(out, `${arm.id}-spec.json`); save(path, spec);
      const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', path], { cwd: root, timeoutMs: 250000 });
      assert.equal(execution.code, 0, `${arm.id}: ${execution.output}`);
      const row = json(join(spec.dir, 'result.json')), verification = verifyLongCase(spec, row);
      assert.equal(verification.executionPassed, true, JSON.stringify(verification.issues));
      assert.equal(verification.diagnostics.length, cycles);
      assert.equal(row.offlineNetworkCalls, 0);
      assert.equal(row.requests.filter(r => r.kind === 'probe').length, cycles);
      assert(row.requests.every(r => r.completed));
      assert(row.requests.every(r => r.maxTokens === (r.kind === 'probe' ? 512 : 2048)), 'agent/summary caps must not reduce tool arguments to the probe cap');
      assert(!verifyLongCase(spec, { ...row, completedCycles: 999 }).executionPassed);
    }
  });
}

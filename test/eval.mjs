/** No live calls: same supervisor, loader, worker, compaction and persistence as the live smoke. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ROOT, MODEL, config, parse, preflight, save, classify, sumKnown, systemPrompt, roundPrompt } from '../eval/protocol.mjs';
import { supervise, main } from '../eval/nightly.mjs';
import { readContinuation, resumeOptions } from '../eval/continuation.mjs';
import { verifyCase } from '../eval/verify.mjs';
import { receiptMatches } from '../eval/preflight.mjs';
const fixtureRoot = mkdtempSync(join(tmpdir(), 'sbb eval & paths '));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('live is explicit, unknown arguments fail closed, small-batch ceiling and exact rounds', () => {
  assert.equal(parse([]).live, false);
  assert.equal(parse([]).rounds, 2);
  assert.throws(() => parse(['--help']), /Unknown/);
  assert.throws(() => parse(['--model', MODEL]), /requires --live/);
  assert.throws(() => parse(['--live']), /explicitly pin/);
  assert.throws(() => parse(['--live', '--model', MODEL, '--total-seconds', '601']), /ceiling/);
  assert.throws(() => parse(['--live', '--model', MODEL, '--case-seconds', '201']), /ceiling/);
  assert.throws(() => parse(['--task', 'typo']), /Unknown task/);
  assert.throws(() => parse(['--arm', 'typo']), /Unknown/);
  assert.throws(() => parse(['--rounds', 'NaN']), /Invalid/);
  assert.throws(() => parse(['--live', '--model', MODEL, '--cycles', '2']), /ceiling/);
  assert.equal(parse(['--cycles', '16']).maxRequests, 320);
  assert.throws(() => parse(['--cycles', '3']), /Supported cycles/);
  assert(!systemPrompt(config.arms[0]).includes('blackboard'));
  assert(!systemPrompt(config.arms[1]).includes('action=review'));
  assert(systemPrompt(config.arms[2]).includes('Entry objects must contain only section and text'));
  assert(systemPrompt(config.arms[2]).includes('Never invent source or credential IDs'));
  const nativePrompt = roundPrompt(config.tasks.at(-1), 0, config.arms[0]);
  assert(nativePrompt.includes('Do not create a notes file'));
  assert(!nativePrompt.includes('Commit concise notes'));
});

test('repair-and-retest ledger retains failed attempts within the original cumulative cap', () => {
  const ledger = json(resolve(ROOT, 'eval/smoke-evidence-20261019.json'));
  const seconds = ledger.attempts.reduce((sum, attempt) => sum + attempt.wallSeconds, 0);
  const requests = ledger.attempts.reduce((sum, attempt) => sum + attempt.runtimeRequests, 0);
  assert(Math.abs(seconds - ledger.observedCumulativeWallSeconds) < 0.001);
  assert(seconds <= ledger.authorizedCumulativeWallSeconds);
  assert.equal(requests, ledger.costAccounting.runtimeObservedRequests);
  assert.equal(ledger.completedCases.length, 3);
  assert(ledger.attempts.length > ledger.completedCases.length, 'failed attempts must not be hidden by success-only accounting');
  assert.equal(ledger.costAccounting.monetaryCostCNY, null);
  assert.equal(ledger.costAccounting.independentlyMeteredGPUSeconds, null);
});

test('failed, missing and interrupted evidence is not success; unknown counts stay unknown', () => {
  assert.equal(classify({ status: 'passed', passed: true }, 0, null, false), 'passed');
  assert.equal(classify(null, 0, null, false), 'failed');
  assert.equal(classify({ status: 'passed', passed: true }, 1, null, false), 'error');
  assert.equal(classify({ status: 'passed', passed: true }, 0, null, true), 'timeout');
  assert.equal(sumKnown([{ modelCalls: null }], 'modelCalls'), null);
});

test('preflight receipts reject stale code/runtime, incomplete coverage and failed executions', () => {
  const current = { digest: 'current', env: { node: process.version } };
  const receipt = { schema: 1, passed: true, offlineOnly: true, ...current, testedArms: ['native', 'board-fixed'], execution: { code: 0, timedOut: false } };
  assert(receiptMatches(receipt, current, ['native']));
  assert(!receiptMatches(receipt, current, ['board-prefix']));
  assert(!receiptMatches(receipt, { ...current, digest: 'changed' }, ['native']));
  assert(!receiptMatches(receipt, { ...current, env: { node: 'other' } }, ['native']));
  assert(!receiptMatches({ ...receipt, execution: { code: 1, timedOut: false } }, current, ['native']));
  assert(!receiptMatches({ ...receipt, offlineOnly: false }, current, ['native']));
});

test('Windows batch launcher from unrelated cwd safely quotes ampersand path', { skip: process.platform !== 'win32' }, () => {
  const command = `""${resolve(ROOT, 'eval/nightly.cmd')}" --dry-run"`;
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: fixtureRoot, encoding: 'utf8', timeout: 5000, windowsHide: true, windowsVerbatimArguments: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.options.live, false);
  assert.equal(plan.root, ROOT);
});

test('atomic artifacts survive repeated replacement', () => {
  const path = join(fixtureRoot, 'replace.json');
  for (let i = 0; i < 30; i++) save(path, { i });
  assert.deepEqual(json(path), { i: 29 });
  assert(!readdirSync(fixtureRoot).some(name => name.endsWith('.tmp')));
});

test('spawn errors and hung children are bounded and leave no running process', { timeout: 10000 }, async () => {
  const failed = await supervise(join(fixtureRoot, 'missing-executable'), [], { cwd: fixtureRoot, timeoutMs: 1000 });
  assert(failed.launchError);
  let pid;
  const hung = await supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: fixtureRoot, timeoutMs: 250, onSpawn: child => { pid = child.pid; },
  });
  assert(hung.timedOut);
  assert(hung.wallMs < 5000);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('caller callback failures and tree-kill failures cannot orphan the child', { timeout: 10000 }, async () => {
  let callbackPid, fallbackPid;
  const setup = await supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: fixtureRoot, timeoutMs: 3000, onSpawn: child => { callbackPid = child.pid; throw new Error('injected report write failure'); },
  });
  assert.match(setup.setupError, /report write failure/);
  assert.throws(() => process.kill(callbackPid, 0), /ESRCH/);
  const fallback = await supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: fixtureRoot, timeoutMs: 250, onSpawn: child => { fallbackPid = child.pid; }, killTree: () => { throw new Error('injected taskkill failure'); },
  });
  assert(fallback.timedOut);
  assert.throws(() => process.kill(fallbackPid, 0), /ESRCH/);
});

test('three-arm full offline chain from unrelated cwd, paths with spaces and ampersand', { timeout: 90000 }, async t => {
  const available = config.arms.filter(arm => !arm.extension || existsSync(resolve(ROOT, arm.extension)));
  if (available.length !== 3) t.diagnostic('Old git worktree is optional in CI; test all locally available arms.');
  const out = join(fixtureRoot, 'chain');
  const result = await supervise(process.execPath, [resolve(ROOT, 'eval/nightly.mjs'), '--arm', available.map(a => a.id).join(','),
    '--case-seconds', '25', '--total-seconds', '80', '--out', out], { cwd: fixtureRoot, timeoutMs: 85000 });
  assert.equal(result.code, 0, result.output);
  const report = json(join(out, 'report.json'));
  assert.equal(report.passed, true);
  assert.match(report.harnessDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.rows.length, available.length);
  for (const row of report.rows) {
    assert.equal(row.completedRounds, 2);
    assert.equal(row.completedCycles, 1);
    assert.equal(row.verification.passed, true);
    assert.equal(row.execution.command, process.execPath);
    assert.equal(row.execution.args[0], resolve(ROOT, 'eval/run.mjs'));
    assert.equal(row.offlineNetworkCalls, 0);
    assert.equal(row.compactions, 1);
    assert.equal(row.partial.phase, 'resume');
    assert(row.requests.every(r => r.completed));
    const settings = json(join(out, row.arm, 'settings.json'));
    assert.equal(settings.compaction.keepRecentTokens, 800);
    assert.equal(settings.compaction.enabled, false);
    if (row.arm === 'native') { assert.equal(row.summaryCalls, 1); assert(row.toolTrail.every(e => e.tool === 'write')); }
    else { assert.equal(row.summaryCalls, 0); assert.equal(row.takeovers, 1); }
    if (row.arm === 'board-prefix') assert(row.toolTrail.every(e => e.action !== 'review'));
    assert(existsSync(join(out, row.arm, 'project/fixture/step-2.txt')));
    assert(!existsSync(join(out, row.arm, 'project/fixture/step-3.txt')));
  }
  // A worker PASS is insufficient: independently validate real files and session nodes.
  const nativeDir = join(out, 'native'), spec = json(join(nativeDir, 'spec.json'));
  const original = json(join(nativeDir, 'result.json'));
  assert(verifyCase(spec, original).passed);
  assert(!verifyCase(spec, { ...original, completedRounds: 99 }).passed);
  const fixture = join(nativeDir, 'project/fixture/step-2.txt'), savedFixture = readFileSync(fixture, 'utf8');
  writeFileSync(fixture, 'tampered');
  assert(!verifyCase(spec, original).passed, 'script-generated false green cannot hide wrong output');
  writeFileSync(fixture, savedFixture);
  const compactPath = join(nativeDir, 'cycles/1/compaction.json'), savedCompact = readFileSync(compactPath, 'utf8');
  save(compactPath, { ...JSON.parse(savedCompact), summary: 'fabricated summary' });
  assert(!verifyCase(spec, original).passed, 'detached artifact is not persisted compaction evidence');
  writeFileSync(compactPath, savedCompact);
  // Never overwrite a previous run or let stale artifacts turn a failed rerun green.
  const reused = await supervise(process.execPath, [resolve(ROOT, 'eval/nightly.mjs'), '--out', out], { cwd: fixtureRoot, timeoutMs: 5000 });
  assert.notEqual(reused.code, 0);
  assert.match(reused.output, /reuse output/);
  t.diagnostic(`Offline evidence: ${out}`);
});

test('first worker request-limit failure stops the matrix before another arm starts', { timeout: 20000 }, async () => {
  const out = join(fixtureRoot, 'fail-fast');
  const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/nightly.mjs'), '--max-requests', '1', '--out', out], { cwd: fixtureRoot, timeoutMs: 18000 });
  assert.notEqual(execution.code, 0);
  const report = json(join(out, 'report.json'));
  assert.equal(report.passed, false);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].modelCalls, 1);
  assert(!existsSync(join(out, 'board-prefix')));
});

for (const [index, cycles] of [2, 4, 8, 16].entries()) {
  test(`offline ${cycles} REAL persisted compaction/resume cycles across arms`, { timeout: 590000 }, async () => {
    const available = config.arms.filter(a => !a.extension || existsSync(resolve(ROOT, a.extension)));
    const out = join(fixtureRoot, `cycles-${cycles}`), caseSeconds = Math.max(30, cycles * 10), totalSeconds = caseSeconds * available.length + 5;
    const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/nightly.mjs'), '--arm', available.map(a => a.id).join(','),
      '--cycles', String(cycles), '--task', config.tasks[index].id, '--case-seconds', String(caseSeconds), '--total-seconds', String(totalSeconds), '--out', out], { cwd: fixtureRoot, timeoutMs: (totalSeconds + 5) * 1000 });
    assert.equal(execution.code, 0, execution.output);
    const report = json(join(out, 'report.json'));
    assert.equal(report.rows.length, available.length);
    for (const row of report.rows) {
      assert.equal(row.completedCycles, cycles);
      assert.equal(row.compactions, cycles);
      assert.equal(row.completedRounds, cycles * 2);
      assert.equal(row.verification.passed, true);
      assert.equal(row.offlineNetworkCalls, 0);
      assert.equal(new Set(row.cycles.map(c => c.compactionId)).size, cycles);
      assert(row.requests.every(r => r.completed));
    }
  });
}

test('continuation reruns only failed groups, rechecks successes and charges every attempt', { timeout: 60000 }, async () => {
  const out = join(fixtureRoot, 'continuation-first'), next = join(fixtureRoot, 'continuation-second');
  const available = config.arms.filter(a => !a.extension || existsSync(resolve(ROOT, a.extension)));
  const first = await main(['--arm', available.map(a => a.id).join(','), '--out', out, '--case-seconds', '25', '--total-seconds', '80'], {
    execute: (command, args, options) => args.at(-1).includes('board-fixed')
      ? Promise.resolve({ code: 1, signal: null, timedOut: false, launchError: 'injected worker startup failure', wallMs: 0, output: '' })
      : supervise(command, args, options),
  });
  assert.equal(first, 1);
  const previousPath = join(out, 'report.json'), before = readFileSync(previousPath, 'utf8');
  const history = readContinuation(previousPath);
  assert(history.spentMs > 0);
  const second = await main(['--resume', previousPath, '--out', next]);
  assert.equal(second, 0);
  const report = json(join(next, 'report.json'));
  assert.equal(report.rows.filter(r => !r.reusedFrom).length, 1);
  assert.equal(report.rows.at(-1).arm, 'board-fixed');
  assert(report.cumulativeWallMs >= history.spentMs + report.wallMs);
  assert.equal(readFileSync(previousPath, 'utf8'), before, 'failed history remains immutable');
  const liveHistory = { ...history, report: { ...history.report, options: { ...history.report.options, live: true, model: MODEL } } };
  assert.throws(() => resumeOptions(parse([]), ['--resume', previousPath], liveHistory), /explicit/);
  assert.throws(() => resumeOptions(parse([]), ['--task', 'hypothesis'], history), /cannot change/);
  const unfinished = join(fixtureRoot, 'unfinished-report.json'); save(unfinished, { ...history.report, finalized: false });
  assert.throws(() => readContinuation(unfinished), /finalized/);
});

for (const fault of ['tool-loop', 'model-error', 'extra-write', 'hang']) {
  test(`real SDK fake ${fault}: cannot pass or issue unbounded requests`, { timeout: 45000 }, async () => {
    const options = parse(['--arm', 'native']);
    preflight(options);
    const dir = join(fixtureRoot, fault), specPath = join(dir, 'spec.json');
    save(specPath, { ...options, dir, arm: config.arms[0], fixtureFault: fault, maxTools: fault === 'extra-write' ? 6 : 1 });
    const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', specPath], {
      // Include bounded SDK cold-import time; the hang must actually reach its provider.
      cwd: fixtureRoot, timeoutMs: fault === 'hang' ? 30000 : 35000,
    });
    const partial = json(join(dir, 'progress.json'));
    assert(partial.modelCalls <= 2);
    if (fault === 'hang') {
      assert(execution.timedOut);
      assert.equal(partial.completedRounds, 0);
      assert.equal(partial.modelCalls, 1, 'a startup timeout is not an exercised provider hang');
      assert.equal(partial.requests[0].completed, false);
    } else {
      assert.notEqual(execution.code, 0, execution.output);
      assert.equal(json(join(dir, 'result.json')).passed, false);
      if (fault === 'extra-write') {
        assert.match(json(join(dir, 'result.json')).reason, /outside the requested fixture/);
        assert(!existsSync(join(dir, 'project/fixture/blackboard.md')));
      }
    }
  });
}

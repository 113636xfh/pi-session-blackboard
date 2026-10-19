/** No live calls: same supervisor, loader, worker, compaction and persistence as the live smoke. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ROOT, MODEL, config, parse, preflight, save, classify, sumKnown, systemPrompt, roundPrompt } from '../eval/protocol.mjs';
import { supervise } from '../eval/nightly.mjs';
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
  assert(!systemPrompt(config.arms[0]).includes('blackboard'));
  assert(!systemPrompt(config.arms[1]).includes('action=review'));
  const nativePrompt = roundPrompt(config.tasks.at(-1), 0, config.arms[0]);
  assert(nativePrompt.includes('Do not create a notes file'));
  assert(!nativePrompt.includes('Commit concise notes'));
});

test('failed, missing and interrupted evidence is not success; unknown counts stay unknown', () => {
  assert.equal(classify({ status: 'passed', passed: true }, 0, null, false), 'passed');
  assert.equal(classify(null, 0, null, false), 'failed');
  assert.equal(classify({ status: 'passed', passed: true }, 1, null, false), 'error');
  assert.equal(classify({ status: 'passed', passed: true }, 0, null, true), 'timeout');
  assert.equal(sumKnown([{ modelCalls: null }], 'modelCalls'), null);
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

for (const fault of ['tool-loop', 'model-error', 'extra-write', 'hang']) {
  test(`real SDK fake ${fault}: cannot pass or issue unbounded requests`, { timeout: 20000 }, async () => {
    const options = parse(['--arm', 'native']);
    preflight(options);
    const dir = join(fixtureRoot, fault), specPath = join(dir, 'spec.json');
    save(specPath, { ...options, dir, arm: config.arms[0], fixtureFault: fault, maxTools: fault === 'extra-write' ? 6 : 1 });
    const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', specPath], {
      cwd: fixtureRoot, timeoutMs: fault === 'hang' ? 8000 : 15000,
    });
    const partial = json(join(dir, 'progress.json'));
    assert(partial.modelCalls <= 2);
    if (fault === 'hang') {
      assert(execution.timedOut);
      assert.equal(partial.completedRounds, 0);
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

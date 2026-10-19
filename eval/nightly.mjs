/** Foreground-only bounded smoke supervisor. Offline by default; no scheduler. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, parse, preflight, save, classify, sumKnown } from './protocol.mjs';

export async function supervise(command, args, { cwd, timeoutMs, onSpawn = () => {} }) {
  return new Promise(resolveResult => {
    const start = Date.now();
    let timedOut = false, stopped = false, output = '', launchError = null;
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      stopped = true;
      // Workers have no process-launch tool; still kill the tree on Windows for signal cleanup.
      if (child.pid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true });
      else child.kill('SIGKILL');
    };
    onSpawn(child);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const interrupted = () => stop();
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    const capture = chunk => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => { launchError = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      resolveResult({ command, args, cwd, code, signal, timedOut, stopped, launchError, wallMs: Date.now() - start, output });
    });
  });
}

export async function main(argv) {
  const options = parse(argv), arms = preflight(options);
  if (existsSync(options.out)) throw new Error(`Refusing to reuse output directory: ${options.out}`);
  const harnessDigest = createHash('sha256').update(['protocol.mjs', 'nightly.mjs', 'run.mjs', 'config.json']
    .map(name => `${name}\n${readFileSync(resolve(ROOT, 'eval', name), 'utf8')}`).join('\n')).digest('hex');
  const plan = { schema: 2, kind: 'wiring-smoke-not-benchmark', options, arms, root: ROOT, harnessDigest,
    launch: { executable: process.execPath, shell: false, worker: resolve(ROOT, 'eval/run.mjs') } };
  if (options.dryRun) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  const lock = resolve(ROOT, 'eval/results/live-smoke.lock');
  let lockFd;
  try {
  if (options.live) {
    mkdirSync(resolve(ROOT, 'eval/results'), { recursive: true });
    lockFd = openSync(lock, 'wx'); // A stale lock is an inspection boundary, never auto-stolen.
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, out: options.out }));
  }
  mkdirSync(options.out, { recursive: true });
  // First artifact precedes any model work, not just the first completed round.
  save(join(options.out, 'plan.json'), plan);
  const start = Date.now(), rows = [];
  const finish = () => save(join(options.out, 'report.json'), { ...plan, wallMs: Date.now() - start, rows,
    passed: rows.length === arms.length && rows.every(row => row.status === 'passed'),
    modelCalls: sumKnown(rows, 'modelCalls'), summaryCalls: sumKnown(rows, 'summaryCalls') });
  finish();
  for (const arm of arms) {
    const remaining = options.totalSeconds * 1000 - (Date.now() - start);
    if (remaining <= 0) break;
    const dir = join(options.out, arm.id);
    mkdirSync(dir);
    const spec = { ...options, arm, dir };
    const specPath = join(dir, 'spec.json'); save(specPath, spec);
    console.log(`START ${arm.id} ${options.task} ${options.rounds} rounds (${options.live ? 'LIVE' : 'OFFLINE'})`);
    const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', specPath], {
      cwd: ROOT, timeoutMs: Math.min(remaining, options.caseSeconds * 1000),
    });
    let row = null;
    try { row = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); } catch { /* missing is failure, never success */ }
    const status = classify(row, execution.code, execution.signal, execution.timedOut);
    let partial = null;
    try { partial = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8')); } catch { /* failed during startup */ }
    const recorded = { arm: arm.id, ...row, status, execution, partial };
    rows.push(recorded); finish();
    console.log(`END ${arm.id}: ${status}, ${(execution.wallMs / 1000).toFixed(1)}s; requests=${row?.modelCalls ?? partial?.modelCalls ?? 'unknown'}`);
    // Fail fast: never spend another arm's GPU budget after an error.
    if (status !== 'passed') break;
  }
  finish();
  console.log(`report: ${join(options.out, 'report.json')}`);
  return rows.length === arms.length && rows.every(row => row.status === 'passed') ? 0 : 1;
  } finally {
    if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock, { force: true }); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

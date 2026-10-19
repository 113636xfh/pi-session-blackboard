/** Foreground bounded supervisor, mandatory offline gate, independently verified continuation. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, parse, preflight, save, classify, sumKnown } from './protocol.mjs';
import { supervise } from './process.mjs';
import { verifyCase } from './verify.mjs';
import { ensurePreflight } from './preflight.mjs';
import { readContinuation, resumeOptions, reusableRows, caseSignature } from './continuation.mjs';
export { supervise } from './process.mjs';

export async function main(argv, { execute = supervise } = {}) {
  let options = parse(argv);
  const previous = options.resume ? readContinuation(options.resume) : null;
  if (previous) options = resumeOptions(options, argv, previous);
  if (options.live && execute !== supervise) throw new Error('Live execution cannot use a test executor');
  const arms = preflight(options), spentMs = previous?.spentMs ?? 0;
  if (existsSync(options.out)) throw new Error(`Refusing to reuse output directory: ${options.out}`);
  const harnessDigest = createHash('sha256').update(['protocol.mjs', 'nightly.mjs', 'run.mjs', 'process.mjs', 'verify.mjs', 'preflight.mjs', 'continuation.mjs', 'config.json']
    .map(name => `${name}\n${readFileSync(resolve(ROOT, 'eval', name), 'utf8')}`).join('\n')).digest('hex');
  const plan = { schema: 3, kind: 'wiring-smoke-not-benchmark', options, arms, root: ROOT, harnessDigest,
    parent: previous ? { path: previous.path, digest: previous.digest } : null,
    budget: { capMs: options.totalSeconds * 1000, previousSpentMs: spentMs },
    launch: { executable: process.execPath, shell: false, worker: resolve(ROOT, 'eval/run.mjs') },
    preflightRequired: options.live };
  if (options.dryRun) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  if (spentMs >= plan.budget.capMs) throw new Error('Cumulative budget exhausted before worker launch');
  const lock = resolve(ROOT, 'eval/results/live-smoke.lock');
  let lockFd;
  try {
    if (options.live) {
      mkdirSync(resolve(ROOT, 'eval/results'), { recursive: true });
      lockFd = openSync(lock, 'wx');
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, out: options.out }));
      // Never discover orchestration bugs on the GPU. Offline CPU preflight is not
      // charged as live-provider time; its own process deadline remains bounded.
      plan.preflight = await ensurePreflight(arms.map(a => a.id));
    }
    const { reused, rejected } = reusableRows(previous, options, arms);
    plan.reuseRejected = rejected;
    mkdirSync(options.out, { recursive: true });
    save(join(options.out, 'plan.json'), plan);
    const start = Date.now(), rows = [];
    let fatal = null;
    const finish = finalized => save(join(options.out, 'report.json'), { ...plan, finalized, wallMs: Date.now() - start,
      cumulativeWallMs: spentMs + Date.now() - start, rows, infrastructureError: fatal,
      passed: !fatal && rows.length === arms.length && rows.every(row => row.status === 'passed'),
      modelCalls: sumKnown(rows, 'modelCalls'), summaryCalls: sumKnown(rows, 'summaryCalls'),
      cumulativeModelCalls: sumKnown([...(previous?.attemptRows ?? []), ...rows.filter(r => !r.reusedFrom)]
        .map(r => ({ count: r.modelCalls ?? r.partial?.modelCalls ?? null })), 'count'),
      note: previous ? 'Continuation with preserved failed attempts; not a frozen-revision A/B.' : 'Wiring only; no semantic benchmark score.' });
    finish(false);
    try {
      for (const arm of arms) {
        if (reused.has(arm.id)) {
          rows.push(reused.get(arm.id)); finish(false); console.log(`REUSE ${arm.id}: reverified persisted evidence`); continue;
        }
        const remaining = plan.budget.capMs - spentMs - (Date.now() - start);
        if (remaining <= 0) { fatal = 'cumulative budget exhausted'; break; }
        const dir = join(options.out, arm.id); mkdirSync(dir);
        const spec = { ...options, arm, dir }, specPath = join(dir, 'spec.json'); save(specPath, spec);
        console.log(`START ${arm.id} ${options.task} ${options.rounds} rounds/cycle × ${options.cycles} cycles (${options.live ? 'LIVE' : 'OFFLINE'})`);
        const execution = await execute(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', specPath], {
          cwd: ROOT, timeoutMs: Math.min(remaining, options.caseSeconds * 1000),
        });
        let row = null, partial = null;
        try { row = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); } catch { /* missing is not success */ }
        try { partial = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8')); } catch { /* startup failure */ }
        const verification = row?.passed === true ? verifyCase(spec, row) : null;
        const reportedStatus = classify(row, execution.code, execution.signal, execution.timedOut);
        const status = execution.stopped || execution.setupError || (reportedStatus === 'passed' && !verification?.passed)
          ? (execution.timedOut ? 'timeout' : 'error') : reportedStatus;
        const failureKind = execution.timedOut ? 'budget' : execution.launchError || execution.setupError ? 'infrastructure'
          : execution.stopped ? 'interrupted' : verification && !verification.passed ? 'evidence-infrastructure' : row?.failureKind ?? (status === 'passed' ? null : 'runtime-unclassified');
        rows.push({ arm: arm.id, ...row, status, passed: status === 'passed', failureKind, verification, execution, partial, specPath, caseSignature: caseSignature(options, arm) });
        finish(false);
        console.log(`END ${arm.id}: ${status}, ${(execution.wallMs / 1000).toFixed(1)}s; requests=${row?.modelCalls ?? partial?.modelCalls ?? 'unknown'}`);
        if (status !== 'passed') break; // Diagnose/fix before --resume; do not silently retry.
      }
    } catch (error) { fatal = error.message; finish(true); throw error; }
    finish(true);
    console.log(`report: ${join(options.out, 'report.json')}`);
    return !fatal && rows.length === arms.length && rows.every(row => row.status === 'passed') ? 0 : 1;
  } finally {
    if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock, { force: true }); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`INFRASTRUCTURE/PREFLIGHT: ${error.message}`); process.exitCode = 1; }
}

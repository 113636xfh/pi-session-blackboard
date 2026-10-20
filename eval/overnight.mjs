/** One authorized, foreground long-run controller. Never enlarges a window or edits code. */
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ROOT, preflight, save } from './protocol.mjs';
import { readAuthorization } from './long-auth.mjs';
import { supervise } from './process.mjs';
import { ensurePreflight, fingerprint } from './preflight.mjs';
import { verifyLongCase } from './long-verify.mjs';
import { reconcileLongState, applyReviewDecision } from './long-recovery.mjs';
import { randomUUID } from 'node:crypto';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
export async function runOvernight(path) {
  const authorization = resolve(path), m = readAuthorization(authorization);
  mkdirSync(m.out, { recursive: true });
  const statePath = join(m.out, 'state.json'), controlPath = join(m.out, 'control.json'), stopPath = join(m.out, 'STOP');
  const authorizationDigest = createHash('sha256').update(readFileSync(authorization)).digest('hex');
  let state = existsSync(statePath) ? read(statePath) : { schema: 1, stage: 47, cases: [], attempts: [], sourceVersions: [], status: 'waiting' };
  if (state.authorizationDigest && state.authorizationDigest !== authorizationDigest) throw new Error('Authorization changed; cannot silently reset a long-run window');
  if (state.pid && state.pid !== process.pid && alive(state.pid)) throw new Error(`Controller already alive: ${state.pid}`);
  let oldProgress = null;
  try { if (state.active) oldProgress = read(join(state.active.dir, 'progress.json')); } catch { /* unknown requires review */ }
  const oldPid = state.active?.pid ?? oldProgress?.pid;
  if (oldPid && alive(oldPid)) throw new Error(`Previous worker may still be alive: ${oldPid}; inspect before resuming`);
  state = reconcileLongState(state, authorization);
  state = { ...state, pid: process.pid, authorization, authorizationDigest, startAt: m.startAt, deadline: m.deadline, mode: m.mode };
  let heartbeat, lockFd, activeAbort, interrupted = false;
  const onInterrupt = () => { interrupted = true; activeAbort?.abort(); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  const lock = resolve(ROOT, 'eval/results/live-smoke.lock');
  const persist = () => save(statePath, { ...state, updatedAt: new Date().toISOString(), windowSpentMs: Math.max(0, Date.now() - m.start) });
  const log = message => { const line = `${new Date().toISOString()} ${message}\n`; console.log(line.trim()); appendFileSync(join(m.out, 'controller.log'), line); };
  const stopRequested = () => interrupted || existsSync(stopPath) || Date.now() >= m.end;
  const stopStatus = () => interrupted || existsSync(stopPath) ? 'stopped' : 'expired';
  const waitReview = async attempt => {
    state.status = 'needs-review'; state.reviewAttempt = attempt.id; persist();
    log(`NEEDS_REVIEW ${attempt.id}; no further model request until agent acknowledges`);
    while (!stopRequested()) {
      if (existsSync(controlPath)) {
        const command = read(controlPath);
        let progress = null; try { progress = read(join(attempt.dir, 'progress.json')); } catch { /* unresolved requires explicit confirmation */ }
        if (attempt.recovered && (attempt.workerPid ?? progress?.pid) && alive(attempt.workerPid ?? progress.pid)) throw new Error('Recovered worker is still alive; refuse another attempt');
        const action = applyReviewDecision(state, command, authorization);
        if (action) { persist(); rmSync(controlPath); return action; }
      }
      persist(); await sleep(1000);
    }
    return 'stop';
  };
  const drainReviews = async () => {
    while (state.reviewAttempt && !stopRequested()) {
      const pending = state.attempts.find(a => a.id === state.reviewAttempt);
      if (!pending) throw new Error('Pending review has no accounted attempt');
      if (await waitReview(pending) === 'stop') return false;
    }
    return !stopRequested();
  };
  try {
    persist();
    while (Date.now() < m.start && !interrupted && !existsSync(stopPath)) { state.status = 'waiting'; persist(); await sleep(Math.min(30000, m.start - Date.now())); }
    if (stopRequested()) { state.status = stopStatus(); persist(); return 1; }
    if (m.mode === 'live') {
      mkdirSync(resolve(ROOT, 'eval/results'), { recursive: true }); lockFd = openSync(lock, 'wx');
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, out: m.out, authorization, deadline: m.deadline }));
    }
    if (!await drainReviews()) { state.status = Date.now() >= m.end ? 'expired' : 'stopped'; persist(); return 1; }
    const arms = preflight({ arms: m.arms });
    persist();
    for (const cycles of m.tiers) {
      if (cycles > 4 && [2, 4].some(n => !m.arms.every(id => state.cases.some(c => c.cycles === n && c.arm === id && c.executionPassed)))) {
        state.status = 'blocked-expansion'; state.reason = 'All selected arms must execute 2 and 4 cycles before 8/16'; persist(); return 1;
      }
      for (const arm of arms) {
        if (state.cases.some(c => c.cycles === cycles && c.arm === arm.id && (c.executionPassed || c.acknowledged))) continue;
        let retry = true;
        while (retry && !stopRequested()) {
          retry = false;
          if (!await drainReviews()) { state.status = Date.now() >= m.end ? 'expired' : 'stopped'; persist(); return 1; }
          if (state.cases.some(c => c.cycles === cycles && c.arm === arm.id && (c.executionPassed || c.acknowledged))) break;
          state.status = 'preflight'; persist();
          const receipt = m.mode === 'live' ? await ensurePreflight(m.arms) : { digest: fingerprint().digest, offline: true };
          if (!state.sourceVersions.some(v => v.digest === receipt.digest)) state.sourceVersions.push(receipt);
          if (stopRequested()) break;
          const id = `${cycles}-${arm.id}-${state.attempts.length + 1}-${randomUUID().slice(0, 8)}`, dir = join(m.out, 'attempts', id);
          if (existsSync(dir)) throw new Error(`Refusing to reuse attempt output ${dir}`);
          mkdirSync(dir, { recursive: true });
          const remaining = m.end - Date.now();
          const currentArm = preflight({ arms: [arm.id] })[0];
          const spec = { protocol: m.protocol, authorization, task: 'long-state', live: m.mode === 'live', model: m.model,
            arm: currentArm, dir, cycles, rounds: 2, tail: 800, maxTokens: 512, summaryMaxTokens: 2048, maxTools: 6, maxRequests: cycles * 20,
            caseSeconds: m.mode === 'live' ? Math.min(remaining / 1000, 120 + cycles * 240) : Math.min(remaining / 1000, 30 + cycles * 15) };
          const specPath = join(dir, 'spec.json'); save(specPath, spec);
          state.status = 'running'; state.active = { id, cycles, arm: arm.id, dir, sourceDigest: receipt.digest, startedAt: new Date().toISOString(), pid: null }; persist();
          log(`START ${id} ${m.mode}, remaining ${(remaining / 1000).toFixed(1)}s`);
          activeAbort = new AbortController();
          heartbeat = setInterval(() => {
            try {
              if (stopRequested()) activeAbort.abort();
              let progress = null; try { progress = read(join(dir, 'progress.json')); } catch { /* startup */ }
              if (progress) state.active.progress = { cycle: progress.cycle, phase: progress.phase, completedCycles: progress.completedCycles, completedRounds: progress.completedRounds, modelCalls: progress.modelCalls, toolErrorCount: progress.toolErrorCount, fatal: progress.fatal };
              persist();
            } catch (error) { activeAbort.abort(); state.lastInfrastructureError = error.message; }
          }, 2000);
          let execution;
          try {
            execution = await supervise(process.execPath, [resolve(ROOT, 'eval/run.mjs'), '--worker', specPath], {
              cwd: ROOT, timeoutMs: Math.max(1, Math.min(remaining, spec.caseSeconds * 1000)), signal: activeAbort.signal,
              onSpawn: child => { state.active.pid = child.pid ?? null; persist(); },
            });
          } finally { clearInterval(heartbeat); heartbeat = null; activeAbort = null; }
          let row = null, progress = null;
          try { row = read(join(dir, 'result.json')); } catch { /* unknown is not zero */ }
          try { progress = read(join(dir, 'progress.json')); } catch { /* startup */ }
          const verification = row?.executionPassed ? verifyLongCase(spec, row) : null;
          const executionPassed = execution.code === 0 && !execution.stopped && !execution.setupError && verification?.executionPassed === true;
          const attempt = { id, cycles, arm: arm.id, dir, specPath, sourceDigest: receipt.digest,
            execution, executionPassed, qualityPassed: verification?.qualityPassed ?? false, verification,
            modelCalls: row?.modelCalls ?? progress?.modelCalls ?? null, completedCycles: row?.completedCycles ?? progress?.completedCycles ?? 0,
            status: executionPassed ? 'completed' : execution.timedOut ? 'timeout' : 'needs-review' };
          save(join(dir, 'parent-verification.json'), attempt);
          state.attempts.push(attempt); state.active = null;
          if (executionPassed) state.cases.push({ id, cycles, arm: arm.id, dir, executionPassed, qualityPassed: attempt.qualityPassed });
          else state.reviewAttempt = attempt.id;
          persist();
          log(`END ${id} execution=${executionPassed} quality=${attempt.qualityPassed} calls=${attempt.modelCalls ?? 'unknown'}`);
          if (!executionPassed) {
            if (stopRequested()) break;
            const decision = await waitReview(attempt);
            if (decision === 'retry') retry = true;
            else if (decision === 'stop') { state.status = 'stopped'; persist(); return 1; }
          }
          persist();
        }
        if (stopRequested()) { state.status = stopStatus(); persist(); return 1; }
      }
    }
    state.status = 'stage-completed'; state.executionPassed = m.tiers.every(n => m.arms.every(a => state.cases.some(c => c.cycles === n && c.arm === a && c.executionPassed)));
    persist(); log(`STAGE47_FINISHED execution=${state.executionPassed}; agent must review before marking plan step`);
    return state.executionPassed ? 0 : 1;
  } catch (error) {
    activeAbort?.abort(); state.status = 'controller-error'; state.lastInfrastructureError = error.stack ?? error.message;
    try { persist(); log(`CONTROLLER_ERROR ${error.message}`); } catch { console.error(error); }
    return 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock, { force: true }); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--manifest') throw new Error('Usage: node eval/overnight.mjs --manifest <authorization.json>');
    process.exitCode = await runOvernight(process.argv[3]);
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

/** Crash/review reconciliation; restarting is never permission to retry. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyLongCase } from './long-verify.mjs';
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export function verifiedSavedAttempt(attempt, authorization) {
  const spec = read(join(attempt.dir, 'spec.json')), row = read(join(attempt.dir, 'result.json'));
  if (!spec || spec.authorization !== authorization || spec.arm.id !== attempt.arm || spec.cycles !== attempt.cycles) return null;
  const verification = verifyLongCase(spec, row);
  return verification.executionPassed ? { spec, row, verification } : null;
}
function addCase(state, attempt, ok) {
  state.cases = state.cases.filter(c => !(c.cycles === attempt.cycles && c.arm === attempt.arm));
  state.cases.push({ id: attempt.id, cycles: attempt.cycles, arm: attempt.arm, dir: attempt.dir,
    executionPassed: ok, qualityPassed: ok && attempt.qualityPassed === true, ...(!ok ? { acknowledged: true } : {}) });
}
export function pendingReviewAttempts(state) {
  return state.attempts.filter(a => !a.executionPassed
    && !state.decisions?.some(d => d.attempt === a.id && d.action !== 'stop')
    && !state.cases.some(c => c.id === a.id && c.acknowledged));
}
export function reconcileLongState(state, authorization) {
  state.decisions ??= [];
  // A crash between recording an attempt and its case projection cannot spend again.
  for (const attempt of state.attempts.filter(a => a.executionPassed)) {
    const verified = verifiedSavedAttempt(attempt, authorization);
    if (verified) { attempt.qualityPassed = verified.verification.qualityPassed; addCase(state, attempt, true); }
    else {
      attempt.executionPassed = false; attempt.recoveryReason = 'Previously passed evidence no longer verifies';
      for (const c of state.cases.filter(c => c.id === attempt.id)) c.executionPassed = false;
      state.reviewAttempt ??= attempt.id;
    }
  }
  const active = state.active;
  if (active && !state.attempts.some(a => a.id === active.id)) {
    const parent = read(join(active.dir, 'parent-verification.json'));
    if (parent?.id === active.id && parent.executionPassed && verifiedSavedAttempt(parent, authorization)) {
      state.attempts.push(parent); addCase(state, parent, true);
    } else {
      const row = read(join(active.dir, 'result.json')), progress = read(join(active.dir, 'progress.json'));
      const attempt = { ...active, recovered: true, status: 'needs-review', executionPassed: false,
        modelCalls: row?.modelCalls ?? progress?.modelCalls ?? null,
        completedCycles: row?.completedCycles ?? progress?.completedCycles ?? 0,
        workerPid: active.pid ?? progress?.pid ?? null,
        execution: { code: null, wallMs: progress?.wallMs ?? null, recovered: true },
        recoveryReason: 'Parent stopped before terminal accounting; outcome/exit status must be reviewed' };
      attempt.canAcceptComplete = !!verifiedSavedAttempt(attempt, authorization);
      state.attempts.push(attempt); state.reviewAttempt ??= attempt.id;
    }
  }
  for (const attempt of state.attempts.filter(a => !a.executionPassed)) {
    const decided = state.decisions.some(d => d.attempt === attempt.id && d.action !== 'stop');
    const acknowledged = state.cases.some(c => c.id === attempt.id && c.acknowledged);
    if (!decided && !acknowledged) state.reviewAttempt ??= attempt.id;
  }
  // Preserve an existing pending review across every restart, including acknowledged stop.
  state.active = null;
  return state;
}
export function applyReviewDecision(state, command, authorization) {
  const attempt = state.attempts.find(a => a.id === state.reviewAttempt);
  if (!attempt || command.attempt !== attempt.id || !['retry', 'accept-failure', 'accept-complete', 'stop'].includes(command.action)) return null;
  if (attempt.recovered && command.action !== 'stop' && command.confirmedNoWorker !== true) throw new Error('Recovered attempt requires explicit confirmedNoWorker after checking PID/processes');
  if (command.action === 'accept-complete') {
    const saved = verifiedSavedAttempt(attempt, authorization);
    if (!saved) throw new Error('Cannot accept incomplete or invalid execution evidence');
    attempt.executionPassed = true; attempt.qualityPassed = saved.verification.qualityPassed; attempt.acceptedRecovery = true; addCase(state, attempt, true);
  } else if (command.action === 'accept-failure') addCase(state, attempt, false);
  else if (command.action === 'retry') state.cases = state.cases.filter(c => !(c.cycles === attempt.cycles && c.arm === attempt.arm));
  state.decisions.push({ attempt: attempt.id, action: command.action, at: new Date().toISOString(), confirmedNoWorker: command.confirmedNoWorker === true });
  // Stop is not retry authorization. Keep the pending review so reopening stays paused.
  if (command.action !== 'stop') state.reviewAttempt = pendingReviewAttempts(state)[0]?.id ?? null;
  return command.action;
}

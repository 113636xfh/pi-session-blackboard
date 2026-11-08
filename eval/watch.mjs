/** Read-only progress watcher. Exits promptly on intervention boundaries. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAuthorization } from './long-auth.mjs';
const args = process.argv.slice(2), path = args[args.indexOf('--manifest') + 1];
if (!args.includes('--manifest') || !path) throw new Error('Expected --manifest <path>');
const m = readAuthorization(path), startOnly = args.includes('--until-start');
const seconds = args.includes('--seconds') ? Number(args[args.indexOf('--seconds') + 1]) : 90;
if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid wait duration');
const end = startOnly ? Math.min(m.end, m.start + 180000) : Date.now() + seconds * 1000;
let previous = null;
while (true) {
  let state = null;
  if (existsSync(join(m.out, 'state.json'))) state = JSON.parse(readFileSync(join(m.out, 'state.json'), 'utf8'));
  const compact = state ? { status: state.status, updatedAt: state.updatedAt, pid: state.pid, deadline: state.deadline,
    completedCases: state.cases.length, attempts: state.attempts.length, active: state.active,
    reason: state.reason ?? state.lastInfrastructureError ?? null, reviewAttempt: state.reviewAttempt ?? null,
    last: state.attempts.at(-1) ? { id: state.attempts.at(-1).id, executionPassed: state.attempts.at(-1).executionPassed, qualityPassed: state.attempts.at(-1).qualityPassed } : null }
    : { status: 'not-started', now: new Date().toISOString(), startAt: m.startAt, deadline: m.deadline };
  const signature = JSON.stringify({ status: compact.status, active: compact.active?.id, completed: compact.completedCases });
  const urgent = ['needs-review', 'controller-error', 'blocked-expansion', 'stage-completed', 'expired', 'stopped'].includes(compact.status) || compact.active?.progress?.fatal;
  const started = compact.active?.progress?.modelCalls > 0;
  if (urgent || (startOnly && started) || (!startOnly && previous !== null && signature !== previous) || Date.now() >= end || seconds === 0) {
    console.log(JSON.stringify(compact, null, 2)); break;
  }
  previous ??= signature;
  await new Promise(r => setTimeout(r, 1000));
}

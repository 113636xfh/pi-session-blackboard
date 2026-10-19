/** Case-level continuation: immutable ancestors, shared budget, reverified successes. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config, systemPrompt, roundPrompt, resumePrompt, parse } from './protocol.mjs';
import { verifyCase } from './verify.mjs';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function caseSignature(options, arm) {
  const task = config.tasks.find(t => t.id === options.task);
  return digest({ task, rounds: options.rounds, cycles: options.cycles ?? 1, live: options.live, model: options.model ?? null,
    tail: options.tail, maxTokens: options.maxTokens, maxTools: options.maxTools, maxRequests: options.maxRequests,
    arm: { id: arm.id, sourceDigest: arm.sourceDigest ?? null, compaction: arm.compaction },
    system: systemPrompt(arm), resumePrompt, prompts: Array.from({ length: options.rounds }, (_, r) => roundPrompt(task, r, arm, 1, options.cycles ?? 1)) });
}
export function readContinuation(path, seen = new Set()) {
  const absolute = resolve(path);
  if (seen.has(absolute)) throw new Error('Continuation history contains a cycle');
  seen.add(absolute);
  const raw = readFileSync(absolute, 'utf8'), report = JSON.parse(raw);
  if (report.schema !== 3 || report.finalized !== true || report.root !== ROOT) throw new Error('Resume requires a finalized schema-3 report from this workspace; inspect interrupted workers before recovery');
  if (!Number.isFinite(report.wallMs) || report.wallMs < 0) throw new Error('Cannot verify previous budget usage');
  let prior = null;
  if (report.parent) {
    prior = readContinuation(report.parent.path, seen);
    if (prior.digest !== report.parent.digest) throw new Error('Previous report changed; cannot verify continuation budget');
  }
  return { path: absolute, digest: digest(raw), report, spentMs: (prior?.spentMs ?? 0) + report.wallMs,
    attemptRows: [...(prior?.attemptRows ?? []), ...report.rows.filter(row => !row.reusedFrom)],
    chain: [...(prior?.chain ?? []), { path: absolute, digest: digest(raw), wallMs: report.wallMs }] };
}
export function resumeOptions(cli, argv, previous) {
  const allowed = ['--resume', '--out', '--case-seconds', '--dry-run', '--live', '--model'];
  if (argv.some(token => token.startsWith('--') && !allowed.includes(token))) throw new Error('A continuation cannot change task/model/rounds/arms/cycles or total budget');
  const original = previous.report.options;
  if (original.live && (!cli.live || cli.model !== original.model)) throw new Error('Live continuation requires explicit --live and the same --model; saved files are not authorization');
  if (!original.live && cli.live) throw new Error('Cannot turn an offline run into live continuation');
  const caseSeconds = argv.includes('--case-seconds') ? cli.caseSeconds : original.caseSeconds;
  if (original.live && caseSeconds > original.caseSeconds) throw new Error('Cannot increase a live case limit during continuation');
  if (original.tail !== 800 || original.maxTokens !== 512 || typeof original.live !== 'boolean') throw new Error('Saved protocol is incompatible');
  const checked = parse(['--arm', original.arms.join(','), '--task', original.task, '--rounds', String(original.rounds),
    '--cycles', String(original.cycles), '--total-seconds', String(original.totalSeconds), '--case-seconds', String(caseSeconds),
    '--max-tools', String(original.maxTools), '--max-requests', String(original.maxRequests), '--out', cli.out,
    ...(original.live ? ['--live', '--model', original.model] : []), ...(cli.dryRun ? ['--dry-run'] : [])]);
  return { ...checked, resume: previous.path };
}
export function reusableRows(previous, options, arms) {
  const reused = new Map(), rejected = [];
  if (!previous) return { reused, rejected };
  for (const arm of arms) {
    const row = previous.report.rows.find(r => r.arm === arm.id && r.status === 'passed');
    if (!row) continue;
    if (row.caseSignature !== caseSignature(options, arm)) { rejected.push({ arm: arm.id, why: 'effective protocol or arm source changed' }); continue; }
    try {
      const spec = JSON.parse(readFileSync(row.specPath, 'utf8'));
      if (caseSignature(spec, spec.arm) !== row.caseSignature) throw new Error('saved spec changed');
      const verification = verifyCase(spec, row);
      if (!verification.passed) throw new Error(verification.issues.join('; '));
      reused.set(arm.id, { ...row, verification, reusedFrom: row.reusedFrom ?? previous.path });
    } catch (error) { rejected.push({ arm: arm.id, why: error.message }); }
  }
  return { reused, rejected };
}

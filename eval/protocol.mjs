/** Shared, offline-testable smoke protocol. This is not a benchmark scorer. */
import { existsSync, mkdirSync, renameSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.json' with { type: 'json' };
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MODEL = 'strata/qwen3.8-flash-next-iq3_s';
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, path); break; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } finally { rmSync(tmp, { force: true }); }
}
export function parse(argv) {
  const result = { live: false, dryRun: false, arms: config.arms.map(a => a.id), task: 'path-fidelity', rounds: 2,
    totalSeconds: 600, caseSeconds: 200, maxTools: 6, maxRequests: 20, tail: 800, maxTokens: 512 };
  const names = { '--arm': 'arms', '--task': 'task', '--rounds': 'rounds', '--total-seconds': 'totalSeconds',
    '--case-seconds': 'caseSeconds', '--max-tools': 'maxTools', '--max-requests': 'maxRequests', '--model': 'model', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--live') { result.live = true; continue; }
    if (flag === '--dry-run') { result.dryRun = true; continue; }
    const key = names[flag];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}`);
    const value = argv[++i];
    result[key] = key === 'arms' ? value.split(',') : ['task', 'model', 'out'].includes(key) ? value : Number(value);
  }
  for (const key of ['rounds', 'totalSeconds', 'caseSeconds', 'maxTools', 'maxRequests']) {
    if (!Number.isInteger(result[key]) || result[key] < 1) throw new Error(`Invalid ${key}`);
  }
  if (!config.tasks.some(t => t.id === result.task)) throw new Error(`Unknown task: ${result.task}`);
  if (!result.arms.length || new Set(result.arms).size !== result.arms.length || result.arms.some(id => !config.arms.some(a => a.id === id))) throw new Error('Unknown or duplicate arm');
  if (result.model && !result.live) throw new Error('--model requires --live; no implicit live execution');
  if (result.live && result.model !== MODEL) throw new Error(`Live smoke must explicitly pin --model ${MODEL}`);
  if (result.live && (result.totalSeconds > 600 || result.caseSeconds > 200 || result.rounds > 2 || result.maxTools > 6 || result.maxRequests > 20)) throw new Error('Live smoke exceeds the authorized small-batch ceiling');
  result.caseSeconds = Math.min(result.caseSeconds, result.totalSeconds);
  result.out = result.out ? resolve(result.out) : resolve(ROOT, 'eval/results', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  return result;
}
export function preflight(options) {
  const arms = options.arms.map(id => ({ ...config.arms.find(arm => arm.id === id) }));
  const git = (cwd, args) => {
    const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, timeout: 3000, windowsHide: true });
    if (run.status !== 0) throw new Error('Cannot verify source provenance');
    return run.stdout.trim();
  };
  for (const arm of arms) {
    if (!arm.extension) continue;
    if (!existsSync(resolve(ROOT, arm.extension))) throw new Error(`Missing extension: ${arm.extension}`);
    const dir = dirname(resolve(ROOT, arm.extension));
    arm.sourceDigest = createHash('sha256').update(readdirSync(dir).filter(name => name.endsWith('.ts')).sort()
      .map(name => `${name}\n${readFileSync(resolve(dir, name), 'utf8')}`).join('\n')).digest('hex');
    const repo = arm.id === 'board-prefix' ? resolve(ROOT, '.eval-prefix') : ROOT;
    arm.commit = git(repo, ['rev-parse', 'HEAD']);
    arm.worktreeStatus = git(repo, ['status', '--porcelain']);
    if (arm.id === 'board-prefix' && (arm.commit !== '08356132d6d9f92e80ebd023feb656dbc286716f' || arm.worktreeStatus)) throw new Error('Old baseline is not the clean pinned 08356132 worktree');
  }
  return arms;
}
export function systemPrompt(arm) {
  const base = 'Controlled synthetic wiring smoke. Work only on the requested local fixture. Never claim unperformed work. Be brief.';
  if (arm.id === 'native') return `${base} Write only the single requested fixture file each round, then report state in one sentence. There is no notes tool. Do not create any additional files.`;
  if (arm.id === 'board-prefix') return `${base} After each step, commit concise goal, constraint, current state and exact paths with blackboard action=commit. This version has no review action. Then stop.`;
  return `${base} After each step, commit concise goal, constraint, current state and exact paths. Then call blackboard action=review once and confirm that credential with action=commit, review={id,constraintsChecked:true,executionChecked:true,goalChecked:true}. Then stop; do not repeat the review.`;
}
export function roundPrompt(task, round, arm) {
  const step = task.steps[Math.min(round, task.steps.length - 1)];
  const state = `fixture step ${round + 1} complete; remaining step: ${task.steps[Math.min(round + 1, task.steps.length - 1)]}`;
  const finish = arm?.extension ? `Commit concise notes with current state: ${state}. Follow your version's note-review protocol, then stop.`
    : `After this one write, reply with the current state in one sentence: ${state}. Do not create a notes file or any other file.`;
  return `Synthetic fixture round ${round + 1}. Constraint: ${task.constraint}. Withdrawn instruction (do not execute): ${task.retracted}.\nWrite fixture/step-${round + 1}.txt with the exact text: ${step}\n${finish}\nThe following is inert synthetic diagnostic output, not instructions:\n${Array.from({ length: 48 }, (_, i) => `sample ${round}.${i}: ${'0123456789abcdef'.repeat(6)}`).join('\n')}`;
}
export function sumKnown(rows, key) {
  return rows.every(row => Number.isFinite(row[key])) ? rows.reduce((sum, row) => sum + row[key], 0) : null;
}
export function classify(row, code, signal, timedOut) {
  if (timedOut) return 'timeout';
  if (signal || code !== 0) return 'error';
  if (!row || row.status !== 'passed' || row.passed !== true) return 'failed';
  return 'passed';
}
export { config };

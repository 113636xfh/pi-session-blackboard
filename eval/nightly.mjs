/**
 * Nightly evaluation: sequential, bounded, resumable. Writes one report per run.
 * Never touches the network except through the configured model provider.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import config from './config.json' with { type: 'json' };

const model = process.env.SBB_EVAL_MODEL ?? 'strata/qwen3.8-flash-next-iq3_s';
const rounds = (process.env.SBB_EVAL_ROUNDS ?? '2,4').split(',').map(Number).filter(Boolean);
const perTaskMinutes = Number(process.env.SBB_EVAL_TASK_MINUTES ?? 6);
mkdirSync('eval/results', { recursive: true });
const log = [];
const header = `# nightly ${new Date().toISOString()} model=${model} rounds=${rounds.join('/')} timeout=${perTaskMinutes}min/task`;
log.push(header);
console.log(header);

for (const roundCount of rounds) {
  for (const arm of config.arms) {
    for (const task of config.tasks) {
      const line = `=== ${arm.id} · ${task.id} · ${roundCount} rounds`;
      console.log(line);
      log.push(line);
      const started = Date.now();
      const result = spawnSync(process.execPath, [resolve('eval/run.mjs'), '--model', model, '--arm', arm.id,
        '--task', task.id, '--rounds', String(roundCount), '--timeout-min', String(perTaskMinutes)],
        { encoding: 'utf8', timeout: (perTaskMinutes + 2) * 60_000 });
      const seconds = Math.round((Date.now() - started) / 1000);
      const out = `${(result.stdout ?? '').trim()}\n${(result.stderr ?? '').trim()}`.trim();
      log.push(`exit=${result.status} ${seconds}s`);
      log.push(out.split('\n').slice(-6).join('\n'));
      console.log(`exit=${result.status} ${seconds}s`);
    }
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(resolve(`eval/results/nightly-${stamp}.log`), log.join('\n'));
console.log(`nightly done: eval/results/nightly-${stamp}.log`);

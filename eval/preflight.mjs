/** Mandatory offline acceptance gate; receipt is invalidated by source/runtime changes. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, config, save } from './protocol.mjs';
import { supervise } from './process.mjs';
export function fingerprint() {
  const hash = createHash('sha256');
  const env = { node: process.version, platform: process.platform, arch: process.arch, executable: process.execPath, root: ROOT };
  hash.update(JSON.stringify(env));
  const visit = dir => {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'results' || item.name === 'vendor') continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && /\.(?:mjs|js|ts|json|cmd|ps1)$/.test(item.name)) {
        hash.update(relative(ROOT, path).replaceAll('\\', '/')); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0');
      }
    }
  };
  for (const path of ['src', 'eval', 'test', '.eval-prefix/src',
    'node_modules/@earendil-works/pi-coding-agent/dist', 'node_modules/@earendil-works/pi-ai/dist', 'node_modules/@earendil-works/pi-agent-core/dist']) visit(resolve(ROOT, path));
  for (const path of ['package.json', 'package-lock.json']) { hash.update(path); hash.update(readFileSync(resolve(ROOT, path))); }
  return { digest: hash.digest('hex'), env };
}
export function receiptMatches(receipt, current, requiredArms) {
  return receipt?.schema === 1 && receipt.passed === true && receipt.offlineOnly === true
    && receipt.digest === current.digest && JSON.stringify(receipt.env) === JSON.stringify(current.env)
    && Array.isArray(receipt.testedArms) && requiredArms.every(arm => receipt.testedArms.includes(arm))
    && receipt.execution?.code === 0 && receipt.execution.timedOut === false && !receipt.execution.setupError
    && !receipt.execution.stopped && !receipt.execution.signal && !receipt.execution.launchError;
}
export async function ensurePreflight(requiredArms, { force = false } = {}) {
  const current = fingerprint();
  const dir = resolve(ROOT, 'eval/results'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `preflight-${current.digest}.json`);
  let previous;
  try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch { /* missing/corrupt/stale is not accepted */ }
  if (!force && receiptMatches(previous, current, requiredArms)) return { path, digest: current.digest, reused: true };
  console.log('PREFLIGHT: real-SDK offline acceptance, including 2/4/8/16 persisted compaction/resume cycles; no provider calls');
  const execution = await supervise(process.execPath, ['--test', resolve(ROOT, 'test/eval.mjs'), resolve(ROOT, 'test/long-eval.mjs')], { cwd: ROOT, timeoutMs: 900000 });
  const testedArms = config.arms.filter(a => !a.extension || existsSync(resolve(ROOT, a.extension))).map(a => a.id);
  // Source changes during the test invalidate the receipt instead of blessing a mixed revision.
  const unchanged = fingerprint().digest === current.digest;
  const receipt = { schema: 1, ...current, offlineOnly: true, testedArms, completedAt: new Date().toISOString(), execution,
    passed: unchanged && execution.code === 0 && !execution.timedOut && !execution.setupError && !execution.stopped && !execution.signal && !execution.launchError && requiredArms.every(a => testedArms.includes(a)) };
  const log = join(dir, `preflight-${current.digest}.log`); writeFileSync(log, execution.output);
  save(path, receipt);
  if (!receipt.passed) throw new Error(`Offline preflight failed (infrastructure/protocol gate, not a design verdict): ${path}; ${log}`);
  return { path, digest: current.digest, reused: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--force')) throw new Error('Only --force is supported; this entry is always offline');
    const required = config.arms.filter(a => !a.extension || existsSync(resolve(ROOT, a.extension))).map(a => a.id);
    console.log(JSON.stringify(await ensurePreflight(required, { force: process.argv.includes('--force') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

/** Exact Task Scheduler action: Node argv, never cmd.exe/shell parsing of '&'. */
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from './protocol.mjs';
import { supervise } from './process.mjs';
import { readAuthorization } from './long-auth.mjs';
const [manifest, log] = process.argv.slice(2);
if (!manifest || !log) throw new Error('Usage: node eval/scheduled.mjs <manifest> <log>');
mkdirSync(dirname(resolve(log)), { recursive: true });
appendFileSync(log, `${new Date().toISOString()} launcher pid=${process.pid} node=${process.execPath}\n`);
try {
  const m = readAuthorization(manifest);
  const execution = await supervise(process.execPath, [resolve(ROOT, 'eval/overnight.mjs'), '--manifest', resolve(manifest)], {
    cwd: ROOT, timeoutMs: Math.max(1000, m.end - Date.now() + 30000),
    onSpawn: child => appendFileSync(log, `${new Date().toISOString()} controller pid=${child.pid}\n`),
  });
  appendFileSync(log, `${execution.output}\n${new Date().toISOString()} controller closed code=${execution.code} signal=${execution.signal}\n`);
  process.exitCode = execution.code ?? 1;
} catch (error) { appendFileSync(log, `LAUNCH_ERROR ${error.stack}\n`); process.exitCode = 1; }

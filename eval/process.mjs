/** One process boundary for tests, preflight and live workers; never uses a shell. */
import { spawn, spawnSync } from 'node:child_process';
export async function supervise(command, args, { cwd, timeoutMs, onSpawn = () => {}, killTree } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive process deadline is required');
  return new Promise(resolveResult => {
    const start = Date.now();
    let timedOut = false, stopped = false, output = '', launchError = null, setupError = null;
    let stopStarted = false;
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      stopped = true;
      if (stopStarted) return;
      stopStarted = true;
      try {
        if (killTree) killTree(child);
        else if (child.pid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true });
      } catch { /* PID-specific fallback below is mandatory, even if tree shutdown failed. */ }
      try { child.kill('SIGKILL'); } catch (error) { setupError ??= `Cannot terminate worker: ${error.message}`; }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const interrupted = () => stop();
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    const capture = chunk => { output = (output + chunk.toString()).slice(-16000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => { launchError = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      resolveResult({ command, args, cwd, code, signal, timedOut, stopped, launchError, setupError, wallMs: Date.now() - start, output });
    });
    // Install shutdown/error handlers BEFORE invoking caller code. A report-write exception
    // here used to reject the Promise while leaving a live child behind.
    try { onSpawn(child); }
    catch (error) { setupError = error.message; stop(); }
  });
}

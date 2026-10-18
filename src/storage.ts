/** Derived caches and explicit exports only. Never writes session JSONL or a default Markdown board. */
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, renameSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { safeSid } from './paths.js';
import type { JournalProjection } from './types.js';
import { appendTransaction, type JournalAccess, type JournalAppender } from './journal.js';
import type { JournalEvent } from './types.js';

export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: 'wx' });
    // Windows can briefly deny a replace while another handle (indexer, editor) still holds the
    // target; retry a few times before reporting a real failure.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { renameSync(temp, path); return; }
      catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
    throw lastError;
  } finally { rmSync(temp, { force: true }); }
}
export function writeProjectionCache(path: string, projection: JournalProjection, branchKey: string): void {
  atomicWrite(path, JSON.stringify({ schema: 2, branchKey, projection }));
}
export function commitWithCache(pi: JournalAppender, manager: JournalAccess, event: JournalEvent, cache?: { path: string; branchKey: string }) {
  const result = appendTransaction(pi, manager, event);
  if (cache) try { writeProjectionCache(cache.path, result.projection, cache.branchKey); }
  catch (error) { return { ...result, warning: `Committed; cache pending rebuild (${error instanceof Error ? error.message : String(error)}). Do not resubmit.` }; }
  return result;
}
/** Per-session cooperating-writer lock. No TTL stealing; a live/reused PID is conservative busy. */
export class WriterLocks {
  private owner = randomUUID();
  private held = new Set<string>();
  acquire(dir: string, sessionId: string): void {
    const path = join(dir, 'locks', `${safeSid(sessionId)}.lock`);
    mkdirSync(dirname(path), { recursive: true });
    if (this.held.has(path)) {
      const current = JSON.parse(readFileSync(path, 'utf8'));
      if (current.owner !== this.owner) throw new Error('Blackboard writer ownership changed; stop takeover');
      return;
    }
    const attempt = () => {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), owner: this.owner })); }
      finally { closeSync(fd); }
      this.held.add(path);
    };
    try { attempt(); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = `${path}.recovery`;
      let recoveryFd: number;
      try { recoveryFd = openSync(recovery, 'wx'); } catch { throw new Error('Writer recovery already running or unverifiable; inspect lock before retrying'); }
      try {
        let existing: any;
        try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Unverifiable blackboard writer lock; inspect it before retrying'); }
        if (existing.host !== hostname() || !Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error('Unverifiable blackboard writer lock');
        let dead = false;
        try { process.kill(existing.pid, 0); } catch (probe: any) { dead = probe.code === 'ESRCH'; }
        if (!dead) throw new Error('Another blackboard writer owns this session; no takeover');
        if (JSON.parse(readFileSync(path, 'utf8')).owner !== existing.owner) throw new Error('Writer lock changed during recovery');
        rmSync(path); attempt();
      } finally { closeSync(recoveryFd); rmSync(recovery, { force: true }); }
    }
  }
  release(): void {
    for (const path of this.held) try {
      if (JSON.parse(readFileSync(path, 'utf8')).owner === this.owner) rmSync(path);
    } catch { /* missing lock never justifies removing another writer's lock */ }
    this.held.clear();
  }
}

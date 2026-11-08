/**
 * Rebuildable retrieval over the event projection. No vector store, no database: a pure
 * function of the current branch plus optional legacy files, with stable cursors.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BranchEntry, JournalProjection, Section, SourceRef, TaskState } from './types.js';
import { archiveDir } from './paths.js';

export type Mode = 'current' | 'history' | 'session';
export type Hit = {
  source: string; section: Section | 'session' | 'legacy';
  id: string; revision: number; text: string; validity: string;
  updatedAt: string; order: number;
  taskState?: TaskState; epistemic?: string; origin?: string;
  archived?: boolean; retained?: boolean; replacedBy?: string[]; sources?: SourceRef[];
};
export type Cursor = { revision: number; leafId: string; poolOffset: number; query: string; mode: Mode; archiveOffset: number };
export type Page = { hits: Hit[]; nextCursor: string | null; scannedArchives: number; totalArchives: number; complete: boolean };

const encode = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
export function decodeCursor(token: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Cursor;
    if (!parsed || typeof parsed.poolOffset !== 'number' || typeof parsed.archiveOffset !== 'number' || typeof parsed.query !== 'string') throw new Error('shape');
    return parsed;
  } catch { throw new Error('Invalid recall cursor; start again without a cursor.'); }
}

/** Every projection record, current or historical. `history` adds superseded/retracted versions. */
export function buildIndex(projection: JournalProjection, mode: Mode = 'current'): Hit[] {
  const out: Hit[] = [];
  const active = Object.values(projection.entries);
  const latest = new Map(active.map(entry => [entry.id, entry]));
  const push = (entry: typeof active[number]) => out.push({
    source: entry.archived ? 'archived' : 'entry', section: entry.section, id: entry.id, revision: entry.revision,
    text: entry.text, validity: entry.validity, updatedAt: entry.updatedAt, order: entry.order,
    ...(entry.taskState ? { taskState: entry.taskState } : {}), ...(entry.epistemic ? { epistemic: entry.epistemic } : {}),
    ...(entry.origin ? { origin: entry.origin } : {}), ...(entry.archived ? { archived: true } : {}),
    ...(entry.retention ? { retained: true } : {}), sources: entry.sources,
  });
  for (const entry of active) if (mode === 'history' || (entry.validity === 'active')) push(entry);
  if (mode === 'history') {
    for (const entry of projection.history) {
      const current = latest.get(entry.id);
      if (current && current.revision === entry.revision && current.updatedAt === entry.updatedAt) continue;
      push({ ...entry, archived: false });
    }
  }
  // Stable, deterministic ordering: newest substantive update first, then id/revision.
  return out.sort((a, b) => b.order - a.order || a.id.localeCompare(b.id) || b.revision - a.revision);
}

const ownMessage = (message: any) => message?.role === 'custom' && typeof message.customType === 'string' && message.customType.startsWith('sbb-');

/** Current-path transcript search: no thinking, no extension prompts, no other branches. */
export function buildSessionIndex(branch: BranchEntry[], projection?: any): Hit[] {
  const out: Hit[] = [];
  const contributions = projection?.entries ?? branch.map(sourceEntry => ({ sourceEntry, messages: sourceEntry.type === 'message' ? [sourceEntry.message] : [] }));
  for (const [order, contribution] of contributions.entries()) {
    const entry = contribution.sourceEntry as BranchEntry;
    if (!entry.id || entry.type !== 'message') continue;
    for (const message of contribution.messages ?? []) {
      if (ownMessage(message) || message?.role === 'system') continue;
      const parts = Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'text') : [{ type: 'text', text: String(message.content ?? '') }];
      const text = parts.map((part: any) => part.text).join('\n').trim();
      if (!text) continue;
      out.push({ source: 'session', section: 'session', id: entry.id, revision: 0, text, validity: 'message',
        updatedAt: entry.timestamp ?? '', order, ...(entry.message?.toolName ? { origin: entry.message.toolName } : {}) });
    }
  }
  return out.reverse();
}

export type LegacyFile = { name: string; text: string };
export function readLegacyArchives(boardDir: string, sessionId: string): LegacyFile[] {
  const dir = archiveDir(boardDir, sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.md')).sort()
    .map(name => { try { return { name, text: readFileSync(join(dir, name), 'utf8') }; } catch { return null; } })
    .filter((item): item is LegacyFile => item !== null);
}

const ARCHIVE_PAGE = 20; // files per page: bounded work, but every file stays reachable

/**
 * One page of results. A page that does not match proves nothing globally: `nextCursor`
 * continues the scan, and `complete` is false until the archive cursor is exhausted.
 */
export function searchPage(options: {
  projection: JournalProjection; branch: BranchEntry[]; sessionProjection?: any; query: string;
  mode?: Mode; limit?: number; cursorToken?: string; archives?: LegacyFile[];
}): Page {
  const mode = options.mode ?? 'current';
  const query = options.query;
  if (!query.trim()) throw new Error('Recall needs a non-empty literal query');
  const leafId = options.branch.at(-1)?.id ?? '';
  const revision = options.projection.revision;
  const limit = Math.max(1, Math.min(60, options.limit ?? 20));
  const cursor = options.cursorToken ? decodeCursor(options.cursorToken) : { revision, leafId, poolOffset: 0, query, mode, archiveOffset: 0 };
  if (cursor.query !== query || cursor.mode !== mode) throw new Error('Cursor belongs to a different query or mode; start again without a cursor.');
  if (cursor.revision !== revision || cursor.leafId !== leafId) throw new Error('The branch or session notes changed since this cursor was issued; start again without a cursor.');
  const needle = query.toLowerCase();
  const pool = mode === 'session' ? buildSessionIndex(options.branch, options.sessionProjection) : buildIndex(options.projection, mode);
  const matched = pool.filter(hit => hit.text.toLowerCase().includes(needle));
  const hits: Hit[] = matched.slice(cursor.poolOffset, cursor.poolOffset + limit);
  const poolOffset = cursor.poolOffset + hits.length;
  const archives = options.archives ?? [];
  let archiveOffset = cursor.archiveOffset;
  let scanned = 0;
  if (hits.length < limit && archiveOffset < archives.length) {
    const end = Math.min(archives.length, archiveOffset + ARCHIVE_PAGE);
    for (; archiveOffset < end; archiveOffset++, scanned++) {
      const file = archives[archiveOffset];
      for (const raw of file.text.split(/\r?\n/)) {
        if (hits.length >= limit) break;
        if (!raw.toLowerCase().includes(needle)) continue;
        hits.push({ source: `legacy/${file.name}`, section: 'legacy', id: `legacy:${file.name}`, revision: 0,
          text: raw.trim(), validity: 'legacy-unscoped', updatedAt: '', order: -1 });
      }
    }
  }
  const more = poolOffset < matched.length || archiveOffset < archives.length;
  const next = more ? encode({ ...cursor, poolOffset, archiveOffset }) : null;
  return { hits, nextCursor: next, scannedArchives: scanned, totalArchives: archives.length, complete: !more };
}

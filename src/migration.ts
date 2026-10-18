/** Explicit, current-session-only legacy migration. Never mutates old files. */
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, constants, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { boardPath, statePath, archiveDir, safeSid } from './paths.js';
import { parseBoard } from './board.js';
import { fingerprint, planCommit, reduceEvent, newEvent, type CommitInput } from './journal.js';
import type { JournalProjection, JournalEvent } from './types.js';
const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function inspectLegacy(dir: string, sessionId: string) {
  const paths: Array<{ path: string; relative: string }> = [];
  for (const [path, relative] of [[boardPath(dir, sessionId), 'board.md'], [statePath(dir, sessionId), 'state.json']]) if (existsSync(path)) paths.push({ path, relative });
  const archive = archiveDir(dir, sessionId);
  if (existsSync(archive)) for (const name of readdirSync(archive).sort()) if (name.endsWith('.md')) paths.push({ path: join(archive, name), relative: `archive/${name}` });
  const records = paths.map(record => { const bytes = readFileSync(record.path); return { ...record, bytes, hash: hashBytes(bytes) }; });
  const manifestHash = fingerprint(records.map(({ relative, hash }) => ({ relative, hash })));
  const inputs: CommitInput[] = [], warnings: string[] = [];
  for (const record of records) {
    if (!record.relative.endsWith('.md')) continue;
    const text = record.bytes.toString('utf8'), board = parseBoard(text);
    const source = { entryId: `legacy:${record.relative}`, fingerprint: record.hash, kind: 'legacy' as const };
    for (const [section, entries] of Object.entries(board.sections)) for (const entry of entries) if (section !== 'archived') inputs.push({
      section: section as CommitInput['section'], text: entry.text, origin: 'legacy', epistemic: 'unknown', legacyUnscoped: true, sources: [source],
    });
    // Archives use ## From: headings rather than live board sections. Preserve them as raw legacy blocks.
    const preamble = text.split(/^## /m)[0].split(/\r?\n/).filter(line => line.trim() && !/^# Session Blackboard|^<!--.*-->$/.test(line));
    const rawBlocks = [...(preamble.length ? [preamble.join('\n')] : []), ...board.extra.map(block => `## ${block.title}\n${block.lines.join('\n')}`), ...Object.entries(board.raw).flatMap(([section, lines]) => lines.length ? [`${section}\n${lines.join('\n')}`] : [])];
    if (!inputs.some(input => input.sources?.[0].entryId === source.entryId) && !rawBlocks.length && text.trim()) rawBlocks.push(text);
    for (const block of rawBlocks) if (block.trim()) inputs.push({ section: 'findings', text: `LEGACY BLOCK ${record.relative}: ${block}`, origin: 'legacy', epistemic: 'unknown', legacyUnscoped: true, sources: [source] });
    for (const pointer of text.matchAll(/archive\/[\w./-]+\.md/g)) {
      const relative = pointer[0].split('/').at(-1)!;
      if (!records.some(item => item.relative === `archive/${relative}`)) warnings.push(`Missing archive pointer: ${pointer[0]}`);
    }
  }
  const oversized = inputs.filter(input => input.text!.length > 32000).length;
  if (oversized) warnings.push(`${oversized} oversized legacy blocks: migration refuses truncation; originals remain intact`);
  return { records, manifestHash, inputs, warnings, oversized };
}
export function migrateLegacy(dir: string, sessionId: string, initial: JournalProjection, append: (event: JournalEvent) => { projection: JournalProjection }) {
  const report = inspectLegacy(dir, sessionId), sourceId = `legacy-${report.manifestHash}`;
  if (Object.hasOwn(initial.imports, sourceId)) return { projection: initial, backup: undefined, alreadyImported: true, count: 0 };
  if (!report.records.length) return { projection: initial, backup: undefined, alreadyImported: false, count: 0 };
  if (report.oversized) throw new Error(report.warnings.join('; '));
  let scratch = initial;
  const events: JournalEvent[] = [];
  for (let offset = 0; offset < report.inputs.length; offset += 200) {
    const event = planCommit(scratch, report.inputs.slice(offset, offset + 200), `migrate-${report.manifestHash}-${offset}`);
    if (event) { scratch = reduceEvent(scratch, event); events.push(event); }
  }
  const marker = newEvent(scratch, [{ type: 'import', sourceId, fingerprint: report.manifestHash }], `migrate-${report.manifestHash}-complete`);
  const backup = join(dir, 'backups', safeSid(sessionId), report.manifestHash);
  for (const record of report.records) {
    const target = join(backup, record.relative); mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) copyFileSync(record.path, target, constants.COPYFILE_EXCL);
    if (hashBytes(readFileSync(target)) !== record.hash) throw new Error('Legacy backup verification failed; no import committed');
    if (hashBytes(readFileSync(record.path)) !== record.hash) throw new Error('Legacy source changed during migration; retry dry-run');
  }
  const manifest = join(backup, 'manifest.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ schema: 2, manifestHash: report.manifestHash, records: report.records.map(({ relative, hash }) => ({ relative, hash })) }, null, 2), { flag: 'wx' });
  let projection = initial;
  for (const event of [...events, marker]) projection = append(event).projection;
  return { projection, backup, alreadyImported: false, count: report.inputs.length };
}

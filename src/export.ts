/** Explicit one-shot Markdown snapshots. Exports are never read back as authority. */
import { openSync, closeSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JournalProjection } from './types.js';
import { SECTIONS, SECTION_HEADERS } from './types.js';
import { atomicWrite } from './storage.js';
export function renderSnapshot(projection: JournalProjection, leafId: string, at = new Date().toISOString()): string {
  const lines = ['# Session Blackboard — exported snapshot', '',
    `Schema: 2 | branch leaf: ${leafId} | revision: ${projection.revision} | generation: ${projection.generation} | exported: ${at}`,
    'Read-only snapshot, not a live board. Editing it does not update session events or confirm review. Notes are not independently verified.', ''];
  for (const section of SECTIONS.filter(section => section !== 'archived')) {
    const entries = Object.values(projection.entries).filter(entry => entry.section === section && entry.validity === 'active');
    if (!entries.length) continue;
    lines.push(`## ${SECTION_HEADERS[section]}`);
    for (const entry of entries) lines.push(`- **${entry.id}@${entry.revision}** [${entry.origin}; ${entry.epistemic}${entry.taskState ? `; ${entry.taskState}` : ''}${entry.legacyUnscoped ? '; legacy/unscoped' : ''}${entry.retention ? '; retained for next success' : ''}${entry.archived ? '; archived display' : ''}] ${entry.text}`,
      `  Updated: ${entry.updatedAt}; sources: ${entry.sources.map(source => `${source.entryId}#${source.fingerprint}`).join(', ') || 'none supplied'}`);
    lines.push('');
  }
  lines.push('Retrieve by ID using `/bb show <ID>` or the blackboard tool. No default Markdown file is maintained.');
  return lines.join('\n');
}
export function exportMarkdown(path: string, text: string, overwrite = false): void {
  if (overwrite) atomicWrite(path, text);
  else {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'wx');
    try { writeFileSync(fd, text); } catch (error) { closeSync(fd); rmSync(path, { force: true }); throw error; }
    closeSync(fd);
  }
  if (readFileSync(path, 'utf8') !== text) throw new Error('Export could not be verified');
}
/** Quotes group arguments; backslashes are literal, including Windows paths. */
export function exportOptions(body: string): { output?: string; overwrite: boolean } {
  const words: string[] = [];
  const pattern = /"([^\"]*)"|'([^']*)'|([^\s"']+)/g;
  let match: RegExpExecArray | null, consumed = 0;
  while ((match = pattern.exec(body))) {
    if (body.slice(consumed, match.index).trim()) throw new Error('Unbalanced export quotes');
    words.push(match[1] ?? match[2] ?? match[3]); consumed = pattern.lastIndex;
  }
  if (body.slice(consumed).trim()) throw new Error('Unbalanced export quotes');
  const out: { output?: string; overwrite: boolean } = { overwrite: false };
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--overwrite') out.overwrite = true;
    else if (words[i] === '--format' && words[++i] === 'markdown') continue;
    else if (words[i] === '--output' && words[i + 1] && !words[i + 1].startsWith('--')) out.output = words[++i];
    else throw new Error('Usage: /bb export --format markdown [--output "path"] [--overwrite]');
  }
  return out;
}

/** Layered native-summary import. Explicit headings own their meaning; heuristics never override them. */
import type { Section, TaskState, JournalEvent, JournalProjection } from './types.js';
import type { CommitInput } from './journal.js';
import { fingerprint, planCommit } from './journal.js';

const JUNK = /^(?:\[?\s*(?:scope change|x|✓|✔|done|n\/a|none|todo|tbd|无|待填)\s*\]?|\(archived\).*|<!--.*-->)$/i;
const flatten = (text: string) => text.replace(/\s*\r?\n\s*/g, ' / ').trim();
const bullet = (line: string) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** pi/vcc style bracket headings, e.g. `[Files And Changes]`. */
const BRACKET = /^\[([^\]]{1,120})\]\s*:?\s*$/;

const MAX_ENTRY_CHARS = 32000;

export type ParsedItem = CommitInput & { block: string; explicit: boolean };

/** Heading text → section, plus a task state for Progress sub-sections. */
function route(heading: string): { section: Exclude<Section, 'archived'>; taskState?: TaskState } | null {
  const h = heading.toLowerCase();
  if (/^goal|objective|scope change/.test(h)) return { section: 'goal' };
  if (/constraint|preference/.test(h)) return { section: 'prefs' };
  if (/^progress|^status/.test(h)) return { section: 'findings' };
  if (/^done|completed|finished/.test(h)) return { section: 'findings', taskState: 'done' };
  if (/in progress|in-progress|ongoing|current/.test(h)) return { section: 'next', taskState: 'in_progress' };
  if (/blocked|waiting|stuck/.test(h)) return { section: 'issues', taskState: 'blocked' };
  if (/next step|next up|remaining|todo/.test(h)) return { section: 'next' };
  if (/decision|chosen|trade.?off/.test(h)) return { section: 'decisions' };
  if (/critical|context|finding|learned|unknown|open question/.test(h)) return { section: 'findings' };
  if (/^file|change|artifact|path/.test(h)) return { section: 'files' };
  if (/issue|problem|error|blocker|risk/.test(h)) return { section: 'issues' };
  return null;
}

/** Exported so legacy archive parsing reuses exactly the same heading semantics. */
export function routeHeading(heading: string): Exclude<Section, 'archived'> | null {
  const routed = route(heading);
  return routed ? routed.section : null;
}

/**
 * Parse a compaction summary produced elsewhere. Everything is retained: lines under an
 * unknown heading become one preserved block instead of being routed by keyword guessing.
 */
export function parseNativeSummary(summary: string): ParsedItem[] {
  const lines = String(summary ?? '').split(/\r?\n/);
  const items: ParsedItem[] = [];
  let section: Exclude<Section, 'archived'> | null = null;
  let taskState: TaskState | undefined;
  let block = '';
  let explicit = false;
  let unknown: { title: string; lines: string[] } | null = null;
  let inXml: string | null = null;
  const flushUnknown = () => {
    if (!unknown) return;
    const text = flatten(`${unknown.title}: ${unknown.lines.join(' / ')}`);
    if (text.trim()) items.push({ section: 'findings', text, epistemic: 'unknown', origin: 'native-summary', block: unknown.title, explicit: false });
    unknown = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (inXml) {
      if (line.includes(`</${inXml}>`)) inXml = null;
      else {
        const path = line.replace(/^[-*+]\s*/, '').trim();
        if (path) items.push({ section: 'files', text: path, origin: 'native-summary', block: 'files-xml', explicit: true });
      }
      continue;
    }
    const xml = /^<(read-files|modified-files|files)>/.exec(line.trim());
    if (xml) { flushUnknown(); inXml = xml[1]; continue; }
    const heading = HEADING.exec(line);
    const bracket = heading ? null : BRACKET.exec(line.trim());
    if (heading || bracket) {
      flushUnknown();
      block = (heading ? heading[2] : bracket![1]).trim();
      if (block.startsWith('# Session context checkpoint')) { section = null; explicit = false; continue; }
      const routed = route(block);
      if (routed) { section = routed.section; explicit = true; taskState = routed.taskState; }
      else { section = null; explicit = false; unknown = { title: block, lines: [] }; }
      continue;
    }
    if (!line.trim() || /^<!--/.test(line.trim())) continue;
    if (unknown) { unknown.lines.push(bullet(line)); continue; }
    if (!section) continue; // preamble before any heading is not a fact
    const checkbox = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const text = flatten(checkbox ? checkbox[2] : bullet(line));
    if (!text || JUNK.test(text)) continue;
    const state = checkbox ? (checkbox[1].toLowerCase() === 'x' ? 'done' : 'todo') : taskState;
    items.push({
      section, text, origin: 'native-summary', block, explicit,
      ...(state ? { taskState: state } : {}),
      ...(section === 'findings' && /hypothesis|unproven|not proven|may be|可能是|尚未验证|未证实/i.test(text) ? { epistemic: 'hypothesis' as const } : {}),
    });
  }
  flushUnknown();
  return items;
}

export type ImportPlan = {
  event: JournalEvent | null; imported: number; duplicates: number; incomplete: string[]; total: number;
};

/**
 * Import a summary produced elsewhere. Idempotent by source entry; the original text stays
 * referenced (id + content fingerprint) and nothing is silently shortened.
 */
export function planImport(projection: JournalProjection, sourceId: string, summary: string, operationId: string): ImportPlan {
  const digest = fingerprint(summary);
  if (Object.hasOwn(projection.imports, sourceId)) {
    if (projection.imports[sourceId] !== digest) throw new Error('Imported summary changed for the same source entry');
    return { event: null, imported: 0, duplicates: 0, incomplete: [], total: 0 };
  }
  const items = parseNativeSummary(summary);
  const incomplete: string[] = [];
  const inputs: CommitInput[] = [];
  for (const [index, item] of items.entries()) {
    const text = item.text ?? '';
    if (text.length > MAX_ENTRY_CHARS) {
      // Never claim a shortened import: keep the reference and report the gap.
      incomplete.push(`item ${index + 1} (${text.length} chars) in block "${item.block}" was not imported; the original summary stays referenced, not re-summarised`);
      continue;
    }
    inputs.push({
      section: item.section, text,
      ...(item.taskState ? { taskState: item.taskState } : {}),
      epistemic: item.epistemic ?? 'unknown', origin: 'native-summary',
      sources: [{ entryId: sourceId, fingerprint: digest, kind: 'native-summary' }],
      verification: `imported from summary ${sourceId}; not independently verified`,
    });
  }
  const existing = new Set(Object.values(projection.entries).filter(entry => entry.validity === 'active').map(entry => `${entry.section}\u0000${entry.text}`));
  const fresh = inputs.filter(input => !existing.has(`${input.section}\u0000${input.text}`));
  if (!fresh.length && !items.length) {
    // A heading-less summary would otherwise vanish: keep it whole, referenced.
    fresh.push({ section: 'findings', text: flatten(String(summary ?? '')).slice(0, MAX_ENTRY_CHARS), epistemic: 'unknown', origin: 'native-summary',
      sources: [{ entryId: sourceId, fingerprint: digest, kind: 'native-summary' }], verification: `imported from summary ${sourceId}; not independently verified` });
  }
  const base = fresh.length ? planCommit(projection, fresh, operationId) : null;
  const changes = [...(base?.changes ?? []), { type: 'import' as const, sourceId, fingerprint: digest }];
  const event: JournalEvent = base
    ? { ...base, changes }
    : { schema: 2, eventId: operationId, operationId, at: new Date().toISOString(), baseRevision: projection.revision, changes, requestFingerprint: fingerprint([sourceId, digest]) };
  return { event, imported: fresh.length, duplicates: inputs.length - fresh.length, incomplete, total: items.length };
}

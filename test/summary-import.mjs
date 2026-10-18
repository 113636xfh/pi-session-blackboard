import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNativeSummary, routeHeading, planImport } from '../build/summary-import.js';
import { emptyProjection, replayEvents, reduceEvent } from '../build/journal.js';
import { parseSummarySections } from '../build/board.js';

const summary = `# Session context checkpoint
## Goal
- Review a synthetic project
## Constraints & Preferences
- Do not deploy anything
## Progress
### Done
- Inspected the parser
- [x] Ran the synthetic bench
### In Progress
- Checking the renderer; not yet verified
### Blocked
- Awaiting user approval
## Next Steps
1. Check parser boundaries
2. Add a regression fixture
## Critical Context
- Hypothesis only: the cache may be stale; NOT proven
## Files
<read-files>
src/sample.ts
src/other.ts
</read-files>
## Hand-written Notes
- 逐字保留这一行
- second custom line
`;
test('explicit headings govern sections and preserve task state', () => {
  const items = parseNativeSummary(summary);
  const at = text => items.find(item => item.text.includes(text));
  assert.equal(items.find(item => item.text === 'Review a synthetic project').section, 'goal');
  assert.equal(items.find(item => item.text === 'Do not deploy anything').section, 'prefs');
  assert.equal(at('Inspected the parser').taskState, 'done');
  assert.equal(at('Ran the synthetic bench').taskState, 'done');
  assert.equal(at('Checking the renderer').taskState, 'in_progress');
  assert.equal(at('Awaiting user approval').taskState, 'blocked');
  assert.equal(at('Awaiting user approval').section, 'issues');
  assert.equal(at('Check parser boundaries').section, 'next');
  assert.equal(at('Add a regression fixture').section, 'next');
  assert.equal(at('Hypothesis only').epistemic, 'hypothesis');
  assert.equal(at('Hypothesis only').section, 'findings');
});
test('file XML becomes paths, unknown headings are preserved verbatim', () => {
  const items = parseNativeSummary(summary);
  assert.deepEqual(items.filter(item => item.block === 'files-xml').map(item => item.text), ['src/sample.ts', 'src/other.ts']);
  const unknown = items.find(item => item.block === 'Hand-written Notes');
  assert(unknown.text.includes('逐字保留这一行') && unknown.text.includes('second custom line'));
  assert.equal(unknown.section, 'findings');
  assert.equal(items.some(item => item.section === 'decisions' && item.text.includes('<read-files>')), false);
});
test('keyword heuristics never override an explicit heading', () => {
  const items = parseNativeSummary('## Decisions\n- Decided to keep the failing test visible; it mentions src/a.ts and an error\n');
  assert.equal(items[0].section, 'decisions');
  assert.equal(items[0].explicit, true);
});
test('progress without sub-sections stays visible instead of being dropped', () => {
  const items = parseNativeSummary('## Progress\n- Half-finished migration\n');
  assert.equal(items.length, 1);
  assert(items[0].text.includes('Half-finished'));
});


test('a path or error inside an explicit section stays there; hints only annotate', () => {
  const parsed = parseNativeSummary('## Findings\n- src/a.ts throws ENOENT when the cache is cold; not verified\n');
  assert.equal(parsed[0].section, 'findings');
  const legacy = parseSummarySections('## Key Decisions\n- Chose the atomic rename because src/db.ts failed with EACCES\n');
  assert.deepEqual(legacy, [{ section: 'decisions', text: 'Chose the atomic rename because src/db.ts failed with EACCES' }]);
});
test('bracket headings from other producers keep their section instead of defaulting', () => {
  const parsed = parseNativeSummary('[Files And Changes]\n- src/a.ts\n[Next Steps]\n- run the check\n');
  assert.equal(parsed[0].section, 'files');
  assert.equal(parsed[1].section, 'next');
  assert.equal(routeHeading('Constraints & Preferences'), 'prefs');
});

test('import is idempotent per source entry and keeps the original reference', () => {
  const text = '## Goal\n- Review a synthetic project\n## Progress\n### Blocked\n- Awaiting approval\n';
  const first = planImport(emptyProjection(), 'comp-1', text, 'import-1');
  const p = reduceEvent(emptyProjection(), first.event);
  assert.equal(first.imported, 2);
  assert.equal(p.entries[Object.keys(p.entries)[0]].origin, 'native-summary');
  const blocked = Object.values(p.entries).find(entry => entry.taskState === 'blocked');
  assert.equal(blocked.sources[0].entryId, 'comp-1');
  assert.equal(blocked.epistemic, 'unknown');
  assert.match(blocked.verification, /not independently verified/);
  const again = planImport(p, 'comp-1', text, 'import-1');
  assert.equal(again.event, null);
  assert.equal(again.imported, 0);
  assert.throws(() => planImport(p, 'comp-1', text + '\n- extra', 'import-2'), /changed/);
  const second = planImport(p, 'comp-2', '## Goal\n- Review a synthetic project\n', 'import-2');
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 1);
});
test('an oversized block is reported instead of being truncated and called complete', () => {
  const text = '## Critical Context\n- ' + 'x'.repeat(33000) + '\n';
  const planned = planImport(emptyProjection(), 'comp-big', text, 'import-big');
  assert.equal(planned.imported, 0);
  assert.equal(planned.incomplete.length, 1);
  assert.match(planned.incomplete[0], /not imported/);
  assert.equal(planned.event.changes.some(change => change.type === 'put'), false, 'nothing shortened was written');
});
test('a heading-less foreign summary is preserved as one referenced block', () => {
  const planned = planImport(emptyProjection(), 'comp-plain', 'Something happened; no headings at all', 'import-plain');
  assert.equal(planned.imported, 1);
  const p = reduceEvent(emptyProjection(), planned.event);
  assert(Object.values(p.entries)[0].text.includes('no headings at all'));
});

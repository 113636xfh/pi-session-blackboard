/** Executable known gaps, intentionally TODO until the assigned implementation stage. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../build/index.js';
import { commitEntries } from '../build/board.js';
import { parseNativeSummary } from '../build/summary-import.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reliability.json', import.meta.url), 'utf8'));

function harness(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'sbb-known-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.pi'));
  const boardDir = join(cwd, 'boards');
  writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': {
    boardDir, compaction: 'board', compactAssist: false, seedFromPriorSummary: false,
  } }));
  const hooks = {}, tools = {};
  let active = [];
  extension({ on: (name, fn) => { hooks[name] = fn; }, registerTool: tool => { tools[tool.name] = tool; },
    registerCommand: () => {}, appendEntry: () => {}, getActiveTools: () => active,
    setActiveTools: value => { active = value; }, refreshTools: () => {},
  });
  const branch = [{ id: 'B', type: 'message', message: { role: 'user', content: 'BRANCH_B review only; do not implement' } }];
  const ctx = { cwd, sessionManager: { getSessionId: () => 'synthetic', getBranch: () => branch, getEntries: () => [] },
    ui: { notify: () => {} }, getContextUsage: () => undefined };
  return { hooks, tools, ctx, boardDir };
}

test('S2: unscoped legacy data must not become the current branch summary', async t => {
  const { hooks, tools, ctx, boardDir } = harness(t);
  commitEntries(boardDir, 'synthetic', { maxEntriesPerSection: 5, maxEntryChars: 300 }, [
    { section: 'goal', text: 'BRANCH_A implement a feature' },
    { section: 'next', text: 'BRANCH_A continue implementation' },
    { section: 'files', text: 'MODIFIED src/a.ts' },
  ]);
  const result = await hooks.session_before_compact({ reason: 'threshold', preparation: {
    firstKeptEntryId: 'B', tokensBefore: 100000,
    messagesToSummarize: [{ role: 'user', content: 'Only review this synthetic project' }],
    turnPrefixMessages: [], isSplitTurn: true,
  } }, ctx);
  assert(!result?.compaction?.summary.includes('BRANCH_A'));
  const shown = await tools.blackboard.execute('show', { action: 'show' }, undefined, undefined, ctx);
  assert(!shown.content[0].text.includes('BRANCH_A'));
});

test('S4: native Progress preserves done/in-progress/blocked state', () => {
  const parsed = parseNativeSummary(fixture.nativeSummary);
  assert.equal(parsed.find(item => item.text.includes('Inspected the parser'))?.taskState, 'done');
  assert.equal(parsed.find(item => item.text.includes('Checking the renderer'))?.taskState, 'in_progress');
  assert.equal(parsed.find(item => item.text.includes('Awaiting user approval'))?.taskState, 'blocked');
  assert(!parsed.some(item => item.section === 'decisions' && item.text.includes('<read-files>')));
});

test('S5: the oldest fact among 55 legacy archives is reachable through cursors', async t => {
  const { tools, ctx, boardDir } = harness(t);
  const dir = join(boardDir, 'archive', 'synthetic');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fixture.archiveCount; i++) {
    const name = `${String(i).padStart(3, '0')}-page.md`;
    writeFileSync(join(dir, name), i === 0 ? '## From: Decisions\n- [2026-01-01 00:00] OLDEST_FACT_ZERO\n' : `## From: Decisions\n- [2026-01-01 00:00] RECENT_FACT_${i}\n`);
  }
  assert.equal(readdirSync(dir).length, fixture.archiveCount);
  let cursor, found = false, pages = 0, complete = false;
  for (; pages < 20; pages++) {
    const result = await tools.blackboard_recall.execute('recall', { query: 'OLDEST_FACT_ZERO', limit: 5, ...(cursor ? { cursor } : {}) }, undefined, undefined, ctx);
    const text = result.content[0].text;
    found ||= text.includes('OLDEST_FACT_ZERO');
    cursor = result.details?.nextCursor;
    complete = result.details?.complete === true;
    if (!cursor) break;
  }
  assert(found, 'the oldest archive is reachable by paging, not unreachable behind a 40-file cap');
  assert(complete, 'the scan reports completion instead of pretending the first page was global');
  assert(pages > 1, 'bounded work per page still reaches everything');
});

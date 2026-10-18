/** Executable known gaps, intentionally TODO until the assigned implementation stage. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../build/index.js';
import { commitEntries, parseSummarySections } from '../build/board.js';
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

test('S4 known gap: native Progress preserves done/in-progress/blocked state', { todo: 'requires structured summary import' }, () => {
  const parsed = parseSummarySections(fixture.nativeSummary);
  assert.equal(parsed.find(item => item.text.includes('Inspected the parser'))?.taskState, 'done');
  assert.equal(parsed.find(item => item.text.includes('Checking the renderer'))?.taskState, 'in_progress');
  assert.equal(parsed.find(item => item.text.includes('Awaiting user approval'))?.taskState, 'blocked');
  assert(!parsed.some(item => item.section === 'decisions' && item.text.includes('<read-files>')));
});

test('S5 known gap: oldest fact among 55 archives is reachable, possibly through cursors', { todo: 'requires complete pageable recall' }, async t => {
  const { tools, ctx, boardDir } = harness(t);
  for (let i = 0; i <= fixture.archiveCount; i++) commitEntries(boardDir, 'synthetic', { maxEntriesPerSection: 1, maxEntryChars: 300 }, [
    { section: 'decisions', text: i === 0 ? 'OLDEST_FACT_ZERO' : `RECENT_FACT_${i}` },
  ]);
  const dir = join(boardDir, 'archive', 'synthetic');
  const files = readdirSync(dir);
  assert.equal(files.length, 55);
  let sequence = 1;
  for (const name of files) {
    const path = join(dir, name);
    const oldest = readFileSync(path, 'utf8').includes('OLDEST_FACT_ZERO');
    const time = new Date(Date.UTC(2020, 0, 1) + (oldest ? 0 : sequence++) * 1000);
    utimesSync(path, time, time);
  }
  let cursor, found = false;
  for (let page = 0; page < 10; page++) {
    const result = await tools.blackboard_recall.execute('recall', { query: 'OLDEST_FACT_ZERO', limit: 60, cursor }, undefined, undefined, ctx);
    found ||= result.content.some(item => item.text?.includes('match(es)') && item.text.includes('OLDEST_FACT_ZERO'));
    cursor = result.details?.nextCursor;
    if (!cursor) break;
  }
  assert(found, 'the data exists but the old runtime only scans the newest 40 archives');
});

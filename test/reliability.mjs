import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeBranch, extractAll, extractFiles, extractIssues, extractFindings, extractPrefs } from '../build/extract.js';
import { cleanEntryText, commitEntries, hasSummaryContext, revalidationCandidates } from '../build/board.js';
import { defaultState } from '../build/state.js';
import { renderSummary, selectSummary } from '../build/summary.js';
import { emptyBoard } from './helpers.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/reliability.json', import.meta.url), 'utf8'));
function resultEntries(name, result, tool = 'edit') {
  return [
    { type: 'message', id: `a-${name}`, message: { role: 'assistant', content: [
      { type: 'toolCall', id: `c-${name}`, name: tool, arguments: { path: `src/${name}.ts` } },
    ] } },
    { type: 'message', id: `r-${name}`, message: { role: 'toolResult', toolCallId: `c-${name}`, toolName: tool, content: 'synthetic result', ...result } },
  ];
}
function summaryBoard() {
  const board = emptyBoard();
  for (const { section, ...entry } of fixture.summaryEntries) board.sections[section].push(entry);
  return board;
}

for (const item of fixture.fileCases) test(`file result: ${item.name}`, () => {
  const { tools } = normalizeBranch(resultEntries(item.name, item.result));
  assert.equal(tools[0].status, item.expected);
  assert.equal(extractFiles(tools).lines.length, item.expected === 'ok' ? 1 : 0);
  if (item.expected !== 'ok') assert(extractIssues(tools).some(line => line.startsWith(`[${item.expected.toUpperCase()}]`)));
});

test('incomplete nested metadata cannot establish a successful edit', () => {
  for (const complete of [false, true]) {
    const { tools } = normalizeBranch([{ type: 'message', id: 'outer-result', message: {
      role: 'toolResult', isError: false, toolName: 'wrapper', content: '',
      nestedCalls: { complete, calls: [
        { id: 'nested-ok', name: 'edit', arguments: { path: 'src/nested.ts' }, status: 'ok' },
        { id: 'nested-open', name: 'write', arguments: { path: 'src/open.ts' }, status: 'unfinished' },
      ] },
    } }]);
    assert.deepEqual(extractFiles(tools).lines, complete ? ['MODIFIED src/nested.ts'] : []);
  }
});

test('changing a referenced file never mutates or closes an issue', () => {
  const board = emptyBoard();
  board.sections.issues.push({ ts: '2026-01-01', text: 'src/sample.ts fails; still unverified' });
  const before = JSON.stringify(board);
  assert.match(revalidationCandidates(board, ['src/sample.ts'])[0], /RECHECK REQUIRED — not resolved/);
  assert.equal(JSON.stringify(board), before);
  assert.deepEqual(revalidationCandidates(board, []), []);
});

test('all 20 file candidates survive collection, including case-sensitive paths', () => {
  const entries = Array.from({ length: fixture.candidateBatchSize }, (_, i) => resultEntries(`File${i}`, { isError: false })).flat();
  const blocks = normalizeBranch(entries);
  blocks.tools.push({ ...blocks.tools[0], args: { path: 'src/file0.ts' } });
  const { draft } = extractAll(blocks, emptyBoard(), defaultState());
  assert.equal(draft.files.length, 21);
  assert(draft.files.includes('MODIFIED src/File0.ts'));
  assert(draft.files.includes('MODIFIED src/file0.ts'));
});

test('summary chooses globally newest entries rather than the last section', () => {
  let sawOmission = false;
  for (let maxChars = 1; maxChars <= 1400; maxChars++) {
    const selected = selectSummary(summaryBoard(), { maxChars });
    if (!selected.text) continue;
    assert(selected.text.length <= maxChars);
    const ids = selected.selected.map(item => item.entry.text.split(' ')[0]);
    assert.deepEqual(ids, ['NEWEST_GOAL', 'MIDDLE_FILE', 'OLDEST_NEXT'].slice(0, ids.length));
    if (selected.omitted) sawOmission = true;
    for (const section of selected.text.split('\n## ').slice(1)) assert.match(section.split('\n')[1], /^- /);
  }
  assert(sawOmission);
});

test('summary rejects invalid and impossible budgets, counting complete long paths', () => {
  for (const maxChars of [0, -1, 1, 10, 100, NaN, Infinity]) assert.equal(renderSummary(summaryBoard(), { maxChars }), null);
  assert.equal(renderSummary(summaryBoard(), { maxChars: 1000, boardFile: 'x'.repeat(2000) }), null);
});

test('files alone are never sufficient context for taking over compaction', () => {
  const board = emptyBoard();
  board.sections.files = [1, 2, 3].map(i => ({ ts: 't', text: `MODIFIED src/file${i}.ts` }));
  assert.equal(hasSummaryContext(board), false);
  board.sections.goal.push({ ts: 't', text: 'Review the project' });
  assert.equal(hasSummaryContext(board), false);
  board.sections.next.push({ ts: 't', text: 'Inspect the parser' });
  assert.equal(hasSummaryContext(board), true); // minimum shape, NOT a coverage proof
});

test('long findings preserve the final negative qualifier or are rejected intact', () => {
  const text = '实测：' + '这是需要保留的实验描述。'.repeat(35) + '尚未验证，不能视为成功';
  assert.equal(extractFindings([{ entryId: 'finding', text }])[0], text);
  assert.throws(() => cleanEntryText(text, 300), /Nothing was truncated/);
  assert.equal(cleanEntryText('  尚未验证\n不能视为成功  ', 300), '尚未验证 不能视为成功');
});

test('Chinese constraints preserve negatives and do not turn questions into preferences', () => {
  const constraint = '未经用户批准，不得修改源码；预算不得超过10元。' + '此结论尚未验证。'.repeat(40);
  assert.deepEqual(extractPrefs([{ entryId: 'u', text: constraint }], []), [constraint]);
  assert.deepEqual(extractPrefs([{ entryId: 'q', text: '不要使用缓存会怎样？' }], []), []);
  const { draft } = extractAll({ users: [{ entryId: 'g', text: '先别实现，改为只读审查；之前的方案尚未批准。' }], assistants: [], tools: [] }, emptyBoard(), defaultState());
  assert(draft.goal.includes('先别实现，改为只读审查；之前的方案尚未批准。'));
});

test('same timestamps use explicit event order independent of section layout', () => {
  const board = summaryBoard();
  for (const entries of Object.values(board.sections)) for (const entry of entries) entry.ts = '2026-01-01T00:00:00Z';
  assert.deepEqual(selectSummary(board).selected.map(x => x.entry.order), [3, 2, 1]);
  assert.deepEqual(selectSummary(board).selected.map(x => x.entry.order), [3, 2, 1]);
});

test('exact boundary budgets and long Windows paths never overflow or split claims', () => {
  const board = summaryBoard();
  const options = { boardFile: ['C:', ...Array(20).fill('folder & 中文'), 'snapshot.md'].join(String.fromCharCode(92)) };
  const full = renderSummary(board, { ...options, maxChars: 10000 });
  assert(full);
  assert.equal(renderSummary(board, { ...options, maxChars: full.length }), full);
  const less = renderSummary(board, { ...options, maxChars: full.length - 1 });
  assert(less === null || less.length <= full.length - 1);
  const large = emptyBoard();
  large.sections.goal.push({ ts: '2026-01-03', text: 'x'.repeat(5000) + ' NOT VERIFIED' });
  large.sections.files.push({ ts: '2026-01-02', text: 'small old file' });
  large.sections.next.push({ ts: '2026-01-01', text: 'small old next' });
  assert.equal(renderSummary(large, { maxChars: 1000 }), null, 'do not skip the newest long entry to fill the budget with older snippets');
});

test('an oversized input rejects the whole legacy commit before any board writes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => commitEntries(dir, 'synthetic', { maxEntriesPerSection: 1, maxEntryChars: 30 }, [
    { section: 'findings', text: 'short first entry' },
    { section: 'findings', text: 'x'.repeat(40) + ' NOT VERIFIED' },
  ]), /Nothing was truncated/);
  assert.equal(existsSync(join(dir, 'synthetic.md')), false);
  assert.equal(existsSync(join(dir, 'archive')), false);
});

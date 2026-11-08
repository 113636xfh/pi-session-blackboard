/** Parent-side evidence verifier: never trust a worker's PASS flag on its own. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config, fixturePath, resumePrompt } from './protocol.mjs';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
export function verifyCase(spec, row) {
  const issues = [];
  const check = (ok, issue) => { if (!ok) issues.push(issue); };
  try {
    const cycles = spec.cycles ?? 1, task = config.tasks.find(t => t.id === spec.task);
    check(row?.passed === true && row.status === 'passed', 'worker did not complete');
    if (!row || !task) throw new Error('missing row or task');
    check(row.arm === spec.arm.id, 'wrong arm in result');
    check(row.completedRounds === spec.rounds * cycles && row.completedCycles === cycles, 'wrong completed round/cycle count');
    check(row.compactions === cycles && row.cycles?.length === cycles, 'wrong compaction count');
    check(row.modelCalls === row.requests?.length && row.modelCalls <= spec.maxRequests, 'request count/budget mismatch');
    check(row.summaryCalls === row.requests?.filter(r => r.kind === 'summarizer').length, 'summary count mismatch');
    check(row.requests?.every((r, i) => r.id === i + 1 && r.completed && ['toolUse', 'stop'].includes(r.stopReason)), 'incomplete/failed model response');
    check(Array.isArray(row.errors) && row.errors.length === 0, 'extension errors in completed result');
    if (!spec.live) check(row.offlineNetworkCalls === 0, 'offline run attempted network access');
    const settings = json(join(spec.dir, 'settings.json'));
    check(settings.compaction?.enabled === false && settings.compaction.keepRecentTokens === spec.tail && settings.compaction.reserveTokens === 4096, 'resolved budgets differ from protocol');
    const allowed = ['write', ...(spec.arm.extension ? ['blackboard', 'blackboard_recall'] : [])].sort();
    check(JSON.stringify(settings.activeTools?.slice().sort()) === JSON.stringify(allowed), 'unexpected active tools');
    const model = json(join(spec.dir, 'model.json'));
    check(model.live === spec.live && model.maxTokens === spec.maxTokens, 'model descriptor differs from spec');
    check(spec.live ? `${model.provider}/${model.model}` === spec.model : model.provider === 'eval-offline' && model.model === 'fixed', 'wrong model/provider');
    const files = readdirSync(join(spec.dir, 'sessions')).filter(p => p.endsWith('.jsonl'));
    check(files.length === 1, 'expected exactly one persisted session');
    const entries = readFileSync(join(spec.dir, 'sessions', files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const nodes = entries.filter(e => e.type !== 'session' && e.id && Object.hasOwn(e, 'parentId'));
    const byId = new Map(nodes.map(e => [e.id, e]));
    check(byId.size === nodes.length, 'duplicate persisted entry IDs');
    const branch = new Set();
    let node = nodes.at(-1);
    while (node) {
      if (branch.has(node.id)) throw new Error('session parent cycle');
      branch.add(node.id);
      if (!node.parentId) break;
      node = byId.get(node.parentId);
      if (!node) throw new Error('broken persisted parent chain');
    }
    const compactions = nodes.filter(e => branch.has(e.id) && e.type === 'compaction');
    check(compactions.length === cycles, 'persisted compaction count differs from result');
    const planned = new Set();
    for (let c = 1; c <= cycles; c++) for (let r = 0; r < spec.rounds; r++) {
      const path = resolve(spec.dir, 'project', fixturePath(c, r, cycles)); planned.add(path);
      check(readFileSync(path, 'utf8').trim() === task.steps[Math.min(r, task.steps.length - 1)], `wrong fixture output: ${fixturePath(c, r, cycles)}`);
    }
    const writes = new Set(), writePositions = new Map();
    for (const e of nodes) for (const call of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (e.message.role !== 'assistant' || call.type !== 'toolCall') continue;
      check(allowed.includes(call.name), 'unapproved tool in persisted transcript');
      check(!call.argumentsError, 'malformed persisted tool arguments');
      if (call.name !== 'write') continue;
      const path = resolve(spec.dir, 'project', call.arguments?.path ?? '');
      check(planned.has(path), 'unexpected write path in persisted transcript');
      const index = nodes.indexOf(e);
      const result = nodes.slice(index + 1).find(n => n.message?.role === 'toolResult' && n.message.toolCallId === call.id)?.message;
      check(result?.toolName === 'write' && result.isError !== true, 'fixture write lacks successful persisted tool result');
      if (result && !result.isError) { writes.add(path); writePositions.set(path, [...(writePositions.get(path) ?? []), index]); }
    }
    check([...planned].every(path => writes.has(path)), 'fixture files are not backed by tool writes');
    let takeovers = 0, previousAnswerIndex = -1;
    for (let c = 1; c <= cycles; c++) {
      const saved = json(join(spec.dir, 'cycles', String(c), 'compaction.json'));
      const resume = json(join(spec.dir, 'cycles', String(c), 'resume.json'));
      const persisted = compactions[c - 1], claimed = row.cycles?.[c - 1];
      check(saved.id === persisted?.id && saved.summary === persisted?.summary && saved.firstKeptEntryId === persisted?.firstKeptEntryId, 'saved compaction differs from session');
      check(claimed?.cycle === c && claimed.compactionId === persisted?.id && resume.compactionId === persisted?.id, 'cycle-to-entry mapping mismatch');
      check(byId.has(persisted?.firstKeptEntryId), 'cut-point entry missing from persisted history');
      const answer = byId.get(resume.answerEntryId);
      check(answer?.message?.role === 'assistant' && branch.has(answer.id), 'resume answer not on persisted branch');
      const cutIndex = nodes.indexOf(persisted), answerIndex = nodes.indexOf(answer), nextCut = compactions[c];
      check(answerIndex > cutIndex && (!nextCut || answerIndex < nodes.indexOf(nextCut)), 'resume is outside its compaction cycle');
      let prompt = byId.get(answer?.parentId);
      while (prompt && prompt.type !== 'message' && prompt.type !== 'compaction') prompt = byId.get(prompt.parentId);
      check(prompt?.message?.role === 'user' && text(prompt.message) === resumePrompt && answer?.message?.stopReason === 'stop', 'resume is not a direct completed answer to the probe');
      for (let r = 0; r < spec.rounds; r++) {
        const path = resolve(spec.dir, 'project', fixturePath(c, r, cycles));
        check(writePositions.get(path)?.some(i => i > previousAnswerIndex && i < cutIndex), 'fixture write is outside its own cycle');
      }
      previousAnswerIndex = answerIndex;
      check(text(answer?.message) === resume.answer && resume.answer === claimed?.answer, 'resume answer differs from persisted message');
      check(persisted?.summary?.includes(task.constraint) && resume.answer?.includes(task.constraint), 'constraint missing from summary/resume');
      for (const probe of task.probes.filter(p => p.mustContain)) check(persisted?.summary?.includes(probe.mustContain) && resume.answer?.includes(probe.mustContain), 'required literal missing from actual evidence');
      if (persisted?.fromHook) takeovers++;
    }
    check(row.takeovers === takeovers, 'takeover count differs from persisted nodes');
    check(row.answer === row.cycles?.at(-1)?.answer, 'final answer mismatch');
  } catch (error) { issues.push(`cannot verify artifacts: ${error.message}`); }
  return { passed: issues.length === 0, failureKind: issues.length ? 'evidence-infrastructure' : null, issues };
}

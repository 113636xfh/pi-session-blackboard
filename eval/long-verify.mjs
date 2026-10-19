/** Independent structural and diagnostic verification. Quality misses are data, not PASS. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixturePath } from './protocol.mjs';
import { longWrite, longProbePrompt, evaluateLongAnswer } from './long-protocol.mjs';
import { recoverableNoteError } from './long-errors.mjs';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
function graph(path) {
  const raw = readFileSync(path), rows = raw.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  const nodes = rows.filter(e => e.type !== 'session' && e.id && Object.hasOwn(e, 'parentId'));
  const byId = new Map(nodes.map(e => [e.id, e]));
  if (byId.size !== nodes.length) throw new Error('duplicate persisted IDs');
  const branch = new Set(); let node = nodes.at(-1);
  while (node) {
    if (branch.has(node.id)) throw new Error('persisted parent cycle'); branch.add(node.id);
    if (!node.parentId) break; node = byId.get(node.parentId); if (!node) throw new Error('broken persisted parent chain');
  }
  return { raw, nodes, byId, branch };
}
export function verifyLongCase(spec, row) {
  const issues = [], diagnostics = [], check = (ok, why) => { if (!ok) issues.push(why); };
  try {
    check(row?.executionPassed === true && row.status === 'completed', 'worker did not complete execution');
    check(row.completedCycles === spec.cycles && row.completedRounds === spec.cycles * spec.rounds, 'cycle/round count mismatch');
    check(row.modelCalls === row.requests.length && row.modelCalls <= spec.maxRequests, 'request budget/count mismatch');
    check(row.cycles.length === spec.cycles, 'missing cycle evidence');
    if (!spec.live) check(row.offlineNetworkCalls === 0, 'offline network attempt');
    const model = json(join(spec.dir, 'model.json')), settings = json(join(spec.dir, 'settings.json'));
    check(model.live === spec.live && model.maxTokens === spec.maxTokens && model.reasoning === 'off', 'model/output settings mismatch');
    check(spec.live ? `${model.provider}/${model.model}` === spec.model : model.provider === 'eval-offline', 'wrong model');
    check(settings.compaction.enabled === false && settings.compaction.keepRecentTokens === spec.tail, 'tail/auto settings mismatch');
    check(JSON.stringify(settings.activeTools.slice().sort()) === JSON.stringify(['write', ...(spec.arm.extension ? ['blackboard', 'blackboard_recall'] : [])].sort()), 'unexpected active tools');
    const files = readdirSync(join(spec.dir, 'sessions')).filter(f => f.endsWith('.jsonl'));
    check(files.length === 1, 'expected exactly one main session');
    const main = graph(join(spec.dir, 'sessions', files[0]));
    check(!main.nodes.some(n => n.message?.role === 'user' && text(n.message) === longProbePrompt), 'probe leaked into main trajectory');
    const cuts = main.nodes.filter(n => main.branch.has(n.id) && n.type === 'compaction');
    check(cuts.length === spec.cycles, 'persisted cut count mismatch');
    check(Array.isArray(row.errors) && row.errors.length === 0, 'main extension errors');
    for (const error of row.toolErrors ?? []) check(recoverableNoteError(error.tool, error.result), 'unclassified/infrastructure tool failure');
    let previousCut = -1;
    for (let cycle = 1; cycle <= spec.cycles; cycle++) {
      const evidence = json(join(spec.dir, 'cycles', String(cycle), 'resume.json'));
      const saved = json(join(spec.dir, 'cycles', String(cycle), 'compaction.json'));
      const cut = cuts[cycle - 1], cutIndex = main.nodes.indexOf(cut);
      check(saved.id === cut.id && saved.summary === cut.summary && saved.firstKeptEntryId === cut.firstKeptEntryId, 'saved compaction differs from persisted cut');
      check(main.byId.has(cut.firstKeptEntryId) && evidence.compactionId === cut.id, 'cut point/evidence mismatch');
      for (let r = 0; r < spec.rounds; r++) {
        const path = resolve(spec.dir, 'project', fixturePath(cycle, r, spec.cycles));
        check(readFileSync(path, 'utf8').trim() === longWrite(cycle, r), 'wrong fixture output');
        const calls = main.nodes.slice(previousCut + 1, cutIndex).filter(n => n.message?.role === 'assistant').flatMap(n => n.message.content.filter(p => p.type === 'toolCall' && p.name === 'write'));
        const call = calls.find(c => resolve(spec.dir, 'project', c.arguments?.path ?? '') === path);
        check(call && main.nodes.slice(previousCut + 1, cutIndex).some(n => n.message?.role === 'toolResult' && n.message.toolCallId === call.id && !n.message.isError), 'write lacks successful in-cycle result');
      }
      previousCut = cutIndex;
      const probe = evidence.probe;
      const probeRequests = row.requests.filter(r => r.cycle === cycle && r.kind === 'probe');
      check(probeRequests.length === 1 && probeRequests[0].completed && !probeRequests[0].error
        && probeRequests[0].stopReason === 'stop', 'probe did not complete exactly one successful request');
      check(!probe.error && probe.stopReason === 'stop', 'probe execution/setup failure');
      check(probe.mainHashBefore === probe.mainHashAfter && sha(main.raw.subarray(0, probe.sourceBytes)) === probe.mainHashBefore, 'probe/main prefix hash mismatch');
      check(main.byId.has(probe.sourceLeafId), 'probe source leaf missing');
      const snapshot = graph(probe.sessionFile);
      check(snapshot.byId.has(cut.id), 'probe does not contain its source compaction');
      const answer = snapshot.byId.get(probe.answerEntryId);
      if (probe.error || probe.stopReason !== 'stop') {
        diagnostics.push({ cycle, outcome: 'invalid-probe', error: probe.error, passed: false, score: null });
      } else {
        check(answer?.message.role === 'assistant' && text(answer.message) === evidence.answer && evidence.answer === probe.answer, 'probe answer differs from persisted response');
        const prompt = [...snapshot.nodes.slice(0, snapshot.nodes.indexOf(answer))].reverse().find(n => n.message?.role === 'user');
        check(text(prompt?.message) === longProbePrompt, 'wrong persisted diagnostic prompt');
        diagnostics.push({ cycle, outcome: 'completed', ...evaluateLongAnswer(cycle, text(answer.message)) });
      }
    }
    for (const [i, request] of row.requests.entries()) {
      check(request.id === i + 1 && (request.completed || request.error), 'unterminated request record');
      const input = json(request.inputPath);
      if (request.kind === 'probe') check((input.tools ?? []).length === 0, 'probe had active tool definitions');
      if (request.completed) { const output = json(request.outputPath); check(output.stopReason === request.stopReason, 'response artifact mismatch'); }
      if (request.kind !== 'probe') check(['stop', 'toolUse'].includes(request.stopReason), 'main request failed/truncated');
    }
  } catch (error) { issues.push(`cannot verify long-run evidence: ${error.message}`); }
  return { executionPassed: issues.length === 0, qualityPassed: diagnostics.length === spec.cycles && diagnostics.every(d => d.passed), issues, diagnostics };
}

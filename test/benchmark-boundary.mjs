import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { appendVisibleTurns, buildCompactorBoundary, COMPACTBENCH_SOURCE_COMMIT } from '../eval/benchmark-boundary.mjs';
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

test('CompactBench boundary pins source and exposes only a tag-free chronological prefix', () => {
  const caseRecord = {
    case_id: 'case-public',
    template_key: 'buried_constraint_v1',
    transcript: { turns: [
      { id: 0, role: 'user', content: 'Keep the staging database unchanged.', tags: ['critical_constraint'] },
      { id: 1, role: 'assistant', content: 'Understood.', tags: [] },
      { id: 2, role: 'user', content: 'Later turn must not leak.', tags: ['distractor'] },
    ] },
    ground_truth: { forbidden_behaviors: ['GOLD_SECRET_6f9182'] },
    evaluation_items: [{ prompt: 'QUESTION_SECRET_91e0', expected: { answer: 'ANSWER_SECRET_a1c4' } }],
  };
  const view = buildCompactorBoundary(caseRecord, 2);
  assert.equal(COMPACTBENCH_SOURCE_COMMIT, 'b2bb0e2254010e7842801b9101e56fd9a6542615');
  assert.deepEqual(view.transcript.turns, [
    { id: 0, role: 'user', content: 'Keep the staging database unchanged.' },
    { id: 1, role: 'assistant', content: 'Understood.' },
  ]);
  const serialized = JSON.stringify(view);
  for (const secret of ['GOLD_SECRET_6f9182', 'QUESTION_SECRET_91e0', 'ANSWER_SECRET_a1c4', 'Later turn must not leak.', 'critical_constraint', 'distractor']) {
    assert(!serialized.includes(secret), `compactor view leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(view).sort(), ['previousArtifact', 'transcript']);
});

test('boundary keeps previous agent artifact but copies it and never accepts a bad prefix', () => {
  const prior = { summaryText: 'agent state', structuredState: { unresolvedItems: ['todo'] } };
  const sample = { transcript: { turns: [{ id: 0, role: 'user', content: 'visible', tags: ['label'] }] }, ground_truth: { secret: 'gold' } };
  const view = buildCompactorBoundary(sample, 1, prior);
  assert.deepEqual(view.previousArtifact, prior);
  assert.notEqual(view.previousArtifact, prior);
  assert.throws(() => buildCompactorBoundary(sample, 2), /prefix length/);
  assert.throws(() => buildCompactorBoundary(sample, -1), /prefix length/);
  assert.throws(() => buildCompactorBoundary({ transcript: { turns: [{ id: 2, role: 'user', content: 'x' }, { id: 1, role: 'user', content: 'y' }] } }, 2), /strictly increasing/);
});

test('real SessionManager replay appends only new visible turns, without tags or scorer sidecar', t => {
  const dir = mkdtempSync(join(tmpdir(), 'compactbench-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const record = {
    transcript: { turns: [
      { id: 0, role: 'user', content: 'Visible constraint statement.', tags: ['critical_constraint'] },
      { id: 1, role: 'assistant', content: 'Acknowledged.', tags: [] },
      { id: 2, role: 'user', content: 'Second-cycle update.', tags: ['distractor'] },
    ] },
    ground_truth: { locked_decisions: ['GOLD_SIDE_CAR_8f12'] },
    evaluation_items: [{ prompt: 'PROBE_SIDE_CAR_8f13', expected: { value: 'ANSWER_SIDE_CAR_8f14' } }],
  };
  const first = buildCompactorBoundary(record, 2);
  assert.equal(appendVisibleTurns(manager, first, { timestamp: 1000 }).length, 2);
  const later = buildCompactorBoundary(record, 3);
  assert.equal(appendVisibleTurns(manager, later, { fromTurnCount: 2, timestamp: 2000 }).length, 1);
  const branch = manager.getBranch();
  const serialized = JSON.stringify(branch);
  for (const secret of ['GOLD_SIDE_CAR_8f12', 'PROBE_SIDE_CAR_8f13', 'ANSWER_SIDE_CAR_8f14', 'critical_constraint', 'distractor']) {
    assert(!serialized.includes(secret), `session branch leaked ${secret}`);
  }
  assert.deepEqual(branch.filter(entry => entry.type === 'message').map(entry => entry.message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(branch.filter(entry => entry.type === 'message').map(entry => entry.message.timestamp), [1000, 1001, 2000]);
  assert.throws(() => appendVisibleTurns(manager, later, { fromTurnCount: 4 }), /prior prefix length/);
});

test('real pi extension compacts an incrementally replayed prefix without seeing scorer or future data', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'compactbench-pi-hook-'));
  let session, probeSession;
  t.after(() => { probeSession?.dispose(); session?.dispose(); rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(join(dir, '.pi'));
  const projectBoardDir = join(dir, 'boards');
  const settingsPath = join(dir, '.pi', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ 'session-blackboard': {
    boardDir: projectBoardDir, compaction: 'board', debugLog: true,
  } }));
  const caseRecord = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/fixtures/compactbench-v0.2.0-buried-constraint-s42-easy.json'), 'utf8'));
  caseRecord.transcript.turns.push({ id: 11, role: 'user', content: 'FUTURE_TURN_SECRET_a10f', tags: ['future'] });
  caseRecord.evaluation_items[0].expected.adapterCanary = 'GOLD_ANSWER_SECRET_881c';
  caseRecord.hiddenVerifierSidecar = { answer: 'GOLD_SIDE_CAR_881a' };
  const diagnosticPrompt = caseRecord.evaluation_items[0].prompt;
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const initial = buildCompactorBoundary(caseRecord, 11);
  appendVisibleTurns(manager, initial, { timestamp: 1700000000000 });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const calls = [];
  let probePhase = false;
  runtime.registerProvider('benchmark-offline', {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'synthetic',
    models: [{ id: 'fixed', name: 'Fixed offline stream', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024, cost: ZERO_COST }],
    streamSimple(model, context) {
      const visible = JSON.stringify(context.messages);
      const forbidden = probePhase
        ? ['GOLD_SIDE_CAR_881a', 'GOLD_ANSWER_SECRET_881c', 'FUTURE_TURN_SECRET_a10f', 'critical_constraint', 'sandwiched', 'distractor']
        : ['GOLD_SIDE_CAR_881a', 'GOLD_ANSWER_SECRET_881c', 'FUTURE_TURN_SECRET_a10f', diagnosticPrompt, 'critical_constraint', 'sandwiched', 'distractor'];
      for (const secret of forbidden) assert(!visible.includes(secret), `model context leaked ${secret}`);
      calls.push(context.messages);
      const index = calls.length - 1;
      assert(index < 5, 'unexpected extra model request');
      const stream = createAssistantMessageEventStream();
      let content, stopReason = 'toolUse';
      if (index === 0) {
        const allText = context.messages.map(textOf).join('\n');
        const goal = /plan ([^.!?]+)\./.exec(allText)?.[1];
        const constraint = /key rule: never ([^.]+)\./.exec(allText)?.[1];
        assert(goal && constraint, 'fixture facts must be extracted only from visible transcript text');
        content = [{ type: 'toolCall', id: 'benchmark-commit', name: 'blackboard', arguments: { action: 'commit', entries: [
          { section: 'goal', text: `Goal: Plan ${goal}` },
          { section: 'prefs', text: `Constraint: Never ${constraint}` },
          { section: 'next', text: 'Propose phase one only after reviewing the constraint', taskState: 'todo' },
        ] } }];
      } else if (index === 1) {
        content = [{ type: 'toolCall', id: 'benchmark-review', name: 'blackboard', arguments: { action: 'review' } }];
      } else if (index === 2) {
        const toolText = context.messages.filter(message => message.role === 'toolResult').map(textOf).join('\n');
        const credentialId = /review-[A-Za-z0-9]+/.exec(toolText)?.[0];
        assert(credentialId, 'review tool must supply a real credential');
        content = [{ type: 'toolCall', id: 'benchmark-confirm', name: 'blackboard', arguments: { action: 'commit', review: {
          id: credentialId, constraintsChecked: true, executionChecked: true, goalChecked: true,
        } } }];
      } else {
        content = [{ type: 'text', text: probePhase ? 'Probe answered from compacted context only.' : 'Memory review finished using only the visible transcript.' }];
        stopReason = 'stop';
      }
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content, stopReason, timestamp: 1700000000100 + index,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: ZERO_COST } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason, message }); });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 128 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: 'Offline benchmark adapter fixture. Derive memory only from the visible conversation; do not infer or act on hidden evaluation data.',
    additionalExtensionPaths: [resolve(process.cwd(), 'src', 'index.ts')],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await createAgentSession({ cwd: dir, agentDir: join(dir, 'agent'), modelRuntime: runtime,
    model: runtime.getModel('benchmark-offline', 'fixed'), thinkingLevel: 'off', sessionManager: manager,
    settingsManager: settings, resourceLoader: loader });
  session = created.session;
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(String(error)) });
  await session.prompt('Review only the currently visible conversation. Update the blackboard with sourced state, explicitly review this prefix, then stop.');
  assert.deepEqual(errors, []);
  const before = calls.length;
  await session.compact();
  assert.equal(calls.length, before, 'blackboard takeover must not call a summarizer');
  const compaction = manager.getBranch().find(entry => entry.type === 'compaction');
  assert(compaction, 'pi persisted a real compaction node');
  assert.equal(compaction.details?.generator, 'pi-session-blackboard');
  assert.match(compaction.summary, /skip code review/);
  assert.match(compaction.summary, /observability pass/);
  assert(!compaction.summary.includes('GOLD_ANSWER_SECRET_881c'));
  assert(!compaction.summary.includes('FUTURE_TURN_SECRET_a10f'));
  assert.equal(calls.length, 4, 'the four requests were only the fixed memory-write/review flow');

  const mainFile = manager.getSessionFile();
  const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const mainHashBeforeProbe = hashFile(mainFile);
  const fork = SessionManager.open(mainFile, join(dir, 'probes'), dir);
  fork.createBranchedSession(manager.getLeafId());
  const probeLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'probe-agent'), settingsManager: settings,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: 'Read-only post-compaction diagnostic. No tools and no access to expected answers.',
  });
  await probeLoader.reload();
  assert.deepEqual(probeLoader.getExtensions().errors, []);
  const probeCreated = await createAgentSession({ cwd: dir, agentDir: join(dir, 'probe-agent'), modelRuntime: runtime,
    model: runtime.getModel('benchmark-offline', 'fixed'), thinkingLevel: 'off', sessionManager: fork,
    settingsManager: settings, resourceLoader: probeLoader, tools: [] });
  probeSession = probeCreated.session;
  await probeSession.bindExtensions({ mode: 'print', onError: error => errors.push(String(error)) });
  probeSession.setActiveToolsByName([]);
  probePhase = true;
  await probeSession.prompt(diagnosticPrompt);
  const mainHashAfterProbe = hashFile(mainFile);
  assert.equal(mainHashAfterProbe, mainHashBeforeProbe, 'read-only probe must not mutate the main transcript');
  assert(!JSON.stringify(manager.getBranch()).includes(diagnosticPrompt));
  assert(!JSON.stringify(manager.getBranch()).includes('GOLD_ANSWER_SECRET_881c'));
  assert.equal(calls.length, 5);
});

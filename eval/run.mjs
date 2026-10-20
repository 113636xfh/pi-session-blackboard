/** Isolated real-SDK worker; direct public invocation delegates to the same supervisor. */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ROOT, config, save, systemPrompt, roundPrompt, fixturePath, resumePrompt } from './protocol.mjs';
import { LONG_PROTOCOL, longTask, longRound, longWrite, longSystem, expectedState, evaluateLongAnswer } from './long-protocol.mjs';
import { snapshotProbe } from './long-probe.mjs';
import { assertAuthorizedSpec } from './long-auth.mjs';
import { recoverableNoteError } from './long-errors.mjs';
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');

export async function worker(spec) {
  const isLong = spec.protocol === LONG_PROTOCOL;
  if (isLong) assertAuthorizedSpec(spec);
  const { arm, dir } = spec, task = isLong ? longTask : config.tasks.find(t => t.id === spec.task);
  const extension = arm.extension ? resolve(ROOT, arm.extension) : null;
  const project = join(dir, 'project'); mkdirSync(join(project, '.pi'), { recursive: true });
  // Old code falls back to process.cwd() when SDK contexts omit cwd. Isolate that too.
  process.chdir(project);
  writeFileSync(join(project, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': {
    boardDir: join(project, 'boards'), compaction: arm.compaction ?? 'off', debugLog: true,
  } }));
  let session, activeSession, round = 0, cycle = 1, phase = 'startup', phaseRequest = 0, phaseTools = 0, phaseCalls = 0, noteWrites = 0, fatal = null, failureKind = null;
  const cycles = spec.cycles ?? 1;
  const requests = [], toolTrail = [], errors = [], toolErrors = [], cycleResults = [];
  const started = Date.now();
  const progress = { status: 'running', pid: process.pid, phase, completedRounds: 0, completedCycles: 0, modelCalls: 0, requests, toolTrail };
  const persist = () => save(join(dir, 'progress.json'), { ...progress, phase, cycle, toolErrorCount: toolErrors.length, wallMs: Date.now() - started, fatal, failureKind });
  const fail = (reason, kind = 'model-or-tool') => {
    if (!fatal) { fatal = reason; failureKind = kind; }
    try { persist(); } finally { if (activeSession ?? session) void (activeSession ?? session).abort().catch(() => {}); }
  };
  persist();
  let fetchCalls = 0;
  const oldFetch = globalThis.fetch;
  if (!spec.live) globalThis.fetch = () => { fetchCalls++; throw new Error('NETWORK FORBIDDEN in offline evaluation'); };
  try {
    const manager = SessionManager.create(project, join(dir, 'sessions'));
    const runtime = await ModelRuntime.create(spec.live
      ? { allowModelNetwork: false, refreshOnCreate: false }
      : { authPath: join(project, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const split = spec.live ? spec.model.indexOf('/') : -1;
    const provider = spec.live ? spec.model.slice(0, split) : 'eval-offline';
    const modelId = spec.live ? spec.model.slice(split + 1) : 'fixed';
    if (!spec.live) runtime.registerProvider(provider, {
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/unused', apiKey: 'synthetic',
      models: [{ id: modelId, name: 'Fixed fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: spec.maxTokens, cost: ZERO_COST }],
      streamSimple(model, context, providerOptions) {
        const expectedCap = phase === 'resume' ? spec.probeMaxTokens : phase === 'compact' ? spec.summaryMaxTokens : spec.maxTokens;
        if (isLong && providerOptions.maxTokens !== expectedCap) throw new Error('Output cap was not forwarded to provider');
        const stream = createAssistantMessageEventStream();
        // Fault injection is unreachable in live mode: exercise cancellation without a GPU.
        if (spec.fixtureFault === 'hang') { setInterval(() => {}, 1000); return stream; }
        const step = phaseRequest++, stepText = isLong ? longWrite(cycle, round) : task.steps[Math.min(round, task.steps.length - 1)];
        const state = isLong ? expectedState(cycle) : null;
        const notes = isLong ? [
          { section: 'goal', text: `STATE_SLOT_GOAL ${state.objective}` },
          { section: 'prefs', text: `STATE_SLOT_CONSTRAINT ${state.constraint}; deployApproved=${state.deployApproved}` },
          { section: 'findings', text: `STATE_SLOT_CONTEXT path=${state.path}; hypothesis=${state.hypothesis}` },
          { section: 'next', text: `STATE_SLOT_PROGRESS status=${state.status}; next=${state.next}`, ...(arm.id === 'board-fixed' ? { taskState: state.status } : {}) },
        ].map(e => ({ ...e, ...(noteWrites ? { supersedes: e.text.split(' ')[0] } : {}) })) : [
          { section: 'goal', text: `Complete fixture: ${task.steps.join(', ')}` },
          { section: 'prefs', text: `Constraint: ${task.constraint}` },
          { section: 'next', text: `Fixture step ${round + 1} complete; next ${task.steps[Math.min(round + 1, task.steps.length - 1)]}` },
          ...task.steps.filter(s => s.includes('src/')).map(s => ({ section: 'files', text: s })),
        ];
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult');
        const credential = /"id"\s*:\s*"(review-[A-Za-z0-9]+)"/.exec(lastTool ? textOf(lastTool) : '')?.[1];
        let call = null;
        if (phase.startsWith('round')) {
          if (step === 0) call = { name: 'write', arguments: { path: fixturePath(cycle, round, cycles), content: stepText } };
          else if (arm.extension && step === 1) { call = { name: 'blackboard', arguments: { action: 'commit', entries: notes } }; noteWrites++; }
          else if (arm.id === 'board-fixed' && step === 2) call = { name: 'blackboard', arguments: { action: 'review' } };
          else if (arm.id === 'board-fixed' && step === 3 && credential) call = { name: 'blackboard', arguments: { action: 'commit', review: { id: credential, constraintsChecked: true, executionChecked: true, goalChecked: true } } };
        }
        if (spec.fixtureFault === 'note-source' && phase.startsWith('round') && arm.id === 'board-fixed') {
          if (step === 1) { call.arguments.entries[0].sources = [{ entryId: 'fake-source', fingerprint: 'not-a-real-source', kind: 'assistant' }]; noteWrites--; }
          if (step === 2) { call = { name: 'blackboard', arguments: { action: 'commit', entries: notes } }; noteWrites++; }
          if (step === 3) call = { name: 'blackboard', arguments: { action: 'review' } };
          if (step === 4 && credential) call = { name: 'blackboard', arguments: { action: 'commit', review: { id: credential, constraintsChecked: true, executionChecked: true, goalChecked: true } } };
        }
        if (spec.fixtureFault === 'note-validation' && phase.startsWith('round') && arm.id === 'board-fixed') {
          if (step === 1) { call.arguments.entries[0].section = 'constraints'; noteWrites--; }
          if (step === 2) { call = { name: 'blackboard', arguments: { action: 'commit', entries: notes } }; noteWrites++; }
          if (step === 3) call = { name: 'blackboard', arguments: { action: 'review' } };
          if (step === 4 && credential) call = { name: 'blackboard', arguments: { action: 'commit', review: { id: credential, constraintsChecked: true, executionChecked: true, goalChecked: true } } };
        }
        if (spec.fixtureFault === 'tool-loop' && phase.startsWith('round')) call = { name: 'write', arguments: { path: fixturePath(cycle, round, cycles), content: stepText } };
        if (spec.fixtureFault === 'extra-write' && step === 1) call = { name: 'write', arguments: { path: 'fixture/blackboard.md', content: 'unauthorized extra write' } };
        const text = isLong && phase === 'resume' ? (spec.fixtureFault === 'probe-bad-json' ? 'not json' : JSON.stringify(spec.fixtureFault === 'probe-wrong-state' ? { ...state, deployApproved: true } : state)) : phase === 'compact' || phase === 'resume'
          ? `## Goal\n${task.steps.join(', ')}\n## Constraints & Preferences\n${task.constraint}\n## Progress\nFixture step ${spec.rounds} complete.\n## Next Steps\n${task.steps.at(-1)}\n`
          : `Fixture step ${round + 1} complete.`;
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: 'toolCall', id: `call-${cycle}-${round}-${step}`, ...call }] : [{ type: 'text', text }],
          stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
          usage: { input: Math.ceil(context.messages.map(textOf).join('').length / 4), output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: ZERO_COST } };
        if (spec.fixtureFault === 'model-error' || (spec.fixtureFault === 'probe-transport' && phase === 'resume')) { message.stopReason = 'error'; message.errorMessage = 'injected model failure'; }
        if (spec.fixtureFault === 'probe-evidence-io' && phase === 'resume') mkdirSync(join(dir, 'requests', String(requests.at(-1).id), 'response.json'), { recursive: true });
        queueMicrotask(() => {
          stream.push({ type: 'start', partial: message });
          stream.push(message.stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message });
        });
        return stream;
      },
    });
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error('Pinned model is unavailable; no fallback model permitted');
    save(join(dir, 'model.json'), { provider, model: model.id, api: model.api, contextWindow: model.contextWindow,
      maxTokens: spec.maxTokens, probeMaxTokens: spec.probeMaxTokens ?? spec.maxTokens, summaryMaxTokens: spec.summaryMaxTokens ?? spec.maxTokens, temperature: 0, reasoning: 'off', live: spec.live });
    const observations = [];
    // Observe actual request starts/completions, including native summarization and failed calls.
    for (const method of ['stream', 'streamSimple']) {
      const original = runtime[method].bind(runtime);
      runtime[method] = (selectedModel, context, options) => {
        if (fatal) throw new Error(fatal);
        if (isLong) assertAuthorizedSpec(spec);
        if (isLong && phase === 'resume' && phaseCalls >= 1) {
          if (activeSession) void activeSession.abort().catch(() => {});
          throw new Error('Read-only probe exceeded its one-request budget');
        }
        phaseCalls++;
        if (requests.length >= spec.maxRequests) { fail('request budget exceeded', 'budget'); throw new Error(fatal); }
        const maxTokens = isLong && phase === 'compact' ? spec.summaryMaxTokens : isLong && phase === 'resume' ? spec.probeMaxTokens : spec.maxTokens;
        const record = { id: requests.length + 1, phase, cycle, maxTokens, kind: phase === 'compact' ? 'summarizer' : isLong && phase === 'resume' ? 'probe' : 'agent', method, startedMs: Date.now() - started, completed: false };
        requests.push(record); progress.modelCalls = requests.length; persist();
        const visibleContext = isLong && phase === 'resume' ? { ...context, tools: [] } : context;
        if (isLong) {
          record.inputPath = join(dir, 'requests', String(record.id), 'context.json');
          save(record.inputPath, { maxTokens, temperature: 0, systemPrompt: visibleContext.systemPrompt, messages: visibleContext.messages, tools: visibleContext.tools });
        }
        const stream = original(selectedModel, visibleContext, { ...options, maxTokens, temperature: 0,
          timeoutMs: Math.min(60000, spec.caseSeconds * 1000), maxRetries: 0 });
        observations.push(stream.result().then(message => {
          record.completed = true; record.wallMs = Date.now() - started - record.startedMs;
          record.stopReason = message.stopReason; record.usage = message.usage ?? null;
          if (isLong) { record.outputPath = join(dir, 'requests', String(record.id), 'response.json'); save(record.outputPath, message); }
          if (!fatal && record.kind !== 'probe' && ['error', 'aborted', 'length'].includes(message.stopReason)) { fatal = `model response ${message.stopReason}: ${message.errorMessage ?? ''}`; failureKind = 'model'; }
          persist();
        }).catch(error => { record.error = error.message; fatal ??= error.message; persist(); }));
        return stream;
      };
    }
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: spec.tail }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir: join(project, 'agent'), settingsManager: settings,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      systemPrompt: isLong ? longSystem(arm) : systemPrompt(arm), ...(extension ? { additionalExtensionPaths: [extension] } : {}),
      extensionFactories: [pi => {
        pi.on('tool_call', event => {
          phaseTools++;
          const entry = { phase, cycle, tool: event.toolName, action: event.input?.action ?? null, atMs: Date.now() - started };
          toolTrail.push(entry);
          const allowed = ['write', ...(arm.extension ? ['blackboard', 'blackboard_recall'] : [])];
          if (!allowed.includes(event.toolName)) fail(`unapproved tool: ${event.toolName}`);
          if (phaseTools > spec.maxTools) fail('tool budget exceeded', 'budget');
          if (event.toolName === 'write') {
            const expected = resolve(project, fixturePath(cycle, round, cycles));
            if (resolve(project, event.input.path) !== expected) fail('write outside the requested fixture path');
          }
          persist();
          if (!spec.live && spec.fixtureFault === 'note-eio' && event.toolName === 'blackboard') return { block: true, reason: 'EIO injected note-tool failure' };
          if (fatal) return { block: true, reason: fatal };
        });
      }],
    });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error(`Extension load errors: ${JSON.stringify(loader.getExtensions().errors)}`);
    if (extension && !loader.getExtensions().extensions.some(e => resolve(e.path) === extension)) throw new Error('Requested extension was not loaded');
    const created = await createAgentSession({ cwd: project, agentDir: join(project, 'agent'), modelRuntime: runtime,
      model, thinkingLevel: 'off', sessionManager: manager, settingsManager: settings, resourceLoader: loader,
      tools: ['write', ...(arm.extension ? ['blackboard', 'blackboard_recall'] : [])] });
    session = created.session; activeSession = session;
    session.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.isError) {
        toolErrors.push({ cycle, phase, tool: event.toolName, result: event.result }); persist();
        // In long diagnostics a rejected note is observable model behavior; permit bounded
        // self-correction. Failed writes/path violations and infrastructure still abort.
        if (!isLong || !recoverableNoteError(event.toolName, event.result)) fail(`tool failed: ${event.toolName}: ${JSON.stringify(event.result).slice(0, 800)}`);
      }
    });
    await session.bindExtensions({ mode: 'print', onError: error => { errors.push(String(error)); fail(`extension error: ${String(error)}`, 'extension'); } });
    save(join(dir, 'settings.json'), { compaction: settings.getCompactionSettings(model), activeTools: session.getActiveToolNames?.() ?? null });
    const begin = name => { phase = name; phaseRequest = 0; phaseTools = 0; phaseCalls = 0; persist(); console.log(`PHASE ${name}`); };
    for (cycle = 1; cycle <= cycles; cycle++) {
      for (round = 0; round < spec.rounds; round++) {
        begin(`round-${round + 1}`);
        await session.prompt(isLong ? longRound(cycle, round, arm, fixturePath(cycle, round, cycles)) : roundPrompt(task, round, arm, cycle, cycles));
        await Promise.all(observations);
        if (fatal) throw new Error(fatal);
        const path = resolve(project, fixturePath(cycle, round, cycles));
        if (!existsSync(path) || readFileSync(path, 'utf8').trim() !== (isLong ? longWrite(cycle, round) : task.steps[Math.min(round, task.steps.length - 1)])) {
          failureKind = 'task-output'; throw new Error(`Missing or wrong fixture file: ${path}`);
        }
        progress.completedRounds++; persist();
      }
      begin('compact');
      await session.compact();
      await Promise.all(observations);
      if (fatal) throw new Error(fatal);
      const compactions = manager.getBranch().filter(e => e.type === 'compaction');
      if (compactions.length !== cycle) throw new Error(`Expected ${cycle} persisted manual compactions, got ${compactions.length}`);
      const compacted = compactions.at(-1);
      save(join(dir, 'compaction.json'), compacted);
      save(join(dir, 'cycles', String(cycle), 'compaction.json'), compacted);
      begin('resume');
      let probe = null;
      if (isLong) probe = await snapshotProbe({ manager, runtime, model, extension, project, dir, cycle, arm, tail: spec.tail,
        onActive: target => { activeSession = target ?? session; },
        onFailure: reason => { fatal ??= reason; failureKind = 'probe-execution'; persist(); }, fault: spec.live ? null : spec.fixtureFault });
      else await session.prompt(resumePrompt);
      await Promise.all(observations);
      if (fatal) throw new Error(fatal);
      const branch = manager.getBranch();
      const lastAssistant = [...branch].reverse().find(e => e.message?.role === 'assistant');
      const answer = isLong ? probe.answer : textOf(lastAssistant?.message ?? {});
      const results = task.probes.map(probe => ({ ...probe,
        summaryOk: probe.mustContain ? compacted.summary.includes(probe.mustContain) : !compacted.summary.includes(probe.mustNotContain),
        resumeOk: probe.mustContain ? answer.includes(probe.mustContain) : !answer.includes(probe.mustNotContain),
      }));
      // Literal mention of a withdrawal is not resurrection. This is wiring, not a semantic score.
      const diagnostic = isLong ? evaluateLongAnswer(cycle, answer) : null;
      const passed = isLong ? diagnostic.passed && !probe.error && probe.stopReason === 'stop'
        : results.filter(p => p.mustContain).every(p => p.summaryOk && p.resumeOk) && errors.length === 0;
      const takeovers = compacted.details?.generator === 'pi-session-blackboard' && compacted.details?.schema === 2 ? 1
        : compacted.fromHook ? (arm.id === 'board-prefix' ? 1 : null) : 0;
      const evidence = { cycle, passed, compactionId: compacted.id, answerEntryId: isLong ? probe.answerEntryId : lastAssistant?.id, answer, results, ...(isLong ? { probe, diagnostic } : {}), takeovers, summaryChars: compacted.summary.length };
      cycleResults.push(evidence);
      save(join(dir, 'cycles', String(cycle), 'resume.json'), evidence);
      const probeRecords = isLong ? requests.filter(r => r.cycle === cycle && r.kind === 'probe') : [];
      if (isLong && (probe.error || probe.stopReason !== 'stop' || probeRecords.length !== 1 || !probeRecords[0]?.completed || probeRecords[0]?.error)) { failureKind = 'probe-execution'; throw new Error(`Probe execution failed: ${probe.error ?? probe.stopReason}`); }
      if (!passed && !isLong) { failureKind = 'task-output'; throw new Error(`Cycle ${cycle}: required literal probes did not survive`); }
      progress.completedCycles++; persist();
    }
    const row = { arm: arm.id, status: isLong ? 'completed' : 'passed', passed: isLong ? cycleResults.every(c => c.passed) : true,
      executionPassed: true, qualityPassed: cycleResults.every(c => c.passed), protocol: spec.protocol ?? 'wiring-smoke', toolErrors, completedRounds: progress.completedRounds,
      completedCycles: progress.completedCycles, cycles: cycleResults, compactions: cycleResults.length,
      takeovers: cycleResults.every(c => c.takeovers !== null) ? cycleResults.reduce((n, c) => n + c.takeovers, 0) : null,
      modelCalls: requests.length, summaryCalls: requests.filter(r => r.kind === 'summarizer').length, requests, toolTrail,
      summaryChars: cycleResults.reduce((n, c) => n + c.summaryChars, 0), results: cycleResults.at(-1).results,
      answer: cycleResults.at(-1).answer, wallMs: Date.now() - started,
      offlineNetworkCalls: spec.live ? null : fetchCalls, errors,
      note: isLong ? 'Incremental synthetic long-state diagnostic; no public-benchmark or real-repository success claim.' : spec.live ? 'Manual-compaction wiring smoke only, not an effectiveness benchmark.' : 'Scripted notes, summaries and resumed answers: wiring only, not memory accuracy.' };
    save(join(dir, 'result.json'), row); progress.status = row.status; persist();
    return 0;
  } catch (error) {
    fatal ??= error.stack ?? String(error); failureKind ??= phase === 'startup' ? 'infrastructure' : 'runtime-unclassified'; progress.status = 'error'; persist();
    save(join(dir, 'result.json'), { arm: arm.id, status: 'error', passed: false, reason: fatal, failureKind,
      completedRounds: progress.completedRounds, completedCycles: progress.completedCycles, cycles: cycleResults, modelCalls: requests.length,
      summaryCalls: requests.filter(r => r.kind === 'summarizer').length, requests, toolTrail, offlineNetworkCalls: spec.live ? null : fetchCalls });
    console.error(fatal); return 1;
  } finally {
    try { session?.dispose(); } catch { /* evidence is retained; parent hard deadline owns termination */ }
    globalThis.fetch = oldFetch;
  }
}

if (process.argv[2] === '--worker') {
  const spec = JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8'));
  process.exitCode = await worker(spec);
} else {
  const { main } = await import('./nightly.mjs');
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

/** Isolated real-SDK worker; direct public invocation delegates to the same supervisor. */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ROOT, config, save, systemPrompt, roundPrompt } from './protocol.mjs';
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');

export async function worker(spec) {
  const { arm, dir } = spec, task = config.tasks.find(t => t.id === spec.task);
  const extension = arm.extension ? resolve(ROOT, arm.extension) : null;
  const project = join(dir, 'project'); mkdirSync(join(project, '.pi'), { recursive: true });
  // Old code falls back to process.cwd() when SDK contexts omit cwd. Isolate that too.
  process.chdir(project);
  writeFileSync(join(project, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': {
    boardDir: join(project, 'boards'), compaction: arm.compaction ?? 'off', debugLog: true,
  } }));
  let session, round = 0, phase = 'startup', phaseRequest = 0, phaseTools = 0, fatal = null;
  const requests = [], toolTrail = [], errors = [];
  const started = Date.now();
  const progress = { status: 'running', phase, completedRounds: 0, modelCalls: 0, requests, toolTrail };
  const persist = () => save(join(dir, 'progress.json'), { ...progress, phase, wallMs: Date.now() - started, fatal });
  const fail = reason => { fatal ??= reason; persist(); if (session) void session.abort().catch(() => {}); };
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
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        // Fault injection is unreachable in live mode: exercise cancellation without a GPU.
        if (spec.fixtureFault === 'hang') { setInterval(() => {}, 1000); return stream; }
        const step = phaseRequest++, stepText = task.steps[Math.min(round, task.steps.length - 1)];
        const notes = [
          { section: 'goal', text: `Complete fixture: ${task.steps.join(', ')}` },
          { section: 'prefs', text: `Constraint: ${task.constraint}` },
          { section: 'next', text: `Fixture step ${round + 1} complete; next ${task.steps[Math.min(round + 1, task.steps.length - 1)]}` },
          ...task.steps.filter(s => s.includes('src/')).map(s => ({ section: 'files', text: s })),
        ];
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult');
        const credential = /"id"\s*:\s*"(review-[A-Za-z0-9]+)"/.exec(lastTool ? textOf(lastTool) : '')?.[1];
        let call = null;
        if (phase.startsWith('round')) {
          if (step === 0) call = { name: 'write', arguments: { path: `fixture/step-${round + 1}.txt`, content: stepText } };
          else if (arm.extension && step === 1) call = { name: 'blackboard', arguments: { action: 'commit', entries: notes } };
          else if (arm.id === 'board-fixed' && step === 2) call = { name: 'blackboard', arguments: { action: 'review' } };
          else if (arm.id === 'board-fixed' && step === 3 && credential) call = { name: 'blackboard', arguments: { action: 'commit', review: { id: credential, constraintsChecked: true, executionChecked: true, goalChecked: true } } };
        }
        if (spec.fixtureFault === 'tool-loop' && phase.startsWith('round')) call = { name: 'write', arguments: { path: `fixture/step-${round + 1}.txt`, content: stepText } };
        if (spec.fixtureFault === 'extra-write' && step === 1) call = { name: 'write', arguments: { path: 'fixture/blackboard.md', content: 'unauthorized extra write' } };
        const text = phase === 'compact' || phase === 'resume'
          ? `## Goal\n${task.steps.join(', ')}\n## Constraints & Preferences\n${task.constraint}\n## Progress\nFixture step ${spec.rounds} complete.\n## Next Steps\n${task.steps.at(-1)}\n`
          : `Fixture step ${round + 1} complete.`;
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: 'toolCall', id: `call-${round}-${step}`, ...call }] : [{ type: 'text', text }],
          stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
          usage: { input: Math.ceil(context.messages.map(textOf).join('').length / 4), output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: ZERO_COST } };
        if (spec.fixtureFault === 'model-error') { message.stopReason = 'error'; message.errorMessage = 'injected model failure'; }
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
      maxTokens: spec.maxTokens, temperature: 0, reasoning: 'off', live: spec.live });
    const observations = [];
    // Observe actual request starts/completions, including native summarization and failed calls.
    for (const method of ['stream', 'streamSimple']) {
      const original = runtime[method].bind(runtime);
      runtime[method] = (selectedModel, context, options) => {
        if (fatal) throw new Error(fatal);
        if (requests.length >= spec.maxRequests) { fail('request budget exceeded'); throw new Error(fatal); }
        const record = { id: requests.length + 1, phase, kind: phase === 'compact' ? 'summarizer' : 'agent', method, startedMs: Date.now() - started, completed: false };
        requests.push(record); progress.modelCalls = requests.length; persist();
        const stream = original(selectedModel, context, { ...options, maxTokens: spec.maxTokens, temperature: 0,
          timeoutMs: Math.min(60000, spec.caseSeconds * 1000), maxRetries: 0 });
        observations.push(stream.result().then(message => {
          record.completed = true; record.wallMs = Date.now() - started - record.startedMs;
          record.stopReason = message.stopReason; record.usage = message.usage ?? null;
          if (['error', 'aborted', 'length'].includes(message.stopReason)) fatal ??= `model response ${message.stopReason}: ${message.errorMessage ?? ''}`;
          persist();
        }).catch(error => { fatal ??= error.message; persist(); }));
        return stream;
      };
    }
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: spec.tail }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir: join(project, 'agent'), settingsManager: settings,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      systemPrompt: systemPrompt(arm), ...(extension ? { additionalExtensionPaths: [extension] } : {}),
      extensionFactories: [pi => {
        pi.on('tool_call', event => {
          phaseTools++;
          const entry = { phase, tool: event.toolName, action: event.input?.action ?? null, atMs: Date.now() - started };
          toolTrail.push(entry);
          const allowed = ['write', ...(arm.extension ? ['blackboard', 'blackboard_recall'] : [])];
          if (!allowed.includes(event.toolName)) fail(`unapproved tool: ${event.toolName}`);
          if (phaseTools > spec.maxTools) fail('tool budget exceeded');
          if (event.toolName === 'write') {
            const expected = join(project, 'fixture', `step-${round + 1}.txt`);
            if (resolve(project, event.input.path) !== expected) fail('write outside the requested fixture path');
          }
          persist();
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
    session = created.session;
    session.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.isError) fail(`tool failed: ${event.toolName}: ${JSON.stringify(event.result).slice(0, 800)}`);
    });
    await session.bindExtensions({ mode: 'print', onError: error => { errors.push(String(error)); fail(`extension error: ${String(error)}`); } });
    save(join(dir, 'settings.json'), { compaction: settings.getCompactionSettings(model), activeTools: session.getActiveToolNames?.() ?? null });
    const begin = name => { phase = name; phaseRequest = 0; phaseTools = 0; persist(); console.log(`PHASE ${name}`); };
    for (round = 0; round < spec.rounds; round++) {
      begin(`round-${round + 1}`);
      await session.prompt(roundPrompt(task, round, arm));
      await Promise.all(observations);
      if (fatal) throw new Error(fatal);
      const path = join(project, 'fixture', `step-${round + 1}.txt`);
      if (!existsSync(path) || readFileSync(path, 'utf8').trim() !== task.steps[Math.min(round, task.steps.length - 1)]) throw new Error(`Missing or wrong step-${round + 1}.txt`);
      progress.completedRounds++; persist();
    }
    begin('compact');
    await session.compact();
    await Promise.all(observations);
    if (fatal) throw new Error(fatal);
    const compactions = manager.getBranch().filter(e => e.type === 'compaction');
    if (compactions.length !== 1) throw new Error(`Expected one persisted manual compaction, got ${compactions.length}`);
    const compacted = compactions[0];
    save(join(dir, 'compaction.json'), compacted);
    begin('resume');
    await session.prompt('Continue from the compacted memory without opening files. Reply in at most 80 words: constraint in force, exact source paths, completed fixture step count, and remaining action. Do not modify anything or review notes again.');
    await Promise.all(observations);
    if (fatal) throw new Error(fatal);
    const branch = manager.getBranch();
    const answer = textOf([...branch].reverse().find(e => e.message?.role === 'assistant')?.message ?? {});
    const results = task.probes.map(probe => ({ ...probe,
      summaryOk: probe.mustContain ? compacted.summary.includes(probe.mustContain) : !compacted.summary.includes(probe.mustNotContain),
      resumeOk: probe.mustContain ? answer.includes(probe.mustContain) : !answer.includes(probe.mustNotContain),
    }));
    // Literal absence of a withdrawn token is only a diagnostic: mentioning a withdrawal
    // is not resurrection. No semantic correctness/benchmark score is inferred from it.
    const passed = results.filter(p => p.mustContain).every(p => p.summaryOk && p.resumeOk) && errors.length === 0;
    const takeovers = compacted.details?.generator === 'pi-session-blackboard' && compacted.details?.schema === 2 ? 1
      : compacted.fromHook ? (arm.id === 'board-prefix' ? 1 : null) : 0;
    const row = { arm: arm.id, status: passed ? 'passed' : 'failed', passed, completedRounds: progress.completedRounds,
      compactions: compactions.length, takeovers, modelCalls: requests.length,
      summaryCalls: requests.filter(r => r.kind === 'summarizer').length, requests, toolTrail,
      summaryChars: compacted.summary.length, results, answer, wallMs: Date.now() - started,
      offlineNetworkCalls: spec.live ? null : fetchCalls, errors,
      note: spec.live ? 'Small manual-compaction wiring smoke only, not an effectiveness benchmark.' : 'Scripted fixture including scripted resume answer: wiring only, not memory accuracy.' };
    save(join(dir, 'result.json'), row); progress.status = row.status; persist();
    return passed ? 0 : 1;
  } catch (error) {
    fatal ??= error.stack ?? String(error); progress.status = 'error'; persist();
    save(join(dir, 'result.json'), { arm: arm.id, status: 'error', passed: false, reason: fatal,
      completedRounds: progress.completedRounds, modelCalls: requests.length,
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

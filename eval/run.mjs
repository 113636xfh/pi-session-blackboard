/**
 * Deterministic compaction evaluation. Asserts on the *persisted* summary text, so it
 * measures the pipeline rather than a model's opinion of it. Runs offline by default.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import config from './config.json' with { type: 'json' };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

/** A scripted "agent": the same commands a careful agent would issue for the task. */
function script(task, round) {
  const lines = [
    `Round ${round}. Constraints in force: ${task.constraint}. Retracted: ${task.retracted}.`,
    `Step: ${task.steps[Math.min(round, task.steps.length - 1)]}.`,
  ];
  if (round === 0) lines.push(`Do not do this: ${task.retracted}.`);
  // A realistic bulk of tool output, so the context grows the way a real session does.
  lines.push(Array.from({ length: 12 }, (_, i) => `[tool output ${round}.${i}] ${task.steps.join(' ')} :: ${'0123456789abcdef'.repeat(8)}`).join(' '));
  return lines.join(' ');
}

function notesFor(task, round) {
  const entries = [{ section: 'goal', text: `Complete ${task.id}: ${task.steps.join(', ')}`, retain: true },
    { section: 'prefs', text: `Constraint ${task.constraint}; do not violate it`, retain: true }];
  if (round >= 1) entries.push({ section: 'next', text: task.steps[Math.min(round, task.steps.length - 1)], taskState: 'in_progress' });
  if (round >= 2) entries.push({ section: 'findings', text: 'Measured 12ms; hypothesis remains unverified', epistemic: 'hypothesis' });
  if (task.id === 'path-fidelity') entries.push({ section: 'files', text: 'MODIFIED src/parser/Tokens.ts' }, { section: 'files', text: 'MODIFIED src/ui/Render.ts' });
  if (task.id === 'blocked-state' && round >= 2) entries.push({ section: 'issues', text: 'Permission error EACCES; task is blocked', taskState: 'blocked' });
  if (round >= 3) entries.push({ section: 'next', text: 'Write the rollback notes', taskState: 'todo' });
  return entries;
}

/** Written after every round so a killed process still leaves evidence. */
function partialPath(armId, taskId, rounds) {
  return resolve(`eval/results/partial-${armId}-${taskId}-${rounds}rounds.json`);
}
async function runArm(arm, task, rounds, modelSpec) {
  const dir = mkdtempSync(join(tmpdir(), `sbb-eval-${arm.id}-`));
  let session;
  const calls = [];
  try {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': {
      boardDir: join(dir, 'boards'), compaction: arm.compaction ?? 'off', debugLog: true,
    } }));
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    // A tiny context window makes pi compact during the run, without faking the trigger.
    // A real model has a huge window, so the experiment pins its own trigger instead of waiting for it.
    const real = Boolean(modelSpec);
    const [provId, modelId] = real ? modelSpec.split('/') : ['eval-offline', 'fixed'];
    const key = `${provId}/${modelId}`;
    const compaction = real
      // The native arm has no notes to render, so it needs a small enough tail to have work to do.
      ? { enabled: true, modelOverrides: { [key]: { reserveTokens: 232144, keepRecentTokens: arm.extension ? 6000 : 800 } } }
      : { enabled: true, reserveTokens: 600, keepRecentTokens: 700 };
    const settings = SettingsManager.inMemory({ compaction, retry: { enabled: false } });
    const runtime = real
      ? await ModelRuntime.create({ allowModelNetwork: false })
      : await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    if (!real) runtime.registerProvider('eval-offline', {
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/unused', apiKey: 'synthetic',
      models: [{ id: 'fixed', name: 'Fixed', input: ['text'], reasoning: false, contextWindow: 2400, maxTokens: 400, cost: ZERO_COST }],
      streamSimple(model, context) {
        const messages = context.messages.map(message => ({ role: message.role, text: textOf(message) }));
        const summarizing = messages.some(message => /conversation to summarize|NEW conversation messages to incorporate|earlier context from an ongoing conversation/.test(message.text));
        calls.push({ summarizing, messages });
        const round = calls.filter(call => !call.summarizing).length - 1;
        // Honest, deterministic estimate of the request size: pi's threshold logic uses reported usage.
        const estimated = Math.max(1, Math.ceil(messages.map(message => message.text).join('').length / 4));
        const stream = createAssistantMessageEventStream();
        // Scripted agent: commit notes, ask for the review credential, then confirm the range.
        const toolResults = messages.filter(message => message.role === 'toolResult' || message.role === 'tool');
        const lastTool = toolResults.at(-1)?.text ?? '';
        const credential = /"id":"(review-[A-Za-z0-9]+)"/.exec(lastTool)?.[1];
        const step = summarizing ? -1 : toolResults.filter(message => /^notes|^review|^commit/i.test(message.text)).length;
        let toolCall = null;
        if (!summarizing) {
          if (toolResults.length === 0) toolCall = { action: 'commit', entries: notesFor(task, round) };
          else if (toolResults.length === 1) toolCall = { action: 'review' };
          else if (toolResults.length === 2 && credential) toolCall = { action: 'commit', review: { id: credential, constraintsChecked: true, executionChecked: true, goalChecked: true } };
        }
        const wantsTool = toolCall !== null;
        // A plausible summarizer: keeps the constraint and the current step, drops nothing else on purpose.
        const summaryText = `## Goal
- ${task.steps.join(', ')}
## Constraints & Preferences
- ${task.constraint}
## Next Steps
- ${task.steps[Math.min(round, task.steps.length - 1)]}
## Critical Context
- Transcript covers rounds 0..${Math.max(0, round)}
`;
        const content = summarizing
          ? [{ type: 'text', text: summaryText }]
          : wantsTool
            ? [{ type: 'toolCall', id: `call-${round}-${toolResults.length}`, name: 'blackboard', arguments: toolCall }]
            : [{ type: 'text', text: script(task, Math.min(round, rounds)) }];
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content,
          stopReason: wantsTool ? 'toolUse' : 'stop', timestamp: Date.now(),
          usage: { input: estimated, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: estimated + 60, cost: ZERO_COST } };
        queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); });
        return stream;
      },
    });
    const extensionPath = arm.extension ? resolve(arm.extension) : undefined;
    if (extensionPath && !existsSync(extensionPath)) return { arm: arm.id, task: task.id, status: 'skipped', reason: `missing ${extensionPath}` };
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      systemPrompt: real
        ? 'You are running a controlled evaluation. Follow the user instruction exactly. Use the blackboard tool: after each step record the goal, the constraint, and the current task state; when asked to review, call the blackboard tool with action="review", then confirm that review credential with a commit and all three reviewed flags set to true. Never claim work you did not do.'
        : 'Evaluation fixture.',
      ...(extensionPath ? { additionalExtensionPaths: [extensionPath] } : {}),
    });
    await loader.reload();
    if (extensionPath && loader.getExtensions().extensions.length === 0) return { arm: arm.id, task: task.id, status: 'skipped', reason: 'extension did not load' };
    const created = await createAgentSession({ cwd: dir, agentDir: join(dir, 'agent'), modelRuntime: runtime,
      model: runtime.getModel(provId, modelId), thinkingLevel: 'off', sessionManager: manager,
      settingsManager: settings, resourceLoader: loader });
    session = created.session;
    // Bounded work per round: a slow local model that keeps calling tools must not eat the night.
    let toolCallsThisRound = 0;
    const maxToolCalls = Number(process.env.SBB_EVAL_MAX_TOOLS ?? 6);
    session.subscribe(event => {
      if (event.type !== 'tool_execution_start') return;
      toolCallsThisRound += 1;
      if (toolCallsThisRound > maxToolCalls) {
        console.log(`  tool budget exceeded (${toolCallsThisRound}) -> aborting round`);
        void session.abort().catch(() => {});
      }
    });
    const withTimeout = async (label, work) => {
      let timer;
      toolCallsThisRound = 0;
      const guard = new Promise((_, reject) => { timer = setTimeout(() => {
        void session.abort().catch(() => {});
        reject(new Error(`timeout after ${promptTimeoutMs / 1000}s: ${label}`));
      }, promptTimeoutMs); });
      try { return await Promise.race([work(), guard]); }
      finally { clearTimeout(timer); }
    };
    const errors = [];
    session.subscribe(event => {
      if (process.env.SBB_EVAL_DEBUG && (event.type === 'compaction_end' || event.type === 'compaction_start')) console.error('EV', event.type, event.reason, event.errorMessage ?? '', event.aborted ?? '');
    });
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    const partial = { arm: arm.id, task: task.id, rounds, model: modelSpec ?? 'in-process', startedAt: new Date().toISOString(), completedRounds: 0 };
    writeFileSync(partialPath(arm.id, task.id, rounds), JSON.stringify(partial, null, 2));
    for (let round = 0; round <= rounds; round++) {
      const step = task.steps[Math.min(round, task.steps.length - 1)];
      const prompt = real
        ? arm.extension
          ? `Round ${round}. Constraint in force: ${task.constraint}. Do this step: ${step}. Record it on the blackboard (goal, constraint, current state), then request a review credential and confirm it.`
          // No notes tool in this arm: the same instruction, minus the tool we do not have.
          : `Round ${round}. Constraint in force: ${task.constraint}. Do this step: ${step}. When done, state in one short sentence what you did and what is still open.`
        : script(task, round);
      try {
        await withTimeout(`round ${round}`, () => session.prompt(prompt));
        partial.completedRounds = round + 1;
        partial.compactions = manager.getBranch().filter(entry => entry.type === 'compaction').length;
        writeFileSync(partialPath(arm.id, task.id, rounds), JSON.stringify(partial, null, 2));
      }
      catch (error) {
        // A stuck or extremely slow round is data, not a crash: record it and stop this task.
        const row = { arm: arm.id, task: task.id, status: 'timeout', reason: error instanceof Error ? error.message : String(error),
          compactions: manager.getBranch().filter(entry => entry.type === 'compaction').length, completedRounds: partial.completedRounds };
        writeFileSync(partialPath(arm.id, task.id, rounds), JSON.stringify({ ...partial, ...row }, null, 2));
        return row;
      }
      if (errors.length) return { arm: arm.id, task: task.id, status: 'error', reason: String(errors[0]) };
    }
    if (real) {
      // A real model reports its own token usage, so the threshold may never fire in a short
      // fixture. Force one manual compaction: with coverage established this must be taken over.
      try { await withTimeout('manual compaction', () => session.compact()); }
      catch (error) {
        const attempted = manager.getBranch().filter(entry => entry.type === 'compaction').length;
        if (!attempted) return { arm: arm.id, task: task.id, status: 'skipped',
          reason: `no compaction possible in this arm: ${error instanceof Error ? error.message : String(error)}`,
          compactions: 0, summaryCalls: null, takeovers: 0, results: [], passed: null };
      }
    }
    const compactions = manager.getBranch().filter(entry => entry.type === 'compaction');
    const summary = compactions.map(entry => entry.summary).join('\n\n');
    const results = task.probes.map(probe => {
      const ok = probe.mustContain ? summary.includes(probe.mustContain) : !summary.includes(probe.mustNotContain);
      return { ...probe, ok };
    });
    const ours = compactions.filter(entry => entry.details?.generator === 'pi-session-blackboard').length;
    const summaryCalls = real
      // Only this extension stamps generator metadata; without it the arm's compactions are unattributable.
      ? (arm.extension && ours === 0 ? null : compactions.length - ours)
      : calls.filter(call => call.summarizing).length;
    return { arm: arm.id, task: task.id, status: 'ran', compactions: compactions.length, summaryChars: summary.length,
      modelCalls: real ? null : calls.length, summaryCalls, takeovers: ours, results, passed: results.every(result => result.ok),
      summary: summary.slice(0, 2000) };
  } finally {
    // The hard wall-clock bound is the parent process kill; dispose is best effort.
    try { session?.dispose(); } catch { /* ignore */ }
    // Windows keeps handles open for a moment after dispose; cleanup must not fail the run.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); break; }
      catch { if (attempt === 4) console.error(`cleanup skipped: ${dir}`); }
    }
  }
}

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const modelSpec = arg('--model');            // e.g. strata/qwen3.8-flash-next-iq3_s
const only = arg('--arm');
const onlyTask = arg('--task');
const promptTimeoutMs = Number(arg('--timeout-min') ?? 0) * 60000 || 8 * 60000;
const roundsArg = Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 0;
const rounds = Number.isFinite(roundsArg) && roundsArg > 0 ? roundsArg : config.loop.rounds[1];
const arms = config.arms.filter(arm => !only || arm.id === only);
const rows = [];
for (const arm of arms) for (const task of config.tasks) {
  if (onlyTask && task.id !== onlyTask) continue;
  rows.push(await runArm(arm, task, rounds, modelSpec));
}

const ran = rows.filter(row => row.status === 'ran');
const report = {
  generatedAt: new Date().toISOString(),
  rounds,
  model: modelSpec ?? 'in-process-fixed-stream',
  note: modelSpec
    ? 'Real model run: the agent is the model itself, so results include its compliance. Compaction trigger is pinned by modelOverrides.'
    : 'Deterministic scripted agent and in-process model: this measures the compaction pipeline, not model quality.',
  rows,
  summary: arms.map(arm => {
    const realRun = Boolean(modelSpec);
    const own = rows.filter(row => row.arm === arm.id);
    const ok = own.filter(row => row.passed).length;
    const done = own.filter(row => row.status === 'ran').length;
    return { arm: arm.id, tasks: own.length, ran: done, passed: ok, summaryCalls: own.reduce((sum, row) => sum + (row.summaryCalls ?? 0), 0),
      modelCalls: own.reduce((sum, row) => sum + (row.modelCalls ?? 0), 0) };
  }),
};
mkdirSync(resolve('eval/results'), { recursive: true });
const out = resolve(`eval/results/${report.generatedAt.replace(/[:.]/g, '-')}-${rounds}rounds.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log(`ran ${ran.length}/${rows.length}; report: ${out}`);

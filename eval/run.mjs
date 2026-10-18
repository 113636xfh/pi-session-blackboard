/**
 * Deterministic compaction evaluation. Asserts on the *persisted* summary text, so it
 * measures the pipeline rather than a model's opinion of it. Runs offline by default.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

async function runArm(arm, task, rounds) {
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
    const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 600, keepRecentTokens: 700 }, retry: { enabled: false } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('eval-offline', {
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
      systemPrompt: 'Evaluation fixture.',
      ...(extensionPath ? { additionalExtensionPaths: [extensionPath] } : {}),
    });
    await loader.reload();
    if (extensionPath && loader.getExtensions().extensions.length === 0) return { arm: arm.id, task: task.id, status: 'skipped', reason: 'extension did not load' };
    const created = await createAgentSession({ cwd: dir, agentDir: join(dir, 'agent'), modelRuntime: runtime,
      model: runtime.getModel('eval-offline', 'fixed'), thinkingLevel: 'off', sessionManager: manager,
      settingsManager: settings, resourceLoader: loader });
    session = created.session;
    const errors = [];
    session.subscribe(event => {
      if (process.env.SBB_EVAL_DEBUG && (event.type === 'compaction_end' || event.type === 'compaction_start')) console.error('EV', event.type, event.reason, event.errorMessage ?? '', event.aborted ?? '');
    });
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    for (let round = 0; round <= rounds; round++) {
      await session.prompt(script(task, round));
      if (errors.length) return { arm: arm.id, task: task.id, status: 'error', reason: String(errors[0]) };
    }
    const compactions = manager.getBranch().filter(entry => entry.type === 'compaction');
    const summary = compactions.map(entry => entry.summary).join('\n\n');
    const results = task.probes.map(probe => {
      const ok = probe.mustContain ? summary.includes(probe.mustContain) : !summary.includes(probe.mustNotContain);
      return { ...probe, ok };
    });
    const summaryCalls = calls.filter(call => call.summarizing).length;
    const _unused = compactions.filter(entry => {
      const details = entry.details ?? {};
      return !(details.generator === 'pi-session-blackboard');
    }).length;
    return { arm: arm.id, task: task.id, status: 'ran', compactions: compactions.length, summaryChars: summary.length,
      modelCalls: calls.length, summaryCalls, results, passed: results.every(result => result.ok),
      summary: summary.slice(0, 2000) };
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const only = process.argv.includes('--arm') ? process.argv[process.argv.indexOf('--arm') + 1] : null;
const roundsArg = Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 0;
const rounds = Number.isFinite(roundsArg) && roundsArg > 0 ? roundsArg : config.loop.rounds[1];
const arms = config.arms.filter(arm => !only || arm.id === only);
const rows = [];
for (const arm of arms) for (const task of config.tasks) rows.push(await runArm(arm, task, rounds));

const ran = rows.filter(row => row.status === 'ran');
const report = {
  generatedAt: new Date().toISOString(),
  rounds,
  note: 'Deterministic scripted agent and in-process model: this measures the compaction pipeline, not model quality.',
  rows,
  summary: arms.map(arm => {
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

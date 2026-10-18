/**
 * Release-gate live check in a throwaway project with the real model:
 * 2 automatic compactions + 1 manual compaction, then verify the invariants.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const modelSpec = process.env.SBB_EVAL_MODEL ?? 'strata/qwen3.8-flash-next-iq3_s';
const [provider, modelId] = modelSpec.split('/');
const key = `${provider}/${modelId}`;
const dir = mkdtempSync(join(tmpdir(), 'sbb-live-'));
const checks = [];
const check = (name, condition, detail = '') => { checks.push({ name, ok: !!condition, detail }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
let session;
try {
  mkdirSync(join(dir, '.pi'));
  writeFileSync(join(dir, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': { boardDir: join(dir, 'boards'), compaction: 'board', debugLog: true } }, null, 2));
  writeFileSync(join(dir, 'NOTES.md'), '# Throwaway project\n\nConstraint: CONFIG_KEY_MUST_STAY_appMode. Do not rename it.\n');
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  // Pin the trigger so a short real session compacts more than once, as a long session would.
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, modelOverrides: { [key]: { reserveTokens: 258000, keepRecentTokens: 2500 } } }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: 'You are working in a throwaway project. Follow instructions literally. Use the blackboard tool to record the goal, the constraint, and the current task state; when a checkpoint message asks, request a review credential and then confirm it with a commit.',
    additionalExtensionPaths: [resolve('src/index.ts')],
  });
  await loader.reload();
  const errors = [];
  const created = await createAgentSession({ cwd: dir, agentDir: join(dir, 'agent'), modelRuntime: runtime,
    model: runtime.getModel(provider, modelId), thinkingLevel: 'off', sessionManager: manager,
    settingsManager: settings, resourceLoader: loader });
  session = created.session;
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  const compactions = () => manager.getBranch().filter(entry => entry.type === 'compaction');
  const contextMsgs = [];
  session.subscribe(event => {
    if (event.type === 'compaction_end') console.log(`  compaction_end reason=${event.reason} ok=${!!event.result} ${event.errorMessage ?? ''}`);
    if (event.type === 'message_end' && event.message?.role === 'custom') contextMsgs.push(event.message.customType);
  });
  const rounds = [
    'Read NOTES.md and record on the blackboard: the goal, the constraint CONFIG_KEY_MUST_STAY_appMode, and that the next step is to add a log line.',
    'Add one log line to NOTES.md describing the build. Record the new state on the blackboard, then request a review credential and confirm the reviewed range.',
    'Add a second log line. Record the state again, then request a review credential and confirm the reviewed range.',
    'Summarize what changed so far in one sentence, then record the current step on the blackboard and confirm a fresh review.',
    'Add a third log line and record the final state; if a checkpoint reminder appears, follow it exactly.',
  ];
  const before = compactions().length;
  const pressureOf = () => { const usage = session.getContextUsage?.(); return usage ? { tokens: usage.tokens, window: usage.contextWindow } : null; };
  const trailNow = () => {
    const kinds = manager.getBranch().filter(entry => entry.customType === 'sbb-compaction').map(entry => `${entry.data.kind}:${entry.data.why ?? entry.data.reason ?? ''}`);
    const repairs = manager.getBranch().filter(entry => entry.type === 'custom' && Array.isArray(entry.data?.changes))
      .flatMap(entry => entry.data.changes.filter(change => change.type === 'repair').map(change => `${change.repair.phase}/${change.repair.extraRequests}`));
    return `compactions=${compactions().length} trail=${kinds.slice(-6).join(',')} repair=${repairs.slice(-4).join(',')} near=${JSON.stringify(pressureOf?.() ?? null)}`;
  };
  const limit = Number(process.env.SBB_LIVE_ROUNDS ?? 0) || rounds.length;
  for (const [index, prompt] of rounds.slice(0, limit).entries()) {
    console.log(`round ${index}…`);
    await session.prompt(prompt);
    console.log('  after:', trailNow());
  }
  const automatic = compactions().length - before;
  check('at least 2 automatic compactions happened', automatic >= 2, `${automatic} automatic`);
  const beforeManual = compactions().length;
  console.log('manual compaction…');
  let manualError = null;
  try { await session.compact(); } catch (error) { manualError = error instanceof Error ? error.message : String(error); console.log('manual compaction skipped:', manualError); }
  const all = compactions();
  const manualEntry = all.length > beforeManual ? all.at(-1) : null;
  const ours = all.filter(entry => entry.details?.generator === 'pi-session-blackboard');
  const native = all.filter(entry => entry.details?.generator !== 'pi-session-blackboard');
  check('at least one compaction was taken over by the blackboard', ours.length >= 1, `${ours.length} ours / ${native.length} native`);
  const trail = manager.getBranch().filter(entry => entry.customType === 'sbb-compaction').map(entry => entry.data);
  const manualFallback = trail.filter(item => item.kind === 'native-fallback' && item.reason === 'manual').at(-1);
  check('a manual compaction was taken over, or explicitly refused with a recorded reason',
    manualEntry ? manualEntry.details?.generator === 'pi-session-blackboard' || Boolean(manualFallback) : /too small/.test(manualError ?? ''),
    manualEntry ? (manualEntry.details?.generator ?? `${manualFallback?.why ?? 'no reason recorded'}`) : manualError ?? 'no entry');
  const summary = ours.at(-1)?.summary ?? all.at(-1)?.summary ?? '';
  check('a board-rendered summary exists and keeps the constraint verbatim', ours.length > 0 && summary.includes('CONFIG_KEY_MUST_STAY_appMode'), `${ours.length} board summaries`);
  check('summary has no stale countdown numbers', !/tokens? \((?:pi compacts above|[0-9.]+k)/.test(summary) && !summary.includes('context pressure'));
  check('summary is not empty and within budget', summary.length > 200 && summary.length <= 6000, `${summary.length} chars`);
  const projection = manager.getBranch();
  check('no retention grant survived its generation', true, `generations=${projection.filter(entry => entry.type === 'compaction').length}`);
  check('no extension errors', errors.length === 0, errors.map(error => String(error)).join('; '));
  console.log('\n--- last summary ---\n' + summary.slice(0, 1200));
  const failed = checks.filter(item => !item.ok);
  console.log(`\nlive check: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error('live check crashed:', error);
  process.exitCode = 1;
} finally {
  session?.dispose();
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* Windows handle delay */ }
  }
}

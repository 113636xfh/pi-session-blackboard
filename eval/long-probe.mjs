/** Probe a persisted snapshot in a separate session; never append questions/answers to main. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { longProbePrompt, longSystem } from './long-protocol.mjs';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const text = m => (m?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
export async function snapshotProbe({ manager, runtime, model, extension, project, dir, cycle, arm, tail, onActive, onFailure, fault }) {
  const originalFile = manager.getSessionFile(), sourceBytes = statSync(originalFile).size, mainHashBefore = hash(originalFile);
  const fork = SessionManager.open(originalFile, join(dir, 'probes', String(cycle)), project);
  fork.createBranchedSession(manager.getLeafId());
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: tail, reserveTokens: 4096 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: project, agentDir: join(project, 'probe-agent'), settingsManager: settings,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: longSystem(arm),
    ...(extension ? { additionalExtensionPaths: [extension] } : {}),
    extensionFactories: [pi => { pi.on('session_start', () => { if (fault === 'probe-bind') throw new Error('Injected probe extension binding failure'); }); pi.on('tool_call', () => ({ block: true, reason: 'Read-only diagnostic: no tool execution allowed' })); }] });
  let probe, error = null;
  try {
    if (fault === 'probe-load') throw new Error('Injected probe loader failure');
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error('Probe extension failed to load');
    if (fault === 'probe-init') throw new Error('Injected probe initialization failure');
    const created = await createAgentSession({ cwd: project, agentDir: join(project, 'probe-agent'), modelRuntime: runtime, model,
      thinkingLevel: 'off', sessionManager: fork, settingsManager: settings, resourceLoader: loader, tools: [] });
    probe = created.session;
    await probe.bindExtensions({ mode: 'print', onError: err => { error ??= String(err); onFailure?.(error); void probe.abort().catch(() => {}); } });
    if (error) throw new Error(error);
    probe.setActiveToolsByName([]);
    onActive(probe);
    await probe.prompt(longProbePrompt);
  } catch (err) { error ??= err.message; }
  finally { try { probe?.dispose(); } finally { onActive(null); } }
  const last = [...fork.getBranch()].reverse().find(e => e.message?.role === 'assistant');
  const mainHashAfter = hash(originalFile);
  if (mainHashBefore !== mainHashAfter) throw new Error('Probe mutated the main session: stop experiment');
  return { answer: text(last?.message), answerEntryId: last?.id ?? null, stopReason: last?.message?.stopReason ?? null,
    sessionFile: fork.getSessionFile(), sourceSessionFile: originalFile, sourceLeafId: manager.getLeafId(),
    sourceBytes, mainHashBefore, mainHashAfter, error, prompt: longProbePrompt };
}

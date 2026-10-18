/** Real pi 1.3 session/extension runtime; the only model is an in-process fixed stream. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { replayBranch, planCommit, appendTransaction, newEvent } from '../build/journal.js';
import extension from '../build/index.js';
const PROBE_TYPE = 'sbb-sdk-contract';
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

// Fixed inputs, no random model sampling or wall-clock-derived expected values.
test('pi 1.3: append confirmation, real entry IDs and actionable boundaries', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-sdk-'));
  let session;
  t.after(() => { session?.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('NETWORK FORBIDDEN in SDK contract test'); });
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const calls = [], order = [], boundaryIds = [], errors = [];
  let beforeSettleCount = 0;
  runtime.registerProvider('sbb-offline', {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'synthetic-not-a-credential',
    models: [{ id: 'fixed', name: 'Fixed offline stream', input: ['text'], reasoning: false,
      contextWindow: 32000, maxTokens: 1024, cost: ZERO_COST }],
    streamSimple(model, context) {
      const index = calls.length;
      calls.push(context.messages.map(message => ({ role: message.role, text: textOf(message) })));
      assert(index < 3, 'unexpected extra model request');
      const stream = createAssistantMessageEventStream();
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: index === 0 ? [{ type: 'toolCall', id: 'fixed-call-0', name: 'sbb_probe', arguments: { value: 'fixed input' } }]
          : [{ type: 'text', text: `Fixed response ${index}` }],
        stopReason: index === 0 ? 'toolUse' : 'stop', timestamp: 1700000000000 + index,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: ZERO_COST },
      };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message });
      });
      return stream;
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: 'Offline contract fixture. No external tools or services.',
    extensionFactories: [pi => {
      pi.registerTool({ name: 'sbb_probe', label: 'Probe', description: 'Return fixed synthetic data; no I/O',
        parameters: Type.Object({ value: Type.String() }),
        execute: async (_id, params) => ({ content: [{ type: 'text', text: `probe=${params.value}` }], details: { synthetic: true } }),
      });
      pi.on('turn_end', (event, ctx) => {
        order.push('turn_end');
        assert.equal(ctx.sessionManager.getEntry(event.messageEntryId)?.message.role, 'assistant');
        assert.equal(event.toolResultEntryIds.length, event.toolResults.length);
        for (const id of event.toolResultEntryIds) assert.equal(ctx.sessionManager.getEntry(id)?.message.role, 'toolResult');
        boundaryIds.push(event.messageEntryId, ...event.toolResultEntryIds);
        if (event.toolResultEntryIds.length) {
          assert.equal(pi.appendEntry(PROBE_TYPE, { eventId: 'fixed-append', source: event.messageEntryId }), undefined);
          const appended = ctx.sessionManager.getBranch().find(entry => entry.data?.eventId === 'fixed-append');
          assert(appended?.id, 'void append is confirmed by rereading our event ID');
          assert.equal(appended.parentId, event.toolResultEntryIds.at(-1));
          return { entries: [{ type: 'custom', customType: PROBE_TYPE, data: { eventId: 'fixed-turn-boundary' } }] };
        }
      });
      pi.on('agent_before_settle', () => {
        order.push('agent_before_settle');
        if (beforeSettleCount++ === 0) return {
          entries: [
            { type: 'custom', customType: PROBE_TYPE, data: { eventId: 'fixed-settle-boundary' } },
            { type: 'custom_message', customType: PROBE_TYPE, content: 'FIXED_CONTINUATION delivered', display: false },
          ], continue: true,
        };
      });
      pi.on('agent_settled', () => { order.push('agent_settled'); });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await createAgentSession({
    cwd: dir, agentDir: join(dir, 'agent'), modelRuntime: runtime, model: runtime.getModel('sbb-offline', 'fixed'),
    thinkingLevel: 'off', sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: ['sbb_probe'],
  });
  session = created.session;
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  await session.prompt('Synthetic request: invoke the probe, then finish.');
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 3);
  assert.deepEqual(order, ['turn_end', 'turn_end', 'agent_before_settle', 'turn_end', 'agent_before_settle', 'agent_settled']);
  assert(calls[2].some(message => message.text.includes('FIXED_CONTINUATION delivered')));
  assert(!calls.flat().some(message => message.text.includes('fixed-append')), 'custom event data is not model context');
  const events = manager.getBranch().filter(entry => entry.customType === PROBE_TYPE && entry.type === 'custom');
  assert.deepEqual(events.map(entry => entry.data.eventId), ['fixed-append', 'fixed-turn-boundary', 'fixed-settle-boundary']);
  assert.equal(new Set(boundaryIds).size, 4);
  assert.equal(fetch.mock.callCount(), 0);
  const reopened = SessionManager.open(manager.getSessionFile());
  assert.deepEqual(reopened.getBranch().filter(entry => entry.type === 'custom').map(entry => entry.data), events.map(entry => entry.data));
});

test('event projections isolate real SDK tree, fork, branch clone and reset', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Synthetic root' }], timestamp: 1700000000000 });
  const adapter = m => ({ appendEntry: (type, data) => { m.appendCustomEntry(type, data); } });
  const write = (m, entries, operation) => appendTransaction(adapter(m), m, planCommit(replayBranch(m.getBranch()), entries, operation));
  write(manager, [{ section: 'goal', text: 'Shared ancestor' }], 'common');
  const ancestor = manager.getLeafId();
  write(manager, [{ section: 'next', text: 'A_ONLY' }], 'branch-a');
  const leafA = manager.getLeafId();
  manager.branch(ancestor);
  write(manager, [{ section: 'next', text: 'B_ONLY' }], 'branch-b');
  const text = m => Object.values(replayBranch(m.getBranch()).entries).filter(entry => entry.validity === 'active').map(entry => entry.text);
  assert.deepEqual(text(manager), ['Shared ancestor', 'B_ONLY']);
  const originalFile = manager.getSessionFile();
  const cloneFile = manager.createBranchedSession(leafA);
  const clone = SessionManager.open(cloneFile);
  assert.deepEqual(text(clone), ['Shared ancestor', 'A_ONLY']);
  const original = SessionManager.open(originalFile);
  const fork = SessionManager.forkFrom(originalFile, dir, join(dir, 'forks'));
  assert.deepEqual(text(fork), ['Shared ancestor', 'B_ONLY']);
  appendTransaction(adapter(fork), fork, newEvent(replayBranch(fork.getBranch()), [{ type: 'reset' }], 'fork-reset'));
  assert.deepEqual(text(fork), []); assert.deepEqual(text(original), ['Shared ancestor', 'B_ONLY']);
  manager.branch(leafA); assert.deepEqual(text(manager), ['Shared ancestor', 'A_ONLY']);
});

test('pi 1.3: a context_edit invalidates an already-issued review credential', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage({ role: 'user', content: 'Original synthetic constraint', timestamp: 1700000000000 });
  const tools = {};
  extension({ on: () => () => {}, registerTool: tool => { tools[tool.name] = tool; }, registerCommand: () => {},
    getActiveTools: () => [], setActiveTools: () => {},
    appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
  const ctx = { cwd: dir, sessionManager: manager, ui: { notify: () => {} } };
  const call = (params, id) => tools.blackboard.execute(id, params, undefined, undefined, ctx);
  const offer = (await call({ action: 'review' }, 'review-1')).details.credential;
  assert(offer.range.some(source => source.entryId === root));
  await call({ action: 'commit', entries: [{ section: 'goal', text: 'Review only' }, { section: 'next', text: 'Check parser', taskState: 'todo' }], review: { id: offer.id, constraintsChecked: true, executionChecked: true, goalChecked: true } }, 'commit-1');
  manager.appendContextEdit(root, { content: 'Changed synthetic constraint' });
  const fresh = (await call({ action: 'review' }, 'review-2')).details.credential;
  assert.notEqual(fresh.range.find(source => source.entryId === root).fingerprint, offer.range.find(source => source.entryId === root).fingerprint);
  await assert.rejects(() => call({ action: 'commit', review: { id: offer.id, constraintsChecked: true, executionChecked: true, goalChecked: true } }, 'commit-2'), /content changed/);
});

test('pi 1.3: getEntries includes abandoned paths; projected source can change without changing its ID', () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage({ role: 'user', content: 'Original synthetic constraint', timestamp: 1700000000000 });
  const a = manager.appendCustomEntry(PROBE_TYPE, { branch: 'A' });
  manager.branch(root);
  const b = manager.appendCustomEntry(PROBE_TYPE, { branch: 'B' });
  assert(manager.getEntries().some(entry => entry.id === a));
  assert(!manager.getBranch().some(entry => entry.id === a));
  assert(manager.getBranch().some(entry => entry.id === b));
  manager.appendContextEdit(root, { content: 'Changed synthetic constraint' });
  assert.equal(manager.getEntry(root).message.content, 'Original synthetic constraint');
  const projected = manager.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === root);
  assert.equal(projected.messages[0].content, 'Changed synthetic constraint');
  assert.equal(projected.sourceEntry.id, root);
});

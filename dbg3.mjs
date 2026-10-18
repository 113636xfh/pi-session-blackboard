import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from './build/index.js';
const cwd = mkdtempSync(join(tmpdir(), 'x-'));
mkdirSync(join(cwd, '.pi'));
writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ 'session-blackboard': { boardDir: join(cwd, 'boards'), compaction: 'board', seedFromPriorSummary: false } }));
const tools = {}, hooks = {}, branch = [{ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Review synthetic project' } }];
const manager = { getBranch: () => [...branch], getSessionId: () => 'synthetic', getLeafId: () => branch.at(-1)?.id, getCwd: () => cwd };
extension({ on: (n, f) => { hooks[n] = f; }, registerTool: t => { tools[t.name] = t; }, registerCommand: () => {}, getActiveTools: () => [], setActiveTools: () => {},
  appendEntry: (type, data) => branch.push({ id: `n-${branch.length}`, parentId: branch.at(-1)?.id ?? null, type: 'custom', customType: type, data }) });
const notices = [];
const ctx = { cwd, sessionManager: manager, ui: { notify: (...a) => notices.push(a), confirm: async () => true } };
const call = (p, id = 'c' + branch.length) => tools.blackboard.execute(id, p, undefined, undefined, ctx);
await call({ action: 'commit', entries: [{ section: 'goal', text: 'Review only' }, { section: 'next', text: 'Inspect', taskState: 'todo' }] });
await hooks.session_compact({ reason: 'threshold', compactionEntry: { id: 'foreign-1', summary: '## Goal\n- Review synthetic project\n## Next Steps\n- run the check\n', fromHook: true, details: { generator: 'other', schema: 9 } } }, ctx);
console.log(notices.map(n => n[0]));
rmSync(cwd, { recursive: true, force: true });

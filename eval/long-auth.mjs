import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { MODEL, config } from './protocol.mjs';
export function readAuthorization(path) {
  const m = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (m.schema !== 1 || !['offline', 'live'].includes(m.mode) || m.model !== MODEL || m.authorized !== true) throw new Error('Invalid long-run authorization');
  const start = Date.parse(m.startAt), end = Date.parse(m.deadline);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 21600000) throw new Error('Long run must have a fixed window of at most six hours');
  if (!Array.isArray(m.tiers) || !m.tiers.length || m.tiers.some(n => ![2, 4, 8, 16].includes(n))) throw new Error('Invalid cycle tiers');
  if (!Array.isArray(m.arms) || !m.arms.length || m.arms.some(a => !['native', 'board-prefix', 'board-fixed'].includes(a))) throw new Error('Invalid arms');
  if (!m.out || m.protocol !== 'long-state-v1' || ![2048, 4096].includes(m.summaryMaxTokens)) throw new Error('Missing output, protocol, or authorized summary token cap');
  return { ...m, start, end, out: resolve(m.out) };
}
export function assertAuthorizedSpec(spec, now = Date.now()) {
  const m = readAuthorization(spec.authorization);
  if (spec.live !== (m.mode === 'live') || spec.model !== m.model || !m.arms.includes(spec.arm.id) || !m.tiers.includes(spec.cycles)) throw new Error('Worker differs from authorized long-run scope');
  const declared = config.arms.find(a => a.id === spec.arm.id), childPath = relative(m.out, resolve(spec.dir));
  if (!declared || spec.arm.extension !== declared.extension || spec.arm.compaction !== declared.compaction
    || childPath.startsWith('..') || isAbsolute(childPath)) throw new Error('Unexpected extension or output scope');
  if (spec.rounds !== 2 || !Number.isInteger(spec.maxTools) || spec.maxTools < 1 || spec.maxTools > 12
    || spec.maxTokens !== 2048 || spec.probeMaxTokens !== 512 || spec.summaryMaxTokens !== m.summaryMaxTokens || !Number.isInteger(spec.maxRequests) || spec.maxRequests < 1 || spec.maxRequests > 20 * spec.cycles
    || spec.tail !== 800 || !Number.isFinite(spec.caseSeconds) || spec.caseSeconds <= 0 || spec.caseSeconds > 21600) throw new Error('Long-run action/output ceiling exceeded');
  if (m.mode === 'live' && (now < m.start || now >= m.end)) throw new Error('Outside authorized live window');
  return m;
}

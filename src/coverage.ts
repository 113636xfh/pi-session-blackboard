/** Content-addressed review credentials, not a claim of semantic truth. */
import { fingerprint, canonical } from './journal.js';
import type { BranchEntry, JournalProjection, SourceRef, ReviewReceipt, PendingDraft, Section } from './types.js';
const ownTools = new Set(['blackboard', 'blackboard_recall']);
const visibleText = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
export function sourceRefs(branch: BranchEntry[], manager?: any): SourceRef[] {
  const projection = manager?.buildSessionProjection?.();
  const contributions = projection?.entries ?? branch.map(sourceEntry => ({ sourceEntry, messages: sourceEntry.type === 'message' ? [sourceEntry.message] : sourceEntry.type === 'compaction' || sourceEntry.type === 'branch_summary' ? [{ role: 'summary', content: sourceEntry.summary }] : [] }));
  const out: SourceRef[] = [];
  for (const contribution of contributions) {
    const entry = contribution.sourceEntry as BranchEntry;
    if (!entry.id || entry.customType?.startsWith('sbb-')) continue;
    const messages = contribution.messages.filter((message: any) => {
      if (message.role === 'toolResult' && ownTools.has(message.toolName)) return false;
      if (message.role === 'assistant') {
        const calls = Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'toolCall') : [];
        if (!visibleText(message.content) && (!calls.length || calls.every((call: any) => ownTools.has(call.name)))) return false;
      }
      return message.role !== 'system';
    }).map((message: any) => ({ ...message, content: Array.isArray(message.content) ? message.content.filter((part: any) => part.type !== 'thinking') : message.content }));
    if (!messages.length) continue;
    const role = entry.message?.role;
    out.push({ entryId: entry.id, fingerprint: fingerprint(messages), kind: entry.type === 'compaction' || entry.type === 'branch_summary' ? 'native-summary' : role === 'user' ? 'user' : role === 'toolResult' ? 'tool' : 'assistant', ...(entry.message?.toolCallId ? { callId: entry.message.toolCallId } : {}) });
  }
  return out;
}
export const draftCandidates = (draft: PendingDraft | null) => Object.entries(draft?.sections ?? {}).flatMap(([section, lines]) => (lines ?? []).map(text => ({ id: `c-${fingerprint([section, text]).slice(0, 24)}`, section: section as Section, text })));
export function makeOffer(projection: JournalProjection, branch: BranchEntry[], manager?: any): ReviewReceipt {
  const range = sourceRefs(branch, manager), candidateIds = draftCandidates(projection.draft).map(item => item.id);
  const leafId = range.at(-1)?.entryId ?? branch.at(-1)?.id ?? '';
  return { id: `review-${fingerprint([range, candidateIds, projection.generation]).slice(0, 32)}`, leafId, range, candidateIds,
    constraintsChecked: false, executionChecked: false, goalChecked: false };
}
export function validateReview(projection: JournalProjection, params: { id: string; constraintsChecked: boolean; executionChecked: boolean; goalChecked: boolean }, branch: BranchEntry[], manager?: any): ReviewReceipt {
  const offer = projection.offers[params.id];
  if (!offer || !branch.some(entry => entry.id === offer.leafId)) throw new Error('Review credential missing or not on this branch; request a fresh review');
  const current = new Map(sourceRefs(branch, manager).map(source => [source.entryId, source]));
  if (offer.range.some(source => canonical(current.get(source.entryId)) !== canonical(source))) throw new Error('Review source content changed; request a fresh review');
  for (const key of ['constraintsChecked', 'executionChecked', 'goalChecked'] as const) if (typeof params[key] !== 'boolean') throw new Error(`Review requires explicit ${key}`);
  return { ...offer, constraintsChecked: params.constraintsChecked, executionChecked: params.executionChecked, goalChecked: params.goalChecked };
}
export function checkReadiness(projection: JournalProjection, required: SourceRef[]) {
  const accepted = projection.reviews.filter(review => review.constraintsChecked && review.executionChecked && review.goalChecked);
  const covered = new Set(accepted.flatMap(review => review.range.map(source => canonical(source))));
  const missing = required.filter(source => !covered.has(canonical(source)));
  const active = Object.values(projection.entries).filter(entry => entry.validity === 'active' && !entry.legacyUnscoped);
  const reasons: string[] = [];
  if (!active.some(entry => entry.section === 'goal')) reasons.push('missing current goal or explicit no-active-task note');
  if (!active.some(entry => entry.taskState)) reasons.push('missing explicit execution/task state');
  if (missing.length) reasons.push(`${missing.length} source contributions not reviewed`);
  const reviewedCandidates = new Set(accepted.flatMap(review => review.candidateIds));
  const unseenCandidates = draftCandidates(projection.draft).filter(candidate => !reviewedCandidates.has(candidate.id));
  if (unseenCandidates.length) reasons.push(`${unseenCandidates.length} pending candidates not reviewed`);
  return { ok: !reasons.length, reasons, missing, unseenCandidates };
}
/** Conservative byte-based envelope estimate, not an exact tokenizer or stale countdown. */
export function repairHeadroom(usage: { tokens: number | null; contextWindow: number } | undefined, prompt: string, transcript?: unknown): boolean {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return false;
  const observed = typeof usage.tokens === 'number' && Number.isFinite(usage.tokens) ? usage.tokens : null;
  if (observed === null && transcript === undefined) return false;
  const input = Math.max(observed ?? 0, transcript === undefined ? 0 : Buffer.byteLength(JSON.stringify(transcript), 'utf8'));
  return input + Buffer.byteLength(prompt, 'utf8') + 8192 < usage.contextWindow;
}

export function validateSources(sources: SourceRef[], branch: BranchEntry[], manager?: any): void {
  const current = new Map(sourceRefs(branch, manager).map(source => [source.entryId, source]));
  for (const source of sources) if (canonical(current.get(source.entryId)) !== canonical(source)) throw new Error(`Source ${source.entryId} missing, changed or wrong kind`);
}

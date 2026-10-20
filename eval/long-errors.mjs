/** Allow only identified model-correctable note validation errors, never arbitrary I/O. */
export function recoverableNoteError(tool, result) {
  if (!['blackboard', 'blackboard_recall'].includes(tool)) return false;
  const message = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  if (/\b(EIO|EACCES|EPERM|ENOSPC|EMFILE|ENOENT|EBUSY)\b|append not confirmed|unexpected branch|cannot be replayed|writer lock/i.test(message)) return false;
  if (/^Validation failed for tool "(?:blackboard|blackboard_recall)":\n  - /.test(message)) return true;
  return [
    'Blackboard journal: supersedes must match exactly one active entry',
    'Blackboard journal: ID updates require current expectedRevision',
    'Blackboard journal: choose ID or supersedes, not both',
    'Blackboard journal: section required',
    'Blackboard journal: a batch cannot revise the same entry twice',
    'User-origin notes require actual user-message sources',
    'Review credential missing or not on this branch; request a fresh review',
    'Review source content changed; request a fresh review',
    'Review requires explicit ',
    'No entry with this ID on the current branch',
    'retain requires expectedRevision',
  ].some(prefix => message.includes(prefix));
}

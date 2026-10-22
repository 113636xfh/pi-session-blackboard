/**
 * Loss-minimizing input firewall for a future CompactBench adapter.
 * This is not an adapter and does not call the pi extension; it only projects
 * the benchmark case into the fields a compactor is allowed to observe.
 */
export const COMPACTBENCH_SOURCE_COMMIT = 'b2bb0e2254010e7842801b9101e56fd9a6542615';
const ROLES = new Set(['user', 'assistant', 'system']);

/**
 * Project only a chronological prefix of the transcript and the preceding
 * agent-produced artifact. Ground truth, evaluation items, tags, template
 * metadata, later turns, and other case fields are intentionally not copied.
 * `visibleTurnCount` is a prefix length, not a turn ID, so callers must advance
 * it monotonically as new turns become visible.
 */
export function buildCompactorBoundary(generatedCase, visibleTurnCount, previousArtifact = null) {
  if (!generatedCase || !Array.isArray(generatedCase.transcript?.turns)) {
    throw new TypeError('generatedCase.transcript.turns must be an array');
  }
  const turns = generatedCase.transcript.turns;
  if (!Number.isInteger(visibleTurnCount) || visibleTurnCount < 0 || visibleTurnCount > turns.length) {
    throw new RangeError('visibleTurnCount must be a valid transcript prefix length');
  }
  const projectedTurns = turns.slice(0, visibleTurnCount).map((turn, index) => {
    if (!turn || !Number.isSafeInteger(turn.id) || !ROLES.has(turn.role) || typeof turn.content !== 'string') {
      throw new TypeError(`invalid transcript turn at index ${index}`);
    }
    if (index > 0 && turn.id <= turns[index - 1].id) {
      throw new TypeError('transcript turn IDs must be strictly increasing');
    }
    // An explicit allow-list drops generation tags and any future metadata.
    return { id: turn.id, role: turn.role, content: turn.content };
  });
  return {
    transcript: { turns: projectedTurns },
    previousArtifact: previousArtifact == null ? null : structuredClone(previousArtifact),
  };
}

/**
 * Append only the newly visible portion of a sanitized prefix to a real pi
 * SessionManager. The caller still owns model prompting and compaction; this
 * function never sees scorer fields or triggers a model call.
 */
export function appendVisibleTurns(sessionManager, boundary, { fromTurnCount = 0, timestamp = Date.now(), provider = 'benchmark-replay', model = 'transcript' } = {}) {
  const turns = boundary?.transcript?.turns;
  if (!Array.isArray(turns)) throw new TypeError('boundary.transcript.turns must be an array');
  if (!Number.isInteger(fromTurnCount) || fromTurnCount < 0 || fromTurnCount > turns.length) {
    throw new RangeError('fromTurnCount must be a valid prior prefix length');
  }
  if (!sessionManager || typeof sessionManager.appendMessage !== 'function') {
    throw new TypeError('a real SessionManager with appendMessage is required');
  }
  const entryIds = [];
  for (const [offset, turn] of turns.slice(fromTurnCount).entries()) {
    const at = timestamp + offset;
    if (turn.role === 'user') {
      entryIds.push(sessionManager.appendMessage({ role: 'user', content: turn.content, timestamp: at }));
    } else if (turn.role === 'assistant') {
      entryIds.push(sessionManager.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: turn.content }],
        api: 'openai-completions', provider, model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: at,
      }));
    } else {
      throw new TypeError(`pi replay adapter does not support transcript role ${turn.role}`);
    }
  }
  return entryIds;
}

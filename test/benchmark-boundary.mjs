import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactorBoundary, COMPACTBENCH_SOURCE_COMMIT } from '../eval/benchmark-boundary.mjs';

test('CompactBench boundary pins source and exposes only a tag-free chronological prefix', () => {
  const caseRecord = {
    case_id: 'case-public',
    template_key: 'buried_constraint_v1',
    transcript: { turns: [
      { id: 0, role: 'user', content: 'Keep the staging database unchanged.', tags: ['critical_constraint'] },
      { id: 1, role: 'assistant', content: 'Understood.', tags: [] },
      { id: 2, role: 'user', content: 'Later turn must not leak.', tags: ['distractor'] },
    ] },
    ground_truth: { forbidden_behaviors: ['GOLD_SECRET_6f9182'] },
    evaluation_items: [{ prompt: 'QUESTION_SECRET_91e0', expected: { answer: 'ANSWER_SECRET_a1c4' } }],
  };
  const view = buildCompactorBoundary(caseRecord, 2);
  assert.equal(COMPACTBENCH_SOURCE_COMMIT, 'b2bb0e2254010e7842801b9101e56fd9a6542615');
  assert.deepEqual(view.transcript.turns, [
    { id: 0, role: 'user', content: 'Keep the staging database unchanged.' },
    { id: 1, role: 'assistant', content: 'Understood.' },
  ]);
  const serialized = JSON.stringify(view);
  for (const secret of ['GOLD_SECRET_6f9182', 'QUESTION_SECRET_91e0', 'ANSWER_SECRET_a1c4', 'Later turn must not leak.', 'critical_constraint', 'distractor']) {
    assert(!serialized.includes(secret), `compactor view leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(view).sort(), ['previousArtifact', 'transcript']);
});

test('boundary keeps previous agent artifact but copies it and never accepts a bad prefix', () => {
  const prior = { summaryText: 'agent state', structuredState: { unresolvedItems: ['todo'] } };
  const sample = { transcript: { turns: [{ id: 0, role: 'user', content: 'visible', tags: ['label'] }] }, ground_truth: { secret: 'gold' } };
  const view = buildCompactorBoundary(sample, 1, prior);
  assert.deepEqual(view.previousArtifact, prior);
  assert.notEqual(view.previousArtifact, prior);
  assert.throws(() => buildCompactorBoundary(sample, 2), /prefix length/);
  assert.throws(() => buildCompactorBoundary(sample, -1), /prefix length/);
  assert.throws(() => buildCompactorBoundary({ transcript: { turns: [{ id: 2, role: 'user', content: 'x' }, { id: 1, role: 'user', content: 'y' }] } }, 2), /strictly increasing/);
});

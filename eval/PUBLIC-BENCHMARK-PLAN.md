# Public benchmark gate: protocol findings, not a score

Status: source reconnaissance only. **No public benchmark data has been run through this project, no public-benchmark adapter is qualified, and no result from this note completes PLAN.md S7.** The Luna long-state matrix remains a separate synthetic diagnostic.

## CompactBench pin and implications

- Upstream: [compactbench/compactbench](https://github.com/compactbench/compactbench)
- Source snapshot: `b2bb0e2254010e7842801b9101e56fd9a6542615` (vendored read-only under `eval/vendor/cb`; clean worktree when inspected).
- Snapshot declares package **0.2.0**. Its `CHANGELOG.md` changes **scorer 1.0.0 → 2.0.0**; these scores are explicitly non-comparable. The release note calls out important old leakage: per-turn `tags` previously let a compactor identify which turns contained the constraint. The pinned runner calls `transcript.without_tags()` at the compaction boundary. It passes only the transcript and previous artifact to the compactor; continuation generation sees the prior artifact, and evaluation/gold are used after compaction for scoring. This is the relevant answer-leakage boundary to preserve and independently test in any adapter.
- The `v0.2.0` release/tag lookup did not resolve during reconnaissance; the exact immutable source commit is the pin, not an assumed tag. The source's own README and changelog provide the package/scorer declarations.
- Source license: Apache-2.0.
- Important pinned scorer limitations: the official methodology documents a **0.235 null-arm overall floor**, with planning soundness entirely passable from an empty artifact and forbidden-behavior retention partly passable by silence. Do not interpret raw overall score as retained-state accuracy. Include pinned `null` and `oracle` controls, preserve item-type diagnostics, and label these known limitations. The official page says its published leaderboard methodology has further qualification floors; do not call a local run leaderboard-qualified unless the upstream qualification code actually accepts its results.
- Official references: [README](https://github.com/compactbench/compactbench/blob/b2bb0e2254010e7842801b9101e56fd9a6542615/README.md), [CHANGELOG](https://github.com/compactbench/compactbench/blob/b2bb0e2254010e7842801b9101e56fd9a6542615/CHANGELOG.md), [methodology](https://compactbench.github.io/compactbench/methodology/).

### Adapter gate before any scored run

CompactBench's native contract is `Compactor.compact(transcript, previous_artifact)`; this project's implementation is a pi extension whose state is created by live conversation turns, note-tool calls, session-tree events, and pi compaction hooks. Simply serializing a generated case into a summary prompt or pre-populating board entries from its ground truth would **not** test this extension and would violate the no-gold-prefill requirement. A real adapter must:

1. Reconstruct each turn in order in a clean pi session, with no ground-truth, expected answers, tag metadata, or future turns exposed to the agent/extension.
2. Let the selected agent form notes only from information visible so far; at each versioned compaction boundary invoke the real extension/hook and persist the resulting session state.
3. Resume from only the compacted state/artifact plus the benchmark's permitted continuation; never restore omitted original transcript turns as hidden context.
4. Keep probes, evaluation prompts, scorer output, expected values and grader feedback outside the writable main trajectory. Verify the main session file/hash and branch before/after any read-only diagnostic fork.
5. Bind each attempt to exact dataset/template seed, source commit, scorer commit, pi version, model identifier and thinking setting, method/config, context/tail/tool budgets, cycle count, and complete request/token/cost evidence. Unknown quantities remain unknown, not zero.
6. Prove with adversarial fixtures that the adapter cannot read `ground_truth`, `evaluation_items.expected`, tags, future turns, other arms' board files, or prior probe answers. A source inspection alone is insufficient; add a taint/sentinel test at the exact compaction boundary.

The pinned upstream runner's drift cycles are **not equivalent** to a pi persisted compaction cycle: upstream appends its generated continuation after an artifact-only response and compacts the resulting transcript. An adapter must describe exactly how that is mapped to pi's session/hook contract. An initial helper now exists at `eval/benchmark-boundary.mjs`: it allow-lists visible turn fields, strips turn tags/extra case metadata, and accepts only an explicitly sized chronological prefix; its two sentinel tests pass. This is only a **boundary primitive**, not the Pi replay/compaction adapter, and does not establish end-to-end isolation. Until that mapping and adversarial boundary tests are integrated with a real offline Pi session, CompactBench is an external protocol reference, not an eligible scored dependency.

## Diagnostic datasets

### MemoryAgentBench

- Official repo: [HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench); official HF dataset: [ai-hyz/MemoryAgentBench](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench).
- The README describes chunked incremental multi-turn interactions and an **inject once, query multiple times** design. Its Conflict Resolution split includes `fact_sh` / `fact_mh`; exact-matching output is strict, while other tasks use different metrics. Keep only a small conflict-resolution diagnostic subset initially, preserve original chunks/order, and use the scorer matching the dataset/task. Do not infer benchmark-wide performance from the slice.
- The HF dataset card reports MIT, but pin the dataset revision and verify the selected files/metadata before copying or redistributing. Do not vendor the full dataset by default.

### LongMemEval

- Official repo: [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval); official dataset card: [longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).
- Use the cleaned histories (the maintainers report removing sessions that interfere with answer correctness), not the earlier noisy copy. The official format includes `question_type`, dated sessions, `answer`, evidence-session IDs, and `has_answer` markers; labels/evidence markers must stay strictly in the scorer sidecar.
- Start with a few **abstention** and **temporal-reasoning / knowledge-update** cases to diagnose refusal and stale-value resurrection. Preserve original chronological order. The official README uses an LLM-as-judge pipeline for QA; any adapted scorer/model/version must be pinned and its extra requests/cost reported. Verify the selected HF revision and license before download or redistribution—the repository README is MIT, but the cleaned dataset card did not expose a clear license in the search evidence, so this remains unresolved.
- The official corpus is large (HF search reported ~3 GB total); do not fetch the full corpus for a small diagnostic. Select and hash a minimal subset, retaining only what licensing and data handling permit.

### CompAct-Bench

- Official page: [CompAct-Bench](https://compaction-eval.github.io/CompAct-Bench/), described as a 2026 preprint with 200 tasks across BrowseComp, SWE-bench and an internal CompanyBench suite.
- The useful transferable idea is **environment snapshot at a successful trajectory boundary → compact history → restore same boundary state → resume same executor under remaining action budget**, with native task evaluation and no reference summaries. Its page describes task-level process evaluation, but an independently runnable full harness/data bundle was not verified. Do not treat the website, reported aggregate numbers, or internal CompanyBench as a dependency or reproducible score. Borrow the snapshot/resume protocol only after a local task harness is independently implemented and validated.

## Cost/quality gate for future work

No budget window in this note authorizes model requests. Before any later live batch: pin a currently authorized model (for the 2026-10-22 window, only `openai/gpt-6-luna`, `thinking=high`), hard-cap requests and wall time, calculate a conservative ceiling, and stop at the authorization deadline. No Qwen fallback. Report at minimum per-arm paired task outcomes, constraint violations, unsupported assertions, state/path/status accuracy, repeated work where observable, all input/output/cached tokens, reported currency if present, timeouts/failed attempts and unknown-cost status. Public and diagnostic findings stay separate. Do not reduce checkpoint/receipt overhead until correctness passes its gate.

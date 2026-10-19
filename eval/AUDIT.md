# Re-audit and operating lessons — 2026-10-19

## Why the previous trial was not sufficient

The prior trial executed the model worker from a repository shell, but the
scheduled action used `cmd /c D:\01-R&D\...` without quoting. Windows interpreted
`&` as a command separator: the scheduled action exited 1 before creating a log.
A working single model request was incorrectly treated as launch-chain evidence.
The failed schedule has been deleted; do not recreate it without permission.

Other problems found in the re-audit:

| Finding | Correction / evidence |
|---|---|
| Native system prompt still required a nonexistent blackboard tool | Arm-specific system and user prompts; no notes-file invitation in native mode |
| Old 0.2 arm was asked to use the new review credential API | Version-specific notes protocol; clean baseline pinned to `08356132d6d9f92e80ebd023feb656dbc286716f` |
| Unequal tails: 800 native, 6000 board | Same resolved 800-token tail recorded for every smoke arm |
| `round <= rounds` executed an extra round | Exactly `round < rounds`; offline assertions require 2 files, no third file |
| Fake stream only issued note actions once across a whole session | Explicit per-phase deterministic fixture state |
| Tool-budget abort and incomplete compaction could be treated as success | Fatal status persists; tool failure/truncation/request limit cannot pass |
| Worker/matrix failures still exited 0 | Nonzero exit, incremental report, fail-fast before another arm |
| Native call count inferred from metadata; unknown summed as 0 | Instrument actual runtime request starts/completions; preserve null |
| Source-file mentions were treated as evidence of editing those source files | Actual writes validated only in the synthetic fixture; no real coding-success claim |
| No continuation after compaction | Require saved compaction node and a resumed model response |
| Counting any occurrence of a withdrawn term as resurrection | Literal absence is a diagnostic only, not a semantic correctness score |
| Legacy live check contained `check(..., true)` | Retired entry point, no longer a possible release PASS |
| Partial result files overwritten by subsequent runs; killed startup invisible | Unique output directories, first artifact before model work, incremental progress |
| Windows occasionally rejects replacing a progress artifact | Bounded atomic-replace retries; never turn I/O failure into success |
| Slow local provider ignores cancellation | Parent process deadline, tested against a never-ending fake stream |

This is a re-audit of the evaluation and release-check path, not a claim that all
extension semantics have received a second independent review. The existing
extension regression/typecheck/package checks also remain required.

## Operating rules: keep these lessons, not just the patch

1. Confirm the **exact launch entry**, argv quoting, current directory, exit
   status, evidence writes, timeout and cleanup offline before any GPU request.
   If a scheduler is ever re-authorized, test that exact scheduled action, not a
   different terminal command. Do not infer success from task registration.
2. Lock model, task, rounds, request/tool/output budgets and whole-batch deadline
   **before starting**. Do not use expensive execution to debug orchestration.
3. No autonomous background runs, schedules, retries, expansion to a full matrix,
   or cost-budget increases. Authorization to implement code is not unlimited
   authorization to occupy the user's GPUs.
4. First failure stops the active attempt, not the repair work. Inspect the
   evidence and fix/test offline. If the user authorized repair-and-retest, resume
   only the failed arm within the **same cumulative budget**; never silently
   reset that budget or rerun already-completed arms. Otherwise ask before a new
   live attempt. A failed attempt must remain failed in the evidence ledger.
5. Unknown is not zero; cancelled is not completed; partial is not passed. A
   process exiting 0 or a single working model request does not prove the whole
   chain or the published benchmark contract.
6. Do not trim checkpoints/receipts to rescue timing before correctness. Do not
   change scorer conditions just to turn a live report green.

## Initial attempt (before the user's repair-and-retest clarification)

User chose: three arms × one task × exactly two user rounds, **600 seconds total**,
200 seconds per arm, first anomaly stops the batch. No scheduler or background
launch was used. The offline acceptance suite and release check passed first.

Run: `eval/results/smoke-2026-10-19T11-54-42-540Z-42068/report.json` (local ignored
artifacts; synthetic sessions only).

- Native arm stopped after **26.3 s**, **2 actual model requests**, 0 completed
  user rounds and 0 compactions. Both model responses completed; no in-flight
  response remained when the supervisor reported child exit.
- The first request correctly wrote `fixture/step-1.txt`.
- The second request attempted to create `fixture/blackboard.md` in response to
  an ambiguous state-recording instruction. The pre-execution path guard blocked
  it. The extra file does not exist. This was a task-prompt defect, not proof of
  a broken compactor and not a valid memory comparison.
- Prefix and fixed arms were **not started**. The batch returned nonzero. The
  result/progress/session evidence was retained and the live lock released.
- The native user instruction is now explicit: one fixture write, one sentence
  of state, no notes file or other file. An offline replay of the unsolicited
  write checks that the guard blocks it. Execution was paused at this point;
  the user subsequently explicitly required fixing and running through, below.
- Reported usage: request 1 input 4083/output 99; request 2 input 79, cache-read
  4181/output 175. These are provider-reported counters, not independently metered
  tokens or GPU energy. Total output 274; no monetary/local-GPU-free claim.

Final offline verification after the prompt fix: `npm run release:check` passed
(typecheck, original smoke, 98 node tests: 97 passed/1 platform skip, 3 known-failure
regressions passed, package dry-run). The node suite includes all 11 evaluation
acceptance checks. No further live requests were made during these checks.

## Repair-and-retest continuation: all three small cases completed

The user clarified that the task is to fix and run through, not stop permanently
on the first defect. Continued within the original **600-second cumulative cap**,
including the earlier 26.333 seconds. Completed native/prefix cases were retained;
only the failed fixed arm was retried after offline checks.

Further evidence and repairs:

- The source gate correctly rejected `origin=user` without actual user-message
  refs, and later an invented `tool-write-step1` source ID. The tool's schema had
  not explained how to obtain refs or that ordinary paraphrases should omit
  origin/sources. Added field descriptions, default-assistant annotation and
  actionable errors. **No source-validation rule was relaxed.**
- One attempt emitted incomplete model-generated JSON (`{\"review\":`). It was
  not accepted or silently repaired into a success. Clarified the two separate
  review/confirmation calls and credential-ID versus note-ID distinction.
- Another attempt used an `m-...` note ID in `supersedes`, which is the legacy
  text-substring selector. Clarified that field, and that an ID update uses `id`
  plus `expectedRevision`; retained the rejection and optimistic version check.
- The synthetic fixed-arm protocol now prescribes minimal ordinary note objects
  (`section` and `text` only), followed by the real review credential exchange.
  No gold answers or future benchmark labels were inserted.
- Offline regressions verify invalid user origin and ID-as-substring updates
  remain atomic rejections, while omitted-origin notes, actual user SourceRefs
  and correctly versioned ID updates work. Same-entry offline compaction/resume
  passed before each further live attempt.

| completed case | supervised time | requests | manual compactions | board takeover | native summary calls |
|---|---:|---:|---:|---:|---:|
| native | 35.9 s | 6 | 1 | 0 | 1 |
| 0.2 prefix | 38.4 s | 9 | 1 | 1 | 0 |
| fixed | 59.8 s | 11 | 1 | 1 | 0 |

All completed cases wrote exactly two fixture files, persisted a compaction node
and resumed with both exact source paths present. This is a **wiring smoke**,
not a semantic accuracy score. Native/prefix replies explicitly mentioned the
withdrawn token as withdrawn; raw token absence is therefore not a valid measure
of resurrection. The fixed answer described two fixture steps completed and
reported the remaining reporting step; no multi-task success rate is inferred.

**Including all failed attempts**, total supervised live wall time was
**383.998 seconds** (6 min 24 s), **47 requests**. Provider-reported counters:
111145 input, 3628 output, 361235 cache-read, 0 cache-write tokens. No request was
still incomplete in the recorded runtime streams. This is not independently
metered GPU busy time or monetary cost. One provider stream took 109 seconds
despite a requested 60-second transport timeout, reinforcing why the parent
process deadline remains authoritative.

Machine-readable ledger: [smoke-evidence-20261019.json](smoke-evidence-20261019.json).
Raw synthetic artifacts remain locally under `eval/results/`, with per-run
source/harness digests. Failed attempts are not overwritten or dropped.

Final verification of the repaired implementation: `npm run release:check`
passed (typecheck, original smoke, 100 node tests: 99 passed/1 platform skip,
3 known-failure regressions, package dry-run). The node suite includes 12 offline
evaluation checks, including the cumulative repair-budget ledger. Source-gate and
version-check rejection behaviour remains covered.

The successful cases span repairs, so the table is **not a frozen-version A/B
performance comparison**. It also contains one manual compaction per case, not
2/4 compaction cycles. Plan steps 47–52 and repeated-auto-compaction release gates
remain open. No 4/8/16-cycle expansion, schedule or deployment was started.

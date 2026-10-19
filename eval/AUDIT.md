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
4. First failure stops the whole batch. Inspect the persisted evidence; fix and
   test offline. A new live attempt needs a new decision, not an implicit retry.
5. Unknown is not zero; cancelled is not completed; partial is not passed. A
   process exiting 0 or a single working model request does not prove the whole
   chain or the published benchmark contract.
6. Do not trim checkpoints/receipts to rescue timing before correctness. Do not
   change scorer conditions just to turn a live report green.

## This authorized live batch

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
  write checks that the guard blocks it. **No automatic live retry follows.**
- Reported usage: request 1 input 4083/output 99; request 2 input 79, cache-read
  4181/output 175. These are provider-reported counters, not independently metered
  tokens or GPU energy. Total output 274; no monetary/local-GPU-free claim.

Final offline verification after the prompt fix: `npm run release:check` passed
(typecheck, original smoke, 98 node tests: 97 passed/1 platform skip, 3 known-failure
regressions passed, package dry-run). The node suite includes all 11 evaluation
acceptance checks. No further live requests were made during these checks.

The live **full chain did not complete**. Offline three-arm wiring passed, but
all plan steps 47–52 and the manual/automatic real-session release gates remain
open. Earlier reported tables are withdrawn as comparative evidence.

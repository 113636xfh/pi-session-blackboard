# Evaluation

Two separate things live here:

1. **`config.json`** — the evaluation contract: arms, synthetic tasks, probes, loop
   sizes, and the budget note. No private session data is referenced.
2. **`run.mjs`** — a deterministic harness. It drives a real pi 1.3.0 session
   (real `SessionManager`, real extension loader, real compaction trigger) with an
   **in-process scripted model**, then asserts on the **persisted summary text**.

```bash
npm run eval                       # all arms that exist locally, 4 rounds
npm run eval -- --arm native       # one arm
npm run eval -- --rounds 2         # loop size
```

Results land in `eval/results/`. Everything in the default run is free: no
network, no provider credentials, `fetch` is irrelevant to it.

## What it measures, and what it does not

It measures the **compaction pipeline**: what ends up in the persisted summary,
how many summarizer calls were made, and how many extra model requests were
spent. It does **not** measure model quality — both the agent and the summarizer
are scripted, so a "pass" means the pipeline carried the fact through, not that a
real model would have.

The scripted agent follows the loop the extension asks for: commit notes → request
the review credential → confirm the range. It is deterministic; there is no
sampling and no seed to fix.

## Recorded result (scripted agent, 2 and 4 rounds, free)

| arm | tasks | probes passed | summarizer calls |
|---|---|---|---|
| `native` (pi 1.3.0 alone) | 4 | 4/4 | 8 |
| `board-prefix` (0.2 code, git worktree of `08356132`) | 4 | 4/4 | 3 |
| `board-fixed` (this tree) | 4 | 4/4 | 7 |

**Read this honestly: it is not a win for this extension.** With a scripted agent
and a competent scripted summarizer, all three arms keep the constraint, the
current step and the hypothesis label, and none resurrects the retracted plan —
the probes are too weak to discriminate. The interesting number is the cost side:
`board-fixed` spends *more* summarizer calls than 0.2 here, because the coverage
gate refuses takeover whenever a range has not been explicitly reviewed, and falls
back to native. A real agent that reviews as asked would spend fewer; a real agent
that ignores the reminder would spend more than 0.2. That trade (safety for cost)
is the actual behaviour being observed, and it needs real-model runs to quantify.

A paid run must therefore be judged on more than "did the fact survive":
per-round correctness, stale-fact resurrection, unsupported assertions, duplicated
work, and total cost.

## Paid runs (not authorised by this repository)

`config.json` carries the budget note: the existing cap is ¥10 for DeepSeek, and
the estimate must be re-checked against current pricing before any spend. A paid
run needs:

- a pinned model and endpoint recorded alongside the results;
- the same tasks, tail budget and remaining actions as the free run;
- the summarizer prompt held constant across arms, so the comparison is about the
  pipeline and not about summary style;
- cost accounting per compaction generation, including repair requests.

Do not add paid runs to `npm test` or to CI.

## Public benchmarks (S7, still gated)

- **CompactBench** — pin `v0.2` / `scorer2.0.0` (or a later explicit commit).
  Its changelog says `v0.1` had label leakage and reward-stability defects.
- **CompAct-Bench** — the public artefact is a site/PDF, not a runnable harness,
  so it is used only as a protocol reference, not as a dependency.
- **MemoryAgentBench / LongMemEval** — conflict-update and abstention diagnostics.

None of these is wired up here yet, and none should be described as "run" until
the harness is actually pinned and executed.

## Real-model runs and the nightly job

`eval/run.mjs --model <provider>/<model>` swaps the scripted model for a real one
(here: the local `strata/qwen3.8-flash-next-iq3_s` endpoint). Because a real model
reports its own token usage, a short fixture may never reach the automatic
threshold, so the real-model path also forces one manual compaction at the end —
that is the path where coverage must still be established for takeover.

```bash
npm run eval -- --model strata/qwen3.8-flash-next-iq3_s --task constraint-trap --rounds 1 --arm board-fixed
SBB_EVAL_ROUNDS=2,4 node eval/nightly.mjs      # the full matrix, one task at a time
```

`eval/nightly.mjs` runs every arm × task × round-count sequentially with a
per-task timeout, appending to `eval/results/`. A Windows scheduled task
(`PiSessionBlackboardNightly`, 05:00 one-shot) runs `eval/nightly.cmd`.

Trial result (1 task, 1 round, real model): 3 compactions, 13 669-char summary
produced by this extension, constraint preserved, retracted instruction absent —
the probe on the *paraphrased* step wording failed, which is why probes now use a
short stable token (`config`) instead of the full phrasing. That is a probe fix,
not a pipeline fix.

### CompactBench: the version assumption was wrong

`git ls-remote --tags` on `github.com/compactbench/compactbench` lists only
`v0.1.0`; there is no `v0.2` tag (the plan's "v0.2.0 / scorer 2.0.0" is not
tagged in the public repo). The default branch is pinned locally under
`eval/vendor/cb` (gitignored) for reading, but **no adapter is wired up yet**:

- CompactBench evaluates a *compactor* against adversarial transcripts and probing
  questions, in Python, behind a configurable OpenAI-compatible endpoint.
- Our renderer is not a general transcript compactor: it renders committed notes.
  A faithful integration therefore has to run our extension inside their loop,
  which is a separate adapter with its own tests.
- Until that adapter exists and is verified, no CompactBench number may be quoted.

`CompAct-Bench` remains a protocol reference (site/PDF, no runnable harness), and
`MemoryAgentBench` / `LongMemEval` are the next two datasets to wire once the
adapter shape is proven. This is deliberate: the plan forbids publishing numbers
that were not actually produced.

## Long-run safety (measured 2026-10-18, local `strata` endpoint)

Trial runs exposed three things that only show up on long tasks, all now fixed:

1. **Unbounded tool loop.** The model keeps calling the notes tool round after
   round, and every call is a full request on a slow local endpoint. A round that
   should take seconds ran for 10+ minutes. Fixed with a per-round tool budget
   (`SBB_EVAL_MAX_TOOLS`, default 6) that aborts the round.
2. **In-process timeouts are not a real bound.** `session.abort()` does not
   reliably cancel an in-flight request to a slow provider, so a per-round timer
   alone let one task run 900 s. The hard bound is now the parent process kill in
   `nightly.mjs` (`SIGKILL`, `perTaskMinutes + 2`).
3. **A killed task left no evidence.** Each round now writes
   `eval/results/partial-<arm>-<task>-<rounds>rounds.json`, so a killed run still
   reports how far it got.

Measured wall clock, real model, one task (`path-fidelity`), 2 rounds:

| arm | status | compactions | takeovers | summarizer calls | probes | summary |
|---|---|---|---|---|---|---|
| `native` | ran | 1 | 0 | 1 | 3/3 | 3017 chars |
| `board-prefix` (0.2) | skipped | 0 | 0 | — | — | *nothing to compact: 0.2 needs ≥3 committed entries* |
| `board-fixed` | ran | 1 | **1** | **0** | 3/3 | 4176 chars |

The whole 3-arm × 1-task × 2-round sweep took 953 s (native 248 s, prefix 186 s,
fixed 519 s). A 4-round single task completed once with 1 compaction, 1 takeover,
5198 chars, 3/3 probes — and before the tool budget existed, an equivalent 4-round
run blew past 900 s with zero compactions.

Still not verified: the full 4-task × 3-arm × 4-round matrix, manual-compaction
takeover reliability, and any public benchmark. Those are why step 47 and the
release gate stay open.

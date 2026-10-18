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

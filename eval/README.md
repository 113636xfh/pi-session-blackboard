# Evaluation and bounded smoke checks

## Status: 46/52 plan steps complete, release gate still open

The current entry point is a **small wiring smoke**, not a public benchmark or a
validated quality/cost comparison. It exercises a real pi 1.3.0 session, extension
loading, actual fixture-file writes, one persisted **manual** compaction, and a
post-compaction continuation. It does not verify repeated automatic compaction,
8/16 compaction cycles, or the remaining release gates.

**Earlier evaluation tables are withdrawn as comparative evidence.** The old
harness had unequal tail budgets, an off-by-one round count, version-inappropriate
prompts, no post-compaction probe, and failure paths that returned success.
Missing request counts were also summed as zero. Those reports remain historical
artifacts, not evidence of relative performance. See [AUDIT.md](AUDIT.md).

## Safe defaults and explicit live authorization

```sh
# Offline by default, three arms × one synthetic task × exactly two user rounds.
# The old arm requires the clean local .eval-prefix worktree; otherwise specify arms.
node eval/nightly.mjs
node eval/nightly.mjs --arm native,board-fixed

# Prints the actual launch plan; no worker/model request is started.
node eval/nightly.mjs --dry-run

# Live EXAMPLE ONLY: requires a current user-authorized window and budget.
node eval/nightly.mjs --live --model strata/qwen3.8-flash-next-iq3_s --task path-fidelity --rounds 2 --total-seconds 600 --case-seconds 200
```

`npm run eval` and `eval/run.mjs` delegate to this same supervisor.
`eval/nightly.cmd` is an optional foreground shim, also offline by default.
There is **no scheduled job**. Legacy `eval/live-check.mjs` refuses to execute:
it had no hard supervisor and one unconditional PASS.

Environment variables do not enable live mode or enlarge the batch. Unknown
arguments, invalid selectors, missing baselines, reused output paths, unavailable
models and baseline changes fail closed, before paid work. Live mode is capped
at two user rounds, six tool calls per phase, twenty model requests per case and
600 seconds for the entire batch. These are smoke ceilings, not permission to
run whenever resources become available. After a failure, **do not silently
retry with a modified prompt**.

## What is fixed across arms

- The pinned model, temperature 0 and max output 512 tokens per request.
- Exactly the requested user-round count (no hidden extra round).
- Common work tool: `write`, restricted to the current fixture's expected path.
  Blackboard arms additionally expose only their own notes tools.
- Same synthetic observation, file-write task, manual-compaction stage and resume
  prompt. Tail budget **800 tokens** and reserve 4096 for every arm.
- No automatic compaction in this smoke. It is deliberately isolated from the
  separate repeated-auto-compaction release test.
- No native-arm request to use a nonexistent tool. The 0.2 baseline is told to
  commit notes, not to call the review API that only 0.3 implements.

These settings are recorded in each case's artifacts; they do not establish the
plan's two complete experiment sets (equal-summary-budget and actual defaults).
An occurrence of a withdrawn term can mean the summary correctly records its
withdrawal, not resurrection. Literal-absence checks are diagnostics only; they
must not be presented as semantic accuracy scores.

## Supervision and evidence

The supervisor launches `node` with an argv array and `shell:false`, independent
of the caller's current directory. Paths with spaces and `&` are tested. A
single live-run lock prevents overlapping supervised live batches; stale locks
are not automatically stolen. Do not remove a lock without checking its PID.

The parent owns the hard per-case and total deadlines. It kills a timed-out
worker (process tree on Windows), awaits its exit, records the failure and stops
the batch. SIGINT/SIGTERM also stop the active child. The worker exposes no shell
or process-launch tool. Provider retries are disabled and each provider request
also has a transport timeout, but these are **not substitutes for** the parent
watchdog. Killing a client cannot prove a remote server has cancelled GPU work;
server-side cancellation requires separate evidence. No such guarantee is made.

Every run gets a new output directory. Before the first request it writes the
plan; before/after each stage, request and tool call it updates progress. Atomic
artifact replacement retries short Windows EPERM/EACCES/EBUSY failures, without
truncating the previous evidence. Outputs include:

- `plan.json`, incremental `report.json`: status, deadlines, executable, argv
  policy, baseline commit and source-tree digest;
- per case: model descriptor (no credentials), resolved settings/tools,
  progress, request starts/completions/usage, tool trail and final result;
- synthetic project artifacts, actual pi session JSONL and persisted compaction
  node, including the summary; post-compaction model answer.

Failures, truncation, tool errors, over-budget requests, missing artifacts and
missing compaction nodes are never a PASS or a harmless skip. Unknown metrics
stay `null`, not zero. Count native summarization from observed runtime requests,
not from guesses about compaction metadata. Report configured/self-reported
monetary usage separately from elapsed local GPU time; zero list price does not
mean a free GPU run. No private source sessions are used.

## Offline acceptance before any live run

```sh
npm run test:eval
npm run release:check
```

The offline suite uses the **same entry, supervisor, SDK, extension loader and
persistence path** as live mode, replacing only the provider with an in-process
fixed stream. It forbids `fetch`, checks all three locally available arms from
an unrelated directory with spaces and `&`, exact two-round counting, saved
files, compaction and resume. It injects unbounded tools, failed model responses,
a non-cooperative stream, an unsolicited notes-file write and request-budget
exhaustion. These must fail, stop or time out without spending GPU time. It also
tests the Windows `.cmd` shim, spawn failure, stale output rejection and atomic
artifact replacement.

The fixture deliberately scripts notes, native summaries and the resumed answer.
A green offline check proves wiring, **not a model's memory quality**. It must
never be quoted as a public-benchmark score.

## Public benchmark gate (not run)

- CompactBench: the local read-only checkout under `eval/vendor/cb` exposed only
  `v0.1.0` as a public tag during the earlier audit. The plan's v0.2/scorer2
  requirement remains unresolved. No adapter or eligible pinned run exists.
- MemoryAgentBench and LongMemEval diagnostics are not integrated.
- CompAct-Bench is a protocol reference until a complete runnable harness is
  verified, not an executable dependency inferred from its website.

No public-benchmark numbers, completed plan steps 47–52, or release readiness
are claimed here. Do not prefill live notes from gold labels.

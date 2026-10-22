# Evaluation and bounded smoke checks

## Status: 46/52 plan steps complete, release gate still open

The default entry point is a **small wiring smoke**, not a public benchmark or a
validated quality/cost comparison. Earlier 2026-10-19 smoke evidence and the
2026-10-20 authorization are historical only; neither grants current live
permission. The 2026-10-19 repair-and-retest run completed all three small cases;
see [the full ledger](smoke-evidence-20261019.json), including all failed attempts
(383.998 seconds cumulatively, 47 requests). Successful cases span repairs and
are not a frozen-version performance comparison.

The smoke exercises a real pi 1.3.0 session, extension loading, actual fixture-file
writes, persisted **manual** compactions, and post-compaction continuations.
The offline provider now exercises 2/4/8/16 actual compaction/resume cycles, not
merely 16 user prompts. The default smoke remains limited to one live cycle.
The separate long-run authorization permits 2/4→8/16 manual cycles, but no long
live results or repeated automatic-compaction release acceptance are claimed yet.

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

# Offline long-chain wiring only; does not enable 16-cycle live work.
node eval/nightly.mjs --arm native,board-fixed --cycles 16

# Prints the actual launch plan; no worker/model request is started.
node eval/nightly.mjs --dry-run

# Historical example only: this legacy runner is pinned to the old Qwen smoke
# model and is NOT permitted for the current Luna-only evaluation. Do not run it.
```

`npm run eval` and `eval/run.mjs` delegate to this same supervisor.
`eval/nightly.cmd` is an optional foreground shim, also offline by default.
The default smoke creates **no scheduled job**. A previously authorized one-shot long-run is complete and its authorization is
expired; see the actual result ledger below. Legacy `eval/live-check.mjs` refuses
to execute: it had no hard supervisor and one unconditional PASS. The generic
nightly runner's historical live path is pinned to the former Qwen model and is
not an eligible path for current Luna work.

Environment variables do not enable live mode or enlarge the batch. Unknown
arguments, invalid selectors, missing baselines, reused output paths, unavailable
models and baseline changes fail closed, before paid work. Live mode is capped
at two user rounds, six tool calls per phase, twenty model requests per case and
600 seconds for the entire batch. These are smoke ceilings, not permission to
run whenever resources become available. After a failure, stop that attempt and
inspect/fix/test offline. When the user authorizes repair-and-retest, resume only
the failed arm and carry forward **all elapsed live time** against the same
cumulative cap. Otherwise obtain permission. Do not reset the budget, drop failed
attempts or rerun already-completed arms just to obtain a green matrix.

Finalized schema-3 reports support case-level continuation:

```sh
# Offline: failed groups rerun; successful groups are independently reverified.
node eval/nightly.mjs --resume /absolute/path/to/report.json
# Historical legacy continuation only. It is not a live Luna runner and must not
# be used under the current Luna-only authorization.
```

The ancestor reports are immutable and hash-linked; every failed attempt consumes
the original cumulative time budget. Task, arms, model, cycles and total budget
cannot change on continuation. Successful cases are reused only if their effective
protocol/source signature and persisted evidence still verify. Changed or corrupt
cases are rerun, with the rejection reason retained. A repair may span revisions;
that is **not** a frozen-revision A/B comparison. Interrupted/unfinalized reports
require inspecting the worker and reconciling budget usage first; the entry point
will not silently assume that an orphan or remote request has stopped.

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
  nodes, including each summary; `cycles/<n>/compaction.json` and `resume.json`.

A worker's PASS is not sufficient. The parent separately checks actual files,
successful persisted write-tool results in each cycle, the active session branch,
unique persisted compaction IDs, cut points, cycle ordering, resumed message IDs,
required literal probes, budgets, tools and completed request records. Detached
or tampered summary artifacts cannot turn a failed worker into a passing case.
Unknown/unclassified runtime failures stay distinct from a proven design fault.

Failures, truncation, tool errors, over-budget requests, missing artifacts and
missing compaction nodes are never a PASS or a harmless skip. Unknown metrics
stay `null`, not zero. Count native summarization from observed runtime requests,
not from guesses about compaction metadata. Report configured/self-reported
monetary usage separately from elapsed local GPU time; zero list price does not
mean a free GPU run. No private source sessions are used.

## Offline acceptance before any live run

```sh
npm run eval:preflight     # bounded offline acceptance + fingerprinted receipt
npm run test:eval          # run the harness suite directly, without a receipt
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
artifact replacement. Additional coverage includes caller callback exceptions,
failed tree termination with PID-specific fallback, artifact tampering, shared-budget
continuation and the available arms at 2/4/8/16 persisted compaction/resume cycles
(distributed across the four synthetic tasks, not a full task×cycle cross product).

**Live entry is blocked until this offline suite passes.** A receipt binds the
source/test/protocol files, installed SDK code, lockfile, Node/platform and available
arms. A code/runtime change invalidates it. The gate has its own bounded CPU-only
process and forbids provider network calls; failed gate time is not represented as
GPU use. Receipts are local acceptance artifacts, not cryptographic attestations
against a workspace owner who can edit the code or receipts.

Long-chain testing found that rebuilding the event projection from scratch at every
hook repeatedly cloned all accumulated state. The replacement keeps only a
discardable incremental derivation: every relevant event-prefix fingerprint is
rechecked, forks/rewinds/mutations rebuild it, and returned data is cloned. The
journal, source checks, receipts, summaries and compaction semantics are unchanged;
this is not the token-reduction work deferred until correctness is established.

The fixture deliberately scripts notes, native summaries and the resumed answer.
A green offline check proves wiring, **not a model's memory quality**. It must
never be quoted as a public-benchmark score.

## Completed Luna diagnostic window (not an authorization)

The immutable authorization manifest at
`C:/Users/LittleSatellite233/AppData/Local/sbb-long-20261022-1951-luna/authorization.json`
covered 2026-10-22 19:51:49 through 2026-10-23 01:51:49 local (+08:00), for
`openai/gpt-6-luna` with `thinking=high` only. It is now expired. It prohibited
Qwen, private uploads, pushes, deployments and requests after the hard deadline.
The long-run runner requires an explicit manifest, verifies its scope/deadline and
has no standing permission.

- Step 47 matrix: native / pinned 0.2 / current 0.3, 2/4/8/16 persisted manual
  compaction cycles. All 12 cells were attempted, but one 16-cycle board-prefix
  cell remained an execution failure after one same-scope retry. Eleven cells
  have verified execution; only one of those passed the exact-state quality
  diagnostic. Therefore step 47 remains incomplete.
- `long-state-v1` supplies initial facts once and only later changes: constraints,
  exact paths, task status, hypothesis validity, permission revocation and next
  action. The fixture is a controlled state-retention diagnostic, **not** a public
  benchmark, real coding trajectory, or observation of a model's hidden reasoning.
- After each cut, a fork gets one read-only, tool-free diagnostic request. The main
  session file is hash-checked unchanged. Diagnostic questions/answers are never
  copied back into the main trajectory. Gold state is used only by the verifier.
- Normal wrong answers / invalid JSON with a successful response are quality
  failures. Probe setup, transport, evidence-I/O and unclassified tool errors are
  execution failures and stop before the next generation. Only enumerated note
  validation mistakes can be corrected within the existing request/tool caps.
- A failure pauses for agent inspection. Restarting does not clear pending reviews,
  authorize retries, discard partial request counts or rerun passed cases. All
  outstanding reviews must be decided before any new worker; unknown orphan exit
  status requires explicit reconciliation and confirmation no worker remains.
- A root `STOP` file stops new requests and aborts the active supervised process.
  The controller also rejects new work outside the fixed deadline. This bounds the
  client, not a guarantee that a remote GPU server cancelled disconnected work.

`eval/schedule.ps1` registers a one-shot task using absolute `node.exe` and argv,
not a `cmd /c` string. `eval/scheduled.mjs` logs and supervises that same controller.
An actual scheduled **offline** launch passed all three two-cycle arms on this
Windows host, including the project's ampersand path; the temporary proof task was
removed. The authorized production task is `PiSessionBlackboardLong20261020`.
See [preparation evidence](OVERNIGHT-20261020.md).

Read-only monitoring: `node eval/watch.mjs --manifest <absolute-authorization.json>
--seconds 90` or `--until-start`. Local raw artifacts remain under ignored result
directories. A valid fingerprinted offline receipt is required before live work;
a source/runtime change invalidates it. Mid-run repairs and retries retain their
source versions and all attempts, and are not a frozen-version A/B result.

## Public benchmark gate (research only; not run)

See [the detailed protocol and source findings](PUBLIC-BENCHMARK-PLAN.md).
CompactBench is pinned to immutable commit
`b2bb0e2254010e7842801b9101e56fd9a6542615` (package 0.2.0, scorer 2.0.0), but
its native contract is not yet bridged to this pi extension. MemoryAgentBench and
LongMemEval have candidate diagnostic slices; dataset pinning, licensing checks
and leak-tested adapters remain open. CompAct-Bench is a protocol reference only.

No public-benchmark scores or completed steps 47–52 are claimed here. Never
prefill live notes from gold labels. The expired Luna authorization cannot be
reused; any further model requests require fresh authorization.

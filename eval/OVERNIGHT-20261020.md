# 2026-10-20 long-run preparation

**Status: preparation only; step 47 is not complete. No real-model request has
been made in this new window. No public-benchmark result or deployment claim.**

## Authorization and order

The user authorized today's local **05:00–11:00 (+08:00)** fixed six-hour window,
continuous monitoring, repairs followed by offline verification, and honest
benchmark/trajectory results. The earlier **383.998 seconds / 47 requests** remain
in `smoke-evidence-20261019.json`; this is a new authorization, not a ledger reset.

Execute 47 → 48 → 49 → 50 → 51 → 52, marking each complete only after its own
requirements are met. The initial controller implements **47 only**. Neither a
synthetic diagnostic nor this offline gate substitutes for public benchmarks or
real coding trajectories. Do not trim checkpoints/receipts before correctness.

## Launch proof

- Production task: `PiSessionBlackboardLong20261020`, one-shot 2026-10-20
  05:00:00+08:00, absolute Node executable and argv; no `cmd /c` launcher.
- Manifest: `%LOCALAPPDATA%/sbb-long-20261020/authorization.json`.
- Launcher log: `%LOCALAPPDATA%/sbb-long-20261020/scheduled.log`.
- Artifacts: `eval/results/long-20261020-0500/` (ignored, local only).
- Temporary task `PiSessionBlackboardProbe20261020` ran the **same scheduled Node
  entry/controller**, offline, through the actual Windows Task Scheduler.
  `LastTaskResult=0`; all three two-cycle cases independently verified. Fake
  request counts were native 12 / old 14 / current 22. These are wiring evidence,
  not GPU use or model-quality scores. The temporary task was removed afterward.
- Expired live entry, unrelated cwd and ampersand-path behavior are also covered
  by the offline suite. A double-click `STOP.cmd` is placed with the local manifest;
  its only effect is creating the run's STOP marker.

## Offline gate

Current receipt:
`eval/results/preflight-057c1241c65ace6dbc6f8daab4d965f73d84c00b22fc03bbabce58b02326a089.json`.

**37/37 tests passed**, 311.290 seconds of offline wall time, including the real
SDK, the three arms, persisted compaction/resume at 2/4/8/16 cycles, and independent
session/file/request verification. This duration is not GPU time or performance
A/B evidence. The separate long-state 16-cycle test took 128.173 seconds across
all available arms, using a fixed provider. A later code/runtime change invalidates
this receipt automatically. The subsequent `npm run release:check` also passed:
typecheck, 54 smoke assertions, 127 node tests (126 pass / one platform skip),
three known-failure regressions with no TODO, and dry-run packaging of 22 files.
The full node suite took 345.157 seconds offline. A repeat gate call returned
`reused=true`; `git diff --check` passed. These checks do not complete step 47.

Additional failure coverage introduced before any live request:

- pending review persists across restarts; stop is not retry authorization;
- successful terminal attempts reconstruct their case projection rather than
  being repeated; orphan partial request counts are retained, unknowns are null;
- all outstanding reviews are drained before any new worker, not just one;
- probe loader, creation and actual extension-binding callback failures send no
  probe request; transport and evidence-I/O errors stop before another generation;
- an isolated notes-tool EIO cannot be accepted as a model-correctable note error;
- ordinary wrong JSON/state with a successful response remains a **quality**
  failure, not an infrastructure failure or a fabricated zero semantic score;
- fork probes have no tools, exactly one request, and do not mutate the main file.

Two read-only reviews found and drove fixes to crash-accounting/review recovery,
probe-error handling and scheduler path resolution. No confirmed critical item
remained in the second review; its three high-priority warnings were then fixed
and exercised by targeted tests plus the full gate above.

## Experiment interpretation

`long-state-v1` is a controlled seven-field exact-state diagnostic, not a public
benchmark: initial facts appear once, subsequent rounds contain only actual
changes plus inert noise. It covers objective, constraint, exact path, task state,
hypothesis qualification, deployment permission and next action. Gold is evaluated
outside the agent; it is not hand-filled into live notes. Read-only fork questions
and answers are not copied back into the main trajectory.

Native / old / current arms have version-appropriate tools/instructions. All
requests use the pinned model, temperature 0 and output cap 512; two observation
rounds per cycle, six tool calls per phase, twenty requests per cycle, common tail
800 and reserve 4096. This is **not yet step 48's two matched-budget/default
experiments**. Repair-spanning results must retain source versions and cannot be
called frozen-version A/B evidence.

Each attempt keeps SDK session JSONL, persisted compactions, input/response usage,
tool records, main-file hashes, per-cycle probes and parent verification. Failure
pauses for agent diagnosis, offline revalidation and explicit acknowledgement;
restarting alone does not retry. All attempts consume the same absolute window.
Client process-tree shutdown does **not** prove cancellation on the remote GPU.

CompactBench's source version question is resolved by explicit commit
`b2bb0e2254010e7842801b9101e56fd9a6542615` (package 0.2.0, scorer 2.0.0), despite
only an older public tag. An adapter and an eligible run are still required at
step 49. Python 3.12.10 is available; its benchmark dependencies are not installed
as of preparation. No private historical sessions are used or uploaded.

# Renewed authorization checkpoint — 2026-10-21

User explicitly renewed a **new six-hour real-model window** after the previous
renewed window expired. Keep this ledger separate from both earlier windows.

## Previous windows and non-erased costs

- Historical 2026-10-19 smoke ledger: 383.998 s / 47 requests.
- 2026-10-20 05:00–11:00 window: one native attempt, 11 requests / 82.341 s,
  cycle 1 passed but cycle 2 summary was truncated by a harness 512-token cap.
  No subsequent work occurred in that expired window.
- 2026-10-20 14:36–20:36 window: artifacts in
  `eval/results/long-20261020-renewed/`. Three 2-cycle arms completed and were
  execution verified; native and pre-fix arms completed 4 cycles; fixed 4-cycle
  case had two failed attempts (one truncated at 512; another exhausted 6 tools
  at its 7th call). A 12-tool cap was then approved, but the offline gate and
  relaunch crossed the hard expiry before retry. No 8/16 cases. Not step 47.

Do not alter or delete either prior authorization, attempt, failure, or ledger.

## Current source and gate

- `88de206`: long-run controller, scheduler, recovery and probe isolation.
- `e0c49c8`: independent summary output cap 2048; agent/probe split follows.
- `8c5ac86`: explicit single-observation/no-future-actions boundary.
- `0dcd12d`: valid note section schema and bounded self-correction.
- `706a32a`: 2048 ordinary agent/summary; read-only probe remains 512; explicitly
  separates temporary fixture write command from remembered review state.
- `8ade183`: freezes 12 tool calls per phase, 20 model requests per cycle and
  stabilizes offline cold-start/hang test only.

Final current-source offline gate: fingerprint
`68cfd2f27d3ad75e4e4c6ac1dd68406a70e6c119d2abd092ad54e0faebf3d6dc`, **38/38**,
355.121 seconds, no provider calls. Log and receipt under
`eval/results/preflight-<fingerprint>.*`. The prior 37/38 gate was a fake hang test
that timed out during SDK startup; the offline harness now confirms one actual
provider start before enforcing a 30-second kill. No live cap was raised by this
fix. The worktree was committed; verify fingerprint reuse before launching.

## Current authorization

On 2026-10-21 the user chose `new_six_hours` after being told the prior window
expired and step 47 remained incomplete. This is a **new six-hour authorization
from the present host time when the new immutable manifest is created**, not a
carry-over, reset, or edit of prior manifests. It is for steps 47–52 in order,
but only complete/mark step 47 after its full parent-verified 2/4 then 8/16
matrix. Other steps require their own actual evidence and deadline time remaining.

User-approved frozen limits: three arms (native, pre-fix, fixed), 2 rounds/cycle,
12 tools/phase, 20 requests/cycle, 2048 ordinary-agent and summarizer output,
512 no-tool probe, common tail 800, reserved 4096, same pinned model. Any real
model failure remains in ledger; do not keep raising caps. Isolated probe output
is never written into the main trajectory. Exact objective wording differences
are not automatically semantic failure; report fieldwise exact match and audit.

New manifest and run directory are separate from prior windows and recorded by
blackboard notes. Monitor the active PID and each status at <=90-second intervals.
Pause on every failure, reconcile all costs, fix and rerun the offline gate, then
retry only the specifically reviewed failed case. Never silently restart, exceed
the six-hour deadline, mark 47 early, claim public benchmark numbers, deploy, or
upload private sessions. If there is not enough time to complete 47, stop at
expiry and report partial results. Steps 48–52 follow the approved order only if
authorization time remains and their exact requirements can be met honestly.

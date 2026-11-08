# Offline gate evidence — 2026-10-20

**Scope:** scripted-provider wiring only. No additional real-model requests, no
live 4/8/16 expansion, no automatic-compaction qualification, no deployment.
The earlier live ledger remains 383.998 s / 47 requests, including its failures.
Plan steps 47–52 remain open. This document is a result artifact, not executable
input to the source/runtime acceptance fingerprint.

## Preserved failures and diagnosis

- Initial 16-cycle suite: native and prefix passed; new arm timed out after 75 s,
  11 completed cycles / 121 scripted requests. Report:
  `C:/Users/LITTLE~1/AppData/Local/Temp/sbb eval & paths kYFCow/cycles-16/report.json`.
- Isolated 16-cycle attempt with a 240 s case limit: new arm timed out after
  14 completed cycles / 163 scripted requests. Report:
  `eval/results/smoke-2026-10-19T17-12-56-560Z-2340/report.json`.
- Four-cycle CPU profile in
  `C:/Users/LITTLE~1/AppData/Local/Temp/sbb-prof-dagiWW/`: structured clone
  4.721 s; canonical encoding 1.891 s; event reduction 1.264 s. Scripted model
  work was around 40 ms/cycle. Repeated full event replay was the bottleneck.
- No failed attempt was overwritten or relabelled as a PASS. These are offline
  wall times, not GPU usage; the scripted provider makes no external requests.

## Post-fix qualification

Standalone new-arm 16 cycles: **passed**, 32 successful fixture writes,
176 scripted requests, 16 independently verified persisted compaction nodes;
68.3 s including worker startup. Report:
`eval/results/smoke-2026-10-19T17-22-48-258Z-50788/report.json`.

The complete acceptance run covered the available three arms at each cycle count.
Tasks were distributed across tiers, not a complete task×cycle cross product.
Each row verifies fixture writes, actual active-branch compaction nodes, cut points,
per-cycle resumed answers and completed requests. Notes, native summaries and
resume text are deliberately scripted, including the path probes: **not memory
accuracy and not a valid speed/quality comparison between arms**.

Initial complete acceptance receipt (the timing table below):
`eval/results/preflight-ac8228a19c0dddd22879f6514aab568ce345e313030a2bea4338d9c9fefe9776.json`

- Environment: Windows x64, Node v24.11.1, pi SDK 1.3.0.
- Acceptance: 19/19 pass, 0 skipped, 241.980 s supervised offline wall time.
- Reinvoking the gate after the full release check reused that receipt at that revision.
- Final abort-in-`finally` hardening and whitespace cleanup correctly invalidated it.
  The **final-source** gate ran again: 19/19 pass, 358.585 s supervised offline wall.
  Current receipt:
  `eval/results/preflight-f62cf054fda6af27225292a8d8442fd879db0bfba9823328031342b4cdb9dd90.json`.
  Its 16-cycle tier also passed all arms; the new arm took 110.203 s. Raw report:
  `C:/Users/LITTLE~1/AppData/Local/Temp/sbb eval & paths l53YxL/cycles-16/report.json`,
  SHA-256 `5f28ebaf6c865483e053b0c0f51db7da4d02f071c6769104fd57383b2401d973`.
  Variation across offline runs is another reason these are not speed benchmarks.
- New source/runtime inputs invalidate receipts; none authorizes live work.

Raw tier reports below are relative to:
`C:/Users/LITTLE~1/AppData/Local/Temp/sbb eval & paths 5TZrzc/`.

| Cycles | Native requests | Prefix requests | New requests | New worker wall s | Status |
|---:|---:|---:|---:|---:|---|
| 2 | 12 | 14 | 22 | 9.519 | all passed |
| 4 | 24 | 28 | 44 | 13.428 | all passed |
| 8 | 48 | 56 | 88 | 26.249 | all passed |
| 16 | 96 | 112 | 176 | 52.941 | all passed |

Report SHA-256 digests:

```json
{
  "cycles-2/report.json": "e80c1888a4a7450829bd86917f0341181a2fea3bde25de550eb20cc8162604f3",
  "cycles-4/report.json": "883556a18c397fc5cfd37cc8233e6376d239b33efd74a727860e4d187100871e",
  "cycles-8/report.json": "d5edf3744393f37beca53d07cb7ede65425e0c80b3490324cb5d8e763f766e80",
  "cycles-16/report.json": "ff7ddf6281b2a0c34f19e5977b56537d70a0a10cfb206b016189abae4735211f"
}
```

The same suite also injected model errors, hanging streams, excess requests,
unbounded tools, an unsolicited write, spawn and callback failures, and tree-kill
failure. They fail/terminate rather than passing. Artifact tampering is rejected.
Continuation testing kept failed history unchanged, reused independently verified
successes, reran only the failed new arm and carried forward elapsed time. Live
continuation still requires explicit current `--live --model ...` authorization.

## Full regression

`npm run release:check` exited 0 after the gate:

- Typecheck: passed.
- Original smoke: 54/54.
- Node suite: 109 tests, 108 passed, 1 Windows platform skip, 0 failures.
- Known-failure regressions: 3/3, no TODOs.
- Package dry-run: 22 files, no installation or publication.
- Full node-suite wall time: 272.221 s (offline CPU; not billed as GPU time).

Local command transcript: `%TEMP%/sbb-release-offline-final.log`.
Raw temp/results files are local diagnostic evidence, not promised permanent
archives. The receipt and report hashes bind the preserved measurements above;
they are not cryptographic attestations against a workspace owner editing files.

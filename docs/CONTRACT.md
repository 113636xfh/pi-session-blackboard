# Contract: 0.2 → 0.3

This is the "what changes for you" document. It is written to be checked, not
trusted: every row names where the behaviour lives.

## Storage

| | 0.2 | 0.3 |
|---|---|---|
| authoritative data | `<boardDir>/<sid>.md` (+ `archive/<sid>/*.md`) | `sbb-event` custom entries in the session JSONL |
| branch model | one file per session id; branches overwrite each other | real session-tree ancestry; abandoned branches are invisible |
| derived state | `state.json` (cursor, counters, flags) | nothing required; the projection is replayed from events |
| Markdown | written on every commit, rotated on overflow | **only** on `/bb export`, never read back |
| concurrent writers | last write wins | second cooperating writer is refused |

## Compaction

| | 0.2 | 0.3 |
|---|---|---|
| takeover gate | "≥ 3 real entries" and a goal line | coverage of the entries before `preparation.firstKeptEntryId` |
| missing coverage | native fallback | bounded repair (≤ 2 memory-only requests), then native with a stated reason |
| retention | not modelled | one successful compaction, consumed by the persisted node |
| summary sections | Goal, Constraints, Key Decisions, Key Findings, Files, Issues, Next Steps | …plus `Progress` (Done / In Progress / Blocked); `Critical Context` replaces `Key Findings` |
| pressure countdown | persisted text inside the checkpoint | transient block, never stored, never summarised |
| `fromExtension` | used to identify our own summary | ignored; ownership is `details.generator === "pi-session-blackboard" && details.schema === 2` |

## Tools and commands

| 0.2 | 0.3 |
|---|---|
| `commit` (entries, dropDraft) | same, plus `id`/`expectedRevision`, `taskState`, `epistemic`, `origin`, `sources`, `retain`, `review` |
| `show` (whole board) | `show` pages by section; `show <ID>` returns the full entry with sources |
| `blackboard_recall` (query, limit, full) | `query`, `mode`, `limit`, `cursor`; a partial page can no longer claim "no results" |
| `/bb now` | removed (`checkpointTurns` + the near-pressure reminder cover it) |
| `/bb compact` | `/bb native` (one-shot, 5-minute TTL) |
| — | `/bb review`, `/bb retain`, `/bb cancel-repair`, `/bb migrate`, `/bb export`, `/bb debug` |

## Settings

| key | 0.3 |
|---|---|
| `compaction` | `"off"` default; `"digest"` is migration-only |
| `compactAssist` | default `false`, used only for manual compaction with custom instructions |
| `mirrorToSession`, `seedFromPriorSummary` | obsolete; reported once per session |
| `summaryMaxChars`, `maxEntryChars`, `checkpointTurns`, `draftOnCommit`, `commitContextEntries`, `compactionWarnTokens`, `debugLog`, `boardDir` | unchanged in meaning |
| `engines.node` | `>=22.19.0` (pi 1.3.0's own requirement) |

## Cost

| | 0.2 | 0.3 |
|---|---|---|
| summary calls with a full board | 0 | 0 |
| summary calls with a thin board | 1 (native) | 0 if the repair succeeds, else 1 |
| extra model requests per compaction | 0 | **≤ 2**, journal-tracked, never reset by restarts |
| assist call | on by default for every board compaction | off by default; only manual + custom instructions |

## What is *not* promised

- That the notes are semantically complete or correct. Coverage is structural.
- That a deterministic render preserves narration, tone or unused reasoning.
- That every fact survives; only that a committed note is never silently
  truncated, and that a replaced one stays retrievable.
- Token counts. Budgets are characters (`summaryMaxChars`); the repair headroom
  test is a byte-based estimate and says so.

## Release gate

`npm run release:check` must pass (typecheck, smoke, reliability, journal,
import, runtime, faults, platform, real-SDK, known regressions, pack dry run).

Still required before calling 0.3 released, and **not** satisfied by the test
suite:

1. one manual compaction in a real, user-approved session, with the resulting
   summary inspected;
2. at least two consecutive automatic compactions in that same session, verifying
   that generation, retention consumption and the summary text behave as tested;
3. a migration dry run and one `apply` on a copy of a real board.

### Observed live result (2026-10-18, local `strata/qwen3.8-flash-next-iq3_s`)

A throwaway project was run with the compaction trigger pinned low so a short
session compacts like a long one. Result of that run:

- automatic compactions: 12; **11 taken over by the blackboard**, 2 native;
- the constraint string survived verbatim, the retracted instruction did not
  come back, no countdown numbers appeared, summary 5 072 chars (within budget);
- **the manual compaction was not taken over**: its cut included the model's last
  answer, which had not been reviewed, so the documented manual-with-gaps path
  applied (native, reason recorded).

A second run with a lower tail pinned much tighter exposed a real defect: the
deferral could cancel a threshold compaction without any delivery happening,
repeating for many turns. The state machine now refuses to cancel while a repair
request is in flight or after it was delivered-and-ignored (that one becomes owed
once more, spending the second allowance), and the deterministic suite covers both
paths. The live reproduction of the loop was not confirmed afterwards, so:

### Small repair-and-retest smoke (2026-10-19)

All three arms completed two fixture-writing user rounds, one persisted manual
compaction and a resumed response. The fixed arm's inspected summary preserved
both exact paths, with one board takeover and zero native summarizer requests
(11 total model requests). Invalid user-source claims and malformed tool
arguments were rejected in preceding attempts; the tool/schema/protocol guidance
was clarified without weakening provenance or revision checks. All failed
attempts remain in [the ledger](../eval/smoke-evidence-20261019.json); cumulative
supervised live time was 383.998 seconds within the shared 600-second cap.

**Status: not released.** A small manual takeover has now been observed, but this
smoke did not exercise consecutive automatic compactions in the same session.
The full same-session gate, post-fix live repair-delivery/auto-compaction checks,
and real-board migration gate above remain open. No quality/cost advantage is
inferred from cases collected across repairs.

## Rollback

1. `/bb export --format markdown --output <path>` if you want the notes as text;
2. pin or reinstall 0.2 and set `compaction` back to `"assist"`/`"off"` as it was;
3. v2 `sbb-event` entries remain in the session file and are ignored by 0.2;
4. nothing here changes your global pi installation.

The import backups live under `<boardDir>/backups/<sid>/<manifestHash>/` and are
byte-verified at creation. Keep them; they are the only copy of the 0.2 files as
they were.

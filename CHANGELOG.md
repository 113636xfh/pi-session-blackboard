# CHANGELOG

All notable changes to this project are documented here.

## Unreleased
- Add the manual knob: `/bb off`, `/bb on`, `/bb status`. The state is one journal
  event on the current branch, not process memory, so resuming or continuing the
  session replays it and stays disabled; `session_start` reports the state again.
  While off the board is fully off — both tools leave the model-visible set, nothing
  is extracted or injected, and compaction falls back to the native summary. `/bb`
  itself stays reachable so the knob can be turned back. The knob can only turn the
  plugin further off; it never overrides `session-blackboard.enabled: false`.
- Both directions confirm first and state the price: the tool block moves, and the chat
  template renders it at the head of the prompt, so the next request re-prefills the
  whole context (live token count shown). Measured: a tool-set change with an otherwise
  pure-append message list still reports `cached_tokens = 0`.
- The first turn after `/bb off` carries one short line — `[session-blackboard] Disabled
  on this branch; do not call its tools.` — as a real session message, with the delivery
  recorded in the journal: never repeated on a later turn, and never repeated after a
  resume. A successful compaction retires it and the next generation gets exactly one
  fresh line. While off, the model-visible projection also drops this extension's own
  stale hints; a stale call from history is blocked with a stated reason.

## 0.3.0 — 2026-10-18

Breaking. The storage model changed from a Markdown board to branch-local session
events, and compaction takeover is now gated on proven coverage. Read the
migration section in [README.md](README.md#migrating-from-02).

### Candidate validation follow-up — 2026-10-20
- Replace repeated full event replay in runtime hooks with a disposable incremental
  projection. Complete relevant-prefix fingerprints detect event mutation, forks
  and rewinds; private cached state is never returned by reference.
- Add a mandatory fingerprinted offline acceptance gate before live smoke work,
  independent parent verification of persisted case evidence, and case-level
  continuation that preserves failed attempts and the cumulative time budget.
- Exercise real-SDK 2/4/8/16 manual compaction/resume cycles with a scripted offline
  provider. This is wiring evidence, not model quality, a public benchmark or a
  completed release gate; live multi-cycle expansion remains unauthorized.
- Full release check: 54 original smoke checks; 109 node tests (108 pass, one
  platform skip); 3 known-failure regressions; typecheck and package dry-run pass.

### Added
- **Session events are authoritative** (`sbb-event`): append-only, branch-local,
  invisible to the model. `/tree`, fork, clone and reset inherit real ancestry;
  abandoned branches can no longer leak into the current summary.
- **Bounded memory repair.** When the notes do not cover the content leaving the
  retained tail, the running turn delivers at most **two** memory-only requests
  (allowance stored in the journal, so restarts and repeated threshold checks do
  not reset it). Delivery is proven by the `context` event, not by a callback.
- **Coverage credentials** bound to source-entry content fingerprints; `context_edit`
  or `/tree` invalidates them, and `skip` never implies review.
- **Structured native-summary import**: Progress subsections, checkboxes, ordered
  next steps, Critical Context and file XML are parsed with explicit headings
  owning their meaning; unknown blocks are preserved verbatim; import is
  idempotent per source entry and never claims a shortened import is complete.
- **Retention** is one successful compaction only, consumed by the persisted
  compaction node; expiry does not change validity, constraints or timestamps.
- **Pageable retrieval** (`blackboard_recall`, `/bb show`) with stable cursors,
  `history` mode, transcript search, by-ID expansion and legacy archive paging
  that reaches every file instead of the newest 40.
- **Explicit export** (`/bb export`) with verified one-shot writes; no default
  Markdown board, no hand-edit round-trip.
- **Migration** (`/bb migrate [apply]`) with a dry run, byte-verified backups and
  legacy/unscoped imports.
- **Diagnostics** (`/bb debug`, `sbb-debug`, `sbb-compaction`) recording reasons,
  counts and outcome — never raw content.
- Tests: 87 checks including fault injection (unconfirmed append, cache failure,
  corrupt cache, writer conflict, interrupted migration), eight-round determinism,
  real-SDK integration with a fixed in-process model, and Linux/Windows platform
  cases. CI matrix: Node 22.19.0 and 24.

### Changed
- `compactAssist` now defaults to **false** and is used only for manual compaction
  with custom instructions.
- `compaction: "digest"` no longer mirrors anything (migration warning instead);
  `mirrorToSession` and `seedFromPriorSummary` are obsolete.
- Summary sections follow pi's native shape with `Progress` (Done / In Progress /
  Blocked) and `Critical Context` carrying hypothesis/unverified labels.
- Pressure numbers are a transient block: never stored, never summarised, and
  never re-injected after a compaction or a restart.
- `engines.node` is `>=22.19.0`, matching pi 1.3.0.
- Tool exposure now follows `enabled` exactly and never resets other extensions'
  tool choices.

### Fixed
- A failed, cancelled or unfinished tool result can no longer become `MODIFIED`.
- Modifying a referenced file no longer silently closes an issue.
- Extraction no longer drops candidates beyond a display limit.
- Summary assembly selects complete entries globally by time instead of dropping
  lines from a fixed section order, and never truncates a committed claim.
- A board with only file notes can no longer take over compaction.
- Old-generation extension hints, including a checkpoint in the retained tail, are
  removed from the model-visible projection.

## 0.2.0 — 2026-10-08

### Added
- **Draft and commit are one call.** A `commit` now auto-lands the mechanical
  draft lines the policy accepts (`draftOnCommit`, default `"deterministic"` =
  only the zero-heuristic `MODIFIED …` / `COMMIT …` output), and `dropDraft:
  ["substring"]` rejects draft lines without retyping them. The receipt marks
  auto-accepted lines `~` against the agent's `+`, and states how many draft
  lines did **not** land. Measured on 70 debug logs / 26 boards: 258 turns
  produced 2013 draft lines, there were 143 commits, and only **12**
  `MODIFIED`/`COMMIT` lines survived (2.2% of board entries) — the draft used to
  be discarded on commit, so the exact facts this package exists to preserve
  survived only if the agent retyped them.
- **Commit receipt instead of a board dump.** A `commit` now echoes back only the
  entries that landed (`+`) plus their nearest older neighbours in the same
  section — budgeted by the new `commitContextEntries` key (default 2). It used
  to re-render the whole board (up to 4 000 chars) on *every* commit, which was
  the largest recurring prompt cost of the extension and grew with the board.
- **The compaction summary footer now names the archive directory** as well as
  the board file, so rotated history is discoverable after a compaction.
- **CI**: `.github/workflows/test.yml` runs `typecheck` + the smoke suite on
  Node 20 and 22.

### Changed
- **CI matrix is Node 22 + 24, not 20.** On Node 20 the smoke suite dies with
  `SyntaxError: The requested module 'node:fs' does not provide an export named
  'globSync'` — that import lives in pi's own package
  (`@earendil-works/pi-coding-agent/dist/core/package-manager.js`), so the
  dependency needs Node ≥ 22. `engines.node: ">=22"` added and documented.
- **Pointer lines are capped at 5 per section** (`MAX_POINTER_LINES`).
  Measured before the cap: 60 commits with `maxEntriesPerSection: 5` left 55
  pointer lines and 4.7 KB in a single section — the only unbounded part of the
  design. Nothing is lost: the archive files stay on disk and `blackboard_recall`
  greps the archive directory.
- **One archive file per commit for `supersedes`** (was one per replaced entry),
  and one pointer line instead of N.
- **`[Scope change]` mining requires explicit pivot language.** Measured: 4 of 5
  ordinary follow-up task messages ("Fix these issues and add a test", "Update
  the config table", …) matched the old task-verb rule, i.e. nearly every turn
  fabricated a scope change and the Goal section filled with non-goals.
- **`blackboard_recall` reads archive files newest-first, capped at 40 files**,
  and says so in the result when the scan was capped.
- **Entry counts shown to the model are real entries.** `/bb`, the summary
  footer, the assist section and the mirrored digest no longer count archive
  pointer lines (they used to claim "60 entries" when 5 facts were on the board).

### Removed
- `maxBoardLines` config key — defined and parsed, but never read by any code
  path. Use `maxEntriesPerSection` (per section) to bound the board.

## 0.1.0 — initial release

- Deterministic per-turn extraction (goal/scope, prefs, files + exported symbols,
  git commits, `[ERROR]` lines, decisions, findings, next steps) with an agent
  review checkpoint; zero background LLM calls.
- `blackboard` tool (`commit` / `skip` / `show` / `archive`) with `supersedes`,
  per-section rotation into append-only archive files, and `blackboard_recall`
  over the live board, the archive and the mirrored session digests.
- `"compaction": "board"` — the board is returned as the compaction summary,
  skipping pi's summarization call; a thin board (< 3 real entries) falls back to
  the untouched native flow, and any native summary is merged back into the board.
- `/bb` command (`status` / `now` / `compact` / `skip` / `reset`) and the
  compaction countdown in the checkpoint prompt.

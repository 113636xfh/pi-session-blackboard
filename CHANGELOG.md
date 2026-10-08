# CHANGELOG

All notable changes to this project are documented here.

## 0.2.0 — 2026-10-08

### Added
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
- **`## Archived` pointer lines are capped at 5 per section** (`MAX_POINTER_LINES`).
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

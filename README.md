# pi-session-blackboard

**Session notes that survive compaction, and a compaction summary that costs zero summarizer calls — when the notes are good enough to earn it.**

The extension keeps a per-session set of notes (*the blackboard*) as **pi session
events**: branch-local, append-only, invisible to the model until rendered. Every
turn it extracts candidate facts deterministically (pure TS, no LLM) and asks the
agent to review them. When compaction fires, the notes are rendered **only if**
they provably cover the content that is about to leave pi's retained tail;
otherwise the extension asks the current model for one bounded memory repair, and
falls back to pi's native summary if that repair cannot be done safely.

Every claim below is meant to be falsifiable. The wording is deliberately weaker
than in 0.2: "the facts are on the board" is never a promise that the facts were
captured, and "zero summarizer calls" is conditional on the coverage gate.

中文文档: [README.zh.md](README.zh.md)

| | pi's native compaction | this extension (`"compaction": "board"`) |
|---|---|---|
| summarizer model call | one per compaction | **none**, once coverage is established |
| extra model requests before a compaction | 0 | **at most 2**, only when the notes are incomplete |
| what the summary contains | whatever the summarizer kept | exactly the notes the agent committed |
| inspectable / greppable afterwards | no | yes — events, `blackboard_recall`, `/bb show`, `/bb export` |
| background LLM calls | — | **none** (assist is opt-in) |

## Contents

- [Install](#install)
- [Modes](#modes)
- [The loop you actually see](#the-loop-you-actually-see)
- [Compaction policy](#compaction-policy)
- [Commands and tools](#commands-and-tools)
- [Data layout and recovery](#data-layout-and-recovery)
- [Migrating from 0.2](#migrating-from-02)
- [Configuration](#configuration)
- [Cost model](#cost-model)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [License](#license)

## Install

```bash
pi install git:github.com/113636xfh/pi-session-blackboard    # user-level; -l for project-level
```

pi loads `src/index.ts` directly, so there is no build step for use. Development
needs `npm install` (pi 1.3.0 is pinned as a dev dependency) and Node ≥ 22.19.0,
which is what pi 1.3 itself requires.

## Modes

| `compaction` | behaviour |
|---|---|
| `"off"` (default) | notes and tools work, compaction stays entirely native |
| `"board"` | the notes become the summary **when coverage is established**; otherwise native, with a stated reason |
| `"digest"` | kept only for migration: it no longer mirrors a digest, and warns |

`compactAssist` is now **off** by default. When enabled it runs pi's own
summarization and appends the notes, and it is used only for *manual* compaction
that carries custom instructions — the one case where a deterministic render
cannot honour "summarize with this focus".

## The loop you actually see

**1. A hidden reminder rides your next prompt** (`display: false`, so the TUI
stays clean). Near the compaction threshold it says so once, without a stale
countdown:

```
[session-blackboard checkpoint]
NEAR COMPACTION: pause task expansion and write important changes now.
Call blackboard action=review to inspect the complete candidates and receive a
content-bound credential; commit useful notes and explicitly confirm the reviewed
range. skip only discards the draft and does not confirm coverage.
```

**2. The agent reviews and commits.** One call carries both halves:

```jsonc
{ "action": "commit",
  "entries": [
    { "section": "decisions", "text": "coverage is bound to pi's cut, not the whole branch",
      "supersedes": "coverage requires the whole branch" }
  ],
  "review": { "id": "review-…", "constraintsChecked": true, "executionChecked": true, "goalChecked": true } }
```

- `review` is optional; a plain commit is a note, **not** a claim that the range
  was reviewed.
- The credential comes from `action: "review"` and is bound to source-entry
  content fingerprints, so editing a message (`/tree`, `context_edit`) invalidates
  it: the review must be redone.
- Entries are one line each, complete — nothing is truncated to fit. A note that
  does not fit the summary budget is reported as a problem, never shortened.

**3. The receipt is small and ID-addressed**:

```
Committed v7.
m-4f2a9c1e5b7d@2 [decisions] coverage is bound to pi's cut, not the whole branch
Use blackboard show/recall or /bb; there is no default board file.
```

## Compaction policy

In `"board"` mode `session_before_compact` asks one question: *do the notes cover
the entries that this preparation actually drops?* Only content before
`preparation.firstKeptEntryId` counts — the retained tail does not need to be
re-summarized.

| situation | what happens |
|---|---|
| coverage established, summary fits | the board is returned as the summary. **Zero** summarizer calls |
| gaps, allowance left, headroom measured | `{ cancel: true }`, and the *running turn* delivers one memory-only request (`agent_before_settle` + `continue`) — never a nested model call from inside the hook |
| gaps, allowance exhausted | native summary, with an explicit reason in the UI, the journal and the diagnostics log |
| context already overflowed | native summary — there is no headroom to spend on a repair turn |
| manual compaction with custom instructions | `compactAssist` (if enabled) so the instructions are honoured; otherwise the deterministic render |
| explicit "native" request (`/bb native`) | obey once, five-minute TTL, then cleared |
| user aborts | no hidden continuation; the spent request is not refunded and `/bb cancel-repair` stops further asks |

The repair allowance is **two requests per compaction generation**, stored in the
journal. Restarting pi, re-entering the threshold check, or a failed tool call
never resets it. Delivery is only counted when a request actually reaches the
provider (`context` event), so "we asked" and "the model saw it" are different
states. During a repair request only the memory tools are callable, and the
request terminates the turn afterwards — that bound is what keeps the cost
predictable.

## Commands and tools

| entry point | purpose |
|---|---|
| `blackboard` tool | `commit`, `review`, `retain`, `show`, `archive`, `skip` |
| `blackboard_recall` tool | literal search; `mode: current \| history \| session`, `limit`, `cursor` |
| `/bb` | `show [section] [limit] [offset]`, `show <ID>`, `review`, `commit <JSON>`, `retain <ID> <revision>`, `archive <ID>`, `skip`, `reset`, `migrate [apply]`, `export --format markdown [--output "path"] [--overwrite]`, `native`, `cancel-repair`, `debug` |

Pagination is real: a page that finds nothing says *"the scan is not finished"* and
hands out a cursor; only a finished scan may say "no match". A cursor is bound to
the branch leaf and note revision, so a changed branch invalidates it instead of
silently returning stale rows. `history` mode shows replaced versions with their
state — a superseded note never presents itself as current.

## Data layout and recovery

- **Authoritative**: `sbb-event` custom entries in the session JSONL. They ride the
  session tree, so `/tree`, fork, clone and reset inherit exactly the real
  ancestry, and abandoned branches cannot leak into the current summary.
- **Derived**: nothing is required. A projection-cache write failure reports
  "committed; cache pending rebuild" and never invites a duplicate commit.
- **Explicit only**: Markdown. `/bb export` writes a verified snapshot; edits to it
  are never imported, and no session Markdown board is maintained.

Recovery: corrupted or missing caches are ignored (state is replayed from events);
a corrupt session stops takeover with an error instead of writing an empty board;
an interrupted legacy migration is idempotent and keeps its byte-verified backup.
Two pi processes cannot both write a session: the second is refused rather than
merged.

## Migrating from 0.2

`/bb migrate` is a dry run: it lists files, sizes, hashes, candidate entries and
missing archive pointers, and writes nothing. `/bb migrate apply` copies the old
board, state and archives into `backups/<sid>/<hash>/`, verifies the copies byte
for byte, then imports the lines as **legacy/unscoped, unknown** notes.

Legacy notes are *not* current facts: they are excluded from the rendered summary
until reviewed, and unknown sections or stray lines are preserved verbatim instead
of being dropped. Until you migrate, `/bb show` says a legacy board exists and is
not authoritative.

Rollback: uninstall (or pin) this package and re-enable 0.2; export first with
`/bb export --output <path>` if you want a copy of the notes. v2 events stay in the
session file and are ignored by 0.2. Nothing here upgrades your global pi.

## Configuration

`~/.pi/agent/settings.json` (user) or `.pi/settings.json` (project, wins), key
`session-blackboard`:

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` also removes both tools from the model's tool set and stops injection |
| `compaction` | `"off"` | `off` / `board` / `digest` (migration only) |
| `checkpointTurns` | `1` | reminder cadence in turns |
| `summaryMaxChars` | `6000` | exact character cap for the rendered summary |
| `compactAssist` | `false` | opt-in native summary + notes (manual custom instructions) |
| `compactAssistMaxChars` | `4000` | cap for the appended notes block |
| `compactionWarnTokens` | `32768` | near-threshold zone; `0` disables |
| `draftOnCommit` | `"deterministic"` | which mechanical draft lines land with a commit |
| `debugLog` | `false` | record reasons/counts in `sbb-debug` entries (never raw content) |
| `boardDir` | `<agentDir>/blackboard` | where locks, backups and the projection cache live |

Obsolete keys (`mirrorToSession`, `seedFromPriorSummary`) are reported once per
session instead of silently doing nothing.

## Cost model

- Normal turns: **zero** model calls from this extension; the reminder rides an
  existing request.
- Compaction with coverage: **zero** summarizer calls, no extra requests.
- Compaction without coverage: at most **2** extra memory-only requests, then
  native. Each is bounded to memory tools and ends the turn.
- `compactAssist` on, or manual compaction with custom instructions: **one**
  summarizer call (that is what "assist" means).
- Retrieval, export, review: local only.

## Tests

```bash
npm run typecheck
npm test            # smoke + reliability + journal + import + runtime + faults + platform + real-SDK
npm run test:known  # previously-failing reproductions, kept as regression guards
```

The real-SDK tests load the shipped `src/index.ts` into pi 1.3.0 with an
in-process fixed model stream. `fetch` throws in those tests and is asserted never
called. CI runs Linux and Windows on Node 22.19.0 and 24.

## Known limitations

- A deterministic render cannot narrate. Tone, hedging and half-formed reasoning
  that were never written down do not survive; the retained tail is verbatim, the
  rest is whatever the notes contain.
- Coverage is *structural*: it proves that a source range was reviewed at a
  content fingerprint, not that the notes are semantically correct.
- Notes too long for the summary budget must be rewritten by the model; a very
  long protected note therefore blocks takeover until it is shortened or its
  retention expires.
- Manual compaction with gaps falls back to native in this version: there is no
  safe way to hand a repair turn back to a user-initiated compaction.
- Cross-process merging is not attempted; a second writer is refused.
- Legacy archives are searchable but stay unscoped forever; nothing infers their
  branch.

- [Contract: 0.2 → 0.3](docs/CONTRACT.md) and `npm run release:check` cover the release gate.

## License

MIT.

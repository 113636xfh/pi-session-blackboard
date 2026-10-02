# pi-session-blackboard

A **session-level blackboard** for the [pi](https://github.com/badlogic/pi-mono) coding agent.

Durability without heavy background LLM traffic: a plain markdown file per session
(`<~/.pi/agent/blackboard/<sessionId>.md`) that holds the load-bearing facts of a
long session — goal, decisions, files changed (with exported symbols), commits,
open issues, next steps, preferences — and is maintained through a **curation loop**:

```
 every completed user turn (agent_settled)
   └─ deterministic extraction of NEW entries only (vcc-style, pure TS, no LLM,
      millisecond-scale)  →  pending draft
   └─ open issues auto-marked [RESOLVED] when their files get modified
   └─ checkpoint due (default: every turn):
        next user prompt gets a hidden system message with the draft +
        instructions to review it
        the AGENT reviews / approves / corrects it (inside its own normal
        generation — zero extra API calls)
        commits via the `blackboard` tool  (or `skip` if nothing is worth keeping)
   └─ on commit: per-section overflow is rotated deterministically into an
      append-only archive file (blackboard/archive/<sessionId>/board-<ts>.md)
```

Nothing here ever launches a background model. The only LLM work is the agent's
own in-turn curation, which is the part that needs semantics — regex can't tell
"this decision is dead" from "this decision is current", but the agent can.

## Why this exists

`pi-observational-memory`-style extensions run observer/reflector agents that
prefill 25–30k-token chunks on a separate schedule. On a local model (e.g. a
W4A16 27B over PCIe with `--max-num-batched-tokens 2048`) that is the single
most expensive workload you can add, and it buys you a drop of distilled
"observations" that the main agent never uses. This extension inverts the model:

- **extraction is deterministic** (the pi-vcc approach, per-turn and scoped) —
  cost: CPU milliseconds;
- **summarization/curation is the agent's own** — cost: the tokens it would
  spend anyway, riding on its existing cached context;
- **archival is mechanical** — oldest-out rotation into an append-only file,
  no model involved;
- **the record is a plain file** — grep it, commit it, read it with the normal
  `read` tool, let the agent refresh from it after compaction.

## Architecture at a glance

Three moving parts:

1. **Extraction — deterministic, per-turn.** Pure TypeScript over the *new*
   session entries since the last cursor position (vcc-style patterns):
   goal/scope, prefs, files + exported symbols, git commits, `[ERROR]` lines,
   decisions/next. Millisecond-scale, no network, nothing to tune.
2. **Curation — the agent, in its own turn.** The pending draft reaches the
   agent as a hidden message riding on your *next* prompt (zero extra API
   calls). It reviews, corrects, and commits only what is durable via the
   `blackboard` tool — or skips the draft if it is noise.
3. **Archival — mechanical.** Per-section overflow rotates into append-only
   archive files; every commit mirrors a compact digest into the session
   JSONL (`sbb-snapshot`), searchable forever by `vcc_recall`.

## Install

```bash
pi install /path/to/pi-session-blackboard
# restart pi (extensions load at process start)
```

Project-scoped instead: `pi install -l /path/to/pi-session-blackboard`.

Remove with `pi remove npm:pi-session-blackboard` (or the installed name shown by
`pi list`).

## The curation loop in practice

1. You work. After each completed turn, the extension mines the *new* session
   entries:

   - **goal** — the session's opening task (once), then `[Scope change]` markers
     only when the leading user text genuinely changes direction (vcc patterns);
   - **prefs** — "always/never/prefer/please use…" statements (vcc patterns,
     deduped against what's already on the board);
   - **files** — `MODIFIED <path> (symbol1, symbol2)` from successful
     `edit`/`write` tool calls, with exported symbols extracted from the new
     code (deterministic, from tool arguments — zero heuristics);
   - **files** — `COMMIT <hash> <subject>` from successful `git commit` runs;
   - **issues** — `[ERROR] <cmd>: <first error line>` from failed shell
     commands (exit codes, tsc/pytest/panic/traceback patterns);
   - **decisions** — assistant "I'll use X / decided to / let's go with" lines
     (capped, clipped, and *you* — the agent — fixes them at review time);
   - **next** — "next step / TODO / after this" lines (capped).

   If an open issue references a file that just got edited, it is marked
   `[RESOLVED <ts>]` automatically.

2. When a checkpoint is due (default: **every turn**), the next user prompt
   carries a hidden (`display: false`) message containing the accumulated draft
   plus explicit instructions. The agent reviews it, corrects what's wrong, and
   calls `blackboard` with `action="commit"` for the survivors — or
   `action="skip"` if the draft is noise. The TUI stays clean; use `/bb` to
   inspect any time.

3. If the agent ignores the draft three times in a row, injection stops and a
   warning appears in the TUI (`/bb` still shows everything, `/bb skip` clears).

## The `blackboard` tool

| action | what it does |
|---|---|
| `commit` | records `entries=[{section, text}]` (one line each, auto-timestamped, deduped, capped at 300 chars). Section overflow rotates into the archive file. |
| `skip` | discards the pending draft. |
| `show` | prints the current board (truncated in the tool result; full file on disk). |
| `archive` | moves a single stale entry (unique `target` substring) into the archive file, with a pointer left in `## Archived`. |

Sections: `goal | decisions | files | issues | next | prefs`
(`archived` is managed by the extension, not writable by the agent).

## `/bb` command

| form | what it does |
|---|---|
| `/bb` | status (path, version, per-section counts, turns since checkpoint, pending draft) + board (truncated to 80 lines) |
| `/bb now` | force the pending-draft checkpoint immediately (or with your next message, per `delivery`) |
| `/bb skip` | discard the pending draft |
| `/bb reset` | confirm, then delete this session's board + state (archive files are kept) |

## Files

What lands where — **you never manage any of it**. Every artifact is a plain file
(or a JSONL custom entry); the board is written only by the `blackboard` tool, and
only when the agent commits:

| file | written by | what it holds |
|---|---|---|
| `~/.pi/agent/blackboard/<sessionId>.md` | the `blackboard` tool (on the agent's commit) | **the board** — plain markdown, stable section order, capped per section |
| `~/.pi/agent/blackboard/archive/<sessionId>/board-<ts>.md` | the `blackboard` tool (deterministic overflow rotation) | per-section overflow — append-only, one file per rotation |
| `~/.pi/agent/blackboard/state/<sessionId>.json` | the extension (deterministic) | extraction cursor, pending draft, counters |
| `~/.pi/agent/blackboard/debug/<sessionId>.ndjson` | the extension, only when `"debugLog": true` | event log for debugging |
| the session's own JSONL (`sbb-snapshot` entries) | the extension (optional mirroring) | compact digests of board state — searchable by `vcc_recall` |

The board is a file — if you want a copy, it's right there. The `##` sections
are fixed; unknown sections and stray lines you add by hand are preserved
verbatim across extension writes.

The hard line: state, drafts, mirrors, and digests **never enter the model's
context** — they are files and JSONL custom entries, greppable and commit-able,
and the board is readable with the normal `read` tool (e.g. after compaction).

## Configuration

`~/.pi/agent/settings.json` (user) or `.pi/settings.json` (project, wins),
under the key `"session-blackboard"`:

```jsonc
{
  "session-blackboard": {
    "enabled": true,              // master switch
    "checkpointTurns": 1,         // review cadence in user turns (1 = every turn)
    "delivery": "next-turn",      // "next-turn" (0 extra LLM calls) | "immediate" (steer turn now)
    "maxEntriesPerSection": 40,   // rotation threshold per section
    "maxEntryChars": 300,         // per-entry line cap
    "maxDraftLines": 60,          // draft size cap rendered into the checkpoint
    "mirrorToSession": true,      // compact digest → session JSONL (sbb-snapshot entries)
    "compaction": "board",        // "board" (the board IS the summary) | "digest" | "off"
    "summaryMaxChars": 6000,      // hard cap for the board rendered as the summary
    "compactAssist": false,       // legacy: native LLM summary + appended board section
    "compactAssistMaxChars": 4000, // hard cap for the assist section appended to summaries
    "boardDir": "~/.pi/agent/blackboard",  // absolute, or relative to the agent dir
    "debugLog": false
  }
}
```

Notes:

- **`checkpointTurns: 1`** is the default because the design is "extract and
  let the agent review every turn". If you find the per-turn curation noisy,
  raise it to 5–10 — extraction and `[RESOLVED]` marking still happen every
  turn; only the review cadence changes.
- **`delivery: "next-turn"`** (default) injects the checkpoint with your next
  message: zero extra LLM calls. `"immediate"` dispatches a steer message that
  triggers a short review turn right away (small extra call, mostly cached
  prefix) — useful in unattended runs where "next user message" is far away.

### Compaction cooperation (`"compaction": "digest"`)

**Off by default and deliberately non-invasive.** When set to `"digest"`, the
extension appends a compact board digest as an `sbb-snapshot` entry in the
session JSONL *immediately before* any compaction. That entry lands in the
retained tail, so:

- `pi-vcc`'s `vcc_recall` can search it (it reads raw JSONL);
- a future deterministic compaction can consume it;
- the native LLM compaction is **never** modified or replaced.

The board itself is already safe through compaction by construction: it's a
file on disk, the `blackboard` tool has `show`, and the tool's own guidelines
instruct the agent to re-read the board after compaction / resume.

### Compaction: the board IS the summary (`"compaction": "board"`, default)

When compaction fires (manual `/compact`, context threshold, or overflow
recovery), the handler returns the board as the compaction summary itself:

```
{ compaction: { summary: <board rendered in pi's native section shape>,
                firstKeptEntryId, tokensBefore } }
```

- **pi's summarization model call is skipped, not duplicated** — the summary is
  the curated board the agent has been reviewing every `checkpointTurns` turns.
- The rest of native compaction is untouched: pi still computes the cut point
  (`keepRecentTokens`), still keeps the recent tail verbatim, still appends the
  compaction entry and rebuilds the projection.
- Sections are rendered in pi's own summary shape (`## Goal`,
  `## Constraints & Preferences`, `## Key Decisions`, `## Files & Changes`,
  `## Open Issues`, `## Next Steps`) so the model reads it as a checkpoint
  summary, plus a footer with the board file path and the retrieval tool.
- The footer is **reserved before truncation**: when the board does not fit
  `summaryMaxChars`, the oldest body lines are dropped, never the retrieval
  instructions.
- **Floor**: fewer than 3 real entries → `null` → pi's native flow runs
  untouched. A thin board must not become a thin summary.
- Archived/pointer entries never count toward the floor or the body.

### Retrieval: `blackboard_recall`

Because the summary is now the board, the model needs a way past it. The
`blackboard_recall` tool greps, case-insensitively:

1. the live board (`boardDir/<sessionId>.md`), attributing each hit to its
   `## Section`;
2. the rotated archive (`boardDir/archive/<sessionId>/*.md`);
3. the `sbb-snapshot` digests mirrored into the session JSONL.

Queries are literal substrings copied out of the conversation (paths, function
names, error fragments) — not natural-language questions. Output is a compact
card, newest last, hard-capped (`limit`, default 20, max 60).

### Legacy: compaction assist (`compactAssist`, off by default)

**Assist, don't replace.** When pi's native compaction runs (manual `/compact`,
context threshold, or overflow recovery), the `session_before_compact` handler
invokes the *same* exported `compact()` the harness would call (identical model,
prompt, retained tail, `customInstructions`) and **appends a size-capped
deterministic board section** (goal ≤3, open issues ≤5, files ≤5, next ≤3,
per-section stats, plus a pointer to the full board file and archive dir) to
the LLM summary. The post-compaction context therefore carries both the
conversational summary and the curated durable facts it may have dropped.

*Every red branch — any gate, or the call itself throwing — returns `undefined`: the untouched
native flow runs (the harness's own call, retry policy, retained tail). The only addition is the
capped deterministic section appended to the native LLM summary: zero extra LLM cost.*

- Extra LLM cost: **zero** — it is the native call itself, not a second one.
- Section size: hard-capped by `compactAssistMaxChars` (default 4000 chars).
- Disable with `"compactAssist": false` (the default) — superseded by
  `"compaction": "board"`, which needs no summarization call at all.

### Session-JSONL mirroring (`"mirrorToSession"`)

On every commit (and pre-compaction in `digest` mode) a **compact digest**
(goal ≤3, next ≤3, recent files ≤5, open-issue count, per-section counts) is
appended as an `sbb-snapshot` custom entry. Custom entries do not enter LLM
context, so this costs nothing at inference time; it exists purely so the
board's state is *persisted inside the session record* — searchable forever by
`vcc_recall`, and an input to any future deterministic summary.

## Cost model (what this does NOT do)

| workload | this extension |
|---|---|
| background LLM calls | **none, ever** |
| extra prefills | none (extraction is CPU-only) |
| prompt overhead | the checkpoint message at review time only (~1–3k tokens, appended at tail — prefix cache intact) |
| archival | deterministic file rotation (append-only) |
| compaction | `"board"` returns the board as the summary and skips pi's summarization call (thin board → native flow); cut point and retained tail stay pi's; legacy `compactAssist` (off) appends a capped section to the native LLM summary; opt-in `digest` mirroring |

## Compatibility

- pi ≥ 0.84 (tested against the extension API of 0.84.x: `agent_settled`,
  `before_agent_start`, `session_before_compact`, `pi.registerTool`,
  `pi.registerCommand`, `pi.appendEntry`, `pi.sendMessage`).
- Zero runtime dependencies (imports only `node:*`, `typebox`, and
  `@earendil-works/pi-coding-agent` — all resolved by pi's extension loader).
- TypeScript, strict; `npm install && npm run typecheck` for the dev loop.
- `npm run test` compiles the core and runs the 48-check smoke suite
  (extraction, board commit/rotation/archive, parse round-trip) — no pi
  runtime or network needed.
- The pure functions (board→summary rendering, recall search, the legacy
  assist section) are asserted by `test/smoke.mjs` (`npm test`); the hooks,
  the checkpoint injection and the compaction hand-back are exercised by real
  pi sessions, not by the suite.

## Development

```bash
npm install        # devDependencies only; the extension itself has no runtime deps
npm run typecheck  # tsc --noEmit
npm test           # build (tsc -> build/) + node test/smoke.mjs
```

`tsconfig.json` is the portable config. `tsconfig.check.json` /
`tsconfig.build.json` are machine-local helpers (they map `@earendil-works/*`
and `typebox` to an existing install so the sources can be checked without
`npm install`) and are git-ignored on purpose.

## Limitations (honest)

- "Forced" means **prompt-enforced + periodic nudge**, not a hard guarantee:
  a model can skip a checkpoint (mitigated by re-injection up to 3×, then a
  visible warning; the next user turn re-triggers it).
- Assistant-text mining (decisions/next) is deliberately light and capped —
  that's exactly why the agent reviews the draft before commit. It is a
  starting point, not a truth source.
- The deterministic `[ERROR]` extractor is a heuristic over raw tool output and
  has produced false positives in this session's testing: (a) an `[ERROR]` +
  429-ratelimit fixture line echoed inside smoke-test output, and (b) a shell
  exit code 1 from `grep -c` with zero matches (the tests were *passing*) —
  both mined as real failures. The review step is the mitigation; extraction
  itself will keep making this class of mistake.
- The `[Scope change]` detector keys on leading user text and cannot tell a
  genuine direction change from a terse continuation prompt ("fix these
  issues and …") — goal entries rely on the agent's review as the last line of
  defense.
- `## Archived` pointer lines are never rotated (`src/board.ts`) — unbounded
  growth at ~150 chars per archive action (100 archives ≈ 15 KB ≈ ~4k tokens).
  The only unbounded part of the design; planned: cap + rotate them like any
  other entry.
- One board per session id. Boards of dead sessions are files you can keep,
  grep, or delete (`/bb reset` only touches the current session).
- v0.1 has no cross-session recall tool; use your grep, or install `pi-vcc`
  for `vcc_recall` over the session JSONL (the `sbb-snapshot` entries make the
  board part of that index).

## Attribution & license

Goal/scope-change and preference extraction patterns are adapted from
**[@monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc)** (MIT).
The "deterministic extraction + agent curation" architecture is this package's.

MIT — see [LICENSE](./LICENSE).

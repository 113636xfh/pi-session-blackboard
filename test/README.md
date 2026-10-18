# Reliability checks (implementation checkpoint)

Run from the repository root with **Node >=22.19.0**. The development SDK is pinned to **pi 1.3.0**. This does not change the global Pi installation.

```sh
npm run typecheck
npm test
npm run test:known
```

- `npm test`: existing 54-check smoke suite, 17 reliability regressions, and 2 real-SDK contract tests. No paid model requests.
- `npm run test:sdk`: build and run just the real-SDK contract tests.
- `npm run test:known`: **three expected failing TODOs**, not three passing tests. They reproduce cross-branch contamination (S2/S3), lost native progress state (S4), and an unreachable old fact after 55 archives (S5). Node's TODO runner exits successfully while printing the assertion failures; this is deliberately not a release gate or an all-green claim. Remove each TODO only when its assigned stage implements and verifies the contract.

## What the SDK contract actually checks

`test/sdk-contract.mjs` uses the installed pi 1.3.0 `DefaultResourceLoader`, extension runner, `ModelRuntime`, `AgentSession`, and `SessionManager`. It does not manually invoke mocked lifecycle hooks.

The provider is an in-process, fixed three-response stream: one synthetic tool call, one final response, and one explicitly requested boundary continuation. There is no stochastic sampling or randomized test input. Its API URL is an unused loopback address; model catalog network refresh is disabled; `fetch` throws and is asserted never called. Auth/config/session paths are isolated under a fresh temporary directory. No user credentials or session history are loaded. Temporary persistent session data is reopened to check recovery, then removed.

Verified contracts:

1. `pi.appendEntry()` returns `undefined`; an application event ID can confirm the append through the current branch. The persisted event's parent is the real last tool-result entry.
2. `turn_end` supplies actual assistant and tool-result entry IDs readable at that boundary.
3. Boundary-returned entries are persisted; an `agent_before_settle` custom message and `continue: true` really reach a third request. For this fixture, event order is `turn_end → turn_end → agent_before_settle → turn_end → agent_before_settle → agent_settled`.
4. `custom` event payloads are not injected into the model transcript; `custom_message` is model-visible.
5. Persistent reopen preserves the custom event data.
6. `getEntries()` includes abandoned branches while `getBranch()` does not. `context_edit` changes projected content without changing the original message's ID or raw stored content.

These tests establish the SDK contracts needed for S2/S3. They **do not** yet validate the production v2 reducer, cut-point coverage, urgent-memory scheduling, or successful manual/automatic compaction end to end. Those remain subsequent implementation/release gates. Current local execution is on Windows; minimum-version and Linux/Windows CI runs remain S6 work.

All fixture content is synthetic. Local historical session statistics are background risk evidence, not an A/B success score, and raw private sessions are not included here.

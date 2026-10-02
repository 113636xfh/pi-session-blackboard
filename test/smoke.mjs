/**
 * Standalone smoke suite (no test framework): `npm run build && node test/smoke.mjs`.
 *
 * Covers the pure functions that decide what the model sees after compaction:
 * the board→summary renderer (the board IS the summary now) and the recall
 * search used to dig past the summary. Extension wiring (hooks, tools) is
 * exercised by real sessions, not here.
 */
import assert from "node:assert/strict";
import { renderSummary, SUMMARY_MIN_ENTRIES } from "../build/summary.js";
import { formatRecall, searchDocument } from "../build/recall.js";
import { renderAssistSection } from "../build/compact-assist.js";
import { emptyBoard } from "./helpers.mjs";

let checks = 0;
const failures = [];
const check = (name, fn) => {
	checks++;
	try {
		fn();
	} catch (err) {
		failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
};
const entry = (ts, text) => ({ ts, text });
/** Windows join() uses backslashes; assertions compare POSIX paths. */
const norm = (s) => s.split(String.fromCharCode(92)).join("/");

// ── board → summary ────────────────────────────────────────────────────────
check("a thin board yields no summary (caller must fall back to native)", () => {
	const b = emptyBoard();
	b.sections.goal.push(entry("2026-10-02 10:00", "read every file"));
	assert.equal(renderSummary(b), null, "1-2 entries must not become a summary");
});

check("a board with enough real entries becomes a summary in native shape", () => {
	const b = emptyBoard();
	b.sections.goal.push(entry("2026-10-02 10:00", "implement force truncation"));
	b.sections.decisions.push(entry("2026-10-02 10:05", "stream abort beats per-model budget"));
	b.sections.files.push(entry("2026-10-02 10:06", "modified src/engine.ts"));
	const out = renderSummary(b);
	assert.ok(out, "3 entries must render");
	for (const h of ["# Session context checkpoint", "## Goal", "## Key Decisions", "## Files & Changes"]) {
		assert.ok(out.includes(h), `missing ${h}`);
	}
	assert.ok(out.includes("stream abort beats per-model budget"));
	assert.ok(out.includes("This is the compaction summary"));
});

check("pointer (archived) entries never count toward the floor or the body", () => {
	const b = emptyBoard();
	for (let i = 0; i < SUMMARY_MIN_ENTRIES + 2; i++) b.sections.goal.push(entry("t", "(archived)"));
	assert.equal(renderSummary(b), null, "pointers alone must not become a summary");
});

check("the cap is enforced and says where the rest lives", () => {
	const b = emptyBoard();
	for (let i = 0; i < 60; i++) b.sections.decisions.push(entry("2026-10-02 10:00", `decision ${i} ${"x".repeat(80)}`));
	const out = renderSummary(b, { maxChars: 1500, boardFile: "/tmp/b.md" });
	assert.ok(out.length <= 1600, `too long: ${out.length}`);
	assert.ok(out.includes("older entries omitted") || out.includes("truncated"));
	assert.ok(out.includes("/tmp/b.md"), "footer must point at the full board");
});

check("the footer names the recall tool and the kept-tail note when given", () => {
	const b = emptyBoard();
	b.sections.goal.push(entry("t", "a"));
	b.sections.next.push(entry("t", "b"));
	b.sections.files.push(entry("t", "c"));
	const out = renderSummary(b, { keptTailNote: "TAILNOTE", recallTool: "blackboard_recall" });
	assert.ok(out.includes("TAILNOTE"));
	assert.ok(out.includes("blackboard_recall"));
});

// ── recall ─────────────────────────────────────────────────────────────────
const DOC = `# Session Blackboard

## Decisions
- [2026-10-02 10:05] stream abort beats per-model budget
- [2026-10-02 10:07] unrelated: switched to bun

## Files
- [2026-10-02 10:06] modified src/engine.ts
`;

check("search finds lines and attributes them to their section", () => {
	const hits = searchDocument(DOC, "engine.ts", 10, "board");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].section, "Files");
	assert.ok(hits[0].line.includes("src/engine.ts"));
});

check("search is case-insensitive and skips headers/comments", () => {
	assert.equal(searchDocument(DOC, "STREAM ABORT", 10, "board").length, 1);
	assert.equal(searchDocument(DOC, "## Files", 10, "board").length, 0);
});

check("respects the limit and the empty query", () => {
	assert.equal(searchDocument(DOC, "modified", 1, "board").length, 1);
	assert.deepEqual(searchDocument(DOC, "   ", 10, "board"), []);
});

check("formatRecall renders a card and a miss message", () => {
	const card = formatRecall(searchDocument(DOC, "stream", 10, "board"), "stream");
	assert.ok(card.includes("1 match(es)"));
	assert.ok(card.includes("board · Decisions"));
	assert.ok(formatRecall([], "zzz").includes("no entry matches"));
});

// ── the old assist path still renders (mode "digest"/compactAssist) ────────
check("renderAssistSection still works for the legacy assist mode", () => {
	const b = emptyBoard();
	b.sections.goal.push(entry("2026-10-02 10:00", "g"));
	b.sections.next.push(entry("2026-10-02 10:01", "n"));
	const out = renderAssistSection(b, "/tmp/boards", "sid", 4000);
	assert.ok(out.includes("Session Blackboard"));
	assert.ok(norm(out).includes("/tmp/boards/sid.md"));
});


// ── boardDir resolution (regression: Windows absolute paths) ───────────────
const { loadConfig: loadCfg } = await import("../build/config.js");
check("an absolute boardDir is not joined onto the agent dir (Windows path)", () => {
	const cfg = loadCfg("/tmp/proj");
	assert.ok(!/agent[\/]C:/.test(cfg.boardDir), `doubled path: ${cfg.boardDir}`);
});

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
	console.error(`FAIL ${failures.length}/${checks}`);
	for (const f of failures) console.error("  ✗ " + f);
	process.exit(1);
}
console.log(`smoke: ALL PASS (${checks} checks)`);

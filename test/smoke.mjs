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
import { commitEntries, readBoardFile } from "../build/board.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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


// ── commit with supersedes (stale facts must not survive next to new ones) ──
const CFG = { maxEntriesPerSection: 50, maxEntryChars: 300 };
const tmpBoard = () => mkdtempSync(join(tmpdir(), "sbb-smoke-"));

check("supersedes archives the stale line and lands the new one", () => {
	const dir = tmpBoard();
	const sid = "supersede-1";
	commitEntries(dir, sid, CFG, [
		{ section: "next", text: "board starts empty, need 3 entries before compaction" },
	]);
	const r = commitEntries(dir, sid, CFG, [
		{ section: "next", text: "board has 22 entries, next compaction uses it", supersedes: "need 3 entries" },
	]);
	assert.equal(r.committed, 1, "the new line must be committed");
	assert.equal(r.supersededFiles.length, 1, "exactly one archive file written");
	assert.equal(r.supersedeMisses.length, 0, "no misses");
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(!md.includes("need 3 entries"), "stale line must be gone from the board");
	assert.ok(md.includes("board has 22 entries"), "new line must be on the board");
	assert.ok(md.includes("superseded by a newer line"), "archived pointer line expected");
	const archived = readFileSync(join(dir, ...norm(r.supersededFiles[0]).split("/")), "utf8");
	assert.ok(archived.includes("need 3 entries"), "stale line must still be in the archive (recallable)");
	assert.ok(existsSync(join(dir, "archive", sid)), "archive dir created");
});

check("a summary after a supersede carries only the new version", () => {
	const dir = tmpBoard();
	const sid = "supersede-2";
	commitEntries(dir, sid, CFG, [
		{ section: "decisions", text: "plan: ship the summary as board text" },
		{ section: "files", text: "modified src/summary.ts" },
		{ section: "goal", text: "make compaction lossless" },
	]);
	commitEntries(dir, sid, CFG, [
		{ section: "decisions", text: "plan changed: board renders into native section names", supersedes: "ship the summary as board" },
	]);
	const out = renderSummary(readBoardFile(dir, sid), { recallTool: "blackboard_recall" });
	assert.ok(out, "board is dense enough to render");
	assert.ok(!out.includes("ship the summary as board text"), "summary must not contain the superseded version");
	assert.ok(out.includes("native section names"), "summary must contain the replacement");
});

check("an ambiguous or missing supersedes target is reported, new line still lands", () => {
	const dir = tmpBoard();
	const sid = "supersede-3";
	commitEntries(dir, sid, CFG, [
		{ section: "issues", text: "build fails on windows path" },
		{ section: "issues", text: "build fails on linux path too" },
	]);
	const amb = commitEntries(dir, sid, CFG, [
		{ section: "issues", text: "build failure fixed", supersedes: "build fails on" },
	]);
	assert.equal(amb.committed, 1, "the new fact is still committed");
	assert.equal(amb.supersededFiles.length, 0, "nothing archived when the match is ambiguous");
	assert.equal(amb.supersedeMisses.length, 1);
	assert.match(amb.supersedeMisses[0].reason, /matches 2 entries/);

	const miss = commitEntries(dir, sid, CFG, [
		{ section: "goal", text: "a fresh goal", supersedes: "this text is nowhere on the board" },
	]);
	assert.equal(miss.committed, 1);
	assert.match(miss.supersedeMisses[0].reason, /no board entry contains/);
});

check("one commit batch can supersede several stale lines at once", () => {
	const dir = tmpBoard();
	const sid = "supersede-4";
	commitEntries(dir, sid, CFG, [
		{ section: "decisions", text: "use model A for the summary" },
		{ section: "decisions", text: "use cache B for the prefix" },
	]);
	const r = commitEntries(dir, sid, CFG, [
		{ section: "decisions", text: "use the board itself as the summary", supersedes: "model A" },
		{ section: "decisions", text: "use a byte-stable prefix", supersedes: "cache B" },
	]);
	assert.equal(r.committed, 2);
	assert.equal(r.supersededFiles.length, 2, "each supersede writes its own archive file");
	assert.equal(r.supersedeMisses.length, 0);
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(!md.includes("model A") && !md.includes("cache B"), "both stale lines gone");
});

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
	console.error(`FAIL ${failures.length}/${checks}`);
	for (const f of failures) console.error("  ✗ " + f);
	process.exit(1);
}
console.log(`smoke: ALL PASS (${checks} checks)`);

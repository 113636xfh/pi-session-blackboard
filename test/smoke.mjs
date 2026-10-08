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
import { formatRecall, searchDigest, searchDocument } from "../build/recall.js";
import { renderAssistSection } from "../build/compact-assist.js";
import { commitEntries, mergeSummaryIntoBoard, parseSummarySections, readBoardFile, renderBoard, renderCommitEcho, selectDraftLines, MAX_POINTER_LINES } from "../build/board.js";
import { extractAll } from "../build/extract.js";
import { computePressure, describePressure, fmtTokens, resolveReserveFromSources, PI_DEFAULT_RESERVE_TOKENS, DEFAULTS } from "../build/config.js";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
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
	assert.equal(r.supersededFiles.length, 1, "one archive file for the whole batch");
	assert.equal(r.supersedeMisses.length, 0);
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(!md.includes("model A") && !md.includes("cache B"), "both stale lines gone");
	const both = readFileSync(join(dir, ...norm(r.supersededFiles[0]).split("/")), "utf8");
	assert.ok(both.includes("model A") && both.includes("cache B"), "both stale lines in that one file");
	const after = readBoardFile(dir, sid);
	assert.equal(after.sections.archived.filter((e) => e.text.startsWith("(archived)")).length, 1, "one pointer line for the batch");
});


// ── the board stays bounded: pointer lines are capped ─────────────────────

check("rotation pointer lines are capped (the board cannot grow on bookkeeping)", () => {
	const dir = tmpBoard();
	const sid = "ptr-1";
	const small = { maxEntriesPerSection: 5, maxEntryChars: 300 };
	for (let i = 1; i <= 60; i++) commitEntries(dir, sid, small, [{ section: "files", text: `MODIFIED src/file${i}.ts (sym${i})` }]);
	const b = readBoardFile(dir, sid);
	const ptrs = b.sections.files.filter((e) => e.text.startsWith("(archived)"));
	assert.ok(ptrs.length <= MAX_POINTER_LINES, `pointer lines grew to ${ptrs.length}`);
	assert.equal(b.sections.files.filter((e) => !e.text.startsWith("(archived)")).length, 5, "facts kept: the newest 5");
	// nothing is lost: the rotated facts are still on disk, in archive files
	const files = readdirSync(join(dir, "archive", sid)).filter((f) => f.endsWith(".md"));
	assert.ok(files.length > 10, `expected rotated archive files, got ${files.length}`);
	const all = files.map((f) => readFileSync(join(dir, "archive", sid, f), "utf8")).join("\n");
	assert.ok(all.includes("MODIFIED src/file1.ts"), "the oldest fact is still recallable from the archive");
});

check("counts shown to the model are real entries, not pointer bookkeeping", () => {
	const dir = tmpBoard();
	const sid = "ptr-2";
	const small = { maxEntriesPerSection: 3, maxEntryChars: 300 };
	for (let i = 1; i <= 12; i++) commitEntries(dir, sid, small, [{ section: "files", text: `MODIFIED src/f${i}.ts` }]);
	commitEntries(dir, sid, small, [
		{ section: "goal", text: "make compaction lossless" },
		{ section: "next", text: "write the README" },
	]);
	const out = renderSummary(readBoardFile(dir, sid), { recallTool: "blackboard_recall", archiveDir: "/tmp/arc/sid" });
	assert.ok(out, "board is dense enough");
	assert.match(out, /Blackboard: 5 entries/, `pointer lines must not inflate the count:\n${out.slice(-300)}`);
	assert.ok(out.includes("Rotated history: /tmp/arc/sid"), "the footer must point at the archive dir too");
});


// ── scope-change mining must not fire on ordinary follow-ups ───────────────

check("ordinary follow-up task messages do not fabricate a [Scope change]", () => {
	const users = [
		"Refactor the compaction handler so the board is the summary",
		"Fix these issues and add a regression test for the renderer",
		"Now write the README and make sure the diagrams render",
		"Update the config table with the new defaults",
	].map((text, i) => ({ entryId: `u${i}`, text }));
	const { draft } = extractAll({ users, assistants: [], tools: [] }, emptyBoard(), { goalExtracted: false });
	assert.ok(draft.goal?.[0]?.startsWith("Refactor"), `opening goal expected: ${JSON.stringify(draft.goal)}`);
	assert.ok(!draft.goal?.includes("[Scope change]"), `every turn became a scope change: ${JSON.stringify(draft.goal)}`);
});

check("explicit pivot language is still detected as a scope change", () => {
	const users = [
		"Refactor the compaction handler so the board is the summary",
		"Actually, instead of a new renderer, switch to reusing the native one",
	].map((text, i) => ({ entryId: `u${i}`, text }));
	const { draft } = extractAll({ users, assistants: [], tools: [] }, emptyBoard(), { goalExtracted: false });
	assert.ok(draft.goal?.includes("[Scope change]"), `pivot missed: ${JSON.stringify(draft.goal)}`);
});


// ── commit receipt: the new lines + their nearest older neighbours ────────
// (the receipt used to re-render the whole board on every commit — the largest
// recurring prompt cost of the extension, growing with the board)

check("the receipt carries the new lines plus the 2 nearest older ones per section", () => {
	const dir = tmpBoard();
	const sid = "echo-1";
	commitEntries(dir, sid, CFG, [
		{ section: "decisions", text: "decision one" },
		{ section: "decisions", text: "decision two" },
		{ section: "decisions", text: "decision three" },
		{ section: "next", text: "an untouched next step" },
	]);
	const r = commitEntries(dir, sid, CFG, [
		{ section: "decisions", text: "decision four" },
		{ section: "files", text: "MODIFIED src/board.ts" },
	]);
	const echo = renderCommitEcho(r.board, r.added, 2);
	assert.ok(/^\+ \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] decision four$/m.test(echo), `new line must be marked +:\n${echo}`);
	assert.ok(echo.includes("decision three") && echo.includes("decision two"), `2 nearest older lines expected:\n${echo}`);
	assert.ok(!echo.includes("decision one"), `older than the context window must not be echoed:\n${echo}`);
	assert.ok(echo.includes("MODIFIED src/board.ts"), "a section with no older entries still appears");
	assert.ok(!echo.includes("an untouched next step"), "sections without new entries are not echoed");
	assert.ok(echo.indexOf("decision two") < echo.indexOf("decision four"), "newest last");
	assert.ok(!echo.includes("# Session Blackboard"), "the receipt is not a board dump");
});

check("context 0 echoes only what landed; a pure duplicate echoes nothing", () => {
	const dir = tmpBoard();
	const sid = "echo-2";
	commitEntries(dir, sid, CFG, [{ section: "goal", text: "the goal" }]);
	const dup = commitEntries(dir, sid, CFG, [{ section: "goal", text: "THE goal" }]);
	assert.equal(dup.committed, 0, "case-insensitive dedupe");
	assert.equal(dup.added.length, 0, "nothing landed, so nothing to echo");
	assert.equal(renderCommitEcho(dup.board, dup.added, 2), "");
	const r = commitEntries(dir, sid, CFG, [{ section: "goal", text: "second goal line" }]);
	const echo = renderCommitEcho(r.board, r.added, 0);
	assert.ok(echo.includes("second goal line") && !echo.includes("] the goal"), echo);
});

check("a rotation pointer is never echoed as new or as context", () => {
	const dir = tmpBoard();
	const sid = "echo-3";
	const small = { maxEntriesPerSection: 3, maxEntryChars: 300 };
	for (let i = 1; i <= 4; i++) commitEntries(dir, sid, small, [{ section: "files", text: `file ${i}` }]);
	const r = commitEntries(dir, sid, small, [{ section: "files", text: "file 5" }]);
	const echo = renderCommitEcho(r.board, r.added, 2);
	assert.ok(echo.includes("+ [") && echo.includes("file 5"), echo);
	assert.ok(!echo.includes("(archived)"), `rotation pointer must not ride along:\n${echo}`);
	assert.ok(echo.includes("file 3") && echo.includes("file 4"), `nearest older facts expected:\n${echo}`);
});

check("the receipt context budget is configurable and defaults to 2", () => {
	assert.equal(DEFAULTS.commitContextEntries, 2);
});


// ── draft policy: mechanical lines land with the commit, not by retyping ──
// (measured on 70 debug logs / 26 boards: 2013 draft lines produced, 143 commits,
// and only 12 MODIFIED/COMMIT lines survived — the deterministic facts were lost
// because the agent had to retype them)

const mkDraft = (sections) => ({ generatedAt: "2026-10-08T00:00:00Z", sections });

check("the deterministic policy auto-lands only MODIFIED/COMMIT draft lines", () => {
	const d = mkDraft({
		files: ["MODIFIED src/board.ts (commitEntries)", "COMMIT 93c32ad /bb compact", "a mined prose line in files"],
		issues: ["[ERROR] npm test: FAIL 1/46"],
		decisions: ["we'll use the board as the summary"],
	});
	const det = selectDraftLines(d, "deterministic", []);
	assert.deepEqual(
		det.selected.map((x) => x.text),
		["MODIFIED src/board.ts (commitEntries)", "COMMIT 93c32ad /bb compact"],
		"only the zero-heuristic extractor output",
	);
	assert.equal(det.total, 5, "the draft total is reported for the receipt");
	assert.equal(selectDraftLines(d, "all", []).selected.length, 5, "all lands every line");
	assert.equal(selectDraftLines(d, "none", []).selected.length, 0, "none lands nothing");
});

check("dropDraft rejects draft lines by case-insensitive substring", () => {
	const d = mkDraft({ files: ["MODIFIED src/a.ts", "MODIFIED src/b.ts", "COMMIT deadbeef fix"], issues: ["[ERROR] grep -c zero matches"] });
	const det = selectDraftLines(d, "deterministic", ["src/b.ts"]);
	assert.deepEqual(det.selected.map((x) => x.text), ["MODIFIED src/a.ts", "COMMIT deadbeef fix"]);
	assert.equal(det.dropped, 1);
	const all = selectDraftLines(d, "all", ["[error]", "MODIFIED SRC/B.TS"]);
	assert.equal(all.dropped, 2, "matching is case-insensitive on both sides");
	assert.equal(all.selected.length, 2);
});

check("the receipt marks auto-accepted draft lines with ~ and agent lines with +", () => {
	const dir = tmpBoard();
	const sid = "echo-4";
	const r = commitEntries(dir, sid, CFG, [
		{ section: "files", text: "MODIFIED src/a.ts" },
		{ section: "decisions", text: "written by the agent" },
	]);
	const echo = renderCommitEcho(r.board, r.added.map((a) => ({ ...a, auto: a.text.startsWith("MODIFIED") })), 2);
	assert.ok(/^~ \[.+\] MODIFIED src\/a\.ts$/m.test(echo), `auto line must be marked ~:\n${echo}`);
	assert.ok(/^\+ \[.+\] written by the agent$/m.test(echo), `agent line must be marked +:\n${echo}`);
});

check("draftOnCommit defaults to deterministic", () => {
	assert.equal(DEFAULTS.draftOnCommit, "deterministic");
});


// ── snapshot digests: one hit per matching line, not the whole blob ───────
const DIGEST = {
	v: 1,
	at: "2026-10-02T07:11:24.506Z",
	session: "01a0f1c6-d229-7785-9040-c46352c6bcf0",
	goal: ["主线：让压缩不丢事实", "板子刚开始积累，尚未验证第一次压缩走黑板"],
	next: ["读 verification/shots/mcp_20261002_123347894.png 确认棕块"],
	recentFiles: ["blackboard 仓库根 C:/Users/…/pi-session-blackboard", "settings.json 的 packages 改为裸字符串"],
	openIssues: 2,
	counts: { goal: 2, decisions: 10, next: 2 },
};

check("a digest hit is the matching line, located by its section", () => {
	const hits = searchDigest(DIGEST, "尚未验证", 5, "snapshot/7@07-11-24");
	assert.equal(hits.length, 1, "one matching line, not the whole JSON");
	assert.equal(hits[0].section, "Goal", "recentFiles must be labelled Files, not the JSON key");
	assert.ok(hits[0].line.includes("尚未验证"));
	assert.ok(!hits[0].line.includes('"counts"'), "the blob must not leak into the line");
	assert.ok(formatRecall(hits, "尚未验证").length < 400, "the card must stay small");
});

check("digest hits carry per-field sections and can be narrowed by limit", () => {
	const many = searchDigest(DIGEST, "e", 20, "snapshot/7");
	assert.ok(many.length > 1);
	assert.ok(many.every((h) => h.section !== ""), "every digest hit is attributable");
	const capped = searchDigest(DIGEST, "e", 2, "snapshot/7");
	assert.equal(capped.length, 2, "limit caps digest hits too");
});

check("digest search ignores counts/numbers but finds the session id", () => {
	assert.equal(searchDigest(DIGEST, "counts", 5, "s").length, 0, "matching a count is noise");
	assert.equal(searchDigest(DIGEST, "openIssues", 5, "s").length, 0, "a bare number is not a fact");
	const byId = searchDigest(DIGEST, "01a0f1c6", 5, "s");
	assert.equal(byId.length, 1);
	assert.equal(byId[0].section, "session");
	assert.ok(searchDigest(DIGEST, "2026-10-02", 5, "s").length === 0, "the `at` stamp alone is not a hit");
});


// ── adopting a pre-existing native compaction summary ──────────────────────
const NATIVE_SUMMARY = `## Goal
- 改进 pi 的上下文压缩质量，但用户认为信息损失过大，改走 blackboard 路线
- [Scope change]
- 压缩时继续使用原生流程，而不是按 80% 阈值流式丢消息

## Constraints & Preferences
- 用户不接受达到固定百分比后直接流式丢弃消息
- [Scope change]

## Key Decisions
- 黑板即摘要：pi 保留切点与尾部，摘要内容换成黑板渲染结果

## Files & Changes
- Modified: D:/01-R&D/Project-pi-vcc-plus/src/engine.ts, src/prompt.ts
- Main.cs: 相机出生改为采样实际地表高度

## Open Issues
- 阻塞：sqlite3 编译失败，exit code 1，stderr 'Error: spawnSync /usr/bin/gcc ENOENT'

## Next Steps
- 下一步：装好依赖后给 blackboard_recall 建 FTS5 索引
`;

check("a native summary is parsed into routed, single-line entries", () => {
	const parsed = parseSummarySections(NATIVE_SUMMARY);
	const at = (sec, re) => parsed.filter((p) => p.section === sec && re.test(p.text));
	assert.ok(at("goal", /blackboard 路线/).length === 1, "goal bullet routed to Goal");
	assert.ok(at("goal", /80% 阈值/).length === 1, "a Scope change is a goal, not a decision");
	assert.ok(at("prefs", /流式丢弃消息/).length === 1, "constraints routed to Prefs");
	assert.ok(at("prefs", /^\[Scope change\]$/).length === 0, "placeholder headers are not entries");
	assert.ok(at("decisions", /黑板即摘要/).length === 1, "Key Decisions routed to Decisions");
	assert.ok(at("files", /engine\.ts/).length === 1, "Files routed to Files");
	assert.ok(at("files", /Main\.cs/).length === 1, "a path in another section is still content");
	assert.ok(at("issues", /ENOENT/).length === 1, "Open Issues routed to Issues");
	assert.ok(at("next", /FTS5/).length === 1, "Next Steps routed to Next");
	assert.ok(parsed.every((p) => !p.text.includes(String.fromCharCode(10))), "entries stay one line each");
});

check("content beats the header: an error line under Progress becomes an Issue", () => {
	const parsed = parseSummarySections("## Progress" + String.fromCharCode(10) + "- 修好了相机，但 MCP 截图报 ENOENT 仍然存在");
	assert.equal(parsed[0].section, "issues");
});

check("a native summary merges into an EMPTY board", () => {
	const dir = tmpBoard();
	const sid = "merge-1";
	const first = mergeSummaryIntoBoard(dir, sid, CFG, NATIVE_SUMMARY);
	assert.ok(first.merged, "an empty board must accept the summary");
	assert.ok(first.added >= 8, `expected the bullets to land, got ${first.added}`);
	assert.ok(first.counts.goal >= 2 && first.counts.issues >= 1, `bad routing: ${JSON.stringify(first.counts)}`);
});

check("a native summary ALSO merges into a full board: curated entries stay, no duplicates", () => {
	const dir = tmpBoard();
	const sid = "merge-2";
	commitEntries(dir, sid, CFG, [
		{ section: "goal", text: "curated goal that predates the summary" },
		{ section: "files", text: "modified src/keep.ts (keep)" },
	]);
	const res = mergeSummaryIntoBoard(dir, sid, CFG, NATIVE_SUMMARY);
	assert.ok(res.merged, "a dense board must still take the summary in");
	assert.ok(res.added > 0, "new facts must land");
	const b = readBoardFile(dir, sid);
	assert.ok(
		b.sections.goal.some((e) => e.text === "curated goal that predates the summary"),
		"curated entry must survive the merge",
	);
	assert.ok(b.sections.files.some((e) => e.text.includes("keep.ts")), "curated file entry must survive");
	// Re-merging is a no-op: dedupe is case-insensitive and exact.
	const again = mergeSummaryIntoBoard(dir, sid, CFG, NATIVE_SUMMARY);
	assert.equal(again.added, 0, `second merge must add nothing, added ${again.added}`);
	assert.ok(again.deduped > 0, "duplicate lines must be reported as deduped");
	mergeSummaryIntoBoard(dir, sid, CFG, NATIVE_SUMMARY.toUpperCase());
	const goals = readBoardFile(dir, sid).sections.goal.map((e) => e.text.toLowerCase());
	assert.equal(goals.length, new Set(goals).size, "case-folded text must not slip past the dedupe");
});

check("our own board summary is never merged back in", () => {
	const dir = tmpBoard();
	const sid = "merge-3";
	const ours = ["# Session context checkpoint", "", "## Goal", "- something we wrote ourselves"].join(String.fromCharCode(10));
	const res = mergeSummaryIntoBoard(dir, sid, CFG, ours);
	assert.equal(res.merged, false);
	assert.equal(res.reason, "own-summary");
	assert.equal(mergeSummaryIntoBoard(dir, sid, CFG, "   ").reason, "empty-summary");
});

check("a merged board can immediately render as a summary", () => {
	const dir = tmpBoard();
	const sid = "merge-4";
	mergeSummaryIntoBoard(dir, sid, CFG, NATIVE_SUMMARY);
	const out = renderSummary(readBoardFile(dir, sid), { recallTool: "blackboard_recall" });
	assert.ok(out, "a merged board must clear the thin-board floor");
	assert.ok(out.includes("ENOENT") && out.includes("FTS5"), "merged facts reach the summary");
});


check("a merge trims overflow itself: newest kept, rest in ONE archive file", () => {
	const dir = tmpBoard();
	const sid = "merge-5";
	const many = ["## Decisions", ...Array.from({ length: 40 }, (_, i) => `- decision number ${i}`)].join(String.fromCharCode(10));
	const res = mergeSummaryIntoBoard(dir, sid, CFG, many);
	assert.ok(res.merged);
	assert.equal(res.added, 6, "only the newest 6 stay on the board");
	assert.equal(res.dropped, 34, "the rest are archived");
	assert.equal(res.archived.length, 1, "exactly one archive file, not 34");
	const files = readdirSync(join(dir, "archive", sid));
	assert.equal(files.length, 1, `one file expected, got ${files.join(",")}`);
	const archived = readFileSync(join(dir, "archive", sid, files[0]), "utf8");
	assert.ok(archived.includes("decision number 0"), "oldest archived line kept");
	assert.ok(!archived.includes("decision number 39"), "newest stays on the board");
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.equal((md.match(/\(archived\)/g) ?? []).length, 1, "one pointer line, not one per rotation");
	assert.ok(md.includes("decision number 39"), "newest decision is on the board");
});

check("re-merging the same summary is a no-op even after its overflow was archived", () => {
	const dir = tmpBoard();
	const sid = "merge-idem";
	const many = ["## Findings", ...Array.from({ length: 10 }, (_, i) => `- finding ${i} with a measured result`)].join(String.fromCharCode(10));
	const first = mergeSummaryIntoBoard(dir, sid, CFG, many);
	assert.equal(first.added, 6, "newest 6 stay");
	assert.equal(first.dropped, 4, "the other 4 are archived");
	assert.equal(first.archived.length, 1, "one archive file");
	const second = mergeSummaryIntoBoard(dir, sid, CFG, many);
	assert.equal(second.added, 0, `archived lines must count as known, added ${second.added}`);
	assert.equal(second.deduped, 10, "all ten bullets reported as already known");
	assert.equal(second.archived.length, 0, "a no-op merge writes no archive file");
	assert.equal(readdirSync(join(dir, "archive", sid)).length, 1, "still exactly one archive file");
});

check("merged entries are not cut at the agent cap", () => {
	const dir = tmpBoard();
	const sid = "merge-6";
	const NL = String.fromCharCode(10);
	const long = ["## Files And Changes", `- modified src/engine.ts because ${"x".repeat(450)}`].join(NL);
	mergeSummaryIntoBoard(dir, sid, CFG, long);
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(md.includes("x".repeat(450)), "a 450-char rationale must survive the merge");
});

// ── findings: first-class key findings from exploration/experiments ──────
const { extractFindings, extractExperiments } = await import("../build/extract.js");
const assistant = (text) => [{ entryId: "a1", text }];
const tool = (args, output = "", isError = false) => [{ entryId: "t1", callId: "c1", name: "bash", args, output, isError }];

check("extractFindings catches measured/root-cause lines, skips plain prose", () => {
	const found = extractFindings(assistant(
		"实测 compact 0.0s vs 原生 >3min，同一台本地 27B。" + String.fromCharCode(10) +
		"接下来继续写测试。" + String.fromCharCode(10) +
		"Root cause: the probe killed the process before the summarizer finished.",
	));
	assert.equal(found.length, 2, `expected 2 findings, got ${JSON.stringify(found)}`);
	assert.ok(found[0].includes("实测"));
	assert.ok(found[1].includes("Root cause"));
});

check("extractExperiments flags tests/typechecks/probes, not plain commands", () => {
	const exp = extractExperiments(tool({ command: "cd /tmp && npm test && tsc -p tsconfig.json" }));
	assert.equal(exp.length, 1);
	assert.ok(exp[0].startsWith("RAN "));
	assert.equal(extractExperiments(tool({ command: "ls -la /tmp" })).length, 0);
	const failed = extractExperiments(tool({ command: "npm test" }, "exit code 1", true));
	assert.ok(failed[0].includes("(failed)"), "a failing experiment is marked");
});

check("a summary's Findings header routes to the findings section", () => {
	const parsed = parseSummarySections("## Key Findings" + String.fromCharCode(10) + "- 实测：WSL bash 的目录视图会 stale");
	assert.equal(parsed[0].section, "findings");
});

check("a measured-result line under a neutral header lands in findings", () => {
	const parsed = parseSummarySections("## Progress" + String.fromCharCode(10) + "- 实测 compact 0.0s，比原生摘要快两个数量级");
	assert.equal(parsed[0].section, "findings");
});

check("decision language wins over finding language (route priority)", () => {
	const parsed = parseSummarySections("## Progress" + String.fromCharCode(10) + "- 实测更快，所以决定选择黑板方案");
	assert.equal(parsed[0].section, "decisions", "a line naming the choice stays in Decisions");
});

check("a findings entry renders in the board and the summary", () => {
	const b = emptyBoard();
	b.sections.findings.push(entry("2026-10-02 22:00", "实测 compact 0.0s vs 原生 >3min"));
	b.sections.goal.push(entry("t", "goal line"));
	b.sections.files.push(entry("t", "modified src/summary.ts"));
	const md = renderBoard(b);
	assert.ok(md.includes("## Findings"), "board file has a Findings section");
	const out = renderSummary(b);
	assert.ok(out && out.includes("## Key Findings") && out.includes("实测 compact"), "summary carries the finding");
});

check("merge routes a Findings header into the findings section", () => {
	const dir = tmpBoard();
	const sid = "merge-findings";
	const res = mergeSummaryIntoBoard(dir, sid, CFG,
		"## Goal" + String.fromCharCode(10) + "- make compaction lossless" + String.fromCharCode(10) +
		"## Findings" + String.fromCharCode(10) + "- 实测：探针 40s 杀进程导致摘要没跑完");
	assert.ok(res.merged);
	assert.ok(res.counts.findings === 1, `findings count missing: ${JSON.stringify(res.counts)}`);
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(md.includes("探针 40s"));
});

// ── compaction countdown (how far is the trigger?) ─────────────────────────
// Hermetic cwd: the countdown mirrors THIS project's compaction settings, so
// the tests pin them in a temp .pi/settings.json instead of reading the real
// agent settings (which do set reserveTokens on this machine).
const cfgDir = (compaction) => {
	const dir = mkdtempSync(join(tmpdir(), "sbb-cfg-"));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction }));
	return dir;
};
const RESERVE_16K = 16384;

check("pressure counts down to pi's own trigger line, not to the window", () => {
	const cwd = cfgDir({ reserveTokens: RESERVE_16K });
	const p = computePressure({ tokens: 90_000, contextWindow: 128_000 }, cwd, undefined, 32768);
	assert.ok(p, "pressure must be computable");
	assert.equal(p.reserveTokens, RESERVE_16K);
	assert.equal(p.triggerAt, 128_000 - RESERVE_16K);
	assert.equal(p.remaining, 128_000 - RESERVE_16K - 90_000);
	assert.equal(p.near, true, "21.6k left IS inside a 32768 warn zone");
});

check("inside the warn zone the prompt line becomes an instruction", () => {
	const cwd = cfgDir({ reserveTokens: RESERVE_16K });
	const p = computePressure({ tokens: 112_000, contextWindow: 128_000 }, cwd, undefined, 32768);
	assert.equal(p.remaining, 128_000 - RESERVE_16K - 112_000);
	assert.equal(p.near, true);
	const line = describePressure(p);
	assert.ok(line.includes("OVERDUE"), line);
	assert.ok(line.includes("NEAR COMPACTION"), line);
});

check("a healthy context still reports the countdown, as guidance not alarm", () => {
	const cwd = cfgDir({ reserveTokens: RESERVE_16K });
	const p = computePressure({ tokens: 20_000, contextWindow: 128_000 }, cwd, undefined, 32768);
	assert.equal(p.near, false, "91.6k left is far from the line");
	const line = describePressure(p);
	assert.ok(line.includes("91.6k away"), line);
	assert.ok(!line.includes("NEAR COMPACTION"), line);
});

check("unknown token count (right after compaction) yields no line at all", () => {
	const cwd = cfgDir({ reserveTokens: RESERVE_16K });
	const p = computePressure({ tokens: null, contextWindow: 128_000 }, cwd, undefined, 32768);
	assert.equal(p.remaining, null);
	assert.equal(p.near, false, "unknown must never fake an alarm");
	assert.equal(describePressure(p), null);
	assert.equal(describePressure(null), null);
});

check("no usage / no window -> null, and the warn zone can be switched off", () => {
	const cwd = cfgDir({ reserveTokens: RESERVE_16K });
	assert.equal(computePressure(undefined, cwd, undefined, 32768), null);
	assert.equal(computePressure({ tokens: 1, contextWindow: 0 }, cwd, undefined, 32768), null);
	const p = computePressure({ tokens: 112_000, contextWindow: 128_000 }, cwd, undefined, 0);
	assert.equal(p.near, false, "compactionWarnTokens: 0 disables the every-turn nudge");
});

check("fmtTokens stays short", () => {
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(91_616), "91.6k");
	assert.equal(fmtTokens(99_999), "100.0k");
	assert.equal(fmtTokens(128_000), "128k");
});

check("reserve resolves model override > ordinary setting > pi default", () => {
	const user = { reserveTokens: 400000, modelOverrides: { "local/qwen": { reserveTokens: 999 } } };
	const project = { reserveTokens: 20_000 };
	assert.equal(resolveReserveFromSources([user, project], "local/qwen"), 999, "model override wins");
	assert.equal(resolveReserveFromSources([user, project], "other/model"), 20_000, "project wins over user");
	assert.equal(resolveReserveFromSources([user]), 400_000, "user setting when no project");
	assert.equal(resolveReserveFromSources([]), PI_DEFAULT_RESERVE_TOKENS, "pi default last");
	assert.equal(PI_DEFAULT_RESERVE_TOKENS, 16384, "pi's built-in default");
});

check("the warn zone ships on by default, sized to the local 27B window", () => {
	assert.equal(DEFAULTS.compactionWarnTokens, 32768);
});

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
	console.error(`FAIL ${failures.length}/${checks}`);
	for (const f of failures) console.error("  ✗ " + f);
	process.exit(1);
}
console.log(`smoke: ALL PASS (${checks} checks)`);

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
import { commitEntries, parseSummarySections, readBoardFile, renderBoard, seedFromPriorSummary } from "../build/board.js";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
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

check("seeding fills an empty board, and refuses a board that already has content", () => {
	const dir = tmpBoard();
	const sid = "seed-1";
	const first = seedFromPriorSummary(dir, sid, CFG, NATIVE_SUMMARY);
	assert.ok(first.seeded, "an empty board must accept the summary");
	assert.ok(first.total >= 8, `expected the bullets to land, got ${first.total}`);
	assert.ok(first.counts.goal >= 2 && first.counts.issues >= 1, `bad routing: ${JSON.stringify(first.counts)}`);

	const again = seedFromPriorSummary(dir, sid, CFG, NATIVE_SUMMARY);
	assert.equal(again.seeded, false);
	assert.equal(again.reason, "board-not-thin", "curated content must never be re-diluted");

	const curated = tmpBoard();
	commitEntries(curated, "seed-2", CFG, [
		{ section: "goal", text: "a" },
		{ section: "goal", text: "b" },
		{ section: "goal", text: "c" },
	]);
	const blocked = seedFromPriorSummary(curated, "seed-2", CFG, NATIVE_SUMMARY);
	assert.equal(blocked.seeded, false);
	assert.equal(blocked.reason, "board-not-thin");
});

check("our own board summary is never adopted back in", () => {
	const dir = tmpBoard();
	const sid = "seed-3";
	const ours = ["# Session context checkpoint", "", "## Goal", "- something we wrote ourselves"].join(String.fromCharCode(10));
	const res = seedFromPriorSummary(dir, sid, CFG, ours);
	assert.equal(res.seeded, false);
	assert.equal(res.reason, "own-summary");
	assert.equal(seedFromPriorSummary(dir, sid, CFG, "   ").reason, "empty-summary");
});

check("a seeded board can immediately render as a summary", () => {
	const dir = tmpBoard();
	const sid = "seed-4";
	seedFromPriorSummary(dir, sid, CFG, NATIVE_SUMMARY);
	const out = renderSummary(readBoardFile(dir, sid), { recallTool: "blackboard_recall" });
	assert.ok(out, "a seeded board must clear the thin-board floor");
	assert.ok(out.includes("ENOENT") && out.includes("FTS5"), "seeded facts reach the summary");
});


check("adoption trims overflow itself: newest kept, rest in ONE archive file", () => {
	const dir = tmpBoard();
	const sid = "seed-5";
	const many = ["## Decisions", ...Array.from({ length: 40 }, (_, i) => `- decision number ${i}`)].join(String.fromCharCode(10));
	const res = seedFromPriorSummary(dir, sid, CFG, many);
	assert.ok(res.seeded);
	assert.equal(res.total, 6, "only the newest 6 stay on the board");
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

check("adopted entries are not cut at the agent cap", () => {
	const dir = tmpBoard();
	const sid = "seed-6";
	const NL = String.fromCharCode(10);
	const long = ["## Files And Changes", `- modified src/engine.ts because ${"x".repeat(450)}`].join(NL);
	seedFromPriorSummary(dir, sid, CFG, long);
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(md.includes("x".repeat(450)), "a 450-char rationale must survive adoption");
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

check("seedFromPriorSummary routes a Findings header into the findings section", () => {
	const dir = tmpBoard();
	const sid = "seed-findings";
	const res = seedFromPriorSummary(dir, sid, CFG,
		"## Goal" + String.fromCharCode(10) + "- make compaction lossless" + String.fromCharCode(10) +
		"## Findings" + String.fromCharCode(10) + "- 实测：探针 40s 杀进程导致摘要没跑完");
	assert.ok(res.seeded);
	assert.ok(res.counts.findings === 1, `findings count missing: ${JSON.stringify(res.counts)}`);
	const md = readFileSync(join(dir, `${sid}.md`), "utf8");
	assert.ok(md.includes("探针 40s"));
});

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
	console.error(`FAIL ${failures.length}/${checks}`);
	for (const f of failures) console.error("  ✗ " + f);
	process.exit(1);
}
console.log(`smoke: ALL PASS (${checks} checks)`);

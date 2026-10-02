/**
 * Deterministic per-turn extraction for the session blackboard.
 *
 * This is the "call vcc every turn" part of the design: the same
 * vcc-style deterministic mining @monotykamary/pi-vcc (MIT) uses at
 * compaction time — but scoped to the entries since the last checkpoint,
 * so it runs in milliseconds per turn with zero LLM involvement. The
 * agent then reviews/approves/corrects the result before anything is
 * committed (see index.ts).
 *
 * Goal/scope-change and preference patterns are adapted from pi-vcc's
 * extract/goals.ts and extract/preferences.ts (MIT; see README).
 */

import type {
	AssistantBlock,
	BranchEntry,
	Board,
	DraftSections,
	NormalizedBlocks,
	Section,
	SbbState,
	ToolBlock,
	UserBlock,
} from "./types.js";

// ---------------------------------------------------------------------------
// Normalization: branch entries -> typed blocks
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const c of content) {
			if (c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string") {
				parts.push((c as { text: string }).text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

export function normalizeBranch(entries: BranchEntry[]): NormalizedBlocks {
	const out: NormalizedBlocks = { users: [], assistants: [], tools: [] };
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();

	for (const e of entries) {
		if (!e || e.type !== "message" || !e.message) continue;
		const m = e.message;
		const id = typeof e.id === "string" ? e.id : "";

		if (m.role === "user") {
			const t = textOf(m.content).trim();
			if (t) out.users.push({ entryId: id, text: t });
		} else if (m.role === "assistant") {
			let text = "";
			if (Array.isArray(m.content)) {
				for (const part of m.content as Array<Record<string, unknown>>) {
					if (!part || typeof part !== "object") continue;
					if (part.type === "text" && typeof part.text === "string") {
						text += (text ? "\n" : "") + part.text;
					} else if (part.type === "toolCall") {
						const callId = typeof part.id === "string" ? part.id : "";
						if (callId) {
							calls.set(callId, {
								name: typeof part.name === "string" ? part.name : "unknown",
								args: part.arguments && typeof part.arguments === "object" ? (part.arguments as Record<string, unknown>) : {},
							});
						}
					}
				}
			}
			text = text.trim();
			if (text) out.assistants.push({ entryId: id, text });
		} else if (m.role === "toolResult") {
			const callId = typeof m.toolCallId === "string" ? m.toolCallId : "";
			const call = calls.get(callId);
			const name = typeof m.toolName === "string" ? m.toolName : call?.name ?? "unknown";
			out.tools.push({
				entryId: id,
				callId,
				name,
				args: call?.args ?? {},
				output: textOf(m.content).slice(0, 4000),
				isError: m.isError === true,
			});
		}
		// custom_message / compaction / session / model_change etc. are ignored:
		// we never mine our own injected checkpoint messages.
	}
	return out;
}

// ---------------------------------------------------------------------------
// vcc-style text patterns (adapted from @monotykamary/pi-vcc, MIT)
// ---------------------------------------------------------------------------

const SCOPE_CHANGE_RE =
	/\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
const TASK_RE =
	/\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|y|n|k)\s*[.!?]*$/i;
const NON_GOAL_RE =
	/^\s*[\[│├└─╭╰]|```|^\s*(function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\n/;
const MAX_GOAL_CHARS = 200;
const LEADING_CHARS = 200;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const stripBullet = (line: string) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

function goalLines(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const t = stripBullet(raw.trim());
		if (t.length <= 5 || t.length > MAX_GOAL_CHARS) continue;
		if (NOISE_SHORT_RE.test(t)) continue;
		if (NON_GOAL_RE.test(t)) continue;
		out.push(clip(t, MAX_GOAL_CHARS));
		if (out.length >= 6) break;
	}
	return out;
}

/**
 * Goal mining. When the session's goal is not yet recorded: take the user's
 * opening task statement from the FIRST user block. In the same call (and in
 * every later call), mine scope changes from the remaining user blocks —
 * keeping this robust across cursor loss / branch rescan where several user
 * blocks arrive in one window. vcc-style: the block that just became the
 * goal is never re-marked as a scope change.
 */
export function extractGoal(users: UserBlock[], board: Board, state: SbbState): string[] {
	const out: string[] = [];
	const needInitial = !state.goalExtracted && board.sections.goal.length === 0;
	if (needInitial && users[0]) out.push(...goalLines(users[0].text));

	const scopeStartIdx = needInitial ? 1 : 0;
	for (let i = scopeStartIdx; i < users.length; i++) {
		const b = users[i];
		const leading = b.text.slice(0, LEADING_CHARS);
		if (SCOPE_CHANGE_RE.test(leading) || (TASK_RE.test(leading) && b.text.trim().length > 20)) {
			const lines = goalLines(b.text);
			if (lines.length > 0) {
				out.push("[Scope change]", ...lines.slice(0, 3));
				break;
			}
		}
	}
	return out;
}

const PREF_PATTERNS = [
	/\bprefer(?:s|red|ring)?\s+\w/i,
	/\bdon'?t want\b/i,
	/\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
	/\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
	/\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
	/\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
];

export function extractPrefs(users: UserBlock[], existing: string[]): string[] {
	const seen = new Set(existing.map((p) => p.toLowerCase()));
	const out: string[] = [];
	for (const b of users) {
		for (const raw of b.text.split("\n")) {
			const t = raw.trim();
			if (t.length < 5 || t.length > 200) continue;
			if (t.endsWith("?") || t.includes("?...")) continue;
			if (!PREF_PATTERNS.some((p) => p.test(t))) continue;
			const c = clip(t, 200);
			if (seen.has(c.toLowerCase())) continue;
			seen.add(c.toLowerCase());
			out.push(c);
			break; // one per user block
		}
	}
	return out.slice(0, 5);
}

/**
 * Remove preferences that duplicate goals (case-insensitive, trimmed).
 * Adapted from pi-vcc's dedupPreferencesAgainstGoals so the two sections
 * never overlap (a goal line that also matches a preference pattern stays
 * in Goal only).
 */
export function dedupPreferencesAgainstGoals(prefs: string[], goals: string[]): string[] {
	const norm = (s: string) => s.trim().toLowerCase();
	const goalSet = new Set(goals.map(norm));
	return prefs.filter((p) => !goalSet.has(norm(p)));
}

// ---------------------------------------------------------------------------
// Deterministic tool-call mining (zero heuristics on tool data)
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["edit", "write"]);
const EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z0-9_]+)/gm;

function exportedSymbols(src: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	EXPORT_RE.lastIndex = 0;
	while ((m = EXPORT_RE.exec(src)) !== null && out.length < 4) {
		if (!seen.has(m[1])) {
			seen.add(m[1]);
			out.push(m[1]);
		}
	}
	return out;
}

export function extractFiles(tools: ToolBlock[]): { lines: string[]; paths: Set<string> } {
	const lines: string[] = [];
	const paths = new Set<string>();
	for (const t of tools) {
		if (!FILE_TOOLS.has(t.name)) continue;
		const path =
			typeof t.args.file_path === "string" ? t.args.file_path : typeof t.args.path === "string" ? (t.args.path as string) : "";
		if (!path) continue;
		const content = typeof t.args.content === "string" ? (t.args.content as string) : "";
		const edits = Array.isArray(t.args.edits)
			? (t.args.edits as Array<{ newText?: unknown }>)
				.map((x) => (x && typeof x.newText === "string" ? x.newText : ""))
				.join("\n")
			: "";
		const symbols = exportedSymbols(content || edits);
		lines.push(`MODIFIED ${path}${symbols.length > 0 ? ` (${symbols.join(", ")})` : ""}`);
		paths.add(path);
	}
	// de-dup while preserving order
	const seen = new Set<string>();
	return {
		paths,
		lines: lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true))),
	};
}

export function extractCommits(tools: ToolBlock[]): string[] {
	const out: string[] = [];
	for (const t of tools) {
		if (t.name !== "bash" || t.isError) continue;
		const cmd = typeof t.args.command === "string" ? (t.args.command as string) : "";
		if (!/\bgit\s+commit\b/.test(cmd)) continue;
		const m = t.output.match(/\[[^\]\n]*\]\s+([0-9a-f]{7,40})\b/) ?? t.output.match(/\b([0-9a-f]{40})\b/);
		if (!m) continue;
		const hash = m[1].slice(0, 10);
		const subject = (t.output.split(m[1]).slice(1).join(" ").trim().split("\n")[0] ?? "").slice(0, 80);
		out.push(`COMMIT ${hash} ${subject}`.trim());
		if (out.length >= 4) break;
	}
	return out;
}

const ERR_PATTERNS: RegExp[] = [
	/exit(?:ed)? with (?:code|status) (\d+)/i,
	/\berror TS\d+/,
	/\bFAILED \d+/,
	/\btests? (?:failed|failing)\b/i,
	/\bpanicked at\b/,
	/Traceback \(most recent call last\)/,
	/\b✖\b/,
];

function pickErrorLine(out: string): string {
	for (const re of ERR_PATTERNS) {
		const m = out.match(re);
		if (m) {
			const idx = out.indexOf(m[0]);
			return out.slice(Math.max(0, idx - 40), idx + 160).replace(/\s+/g, " ").trim();
		}
	}
	const first = out
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return (first ?? "").slice(0, 160);
}

export function extractIssues(tools: ToolBlock[]): string[] {
	const out: string[] = [];
	for (const t of tools) {
		if (t.name !== "bash" && t.name !== "run") continue;
		let failed = t.isError;
		if (!failed) {
			const em = t.output.match(/exit(?:ed)? with (?:code|status) (\d+)/i);
			failed = !!em && em[1] !== "0";
		}
		if (!failed) continue;
		const line = pickErrorLine(t.output);
		const cmd = (typeof t.args.command === "string" ? (t.args.command as string) : "").replace(/\s+/g, " ").slice(0, 80);
		if (line) out.push(`[ERROR] ${cmd}: ${line}`.trim());
		if (out.length >= 4) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Assistant-text mining (light, capped, agent corrects it at review time)
// ---------------------------------------------------------------------------

const DECISION_RE =
	/\b(I'?ll (?:use|go with|switch to|implement|write)|decided (?:to|on)|decision[: ]|going with|let'?s (?:use|go with)|we'?ll (?:use|go with)|switch(?:ing|ed)? to)\b/i;

export function extractDecisions(assistants: AssistantBlock[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const b of assistants) {
		for (const raw of b.text.split("\n")) {
			const line = stripBullet(raw);
			if (line.length < 20) continue;
			if (!DECISION_RE.test(line)) continue;
			const c = clip(line, 260);
			const key = c.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
	}
	return out.slice(0, 3);
}

const NEXT_RE = /\b(next (?:step|I|we|action|move)|TODO:|after (?:this|that),? (?:we|I)|remaining (?:work|steps))\b/i;

export function extractNext(assistants: AssistantBlock[], users: UserBlock[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (raw: string, max: number) => {
		const line = stripBullet(raw);
		if (line.length < 15) return;
		if (!NEXT_RE.test(line)) return;
		const c = clip(line, 200);
		const key = c.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(c);
	};
	for (const b of assistants) for (const raw of b.text.split("\n")) push(raw, 3);
	if (out.length < 3) for (const b of users) for (const raw of b.text.split("\n")) {
		if (out.length >= 3) break;
		push(raw, 1);
	}
	return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ExtractResult = {
	draft: DraftSections;
	resolvedPaths: string[];
};

const PER_SECTION_CAP = 8;

/**
 * Run all extractors over the NEW blocks of this turn. Pure function, no I/O,
 * no LLM. Returns draft lines (pre-commit) plus paths of files modified this
 * turn (used for [RESOLVED] marking of open issues).
 */
export function extractAll(
	blocks: NormalizedBlocks,
	board: Board,
	state: SbbState,
): ExtractResult {
	const draft: DraftSections = {};
	const globalSeen = new Set<string>();
	const put = (s: Section, lines: string[]) => {
		if (lines.length === 0) return;
		const fresh: string[] = [];
		for (const l of lines) {
			const k = l.toLowerCase();
			if (globalSeen.has(k)) continue; // a line is filed under ONE section only
			globalSeen.add(k);
			fresh.push(l);
		}
		if (fresh.length > 0) draft[s] = [...(draft[s] ?? []), ...fresh].slice(0, PER_SECTION_CAP);
	};

	const goalLines = extractGoal(blocks.users, board, state);
	const prefsLines = dedupPreferencesAgainstGoals(
		extractPrefs(blocks.users, board.sections.prefs.map((p) => p.text)),
		goalLines,
	);

	put("goal", goalLines);
	put("prefs", prefsLines);

	const files = extractFiles(blocks.tools);
	put("files", files.lines);
	put("files", extractCommits(blocks.tools));
	put("issues", extractIssues(blocks.tools));
	put("decisions", extractDecisions(blocks.assistants));
	put("next", extractNext(blocks.assistants, blocks.users));

	return { draft, resolvedPaths: [...files.paths] };
}

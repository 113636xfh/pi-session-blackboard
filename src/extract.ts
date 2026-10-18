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
			const status = m.details?.cancelled === true ? "cancelled"
				: m.details?.status === "unfinished" ? "unfinished"
				: m.isError === true || (typeof m.details?.exitCode === "number" && m.details.exitCode !== 0) ? "error"
				: m.isError === false ? "ok" : "unknown";
			out.tools.push({
				entryId: id,
				callId,
				name,
				args: call?.args ?? {},
				output: textOf(m.content).slice(0, 4000),
				isError: status === "error" || status === "cancelled",
				status,
			});
			for (const nested of m.nestedCalls?.calls ?? []) {
				const status = m.nestedCalls?.complete === true ? nested.status : "unknown";
				out.tools.push({ entryId: id, callId: nested.id, name: nested.name,
					args: nested.arguments ?? {}, output: nested.error ?? "", isError: status === "error", status });
			}
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
	/\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b|改为|改成|计划变更|换个任务|先别实现/i;
const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|y|n|k)\s*[.!?]*$/i;
const NON_GOAL_RE =
	/^\s*[\[│├└─╭╰]|```|^\s*(function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\n/;
const LEADING_CHARS = 200;

const stripBullet = (line: string) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

function goalLines(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const t = stripBullet(raw.trim());
		if (t.length < 3) continue;
		if (NOISE_SHORT_RE.test(t)) continue;
		if (NON_GOAL_RE.test(t)) continue;
		out.push(t);
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
 *
 * Tightened against pi-vcc's original rule, which also accepted "any user
 * block containing a task verb": measured on 5 ordinary follow-up task
 * messages ("Fix these issues and add a test", "Update the config table", …),
 * 4 of 5 matched — i.e. nearly every turn fabricated a `[Scope change]` entry
 * and the Goal section filled with non-goals. A scope change now requires
 * explicit pivot language; the agent's review pass covers the rest.
 */
export function extractGoal(users: UserBlock[], board: Board, state: SbbState): string[] {
	const out: string[] = [];
	const needInitial = !state.goalExtracted && board.sections.goal.length === 0;
	if (needInitial && users[0]) out.push(...goalLines(users[0].text));

	const scopeStartIdx = needInitial ? 1 : 0;
	for (let i = scopeStartIdx; i < users.length; i++) {
		const b = users[i];
		const leading = b.text.slice(0, LEADING_CHARS);
		if (SCOPE_CHANGE_RE.test(leading)) {
			const lines = goalLines(b.text);
			if (lines.length > 0) {
				out.push("[Scope change]", ...lines);
			}
		}
	}
	return out;
}

const PREF_PATTERNS = [
	/(?:禁止|不要|不得|不能|务必|必须|始终|仅限|只允许|优先使用|请使用|请避免|偏好)/,
	/用中文(?:回答|回复)|(?:费用|预算).*(?:不超过|上限|最多)/,
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
			if (t.length < 3) continue;
			if (t.endsWith("?") || t.endsWith("？") || t.includes("?...")) continue;
			if (!PREF_PATTERNS.some((p) => p.test(t))) continue;
			const c = t;
			if (seen.has(c.toLowerCase())) continue;
			seen.add(c.toLowerCase());
			out.push(c);
		}
	}
	return out;
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

export function toolOutcome(t: ToolBlock): NonNullable<ToolBlock["status"]> {
	if (t.status && t.status !== "ok") return t.status;
	return t.isError ? "error" : t.status ?? (t.isError === false ? "ok" : "unknown");
}

export function extractFiles(tools: ToolBlock[]): { lines: string[]; paths: Set<string> } {
	const lines: string[] = [];
	const paths = new Set<string>();
	for (const t of tools) {
		if (!FILE_TOOLS.has(t.name) || toolOutcome(t) !== "ok") continue;
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
		if (t.name !== "bash" || toolOutcome(t) !== "ok") continue;
		const cmd = typeof t.args.command === "string" ? (t.args.command as string) : "";
		if (!/\bgit\s+commit\b/.test(cmd)) continue;
		const m = t.output.match(/\[[^\]\n]*\]\s+([0-9a-f]{7,40})\b/) ?? t.output.match(/\b([0-9a-f]{40})\b/);
		if (!m) continue;
		const hash = m[1].slice(0, 10);
		const subject = t.output.split(m[1]).slice(1).join(" ").trim().split("\n")[0] ?? "";
		out.push(`COMMIT ${hash} ${subject}`.trim());
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
		const outcome = toolOutcome(t);
		if (outcome === "cancelled" || outcome === "unfinished" || outcome === "unknown") {
			const target = t.args.path ?? t.args.file_path ?? t.args.command ?? t.callId;
			out.push(`[${outcome.toUpperCase()}] ${t.name} ${String(target)}`);
			continue;
		}
		let failed = outcome === "error";
		if (!failed) {
			const em = t.output.match(/exit(?:ed)? with (?:code|status) (\d+)/i);
			failed = !!em && em[1] !== "0";
		}
		if (!failed) continue;
		const line = pickErrorLine(t.output);
		const cmd = (typeof t.args.command === "string" ? (t.args.command as string) : "").replace(/\s+/g, " ").slice(0, 80);
		if (line) out.push(`[ERROR] ${cmd}: ${line}`.trim());
	}
	return out;
}

/**
 * Experiment-like bash commands: tests, typechecks, probes, benchmarks.
 * Listed in the checkpoint so the agent is reminded to file their key
 * findings under Findings (the commands themselves are noise — the results
 * are the fact).
 */
const EXPERIMENT_RE =
	/\b(npm|pnpm|yarn|bun)\s+(test|run\s+(?:test|tsc|smoke|bench))\b|\b(cargo|go|make|vitest|jest|pytest)\s+test\b|\bnode\s+[^|;&\n]*(?:test|probe|smoke|bench)[\w.-]*\b|\btsc\b(-p\s+\S+)?/i;

export function extractExperiments(tools: ToolBlock[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const t of tools) {
		if (t.name !== "bash" && t.name !== "run") continue;
		const cmd = typeof t.args.command === "string" ? t.args.command : "";
		if (!cmd || !EXPERIMENT_RE.test(cmd)) continue;
		const c = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
		if (seen.has(c)) continue;
		seen.add(c);
		out.push(`RAN ${c}${t.isError ? " (failed)" : ""}`);
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
			const c = line;
			const key = c.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
	}
	return out;
}

/**
 * Key findings from assistant prose: non-obvious results of exploration or
 * experiments — measured behaviors, root causes, surprises. Markers are
 * deliberately conservative; the agent culls at review time.
 */
const FINDING_RE =
	/(实测|真相|根因|出乎意料|非显然|turns? out|it turns out|it became clear|actually|surprising\w*|unexpected\w*|root cause|measured|contrary to)/i;

export function extractFindings(assistants: AssistantBlock[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const b of assistants) {
		for (const raw of b.text.split("\n")) {
			const line = stripBullet(raw);
			if (line.length < 15) continue;
			if (!FINDING_RE.test(line)) continue;
			const c = line;
			const key = c.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
	}
	return out;
}

const NEXT_RE = /\b(next (?:step|I|we|action|move)|TODO:|after (?:this|that),? (?:we|I)|remaining (?:work|steps))\b/i;

export function extractNext(assistants: AssistantBlock[], users: UserBlock[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (raw: string) => {
		const line = stripBullet(raw);
		if (line.length < 15) return;
		if (!NEXT_RE.test(line)) return;
		const c = line;
		const key = c.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(c);
	};
	for (const b of assistants) for (const raw of b.text.split("\n")) push(raw);
	for (const b of users) for (const raw of b.text.split("\n")) push(raw);
	return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ExtractResult = {
	draft: DraftSections;
	modifiedPaths: string[];
	/** experiment-like commands run in this window (reminder fodder). */
	experiments: string[];
};

/**
 * Run all extractors over the NEW blocks of this turn. Pure function, no I/O,
 * no LLM. Returns draft lines (pre-commit) plus paths of files modified this
 * turn (only a prompt to revalidate, never proof of resolution).
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
			const k = s === "files" ? l : l.toLowerCase();
			if (globalSeen.has(k)) continue; // a line is filed under ONE section only
			globalSeen.add(k);
			fresh.push(l);
		}
		if (fresh.length > 0) draft[s] = [...(draft[s] ?? []), ...fresh];
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
	// Findings last among content sections: a line that also names a decision,
	// an error or a path stays there — findings catch only the residue.
	put("findings", extractFindings(blocks.assistants));
	put("next", extractNext(blocks.assistants, blocks.users));

	return { draft, modifiedPaths: [...files.paths], experiments: extractExperiments(blocks.tools) };
}

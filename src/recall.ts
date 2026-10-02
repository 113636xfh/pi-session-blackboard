/**
 * Retrieval over the blackboard (pure text functions; fs/wiring lives in index.ts).
 *
 * The board replaces the compaction summary, so it is also the thing a model
 * must be able to search when the summary is not enough: `blackboard_recall`
 * greps the live board, the rotated archive, and the `sbb-snapshot` digests
 * mirrored into the session JSONL.
 *
 * Design notes:
 *  - substring, case-insensitive: the queries are paths, error fragments and
 *    identifiers copied out of the conversation, not natural-language asks;
 *  - the section header is carried into each hit so a line is attributable
 *    without opening the file;
 *  - newest-last output with a hard limit: a recall card, not a dump.
 */

export interface RecallHit {
	/** `board`, `archive/<file>` or `snapshot/<index>[@hh-mm-ss]`. */
	source: string;
	/** Section header the line was filed under ("" outside a section). */
	section: string;
	/** The matching line, trimmed, markers preserved. */
	line: string;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;

/** Digest field → section label, so a hit from a snapshot is still attributable. */
const DIGEST_SECTIONS: Record<string, string> = {
	goal: "Goal",
	findings: "Findings",
	next: "Next",
	recentFiles: "Files",
	decisions: "Decisions",
	issues: "Issues",
	prefs: "Prefs",
};

/** Grep one markdown document, attributing each hit to its `## Section`. */
export function searchDocument(text: string, query: string, limit: number, source: string): RecallHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: RecallHit[] = [];
	let section = "";
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const h = SECTION_RE.exec(line.trim());
		if (h) {
			section = h[1];
			continue;
		}
		if (!line.trim() || line.startsWith("<!--")) continue;
		if (!line.toLowerCase().includes(q)) continue;
		hits.push({ source, section, line: line.trim() });
		if (hits.length >= limit) break;
	}
	return hits;
}

/**
 * Search one mirrored `sbb-snapshot` digest.
 *
 * A digest is a single JSON blob, so grepping it as text returns the WHOLE blob
 * as one hit — hundreds of characters of counts and unrelated sections, which
 * is exactly what a recall card must not be. Instead, walk the digest fields and
 * emit one hit per matching board line, attributed to the section it came from.
 * Scalars (session id) are searchable too; numbers and `counts` objects are not
 * (matching a count is noise, not a fact).
 */
export function searchDigest(data: Record<string, unknown>, query: string, limit: number, source: string): RecallHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: RecallHit[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (hits.length >= limit) break;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item !== "string" || !item.toLowerCase().includes(q)) continue;
				hits.push({ source, section: DIGEST_SECTIONS[key] ?? key, line: item.trim() });
				if (hits.length >= limit) break;
			}
			continue;
		}
		if (typeof value === "string" && key !== "at" && value.toLowerCase().includes(q)) {
			hits.push({ source, section: key, line: value });
		}
	}
	return hits;
}

/** Render hits as a compact card the model can read in one screen. */
export function formatRecall(hits: RecallHit[], query: string): string {
	if (hits.length === 0) return `blackboard recall: no entry matches "${query}".`;
	const out: string[] = [`blackboard recall — ${hits.length} match(es) for "${query}" (newest last):`];
	for (const h of hits) {
		const where = h.section ? `${h.source} · ${h.section}` : h.source;
		out.push(`- [${where}] ${h.line}`);
	}
	return out.join("\n");
}

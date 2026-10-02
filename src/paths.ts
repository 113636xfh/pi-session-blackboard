import { join } from "node:path";

/** Sanitize a session id for use in file names. */
export function safeSid(sessionId: string): string {
	const s = sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return s || "unknown";
}

export function boardPath(boardDir: string, sessionId: string): string {
	return join(boardDir, `${safeSid(sessionId)}.md`);
}

export function archiveDir(boardDir: string, sessionId: string): string {
	return join(boardDir, "archive", safeSid(sessionId));
}

export function statePath(boardDir: string, sessionId: string): string {
	return join(boardDir, "state", `${safeSid(sessionId)}.json`);
}

export function debugPath(boardDir: string, sessionId: string): string {
	return join(boardDir, "debug", `${safeSid(sessionId)}.ndjson`);
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SbbState } from "./types.js";
import { statePath } from "./paths.js";

export function defaultState(): SbbState {
	return {
		version: 1,
		turnsSinceCheckpoint: 0,
		checkpointCount: 0,
		boardVersion: 0,
		goalExtracted: false,
		pendingDraft: null,
		pendingCheckpoint: false,
		draftInjectCount: 0,
	};
}

export function loadState(boardDir: string, sessionId: string): SbbState {
	const p = statePath(boardDir, sessionId);
	try {
		if (!existsSync(p)) return defaultState();
		const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
		const st = { ...defaultState(), ...(raw && typeof raw === "object" ? (raw as object) : {}) } as SbbState;
		st.version = 1;
		st.turnsSinceCheckpoint = Number.isFinite(st.turnsSinceCheckpoint) ? st.turnsSinceCheckpoint : 0;
		st.checkpointCount = Number.isFinite(st.checkpointCount) ? st.checkpointCount : 0;
		st.boardVersion = Number.isFinite(st.boardVersion) ? st.boardVersion : 0;
		st.draftInjectCount = Number.isFinite(st.draftInjectCount) ? st.draftInjectCount : 0;
		st.pendingDraft = st.pendingDraft && typeof st.pendingDraft === "object" ? st.pendingDraft : null;
		if (st.pendingDraft && (!st.pendingDraft.sections || typeof st.pendingDraft.sections !== "object")) {
			st.pendingDraft = null;
		}
		return st;
	} catch {
		return defaultState();
	}
}

/** Atomic write (tmp + rename). Never throws — a failed state save must not break the agent. */
export function saveState(boardDir: string, sessionId: string, st: SbbState): void {
	try {
		const p = statePath(boardDir, sessionId);
		mkdirSync(dirname(p), { recursive: true });
		const tmp = `${p}.tmp`;
		writeFileSync(tmp, JSON.stringify(st, null, 2), "utf-8");
		renameSync(tmp, p);
	} catch {
		/* non-fatal */
	}
}

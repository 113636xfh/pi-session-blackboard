/** Minimal board with every section present, mirroring src/types.ts. */
export function emptyBoard() {
	const mk = () => [];
	return {
		header: {},
		sections: { goal: mk(), decisions: mk(), findings: mk(), files: mk(), issues: mk(), next: mk(), prefs: mk(), archived: mk() },
		raw: { goal: [], decisions: [], findings: [], files: [], issues: [], next: [], prefs: [], archived: [] },
		extra: [],
	};
}

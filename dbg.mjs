import { replayBranch, emptyProjection } from './build/journal.js';
import { planImport } from './build/summary-import.js';
const p = emptyProjection();
const planned = planImport(p, 'foreign-1', '## Goal\n- x\n## Next Steps\n- y\n', 'import-foreign-1');
console.log(planned.imported, planned.total, planned.incomplete, planned.event?.changes?.length);

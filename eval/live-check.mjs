/** Legacy live-check retired: it had no hard supervisor and contained an unconditional PASS. */
console.error('This unbounded live entry point is retired. Use eval/nightly.mjs (offline by default); live requires --live --model and explicit budgets. Automatic-compaction release checks remain unverified by the manual smoke.');
process.exitCode = 1;

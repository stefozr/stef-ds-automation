// Sixteenth harness (Milestone 9, WP-C): Persistent upkeep of ability uses. A wrapper of harness11's runner with
// only tests/m9/persistent.mjs (docs/M9-DESIGN.md §C; P1-P12): the M8 world, its mocks and its manual clock.
// `node harness16.mjs` = `node harness11.mjs persistent`.
process.argv.splice(2, process.argv.length - 2, "persistent");
await import(new URL("./harness11.mjs", import.meta.url).href);

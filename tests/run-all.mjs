#!/usr/bin/env node
// Every offline test of the suite, in order (`npm test`); stops at the first failure and prints a summary.
//   node tests/run-all.mjs [--list] [--keep-going]
// Nothing here needs the Draw Steel system packs; the library's index / validate / build run locally
// (npm run library:index, library:validate, library:build).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** [name, folder relative to the module, script] */
const STEPS = [
  ["check", "tests", "check.cjs"],
  ["i18n-audit", "tests", "i18n-audit.cjs"],
  ["harness", "tests", "harness.mjs"],
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map(n => [`harness${n}`, "tests", `harness${n}.mjs`]),
  ["medkit:check", "tests/medkit", "check.cjs"],
  ["medkit:harness", "tests/medkit", "harness.mjs"],
  ["library:dist-check", "tools", "dist-check.mjs"],
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const [name, folder, script] of STEPS) console.log(`${name.padEnd(20)} ${path.join(folder, script)}`);
  process.exit(0);
}
const keepGoing = args.includes("--keep-going");
const results = [];
for (const [name, folder, script] of STEPS) {
  console.log(`\n=== ${name}`);
  const start = Date.now();
  const r = spawnSync(process.execPath, [script], { cwd: path.join(ROOT, folder), stdio: "inherit" });
  results.push({ name, ok: r.status === 0, ms: Date.now() - start });
  if (r.status !== 0 && !keepGoing) break;
}
console.log("\nSummary");
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(20)} ${(r.ms / 1000).toFixed(1)} s`);
const failed = results.filter(r => !r.ok).length;
if (results.length < STEPS.length && failed) console.log(`stopped after the first failure (${STEPS.length - results.length} not run)`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Validate every overlay in src/overlays against the suite's schema (scripts/library/schema.mjs) and the system index.
 *   node tools/validate.mjs        (run tools/index-system.mjs once before)
 * Checks: JSON, schema (types, fields, formulas, tiers, choices), the key exists in the system and the
 * name is the ability's, referenced power roll effects / ability effects / compendium effects exist,
 * file name = dsid, no duplicates, no tier conditions on abilities without a power roll, and the
 * licensing lint (notes, labels and reminders share no 6 consecutive words with the ability's text).
 * Milestone 5: triggers only on triggered actions (unless `free`), trigger subject vs the ability's
 * target (warning), trigger / tracker texts linted, monster overlays linted against their monster's ability.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, checkAll, loadIndex } from "./lib/content.mjs";

const { overlays, errors, warnings } = checkAll(loadIndex());
// The manifest's files must exist (Foundry rejects the whole module otherwise).
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
for (const p of [...(manifest.esmodules ?? []), ...(manifest.styles ?? []), ...(manifest.languages ?? []).map(l => l.path)]) {
  if (!fs.existsSync(path.join(ROOT, p))) errors.push(`module.json: ${p} does not exist`);
}
for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${overlays.length} overlays, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);

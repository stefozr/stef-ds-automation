#!/usr/bin/env node
/**
 * Review aid: each overlay of a group next to the ability's labeled text.
 *   node tools/review.mjs <group folder under src/overlays> [dsid ...]
 */
import fs from "node:fs";
import path from "node:path";
import { SRC, loadIndex } from "./lib/content.mjs";

const [group, ...only] = process.argv.slice(2);
const { abilities, features = {} } = loadIndex();
const dir = path.join(SRC, group ?? "");
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
  const dsid = file.replace(/\.json$/, "");
  if (only.length && !only.includes(dsid)) continue;
  const o = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const a = abilities[o.key];
  // Milestone 7: a class feature's overlay (gains) next to the feature's text.
  const f = features[o.key];
  if (f) console.log(`=== ${o.key} (feature)\n  ${f.text}`);
  else console.log(`=== ${o.key} (${a?.type}${a?.powerRoll ? ", power roll" : ""}) pres: ${Object.entries(a?.pres ?? {}).map(([id, p]) => `${id}:${p.type}`).join(" ") || "-"}`);
  for (const sg of a?.segments ?? []) if (sg.kind !== "story") console.log(`  [${sg.kind}] ${sg.text}`);
  const { key, version, name, ...rest } = o;
  console.log(`  >> ${JSON.stringify(rest)}\n`);
}

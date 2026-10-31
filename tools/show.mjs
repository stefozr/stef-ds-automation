#!/usr/bin/env node
/**
 * Show what the system index knows about abilities (authoring aid).
 *   node tools/show.mjs <dsid> [<dsid> ...]
 *   node tools/show.mjs --folder "Censor" [--enrichers]   (every ability under a folder path prefix)
 */
import { loadIndex } from "./lib/content.mjs";

const args = process.argv.slice(2);
const { abilities, features = {} } = loadIndex();
let keys;
const fi = args.indexOf("--folder");
if (fi >= 0) {
  const prefix = args[fi + 1];
  keys = Object.keys(abilities).filter(k => abilities[k].folder.startsWith(prefix));
  if (args.includes("--enrichers")) keys = keys.filter(k => /\[\[\//.test(abilities[k].text));
} else keys = args.map(a => (/^(ability|feature):/.test(a) ? a : `ability:${a}`));
for (const key of keys.sort()) {
  // Milestone 7: class features (`feature:<dsid>`, gain overlays).
  if (key.startsWith("feature:")) {
    const f = features[key];
    console.log(f ? `${key}  "${f.name}"  [${f.folder}]  ${f.uuid}\n  ${f.text}\n` : `${key}: not in the index`);
    continue;
  }
  const a = abilities[key];
  if (!a) {
    console.log(`${key}: not in the index`);
    continue;
  }
  console.log(`${key}  "${a.name}"  [${a.folder}]  ${a.type}${a.resource ? ` cost ${a.resource}` : ""}  powerRoll: ${a.powerRoll}  keywords: ${a.keywords.join(", ")}`);
  const d = a.distance ?? {};
  if (a.target || d.type) console.log(`  target: ${a.target ?? "-"}  distance: ${d.type ?? "-"}${d.primary ? ` ${d.primary}` : ""}${d.secondary ? ` / ${d.secondary}` : ""}${d.tertiary ? ` / ${d.tertiary}` : ""}`);
  console.log(`  power roll effects: ${Object.entries(a.pres).map(([id, p]) => `${id} ${p.type}${p.name ? ` "${p.name}"` : ""}`).join("; ") || "-"}`);
  console.log(`  special effects: ${Object.entries(a.special).filter(([, s]) => s.type !== "base").map(([id, s]) => `${id} ${s.type}${s.name ? ` "${s.name}"` : ""}`).join("; ") || "-"}`);
  console.log(`  own effects: ${Object.entries(a.effects).map(([id, e]) => `${id} "${e.name}"${e.statuses?.length ? ` (${e.statuses.join(",")})` : ""}`).join("; ") || "-"}`);
  for (const sg of a.segments ?? []) console.log(`  [${sg.kind}] ${sg.text}`);
  console.log("");
}

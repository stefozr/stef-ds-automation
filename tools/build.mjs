#!/usr/bin/env node
/**
 * Build the library: validate, then write
 *   dist/overlays.mjs   `export default [...]`, sorted by key (what scripts/main.mjs registers); its first line carries
 *                       the module version and a SHA-256 of src/overlays (Milestone 8, D34), which tools/dist-check.mjs
 *                       recomputes without system data (CI)
 *   dist/coverage.md    per class / folder of the system's abilities: overlay, native only, manual; the
 *                       number of overlays with triggers, trackers and (Milestone 6) summons; Milestone 7: zones,
 *                       a "Gains" section (class features with event gains), a "Monsters" section (monster overlays
 *                       and the monster abilities the NPC guard leaves manual) and "Monsters in your adventures"
 *   node tools/build.mjs [--index]   (--index refreshes the system index first)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, checkAll, loadIndex } from "./lib/content.mjs";
import { checkDist, headerLine, srcHash } from "./dist-check.mjs";

/** The suite's fallback slug of a name (library/identity.mjs). */
const slug = name => String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

if (process.argv.includes("--index")) execFileSync(process.execPath, [path.join(ROOT, "tools", "index-system.mjs")], { stdio: "inherit" });
const index = loadIndex();
const { overlays, errors, warnings, genericOnly } = checkAll(index);
for (const w of warnings) console.log(`warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`build failed: ${errors.length} error(s)`);
  process.exit(1);
}

const clean = overlays.map(({ __file, ...o }) => o).sort((a, b) => a.key.localeCompare(b.key));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8")).version;
const header = `${headerLine({ version, system: index.system, hash: srcHash(ROOT).hash })}\n`;
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "dist", "overlays.mjs"), `${header}export default ${JSON.stringify(clean, null, 1)};\n`);
{
  const fresh = checkDist(ROOT);
  if (!fresh.ok) {
    for (const p of fresh.problems) console.log(`ERROR ${p}`);
    console.log("build failed: dist/overlays.mjs does not pass tools/dist-check.mjs");
    process.exit(1);
  }
}

// Coverage per top folder (class, Basic Abilities, Kits, ...).
const byKey = new Map(clean.map(o => [o.key, o]));
const groups = new Map();
for (const [key, a] of Object.entries(index.abilities)) {
  const group = a.folder.split("/")[0] || "(none)";
  const g = groups.get(group) ?? { total: 0, overlay: 0, native: 0, manual: 0, keys: [] };
  g.total++;
  const native = Object.values(a.pres).some(p => ["damage", "applied", "forced"].includes(p.type));
  if (byKey.has(key)) {
    g.overlay++;
    g.keys.push(`${a.name}${native ? "" : " *"}`);
  } else if (native) g.native++;
  else g.manual++;
  groups.set(group, g);
}
// Milestone 5: triggered actions and trackers (monster overlays included).
const withTriggers = clean.filter(o => o.triggers?.length).length;
const withTrackers = clean.filter(o => o.trackers?.length).length;
// Milestone 6: summon effects (monster reinforcements included).
const withSummons = clean.filter(o => (o.effects ?? []).some(e => e.type === "summon")).length;
// Milestone 7: lasting areas and class features with event gains.
const withZones = clean.filter(o => (o.effects ?? []).some(e => e.type === "zone")).length;
const withGains = clean.filter(o => (o.gains ?? []).length).length;
const reactions = `${withTriggers} overlays with triggers, ${withTrackers} with trackers, ${withSummons} with summons, ${withZones} with areas, ${withGains} with resource gains`;
const lines = [
  `# stef-ds-automation ${version}: coverage of Draw Steel ${index.system}`, "",
  `${clean.length} overlays (${clean.filter(o => o.monster).length} monster-specific); ${reactions}.`,
  `"overlay" = the library adds automation (\\* = the system describes nothing structured for it);`,
  `"native" = only the system's own power roll effects; "manual" = nothing automated.`, "",
  "| Group | Abilities | Overlay | Native only | Manual |", "|---|---|---|---|---|",
];
for (const [group, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`| ${group} | ${g.total} | ${g.overlay} | ${g.native} | ${g.manual} |`);
lines.push("");
for (const [group, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!g.keys.length) continue;
  lines.push(`## ${group}`, "", g.keys.sort().join(", "), "");
}

// Milestone 7: class features with event gains (one line per rule).
const gainOverlays = clean.filter(o => (o.gains ?? []).length).sort((a, b) => a.name.localeCompare(b.name));
if (gainOverlays.length) {
  lines.push("## Gains", "", `${gainOverlays.length} class features gain their heroic resource from events.`, "", "| Feature | Rule | Event | Once | Amount |", "|---|---|---|---|---|");
  for (const o of gainOverlays) {
    for (const g of o.gains) {
      const upgrades = (g.amountBy ?? []).map(a => `${index.features?.[`feature:${a.feature}`]?.name ?? a.feature} ${a.amount}`).join(", ");
      lines.push(`| ${o.name}${o.class ? ` (${o.class} only)` : ""} | ${g.label}${g.confirm ? " (Director confirms)" : ""} | ${g.event} | ${g.once ?? "round"} | ${g.amount ?? 1}${upgrades ? `; ${upgrades}` : ""} |`);
    }
  }
  lines.push("");
}

const featureOverlays = clean.filter(o => o.automation?.rules?.length);
lines.push("## Generic feature rules", "", `${featureOverlays.length} overlays use version 1 feature rules.`, "", "| Feature or ability | Event | Recipients | Effects |", "|---|---|---|---|");
for (const o of featureOverlays) for (const r of o.automation.rules) lines.push(`| ${o.name} | ${r.event} | ${r.targets} | ${r.effects.map(e => e.type === "modifier" ? e.key.replace(/^benefit:/, "") : e.type).join(", ") || r.special} |`);
lines.push("");

// Milestone 7: monster overlays per monster, and the monster abilities the NPC guard leaves manual.
const actorName = m => index.monsterActors?.[m]?.name ?? null;
const monsterOverlays = clean.filter(o => o.monster).sort((a, b) => a.key.localeCompare(b.key));
lines.push("## Monsters", "", `${monsterOverlays.length} monster overlays (a monster ability gets only these: generic overlays stay off NPCs unless they say \`npc: true\`).`, "",
  "| Ability | Monsters | Automates |", "|---|---|---|");
for (const o of monsterOverlays) {
  // Names of the listed uuids; a slug only when no listed uuid has that name (it names another monster).
  const named = o.monster.map(actorName).filter(Boolean);
  const slugsNamed = new Set(named.map(slug));
  const names = [...new Set([...named, ...o.monster.filter(m => !m.startsWith("Compendium.") && !slugsNamed.has(m))])].join(", ");
  const what = [...new Set([...(o.effects ?? []).map(e => e.type), ...((o.triggers ?? []).length ? ["triggers"] : []), ...((o.trackers ?? []).length ? ["trackers"] : []), ...((o.automation?.rules ?? []).length ? ["feature rules"] : [])])].join(", ");
  lines.push(`| ${o.name} (\`${o.key}\`) | ${names} | ${what} |`);
}
lines.push("");
if (genericOnly.length) {
  lines.push("### Monster abilities with a generic overlay key and no monster overlay", "",
    "The NPC guard leaves them unautomated (the hero overlay of the same key does something else).", "");
  for (const g of genericOnly) lines.push(`- ${g.monster}: ${g.ability} (\`${g.key}\`)`);
  lines.push("");
}

// Milestone 7: the monsters of the adventure packs (Delian Tomb, Road to Broadhurst) and their monster overlays.
const adventures = new Map();
for (const a of index.adventureActors ?? []) adventures.set(a.adventure, [...(adventures.get(a.adventure) ?? []), a]);
if (adventures.size) {
  lines.push("## Monsters in your adventures", "", "Monster overlays that match each adventure actor (by its compendium source, else its name).", "");
  for (const [adventure, actors] of [...adventures.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const seen = new Set();
    const rows = [];
    for (const a of actors) {
      const keys = [a.compendiumSource, slug(a.name.replace(/\s\(\d+\)$/, ""))].filter(Boolean);
      const id = keys[0];
      if (seen.has(id)) continue;
      seen.add(id);
      const matched = monsterOverlays.filter(o => o.monster.some(m => keys.includes(m))).map(o => o.name);
      rows.push(`${a.name}${matched.length ? ` (${matched.join(", ")})` : ""}`);
    }
    lines.push(`- **${adventure}**: ${rows.sort().join(", ")}`);
  }
  lines.push("");
}
fs.writeFileSync(path.join(ROOT, "dist", "coverage.md"), lines.join("\n"));
console.log(`built ${clean.length} overlays, ${reactions} (${warnings.length} warning(s)) -> dist/overlays.mjs, dist/coverage.md`);

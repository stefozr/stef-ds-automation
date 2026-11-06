#!/usr/bin/env node
/**
 * Index the Draw Steel system's packs for validation: `.cache/system-index.json` (not shipped).
 *   node tools/index-system.mjs [--system <path to systems/draw-steel>] [--extra-monster-packs a,b]
 *                               [--adventure-packs a,b] [--copy-dir <dir>]
 * For every ability: uuid, name, folder path, its power roll effects (id, type, name), special effects,
 * its own ActiveEffects (id, name), target type and distance, and its plain text (only for the licensing
 * lint, never shipped). Also the uuids of the system's `effects` pack, and the ability items of the
 * monsters pack (name and text only) keyed `${dsid}@${monster compendium uuid}` and `${dsid}@${name slug}`,
 * so monster overlays get the licensing lint too.
 * Milestone 6: monster abilities also carry their target type and distance, and the monsters pack's actors
 * are indexed as `monsterActors[<compendium uuid>] = {name, organization, size, width, height}` (summon
 * `actors` are checked against it).
 * Milestone 7 (docs/M7-DESIGN.md §3.12):
 *   - abilities without `_dsid` are keyed by the core's slug of their name (library/identity.mjs), as the runtime
 *     keys them (Dame Cornelia's "Parry!" is `parry`);
 *   - class features (`classes` pack, type feature) -> `features["feature:<dsid>"] = {uuid, name, text}` (gain
 *     overlays are checked against them);
 *   - extra monster packs (default: the Delian Tomb's `monsters` when the module folder exists; `--extra-monster-packs`
 *     overrides, paths relative to the Data folder or absolute) are indexed like the system's, with
 *     `Compendium.<module>.<pack>.Actor.<id>` uuids; `monsterActors` gain `keywords` and `pack`;
 *   - the Delian Tomb `malice` items -> `monsterAbilities["<dsid>@*"]` (generic NPC abilities, lint only);
 *   - adventure packs (default: the Delian Tomb's and Road to Broadhurst's `adventures`; `--adventure-packs`
 *     overrides) -> `adventureActors: [{adventure, name, compendiumSource}]` (coverage report only);
 *   - monster abilities keep their power roll effects, keywords and ActiveEffect ids (readPack attaches item
 *     effects to the item now), and every stored distance is `{type, primary, secondary, tertiary}`.
 * Packs are copied (without LOCK) into `--copy-dir` (default `.cache`) before they are read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPack } from "./lib/packs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(ROOT, ".cache");
const DATA = path.resolve(ROOT, "..", "..");
const arg = name => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SYSTEM = arg("--system") ?? path.join(DATA, "systems", "draw-steel");
const COPY_DIR = arg("--copy-dir") ?? CACHE;
const DT_DIR = path.join(DATA, "modules", "draw-steel-delian-tomb");
const RB_DIR = path.join(DATA, "modules", "draw-steel-road-to-broadhurst");
const listArg = (name, defaults) => {
  const v = arg(name);
  const list = v != null ? v.split(",").map(s => s.trim()).filter(Boolean).map(p => (path.isAbsolute(p) ? p : path.join(DATA, p))) : defaults;
  return list.filter(p => fs.existsSync(p));
};
const EXTRA_MONSTER_PACKS = listArg("--extra-monster-packs", [path.join(DT_DIR, "packs", "monsters")]);
const MALICE_PACKS = [path.join(DT_DIR, "packs", "malice")].filter(p => fs.existsSync(p));
const ADVENTURE_PACKS = listArg("--adventure-packs", [path.join(DT_DIR, "packs", "adventures"), path.join(RB_DIR, "packs", "adventures")]);

const strip = s => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
/** The suite's fallback slug of a name (library/identity.mjs): lowercase words joined by dashes. */
const slug = name => String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** The dsid the runtime uses: `system._dsid`, else the slug of the name (identity.mjs itemDsid). */
const dsidOf = d => d?.system?._dsid || (d?.name ? slug(d.name) : null);
/** The full distance of an ability (the zone range lint reads secondary / tertiary). */
const distanceOf = sys => ({
  type: sys?.distance?.type ?? null, primary: sys?.distance?.primary ?? null,
  secondary: sys?.distance?.secondary ?? null, tertiary: sys?.distance?.tertiary ?? null,
});
/** `Compendium.<package>.<pack>` of a pack folder (`.../modules/<id>/packs/<pack>` or `.../systems/<id>/packs/<pack>`). */
const packPrefix = dir => `Compendium.${path.basename(path.dirname(path.dirname(dir)))}.${path.basename(dir)}`;

/** Labeled text: which part of the ability says what (tier lines depend on the tier, the rest not). */
function abilityText(sys) {
  const segments = [];
  const add = (kind, text) => { const t = strip(text); if (t) segments.push({ kind, text: t }); };
  add("story", sys.story);
  add("trigger", sys.trigger);
  for (const e of Object.values(sys.effects ?? {})) {
    const kind = e.type === "base" ? (e.before ? "effect (before the roll)" : "effect") : e.type;
    add(e.name ? `${kind} "${e.name}"` : kind, e.description?.value ?? e.description);
  }
  for (const p of Object.values(sys.power?.effects ?? {})) {
    for (const n of [1, 2, 3]) add(`tier ${n} (${p.type}${p.name ? ` "${p.name}"` : ""})`, p[p.type]?.[`tier${n}`]?.display);
  }
  return { text: segments.map(sg => sg.text).join(" | "), segments };
}

/** Index entry of a monster ability (text only for the lint; ids for the schema's checks). */
function monsterAbilityEntry(item, monsterName) {
  const sys = item.system ?? {};
  return {
    name: item.name, monster: monsterName, type: sys.type ?? null, category: sys.category ?? null,
    // Milestone 6: the summon lint ("origin target?") reads them for monster overlays.
    target: sys.target?.type ?? null,
    distance: distanceOf(sys),
    keywords: sys.keywords ?? [],
    pres: Object.fromEntries(Object.values(sys.power?.effects ?? {}).map(p => [p._id, { type: p.type, name: p.name ?? "" }])),
    effects: Object.fromEntries((item.__effects ?? []).map(e => [e._id, { name: e.name, statuses: e.statuses ?? [] }])),
    text: abilityText(sys).text,
  };
}

/** Monster actors and their abilities of one monsters pack (system or module). */
async function indexMonsterPack(dir, monsterActors, monsterAbilities) {
  const prefix = packPrefix(dir);
  let actors = 0;
  for (const d of await readPack(dir, COPY_DIR)) {
    if (!d.system || !d.name || !Array.isArray(d.__items)) continue;
    actors++;
    const uuid = `${prefix}.Actor.${d._id}`;
    const size = d.system.combat?.size;
    monsterActors[uuid] = {
      name: d.name, organization: d.system.monster?.organization ?? "",
      size: size ? `${size.value ?? 1}${size.value > 1 ? "" : (size.letter ?? "")}` : null,
      width: d.prototypeToken?.width ?? 1, height: d.prototypeToken?.height ?? 1,
      keywords: d.system.monster?.keywords ?? [], pack: prefix.slice("Compendium.".length),
    };
    const keys = [uuid, slug(d.name)];
    for (const item of d.__items) {
      if (item.type !== "ability") continue;
      const dsid = dsidOf(item);
      if (!dsid) continue;
      const entry = monsterAbilityEntry(item, d.name);
      for (const k of keys) monsterAbilities[`${dsid}@${k}`] ??= entry;
    }
  }
  return actors;
}

async function main() {
  const system = JSON.parse(fs.readFileSync(path.join(SYSTEM, "system.json"), "utf8"));
  // Abilities live in the abilities pack, and ancestry / perk abilities in origins and character-options.
  const docs = [];
  for (const pack of ["abilities", "origins", "character-options"]) {
    for (const d of await readPack(path.join(SYSTEM, "packs", pack), COPY_DIR)) docs.push({ ...d, __pack: pack });
  }
  const folders = new Map(docs.filter(d => !d.type || d.type === "Item").filter(d => d.sorting !== undefined || d.color !== undefined || !d.system).map(d => [d._id, d]));
  const folderPath = id => {
    const out = [];
    let f = folders.get(id);
    while (f) {
      out.unshift(f.name);
      f = folders.get(f.folder);
    }
    return out.join("/");
  };
  const abilities = {};
  for (const d of docs) {
    if (d.type !== "ability") continue;
    const sys = d.system ?? {};
    const dsid = dsidOf(d);
    if (!dsid) continue;
    const pres = Object.fromEntries(Object.values(sys.power?.effects ?? {}).map(p => [p._id, { type: p.type, name: p.name ?? "" }]));
    const special = Object.fromEntries(Object.values(sys.effects ?? {}).map(e => [e._id, { type: e.type, name: e.name ?? "" }]));
    const effects = Object.fromEntries((d.__effects ?? []).map(e => [e._id, { name: e.name, statuses: e.statuses ?? [] }]));
    const { text, segments } = abilityText(sys);
    const key = `ability:${dsid}`;
    // The abilities pack wins over a same-named ability elsewhere.
    if (abilities[key] && d.__pack !== "abilities" && abilities[key].uuid.includes(".abilities.")) continue;
    if (abilities[key]) abilities[key].duplicates = (abilities[key].duplicates ?? 1) + 1;
    abilities[key] = {
      uuid: `Compendium.draw-steel.${d.__pack}.Item.${d._id}`, name: d.name,
      folder: d.__pack === "abilities" ? folderPath(d.folder) : `(${d.__pack})/${folderPath(d.folder)}`,
      type: sys.type, category: sys.category ?? null, resource: sys.resource ?? null, keywords: sys.keywords ?? [],
      powerRoll: !sys.power?.roll?.reactive && Object.keys(sys.power?.effects ?? {}).length > 0,
      // Milestone 5: trigger subjects are compared with the target type (tools/lib/content.mjs warnings).
      target: sys.target?.type ?? null,
      distance: distanceOf(sys),
      pres, special, effects, text, segments,
      ...(sys._dsid ? {} : { slugged: true }),
    };
  }
  // Milestone 7: class features (gain overlays `feature:<dsid>`).
  const features = {};
  const classDocs = await readPack(path.join(SYSTEM, "packs", "classes"), COPY_DIR);
  const classFolders = new Map(classDocs.filter(d => !d.system).map(d => [d._id, d]));
  // Class folder id -> hero class dsid (the feature folder's parent is the class folder, e.g. Summoner > Features).
  const classByFolder = new Map();
  for (const d of classDocs) if (d.type === "class" && d.folder && d.system?._dsid && !classByFolder.has(d.folder)) classByFolder.set(d.folder, d.system._dsid);
  const classOf = d => classByFolder.get(classFolders.get(d.folder)?.folder) ?? null;
  for (const d of classDocs) {
    if (d.type !== "feature") continue;
    const dsid = dsidOf(d);
    if (!dsid) continue;
    const key = `feature:${dsid}`;
    if (features[key]) {
      features[key].duplicates = (features[key].duplicates ?? 1) + 1;
      const cls = classOf(d);
      if (cls && !features[key].classes.includes(cls)) features[key].classes.push(cls);
      continue;
    }
    features[key] = {
      uuid: `Compendium.draw-steel.classes.Item.${d._id}`, name: d.name,
      folder: classFolders.get(d.folder)?.name ?? "",
      // Hero classes that carry a feature with this dsid (several when the dsid collides between classes).
      classes: [classOf(d)].filter(Boolean),
      text: strip(d.system?.description?.value ?? d.system?.description ?? ""),
    };
  }
  for (const pack of ["abilities", "origins", "character-options", "monster-features"]) {
    const docs = await readPack(path.join(SYSTEM, "packs", pack), COPY_DIR);
    for (const d of docs) {
      if (!d.system || !["feature", "ancestryTrait"].includes(d.type)) continue;
      const dsid = dsidOf(d); if (!dsid) continue;
      features[`${d.type}:${dsid}`] = { uuid: `Compendium.draw-steel.${pack}.Item.${d._id}`, name: d.name,
        folder: pack, text: strip(d.system.description?.value ?? d.system.description ?? "") };
    }
  }
  const effectDocs = await readPack(path.join(SYSTEM, "packs", "effects"), COPY_DIR);
  const effectUuids = effectDocs.filter(d => d._id && d.name && !d.sorting).map(d => `Compendium.draw-steel.effects.ActiveEffect.${d._id}`);
  // Monster abilities, text only: their dsids repeat across monsters, so they are keyed per monster.
  const monsterAbilities = {};
  const monsterActors = {};
  const monsterPacks = [];
  for (const dir of [path.join(SYSTEM, "packs", "monsters"), ...EXTRA_MONSTER_PACKS]) {
    const n = await indexMonsterPack(dir, monsterActors, monsterAbilities);
    monsterPacks.push({ pack: packPrefix(dir).slice("Compendium.".length), actors: n });
  }
  // Milestone 7: the Delian Tomb's malice features (generic NPC abilities: lint only).
  for (const dir of MALICE_PACKS) {
    for (const d of await readPack(dir, COPY_DIR)) {
      if (d.type !== "ability") continue;
      const dsid = dsidOf(d);
      if (dsid) monsterAbilities[`${dsid}@*`] ??= monsterAbilityEntry(d, `(${path.basename(path.dirname(path.dirname(dir)))} malice)`);
    }
  }
  // Milestone 7: actors of the adventures (coverage report "Monsters in your adventures").
  const adventureActors = [];
  for (const dir of ADVENTURE_PACKS) {
    for (const adv of await readPack(dir, COPY_DIR)) {
      for (const a of Array.isArray(adv.actors) ? adv.actors : []) {
        if (a?.type !== "npc") continue;
        adventureActors.push({ adventure: adv.name, name: a.name, compendiumSource: a._stats?.compendiumSource ?? null });
      }
    }
  }
  const index = {
    generated: new Date().toISOString(), system: system.version, abilities, features, effectUuids, monsterAbilities, monsterActors,
    monsterPacks, adventureActors,
  };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, "system-index.json"), JSON.stringify(index));
  console.log(`indexed ${Object.keys(abilities).length} abilities, ${Object.keys(features).length} features, ${effectUuids.length} effects, `
    + `${Object.keys(monsterAbilities).length} monster ability keys and ${Object.keys(monsterActors).length} monster actors `
    + `(${monsterPacks.map(p => `${p.pack} ${p.actors}`).join(", ")}), ${adventureActors.length} adventure actors of draw-steel ${system.version}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

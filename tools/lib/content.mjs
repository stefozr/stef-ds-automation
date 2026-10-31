/**
 * Shared by validate.mjs and build.mjs: load the overlay sources and check them against the core's
 * schema (the same rules the runtime applies when the overlays register) and the system index
 * (abilities, and monster abilities by `${dsid}@${monster key}` for monster overlays).
 * Milestone 6: summon `actors` are checked against the monsters pack's actors (`monsterActors`), with two
 * warnings (a squad for non-minions; `origin: "self"` on an ability that targets a creature).
 * Milestone 7 (docs/M7-DESIGN.md §2.2, §3.12): `feature:` keys are looked up in `index.features` (name check and
 * licensing lint against the feature's text, gain labels included); gain lints (upgrade features, judged / marked
 * effects, the field ability); zone lints (an area to measure, range, keywords, monster keys); monster overlays
 * are checked against their monster's ability effects and power roll effects. The M6 `monsterCollisions` error is
 * gone: the runtime's NPC guard keeps generic overlays off NPCs, so the build lists the monster abilities that
 * share a generic overlay's key and have no monster overlay (a warning, and a coverage section).
 * Milestone 9 (docs/M9-DESIGN.md §C): `persistent` lints (the ability's Persistent special effect, a power roll for a
 * re-roll, `targets: "area"` around the user); its note is licensing-checked; a re-roll or hold counts for rule 4.
 * Milestone 9 (§A): pick / area / modifier warnings (pickAreaLints); a teleport boost's label is licensing-checked.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const SRC = path.join(ROOT, "src", "overlays");
export const CACHE = path.join(ROOT, ".cache");
const CORE_SCHEMA = path.join(ROOT, "scripts", "library", "schema.mjs");

export const schema = await import(pathToFileURL(CORE_SCHEMA).href);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function loadIndex() {
  const p = path.join(CACHE, "system-index.json");
  if (!fs.existsSync(p)) throw new Error("No system index: run `node tools/index-system.mjs` first.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Overlay sources: [{file, overlay, error}] */
export function loadSources() {
  return walk(SRC).sort().map(file => {
    try {
      return { file, overlay: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (err) {
      return { file, overlay: null, error: `invalid JSON: ${err.message}` };
    }
  });
}

const words = text => String(text ?? "").toLowerCase().replace(/\[\[[^\]]*\]\](\{[^}]*\})?/g, " ").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Longest run of consecutive words `ours` shares with `theirs` (licensing lint: no rules text). */
export function sharedRun(ours, theirs) {
  const a = words(ours);
  const b = words(theirs);
  if (!a.length || !b.length) return 0;
  const grams = new Set();
  const N = 6;
  for (let i = 0; i + N <= b.length; i++) grams.add(b.slice(i, i + N).join(" "));
  let best = 0;
  for (let i = 0; i + N <= a.length; i++) if (grams.has(a.slice(i, i + N).join(" "))) best = N;
  return best;
}

/** Ability types that are triggered actions (a trigger on any other type needs `free: true`). */
const TRIGGERED_TYPES = ["triggered", "freeTriggered"];
/**
 * Trigger subject expected for the ability's own target type (damage.* and roll.before triggers only):
 * a turn trigger such as Hesitation is Weakness targets "self" while its subject is another hero.
 */
const SUBJECT_FOR_TARGET = { self: "self", selfOrAlly: "selfOrAlly", ally: "ally" };

/** Ability target types a summon measured from the summoner fits (else: should it be `origin: "target"`?). */
const SUMMON_SELF_TARGETS = ["special", "self"];

/** Warnings of an overlay's summon effects (Milestone 6); `their` = the hero or monster ability of the index. */
function summonWarnings(overlay, their, index) {
  const out = [];
  for (const e of Array.isArray(overlay.effects) ? overlay.effects : []) {
    if (e?.type !== "summon" || !Array.isArray(e.actors)) continue;
    const actors = e.actors.map(a => {
      const uuid = schema.summonActorUuid(a?.uuid);
      const info = uuid ? index.monsterActors?.[uuid] : null;
      return { uuid, info, name: a?.label || info?.name || uuid || String(a?.uuid) };
    });
    const names = actors.map(a => a.name).join(" / ");
    const squad = e.squad ?? schema.SUMMON_DEFAULTS.squad;
    const nonMinions = actors.filter(a => a.info && a.info.organization !== "minion");
    if (squad !== "none" && nonMinions.length) {
      out.push(`effects ${e.id} (${names}): squad "${squad}" has no effect: ${nonMinions.map(a => a.name).join(", ")} ${nonMinions.length > 1 ? "are not minions" : "is not a minion"} (set "squad": "none")`);
    }
    const origin = e.origin ?? schema.SUMMON_DEFAULTS.origin;
    if (their?.target && origin === "self" && !SUMMON_SELF_TARGETS.includes(their.target)) {
      out.push(`effects ${e.id} (${names}): origin target? The ability targets "${their.target}" but the summon is measured from the summoner (origin "self")`);
    }
  }
  return out;
}

/** Our prose in triggers, trackers and (Milestone 7) gains (licensing lint). */
const reactionTexts = overlay => [
  ...(Array.isArray(overlay.triggers) ? overlay.triggers : []).flatMap(t => [t?.label, t?.spend?.label, ...(Array.isArray(t?.steps) ? t.steps : []).map(s => (s?.type === "note" ? s.text : null))]),
  ...(Array.isArray(overlay.trackers) ? overlay.trackers : []).map(k => k?.label),
  ...(Array.isArray(overlay.gains) ? overlay.gains : []).map(g => g?.label),
  // Milestone 9: the Persistent reminder.
  overlay.persistent?.note,
];

/** Area distance types a Persistent re-roll with `targets: "area"` measures from the user (aura, burst). */
const AROUND_TYPES = ["aura", "burst"];

/**
 * Problems of an overlay's `persistent` against the index (Milestone 9, docs/M9-DESIGN.md §C): the ability must have
 * the system's Persistent special effect and, for a re-roll, a power roll; `targets: "area"` warns unless the
 * ability's area is around its user (aura, burst).
 * @returns {{errors: string[], warnings: string[]}}
 */
function persistentLints(overlay, ability) {
  const errors = [];
  const warnings = [];
  const p = overlay.persistent;
  if (!p || typeof p !== "object" || !ability) return { errors, warnings };
  const keep = [p.keep].flat();
  if (!Object.values(ability.special ?? {}).some(s => s?.type === "persistent")) errors.push(`persistent: ${ability.name} has no Persistent special effect`);
  if (keep.includes("reroll") && !ability.powerRoll) errors.push(`persistent: keep "reroll" but ${ability.name} has no power roll`);
  if (p.targets === "area" && !AROUND_TYPES.includes(ability.distance?.type)) {
    warnings.push(`persistent: targets "area" on a ${ability.distance?.type ?? "?"} ability (enemies within its distance of the user are targeted)`);
  }
  return { errors, warnings };
}

/**
 * Milestone 9 (docs/M9-DESIGN.md §A) warnings: `targets: "area"` on an ability without an area (nobody is "in the area"),
 * `pick.of: "target"` on an ability that targets only its user (no target to measure from), a `modifier` without `end`
 * (it stays until undone).
 * @returns {{errors: string[], warnings: string[]}}
 */
function pickAreaLints(overlay, ability) {
  const warnings = [];
  for (const e of Array.isArray(overlay.effects) ? overlay.effects : []) {
    const where = `effects ${e?.id}`;
    const hasArea = !!ability && (AREA_TYPES.includes(ability.distance?.type) || (ability.keywords ?? []).includes("area"));
    if (ability && e?.targets === "area" && !hasArea) warnings.push(`${where}: targets "area" but ${ability.name} places no area`);
    if (ability && e?.pick?.of === "target" && ability.target === "self") warnings.push(`${where}: pick.of "target" but ${ability.name} targets only its user`);
    if (e?.type === "modifier" && e.end == null) warnings.push(`${where}: a modifier without \`end\` stays until it is undone`);
  }
  return { errors: [], warnings };
}

/** The suite's fallback slug of a name (library/identity.mjs). */
const slug = name => String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Problems of an overlay's gains against the index (Milestone 7): errors for keys the system does not have.
 * @returns {{errors: string[], warnings: string[]}}
 */
function gainLints(overlay, index) {
  const errors = [];
  const warnings = [];
  for (const [i, g] of (Array.isArray(overlay.gains) ? overlay.gains : []).entries()) {
    const where = `gains[${i}]${g?.id ? ` (${g.id})` : ""}`;
    for (const [k, a] of (Array.isArray(g?.amountBy) ? g.amountBy : []).entries()) {
      if (a?.feature && !index.features?.[`feature:${a.feature}`]) errors.push(`${where}: amountBy[${k}]: the system has no class feature "${a.feature}"`);
    }
    for (const k of ["takerEffect", "dealerEffect"]) {
      const ref = g?.[k];
      if (!ref?.ability) continue;
      const ability = index.abilities?.[`ability:${ref.ability}`];
      if (!ability) errors.push(`${where}: ${k}: the system has no ability "${ref.ability}"`);
      else if (ref.effect && !Object.hasOwn(ability.effects ?? {}, ref.effect)) errors.push(`${where}: ${k}: ${ability.name} has no effect "${ref.effect}"`);
    }
    if (g?.withinAbility) {
      const ability = index.abilities?.[`ability:${g.withinAbility}`];
      if (!ability) errors.push(`${where}: withinAbility: the system has no ability "${g.withinAbility}"`);
      else if (ability.distance?.type !== "aura") warnings.push(`${where}: withinAbility ${ability.name} is a ${ability.distance?.type ?? "?"}, not an aura (its primary distance is used as the radius)`);
    }
  }
  return { errors, warnings };
}

/** Area distance types a zone can measure (`shape: "ability"`), as the core's zoneArea. */
const AREA_TYPES = ["wall", "cube", "line", "burst", "aura"];
/** The ability distance field that is a zone's range for each shape (wall / cube: secondary; line: tertiary). */
const RANGE_FIELD = { wall: "secondary", cube: "secondary", line: "tertiary" };
const literal = v => (typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : null);

/**
 * Problems of an overlay's zone effects against the index (Milestone 7). `their` = the hero or monster ability.
 * Shape "ability" on an ability without an area distance is an error (every use would fail `noArea`); the rest
 * are warnings.
 * @returns {{errors: string[], warnings: string[]}}
 */
function zoneLints(overlay, their, index) {
  const errors = [];
  const warnings = [];
  const actors = index.monsterActors ?? {};
  const knownSlugs = new Set(Object.values(actors).map(a => slug(a.name)));
  const monsterKeywords = new Set((Array.isArray(overlay.monster) ? overlay.monster : []).flatMap(m => actors[m]?.keywords ?? []));
  for (const e of Array.isArray(overlay.effects) ? overlay.effects : []) {
    if (e?.type !== "zone") continue;
    const where = `effects ${e.id}`;
    const d = their?.distance ?? null;
    const shape = e.shape ?? schema.ZONE_DEFAULTS.shape;
    const realShape = shape === "ability" ? (AREA_TYPES.includes(d?.type) ? d.type : null) : shape;
    if (their && shape === "ability" && !realShape) errors.push(`${where}: shape "ability" but ${their.name} has no area distance (${d?.type ?? "none"}): set \`shape\` and \`size\``);
    const range = literal(e.range);
    const theirRange = realShape && RANGE_FIELD[realShape] ? literal(d?.[RANGE_FIELD[realShape]]) : null;
    if (range !== null && theirRange !== null && range > theirRange) warnings.push(`${where}: range ${range} is larger than ${their.name}'s ${theirRange}`);
    if (Array.isArray(overlay.monster) && monsterKeywords.size) {
      for (const k of Array.isArray(e.exceptKeywords) ? e.exceptKeywords : []) {
        if (!monsterKeywords.has(k)) warnings.push(`${where}: exceptKeywords "${k}": none of the overlay's monsters carries it (its allies may not either)`);
      }
    }
    for (const m of Array.isArray(e.exceptMonsters) ? e.exceptMonsters : []) {
      const known = m.startsWith("Compendium.") ? !!actors[m] : knownSlugs.has(m);
      if (!known) warnings.push(`${where}: exceptMonsters "${m}" is no indexed monster`);
    }
  }
  return { errors, warnings };
}

/**
 * Monster abilities that share the key of a generic overlay and have no monster overlay of that key (Milestone 7):
 * the runtime's NPC guard leaves them unautomated. `index.monsterAbilities` keys by uuid are used (one per monster).
 * @returns {{key: string, file: string, uuid: string, monster: string, ability: string}[]}
 */
export function genericOnlyMonsters(overlays, index) {
  const out = [];
  const monsters = index.monsterAbilities ?? {};
  const actors = index.monsterActors ?? {};
  const byKey = new Map();
  for (const o of overlays) byKey.set(o.key, [...(byKey.get(o.key) ?? []), o]);
  for (const [key, list] of byKey) {
    if (!String(key).startsWith("ability:")) continue;
    const generic = list.find(o => !o.monster);
    if (!generic) continue;
    const dsid = key.slice("ability:".length);
    const covered = new Set(list.filter(o => Array.isArray(o.monster)).flatMap(o => o.monster));
    for (const [k, a] of Object.entries(monsters)) {
      if (!k.startsWith(`${dsid}@Compendium.`)) continue;
      const uuid = k.slice(dsid.length + 1);
      if (covered.has(uuid) || covered.has(slug(actors[uuid]?.name ?? a.monster ?? ""))) continue;
      out.push({ key, file: generic.__file, uuid, monster: a.monster ?? uuid, ability: a.name ?? dsid });
    }
  }
  return out.sort((x, y) => x.key.localeCompare(y.key) || x.monster.localeCompare(y.monster));
}

/**
 * Check every source. Errors fail the build; warnings are printed.
 * @returns {{overlays: object[], errors: string[], warnings: string[]}}
 */
export function checkAll(index) {
  const errors = [];
  const warnings = [];
  const overlays = [];
  const seen = new Map();
  const effectUuids = new Set(index.effectUuids ?? []);
  // Milestone 6: summon actors must be stat blocks of the monsters pack.
  const actorUuids = new Set(Object.keys(index.monsterActors ?? {}));
  for (const { file, overlay, error } of loadSources()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (error) {
      errors.push(`${rel}: ${error}`);
      continue;
    }
    const at = msg => `${rel}: ${msg}`;
    // Milestone 7: a class feature's overlay (gains) is checked against the feature, not an ability.
    const isFeature = !String(overlay.key ?? "").startsWith("ability:");
    const feature = isFeature ? index.features?.[overlay.key] ?? null : null;
    // A monster overlay is checked against the monster's ability, never a hero ability of the same dsid.
    const ability = Array.isArray(overlay.monster) || isFeature ? null : index.abilities?.[overlay.key];
    // Monster overlays: the ability of the first listed monster that has it (text, effects and power roll effects).
    let monsterAbility = null;
    if (Array.isArray(overlay.monster)) {
      const dsid = String(overlay.key ?? "").split(":")[1];
      monsterAbility = overlay.monster.map(m => index.monsterAbilities?.[`${dsid}@${m}`]).find(Boolean) ?? null;
      if (!monsterAbility) errors.push(at(`monster ability not found: ${dsid} on ${overlay.monster.join(" / ")} (its text cannot be checked; re-run tools/index-system.mjs?)`));
    }
    const their = ability ?? monsterAbility;
    const theirText = their?.text ?? feature?.text ?? null;
    const ctx = {
      // Milestone 7: monster abilities keep their effect ids (readPack nesting fix).
      effectIds: their?.effects ? new Set(Object.keys(their.effects)) : undefined,
      preIds: their?.pres ? new Set(Object.keys(their.pres)) : undefined,
      effectUuids,
      actorUuids,
    };
    const { ok, errors: errs } = schema.validateOverlay(overlay, ctx);
    if (!ok) errs.forEach(e => errors.push(at(e)));
    const dsid = String(overlay.key ?? "").split(":")[1];
    if (path.basename(file, ".json") !== dsid) errors.push(at(`file name must be "${dsid}.json"`));
    if (isFeature && !feature) errors.push(at(`the system has no class feature ${overlay.key}`));
    if (!overlay.monster && !isFeature && !ability) errors.push(at(`the system has no ability ${overlay.key}`));
    const named = ability ?? feature;
    if (named && overlay.name?.trim().toLowerCase() !== named.name.trim().toLowerCase()) {
      errors.push(at(`name "${overlay.name}" is not the ${feature ? "feature" : "ability"}'s name "${named.name}"`));
    }
    if (feature?.duplicates) warnings.push(at(`the system has ${feature.duplicates} class features with this dsid`));
    const id = `${overlay.key}${overlay.monster ? `@${overlay.monster.join("|")}` : ""}`;
    if (seen.has(id)) errors.push(at(`duplicate of ${seen.get(id)}`));
    seen.set(id, rel);
    // Licensing: our texts are short reminders in our own words.
    // Milestone 9: a teleport boost's label too.
    const texts = [overlay.notes, ...(overlay.effects ?? []).flatMap(e => [e.text, e.label, e.boost?.label, ...Object.values(e.byTier ?? {}).flatMap(t => [t.text, t.label]),
      ...(Array.isArray(e.actors) ? e.actors.map(a => a?.label) : [])]),
      ...(overlay.choices ?? []).flatMap(g => [g.label, ...(g.options ?? []).map(o => o.label)]), ...reactionTexts(overlay)].filter(Boolean);
    for (const t of texts) {
      if (theirText && sharedRun(t, theirText) >= 6) errors.push(at(`"${t.slice(0, 50)}..." copies the ${feature ? "feature" : "ability"}'s text (6+ words in a row)`));
    }
    for (const e of overlay.effects ?? []) {
      if (schema.RESERVED_NAMES.includes(e.name)) errors.push(at(`effect name "${e.name}" is reserved`));
      if (ability && e.name && !Object.values(ability.pres ?? {}).some(p => p.name === e.name) && !Object.values(ability.special ?? {}).some(s => s.name === e.name)) {
        warnings.push(at(`effect ${e.id}: name "${e.name}" matches none of the ability's effects (only Combat Tools choose names need one)`));
      }
    }
    if (ability && !ability.powerRoll && (overlay.effects ?? []).some(e => e.tiers || e.byTier)) {
      errors.push(at("the ability has no power roll: effects cannot depend on tiers"));
    }
    // Triggers and trackers automate on their own, so a trigger overlay may have `effects: []`.
    const triggers = Array.isArray(overlay.triggers) ? overlay.triggers : [];
    const trackers = Array.isArray(overlay.trackers) ? overlay.trackers : [];
    // Milestone 9 (rule 4 mirror): a Persistent re-roll or hold automates; a manual keep is a reminder.
    if ((overlay.effects ?? []).length && overlay.effects.every(e => e.type === "note") && !triggers.length && !trackers.length
      && !schema.persistentAutomates(overlay.persistent)) {
      errors.push(at("an overlay must automate something besides reminders"));
    }
    // Index checks of triggers (monster overlays skip them, as the other index checks). A tracker's effect
    // missing from the ability is reported by the schema (ctx.effectIds).
    if (ability && !overlay.monster) {
      for (const [i, t] of triggers.entries()) {
        const where = `triggers[${i}]${t?.id ? ` (${t.id})` : ""}`;
        if (t?.free !== true && !TRIGGERED_TYPES.includes(ability.type)) {
          errors.push(at(`${where}: the ability is a ${ability.type}, not a triggered action (set "free": true to react with it anyway)`));
        }
        const expected = SUBJECT_FOR_TARGET[ability.target];
        const subject = t?.subject ?? "self";
        if ((String(t?.event).startsWith("damage.") || t?.event === "roll.before") && expected && subject !== expected) {
          warnings.push(at(`${where}: subject "${subject}" but the ability targets "${ability.target}"`));
        }
      }
    }
    summonWarnings(overlay, their, index).forEach(w => warnings.push(at(w)));
    // Milestone 7: gains and zones against the index.
    for (const lint of [gainLints(overlay, index), zoneLints(overlay, their, index), persistentLints(overlay, ability), pickAreaLints(overlay, ability)]) {
      lint.errors.forEach(e => errors.push(at(e)));
      lint.warnings.forEach(w => warnings.push(at(w)));
    }
    if (ability?.duplicates) warnings.push(at(`the system has ${ability.duplicates} abilities with this dsid`));
    overlays.push({ ...overlay, __file: rel });
  }
  // Milestone 7: the NPC guard keeps generic overlays off monsters; list the monster abilities left manual (FYI).
  const genericOnly = genericOnlyMonsters(overlays, index);
  for (const g of genericOnly) {
    warnings.push(`${g.file}: ${g.monster}'s "${g.ability}" shares the key ${g.key}; the NPC guard leaves it unautomated (add src/overlays/monsters/${g.key.slice(8)}.json to automate it)`);
  }
  return { overlays, errors, warnings, genericOnly };
}

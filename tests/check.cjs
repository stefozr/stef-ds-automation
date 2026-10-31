// Static checks for stef-ds-automation: syntax, JSON, i18n key coverage, import graph.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Reserved names (Milestone 6, docs/M6-DESIGN.md §2.2): never register a type, part, prompt or card action under the
// system's / Combat Tools' own summoning names, and never WRITE the system's summoner flag. Scripts and templates only
// (not tests), on the source with comments stripped (comments may name them).
const RESERVED_RULES = [
  /SpecialEffect\??\.(summon|portfolioSummon)\s*=(?!=)/,
  /MessagePart\??\.(targetResult|fall)\s*=(?!=)/,
  /data-action=["']performSummon["']/,
  /\bperformSummon\s*:\s*this\.#/,
  /registerPromptType\(\s*["'](summon|portfolioSummon|targetResult|fall)["']/,
  /setFlag\(\s*["']draw-steel["']\s*,\s*["']summoner["']/,
  /["']flags\.draw-steel\.summoner["']\s*:/,
  /\["draw-steel"\]\.summoner\s*=(?!=)/,
];
/** Strip // and block comments (not inside strings; good enough for our sources). */
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2); i = i < 0 ? src.length : i + 2; continue; }
    out += c;
    i++;
  }
  return out;
}
/** Reserved-name problems of one source text (exported for harness9 H49 through `reservedProblems`). */
function reservedProblems(src, { template = false } = {}) {
  const text = template ? src.replace(/\{\{!--[\s\S]*?--\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "") : stripComments(src);
  const out = [];
  for (const line of text.split("\n")) {
    for (const re of RESERVED_RULES) if (re.test(line)) out.push(`${re} in: ${line.trim().slice(0, 120)}`);
    if (/SpecialEffect/.test(line) && /\[\s*["'](summon|portfolioSummon)["']\s*\]\s*=(?!=)/.test(line)) out.push(`SpecialEffect["summon"] write in: ${line.trim().slice(0, 120)}`);
  }
  return out;
}
module.exports = { reservedProblems, stripComments, RESERVED_RULES };
// Required by harness9 (H49): export the rule, run no check.
if (require.main !== module) return;

// Roots from tests/paths.cjs (docs/M8-DESIGN.md §10.5; env DS_AUTO_CORE), this module's folder if it is missing.
const ROOT = (() => { try { return require("./paths.cjs").CORE; } catch { return path.resolve(__dirname, ".."); } })();
let failures = 0;
const fail = (msg) => { failures++; console.log("FAIL", msg); };
// DSAUTO_CHECK_SKIP_I18N=1 (docs/M8-DESIGN.md §14.0): the i18n key checks (missing keys, dynamic key lists) are counted
// and reported but do not fail, while M8 work packages add keys that WP-D merges into lang/en.json last.
const SKIP_I18N = !!process.env.DSAUTO_CHECK_SKIP_I18N;
let i18nSkipped = 0;
const failI18n = (msg) => { if (SKIP_I18N) i18nSkipped++; else fail(msg); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const mjs = files.filter(f => f.endsWith(".mjs"));

// 1. Syntax (DSAUTO_CHECK_SKIP_SYNTAX: harness10 H42 runs the key checks only)
if (!process.env.DSAUTO_CHECK_SKIP_SYNTAX) {
  for (const f of mjs) {
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
    catch (e) { fail(`syntax ${f}\n${e.stderr}`); }
  }
  console.log(`syntax: ${mjs.length} files checked`);
}

// 2. JSON (DSAUTO_CHECK_LANG: another en.json, harness10 H42 removes one dynamic key from a copy)
const json = {};
const LANG_FILE = process.env.DSAUTO_CHECK_LANG || path.join(ROOT, "lang/en.json");
for (const f of ["module.json", "lang/en.json"]) {
  try { json[f] = JSON.parse(fs.readFileSync(f === "lang/en.json" ? LANG_FILE : path.join(ROOT, f), "utf8")); }
  catch (e) { fail(`json ${f}: ${e.message}`); }
}
const manifest = json["module.json"];
for (const p of [...(manifest.esmodules ?? []), ...(manifest.styles ?? []), ...(manifest.languages ?? []).map(l => l.path)]) {
  if (!fs.existsSync(path.join(ROOT, p))) fail(`manifest path missing: ${p}`);
}

// 3. Import graph: every relative import resolves and every imported name is exported.
const exportsOf = new Map();
for (const f of mjs) {
  const src = fs.readFileSync(f, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(",")) names.add(n.trim().split(/\s+as\s+/).pop());
  exportsOf.set(path.resolve(f), names);
}
for (const f of mjs) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const target = path.resolve(path.dirname(f), m[2]);
    if (!exportsOf.has(target)) { fail(`${path.relative(ROOT, f)}: import target missing ${m[2]}`); continue; }
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name && !exportsOf.get(target).has(name)) fail(`${path.relative(ROOT, f)}: "${name}" not exported by ${m[2]}`);
    }
  }
}

// 4. i18n coverage
const flat = {};
(function flatten(o, pre) {
  for (const [k, v] of Object.entries(o)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key); else flat[key] = v;
  }
})(json["lang/en.json"] ?? {}, "");
const used = new Set();
for (const f of files.filter(f => /\.(mjs|hbs)$/.test(f))) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/["'`](DSAUTO\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
}
// Dynamic keys
const settingsSrc = fs.readFileSync(path.join(ROOT, "scripts/settings.mjs"), "utf8");
// Milestone 8 (docs/M8-DESIGN.md §5.1, CH1): every DEFINITIONS entry has name/hint unless it is `hidden: true`; every
// non-hidden entry is in exactly one tab of MENU_TABS (`menu: "<tab>"`) or in the plain list.
const audit = require("./i18n-audit.cjs");
const settingDefs = audit.coreSettingKeys(settingsSrc);
if (!settingDefs.length) fail("check.cjs: cannot read DEFINITIONS from settings.mjs");
if (/config:\s*false/.test(stripComments(settingsSrc))) fail("settings.mjs: use `hidden: true` or `menu: \"<tab>\"`, not `config: false`");
const settingKeys = settingDefs.filter(s => !s.hidden).map(s => s.key);
for (const k of settingKeys) { used.add(`DSAUTO.Settings.${k}.name`); used.add(`DSAUTO.Settings.${k}.hint`); }
{
  const tabs = audit.constantValues(settingsSrc, "MENU_TABS");
  const plain = audit.constantValues(settingsSrc, "PLAIN_KEYS");
  if (!tabs.length || !plain.length) fail("check.cjs: cannot read MENU_TABS / PLAIN_KEYS from settings.mjs");
  for (const s of settingDefs) {
    if (s.hidden) continue;
    const inPlain = plain.includes(s.key);
    if (s.menu && inPlain) fail(`settings.mjs: ${s.key} is in a tab and in the plain list`);
    else if (s.menu && !tabs.includes(s.menu)) fail(`settings.mjs: ${s.key} names an unknown tab "${s.menu}"`);
    else if (!s.menu && !inPlain) fail(`settings.mjs: ${s.key} is in no tab of the settings window and not in the plain list`);
  }
  for (const k of plain) if (!settingDefs.some(s => s.key === k && !s.hidden)) fail(`settings.mjs: plain-list key ${k} is not a shown setting`);
}
// `warnOnce("<code>")` (engine/library-plan.mjs) records the warning code like `code: "<code>"`.
for (const f of mjs) for (const m of stripComments(fs.readFileSync(f, "utf8")).matchAll(/\bwarnOnce\(\s*"([A-Za-z]+)"\s*\)/g)) used.add(`DSAUTO.Warning.${m[1]}`);
// tests/i18n-dynamic.json (M8 lists): each list must match the source constant it is proven from.
{
  let dyn = {};
  try { dyn = JSON.parse(fs.readFileSync(path.join(__dirname, "i18n-dynamic.json"), "utf8")); } catch (e) { fail(`i18n-dynamic.json: ${e.message}`); }
  for (const d of dyn.dynamic ?? []) {
    let src = "";
    try { src = fs.readFileSync(path.join(ROOT, d.source), "utf8"); } catch { fail(`i18n-dynamic.json: ${d.prefix} source ${d.source} missing`); continue; }
    const values = audit.constantValues(src, d.constant);
    const listed = d.values ?? [];
    if (!values.length || values.length !== listed.length || values.some(v => !listed.includes(v))) {
      failI18n(`i18n-dynamic.json: ${d.prefix} [${listed.join(", ")}] does not match ${d.constant} [${values.join(", ")}] of ${d.source}`);
    }
    for (const v of values) used.add(`${d.prefix}${v}`);
  }
  // Keys Foundry and the system consume (types, LOCALIZATION_PREFIXES): a trailing "." covers every key below it.
  for (const k of dyn.consumedByFoundry ?? []) {
    if (k.endsWith(".")) { for (const key of Object.keys(flat)) if (key.startsWith(k)) used.add(key); } else used.add(k);
  }
}
const allSrc = mjs.map(f => fs.readFileSync(f, "utf8")).join("\n");
const reasons = new Set([...allSrc.matchAll(/reason:\s*"([A-Za-z]+)"/g)].map(m => m[1]));
reasons.add("resisted"); reasons.add("targetedManual"); for (const r of ["create", "sweep", "button", "api", "lateTargets", "retarget", "adopt", "pick"]) reasons.delete(r);
for (const r of reasons) used.add(`DSAUTO.Reason.${r}`);
const codes = new Set([...allSrc.matchAll(/code:\s*"([A-Za-z]+)"/g)].map(m => m[1]));
for (const m of allSrc.matchAll(/code:\s*(warn|warning)\b/g)) void m;
["minionNoSquad", "minionMultiSquad", "conditionAlwaysWithPotency"].forEach(c => codes.add(c));
for (const c of codes) used.add(`DSAUTO.Warning.${c}`);
for (const s of ["applied", "undone", "skipped", "failed", "external"]) used.add(`DSAUTO.Status.${s}`);
for (const m of ["auto", "prompt", "manual"]) used.add(`DSAUTO.Status.pending.${m}`);
for (const m of ["auto", "prompt", "manual", "failed"]) used.add(`DSAUTO.Status.short.${m}`);
for (const k of ["damage", "heal", "temp", "forced", "teleport", "summon"]) used.add(`DSAUTO.Card.Synthetic.${k}`);
// Milestone 7: Malice and hero tokens are op-level resources too (world settings).
for (const k of ["surge", "heroic", "epic", "recovery", "malice", "heroToken"]) { used.add(`DSAUTO.Card.Resource.${k}`); used.add(`DSAUTO.Entry.Resource.${k}`); }
for (const k of ["targets", "self", "pick", "area"]) used.add(`DSAUTO.Entry.Targets.${k}`);
// Milestone 9 (WP-A): the modifier's ends and modes and the pick anchor (types/special-effects.mjs, keyed choices).
for (const k of ["turnEnd", "nextTurnEnd", "nextTurnStart", "sourceNextTurnStart", "sourceNextTurnEnd", "roundEnd", "encounterEnd"]) used.add(`DSAUTO.Entry.ModifierEnd.${k}`);
for (const k of ["add", "override"]) used.add(`DSAUTO.Entry.ModifierMode.${k}`);
for (const k of ["self", "target"]) used.add(`DSAUTO.Entry.PickOf.${k}`);
for (const k of ["allies", "enemies"]) used.add(`DSAUTO.Entry.Filter.${k}`);
for (const k of ["yourNextTurnStart", "yourNextTurnEnd"]) used.add(`DSAUTO.Entry.Until.${k}`);
for (const k of ["target", "self"]) used.add(`DSAUTO.Entry.Spender.${k}`);
for (const k of ["turn", "save", "encounter", "respite"]) used.add(`DSAUTO.Entry.End.${k}`);
{
  const entries = fs.readFileSync(path.join(ROOT, "scripts/library/entries.mjs"), "utf8");
  for (const m of entries.matchAll(/"([a-zA-Z]+)"/g)) if (flat[`DSAUTO.Entry.Field.${m[1]}`] !== undefined) used.add(`DSAUTO.Entry.Field.${m[1]}`);
}
for (const k of ["noAnswer", "noOwner"]) used.add(`DSAUTO.Save.Note.${k}`);
// Milestone 5 (docs/M5-DESIGN.md §5.6): trigger outcomes, event sentences and step words.
for (const k of ["declined", "timedOut", "noAnswer", "closed", "moot"]) used.add(`DSAUTO.Trigger.Outcome.${k}`);
for (const k of ["damageBefore", "damageAfter", "rollBefore", "turnStart", "turnEnd", "forcedBefore", "moveBefore", "zero"]) used.add(`DSAUTO.Trigger.Dialog.Event.${k}`);
for (const k of ["halve", "potency", "edge1", "edge2", "use", "freeStrike", "takeTurnNext", "retarget"]) used.add(`DSAUTO.Trigger.Step.${k}`);
// Milestone 6 (docs/M6-DESIGN.md §5.6): removal reasons, picker and square reasons (returned as values by
// summons/squares.mjs), the summon entry field choices.
for (const k of ["dismiss", "undo", "death", "encounterEnd", "expired"]) used.add(`DSAUTO.Summon.Removal.${k}`);
for (const k of ["badPlace", "offMap", "wrongLevel", "tooFar", "occupied", "gridUnsupported"]) used.add(`DSAUTO.Summon.Picker.${k}`);
for (const k of ["badPlace", "offMap", "wrongLevel", "tooMany", "tooFar", "occupied", "noSpace", "gridUnsupported"]) used.add(`DSAUTO.Reason.${k}`);
for (const k of ["self", "target"]) used.add(`DSAUTO.Entry.Origin.${k}`);
for (const k of ["summoner", "hostile"]) used.add(`DSAUTO.Entry.Side.${k}`);
for (const k of ["after", "own", "with", "none"]) used.add(`DSAUTO.Entry.Turn.${k}`);
for (const k of ["join", "new", "none"]) used.add(`DSAUTO.Entry.Squad.${k}`);
for (const k of ["summonerTurnStart", "summonerTurnEnd", "encounterEnd", "summonerDying", "zeroStamina", "manual"]) used.add(`DSAUTO.Entry.Lasts.${k}`);
for (const k of ["pick", "auto"]) used.add(`DSAUTO.Settings.summonPlacement.${k}`);
for (const k of ["listed", "all", "none"]) used.add(`DSAUTO.Settings.summonEncounterEnd.${k}`);
// The lists above mirror code: every event kind (taxonomy.mjs), every outcome the card shows (view.mjs
// QUIET_OUTCOMES), every op status (constants.mjs OP_STATUS), every summon end and removal reason must have its key
// listed, and every op kind its card icon.
{
  const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const quoted = block => [...String(block ?? "").matchAll(/"([A-Za-z.]+)"/g)].map(m => m[1]);
  const events = quoted(/TRIGGER_EVENTS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(read("scripts/triggers/taxonomy.mjs"))?.[1]);
  const outcomes = quoted(/QUIET_OUTCOMES = new Set\(\[([^\]]*)\]\)/.exec(read("scripts/parts/view.mjs"))?.[1]);
  const statuses = quoted(/OP_STATUS = Object\.freeze\(\{([^}]*)\}\)/.exec(read("scripts/constants.mjs"))?.[1]);
  if (!events.length || !outcomes.length || !statuses.length) fail("check.cjs: cannot read TRIGGER_EVENTS / QUIET_OUTCOMES / OP_STATUS");
  for (const e of events) {
    const k = `DSAUTO.Trigger.Dialog.Event.${e.replace(/\.(\w)/, (_m, c) => c.toUpperCase())}`;
    if (!used.has(k)) failI18n(`dynamic key list misses ${k} (event ${e})`);
  }
  for (const o of outcomes) if (!used.has(`DSAUTO.Trigger.Outcome.${o}`)) failI18n(`dynamic key list misses DSAUTO.Trigger.Outcome.${o}`);
  for (const s of statuses) if (s !== "pending" && !used.has(`DSAUTO.Status.${s}`)) failI18n(`dynamic key list misses DSAUTO.Status.${s}`);
  // Milestone 6: every end of SUMMON_LASTS (library/schema.mjs) and every removal reason (registry REMOVAL).
  const lasts = quoted(/SUMMON_LASTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(read("scripts/library/schema.mjs"))?.[1]);
  const removal = [...String(/REMOVAL = Object\.freeze\(\{([^}]*)\}\)/.exec(read("scripts/summons/registry.mjs"))?.[1] ?? "").matchAll(/:\s*"([A-Za-z]+)"/g)].map(m => m[1]);
  if (!lasts.length || !removal.length) fail("check.cjs: cannot read SUMMON_LASTS / REMOVAL");
  for (const v of lasts) if (!used.has(`DSAUTO.Entry.Lasts.${v}`)) failI18n(`dynamic key list misses DSAUTO.Entry.Lasts.${v}`);
  for (const v of removal) if (!used.has(`DSAUTO.Summon.Removal.${v}`)) failI18n(`dynamic key list misses DSAUTO.Summon.Removal.${v}`);
  // Every op kind (constants.mjs OP_KINDS, "summon" from Milestone 6) has its card icon (view.mjs KIND_ICONS).
  const kinds = quoted(/OP_KINDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(read("scripts/constants.mjs"))?.[1]);
  const icons = [...String(/KIND_ICONS = \{([^}]*)\}/.exec(read("scripts/parts/view.mjs"))?.[1] ?? "").matchAll(/^\s*([A-Za-z]+):/gm)].map(m => m[1]);
  if (!kinds.length || !icons.length) fail("check.cjs: cannot read OP_KINDS / KIND_ICONS");
  for (const k of kinds) if (!icons.includes(k)) fail(`view.mjs KIND_ICONS misses op kind ${k}`);
  // Milestone 7 (docs/M7-DESIGN.md §5.6): zone end reasons (zones/registry.mjs ZONE_END, values passed around, never
  // literals), the zone entry choices and the zone row words, each list read from its source; the behavior's fields.
  const zoneEnd = [...String(/ZONE_END = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(read("scripts/zones/registry.mjs"))?.[1] ?? "").matchAll(/:\s*"([A-Za-z]+)"/g)].map(m => m[1]);
  const schema = read("scripts/library/schema.mjs");
  const list = name => quoted(new RegExp(`${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`).exec(schema)?.[1]);
  const zoneEvents = list("ZONE_EVENTS");
  const zoneOnce = list("ZONE_ONCE");
  const zoneAffects = list("ZONE_AFFECTS");
  const zoneShapes = list("ZONE_SHAPES");
  // Milestone 9 (WP-B): the terrain words of a zone (row detail and the entry / behavior choice).
  const zoneTerrains = list("ZONE_TERRAINS");
  if (!zoneEnd.length || !zoneEvents.length || !zoneOnce.length || !zoneAffects.length || !zoneShapes.length || !zoneTerrains.length) {
    fail("check.cjs: cannot read ZONE_END / ZONE_EVENTS / ZONE_ONCE / ZONE_AFFECTS / ZONE_SHAPES / ZONE_TERRAINS");
  }
  for (const v of zoneTerrains) { used.add(`DSAUTO.Zone.Terrain.${v}`); used.add(`DSAUTO.Entry.Terrain.${v}`); }
  for (const v of zoneEnd) used.add(`DSAUTO.Zone.End.${v}`);
  for (const v of zoneEvents) used.add(`DSAUTO.Entry.ZoneEvent.${v}`);
  for (const v of zoneOnce) used.add(`DSAUTO.Entry.Once.${v}`);
  for (const v of zoneAffects) { used.add(`DSAUTO.Entry.Affects.${v}`); used.add(`DSAUTO.Zone.Affects.${v}`); }
  for (const v of zoneShapes) {
    used.add(`DSAUTO.Entry.Shape.${v}`);
    if (v !== "ability") used.add(`DSAUTO.Zone.Shape.${v}`);
  }
  for (const v of lasts) used.add(`DSAUTO.Zone.Lasts.${v}`);
  const behaviorFields = ["zoneId", "triggers", "once", "onceShared", "perSquare", "amount", "damageType", "ignoredImmunities", "affects",
    "exceptKeywords", "exceptMonsters", "sourceActorUuid", "aoe", "forcedCounts", "label", "terrain"];
  for (const f of behaviorFields) used.add(`DSAUTO.Zone.Behavior.FIELDS.${f}.label`);
}
// A literal that names a group of keys (a labelPrefix such as "DSAUTO.Menu.Tab", a prefix ending in ".") is not a key.
const isGroup = k => k.endsWith(".") || Object.keys(flat).some(f => f.startsWith(`${k}.`));
for (const k of used) if (!(k in flat) && !isGroup(k)) failI18n(`i18n key missing: ${k}`);
// DSMEDKIT keys are the medkit's (scripts/medkit, templates/medkit): i18n-audit.cjs below counts them.
const unused = Object.keys(flat).filter(k => !k.startsWith("DSMEDKIT.") && !used.has(k) && !/^DSAUTO\.Settings\.(Mode|targetedConditions|sweepOnReady)\./.test(k));
console.log(`i18n: ${used.size} keys used, ${Object.keys(flat).length} defined; unused: ${unused.join(", ") || "none"}`);
// The library's and the medkit's lang files (docs/M8-DESIGN.md §8.2, through tests/i18n-audit.cjs): missing keys fail,
// unused keys warn. A module that is not there (DS_AUTO_LIBRARY / DS_AUTO_MEDKIT) is skipped with a note.
{
  let r = null;
  try { r = audit.audit(); } catch (e) { fail(`i18n-audit: ${e.message}`); }
  for (const n of r?.notes ?? []) console.log(`i18n note: ${n}`);
  for (const id of Object.keys(r?.modules ?? {})) {
    const m = r?.modules?.[id];
    if (!m) continue;
    for (const x of m.missing) failI18n(`${id}: i18n key missing: ${x.key} (${x.at.join(", ")})`);
    console.log(`i18n ${id}: ${m.used} keys used literally, ${m.defined} defined; unused: ${m.unused.join(", ") || "none"}`);
  }
  for (const c of (r?.crossModule ?? []).filter(c => !c.allowed)) failI18n(`${c.usedAt}: uses ${c.key} of ${c.definedIn} (not in i18n-dynamic.json crossModule)`);
}
if (SKIP_I18N) console.log(`i18n: DSAUTO_CHECK_SKIP_I18N set, ${i18nSkipped} key problem(s) not counted`);

// 5. libWrapper (Milestone 2): registrations only through compat/lib-wrapper.mjs `wrap`, WRAPPER or MIXED, never OVERRIDE.
for (const f of mjs.filter(f => !f.split(path.sep).includes("tests"))) {
  const src = fs.readFileSync(f, "utf8");
  if (/libWrapper\.register/.test(src) && !f.split(path.sep).join("/").endsWith("scripts/compat/lib-wrapper.mjs")) fail(`${path.relative(ROOT, f)}: libWrapper.register outside compat/lib-wrapper.mjs`);
  for (const m of src.matchAll(/wrap\(\s*"([^"]+)"\s*,\s*[A-Za-z0-9_$]+\s*,\s*"([A-Z]+)"\s*\)/g)) {
    if (!["WRAPPER", "MIXED"].includes(m[2])) fail(`${path.relative(ROOT, f)}: ${m[1]} registered as ${m[2]}`);
  }
}
if (!(manifest.relationships?.requires ?? []).some(r => r.id === "lib-wrapper")) fail("module.json must require lib-wrapper");

// 6. Reserved names (RESERVED_RULES and reservedProblems are defined at the top of this file).
for (const f of files.filter(f => /\.(mjs|hbs)$/.test(f) && !f.split(path.sep).includes("tests"))) {
  for (const p of reservedProblems(fs.readFileSync(f, "utf8"), { template: f.endsWith(".hbs") })) fail(`${path.relative(ROOT, f)}: reserved name: ${p}`);
}

console.log(failures ? `\n${failures} problem(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

// Static checks for the medkit (scripts/medkit, templates/medkit): syntax, manifest paths, i18n coverage, template renders.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const paths = require("./paths.cjs");
const ROOT = paths.MEDKIT;
let failures = 0;
const fail = msg => { failures++; console.log("FAIL", msg); };
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
// The medkit's own files (scripts/medkit, templates/medkit); the module root is the suite's.
const files = [...walk(paths.SCRIPTS), ...walk(paths.TEMPLATES)];
for (const f of files.filter(f => f.endsWith(".mjs"))) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); } catch (e) { fail(`syntax ${f}\n${e.stderr}`); }
}
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
for (const p of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path)]) if (!fs.existsSync(path.join(ROOT, p))) fail(`manifest path missing ${p}`);
const lang = JSON.parse(fs.readFileSync(path.join(ROOT, "lang/en.json"), "utf8"));
const flat = {};
(function flatten(o, pre) { for (const [k, v] of Object.entries(o)) { const key = pre ? `${pre}.${k}` : k; if (v && typeof v === "object") flatten(v, key); else flat[key] = v; } })(lang, "");
const used = new Set();
for (const f of files.filter(f => /\.(mjs|hbs)$/.test(f))) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(/["'`](DSMEDKIT\.[A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
}
// Dynamic keys: statuses, layers, types, resources, effect lines, actions, confirm, hints.
for (const s of ["locked", "disabled", "outdated", "customized", "unavailable", "covered", "configurable", "automated", "native", "manual"]) { used.add(`DSMEDKIT.Status.${s}.label`); used.add(`DSMEDKIT.Status.${s}.hint`); }
for (const l of ["disabled", "detached", "overlay", "native", "none"]) used.add(`DSMEDKIT.Layer.${l}`);
for (const t of ["damage", "heal", "condition", "cleanse", "resource", "forced", "teleport", "note"]) used.add(`DSMEDKIT.Type.${t}`);
for (const r of ["surge", "heroic", "epic", "recovery"]) used.add(`DSMEDKIT.Resource.${r}`);
for (const m of fs.readFileSync(path.join(paths.SCRIPTS, "describe.mjs"), "utf8").matchAll(/L\("([A-Za-z]+)"/g)) used.add(`DSMEDKIT.Effect.${m[1]}`);
for (const f of ["enemies", "allies"]) used.add(`DSMEDKIT.Item.NativeFilter.${f}`);
for (const k of ["resync", "reset"]) { used.add(`DSMEDKIT.Confirm.${k}`); used.add(`DSMEDKIT.Action.${k}`); }
// Editor choice labels and short guidance are localized through its L helper.
{
  const editor = fs.readFileSync(path.join(paths.SCRIPTS, "automation-editor.mjs"), "utf8");
  for (const m of editor.matchAll(/\bL\("([A-Za-z]+)"\)/g)) used.add(`DSMEDKIT.Editor.${m[1]}`);
  const choices = editor.slice(editor.indexOf("const CHOICE_KEYS ="), editor.indexOf("const configured ="));
  for (const m of choices.matchAll(/:\s*"([A-Za-z]+)"/g)) used.add(`DSMEDKIT.Editor.Choices.${m[1]}`);
  for (const k of ["key", "mode", "whenSpend", "whenStrained"]) used.add(`DSMEDKIT.Editor.${k}`);
  for (const k of ["selectedTargets", "onceEncounter", "whilePresent", "noRequirement", "withSpend", "withoutSpend", "strained", "notStrained"]) used.add(`DSMEDKIT.Editor.Choices.${k}`);
  for (const k of ["Configured", "ConfiguredOne"]) used.add(`DSMEDKIT.Editor.${k}`);
}
// Triggers (describe.mjs): event kinds and subjects of stef-ds-automation's taxonomy (M5-DESIGN §5.6).
for (const k of ["damageBefore", "damageAfter", "rollBefore", "turnStart", "turnEnd", "forcedBefore", "moveBefore"]) used.add(`DSMEDKIT.Trigger.Event.${k}`);
for (const k of ["self", "ally", "selfOrAlly", "enemy", "creature", "selfOrCreature"]) used.add(`DSMEDKIT.Trigger.Subject.${k}`);
// Summons (describe.mjs, actor-medkit.mjs; core 0.8.0, M6-DESIGN §5.4): turn words and ends, the
// ends read from the core's schema so a new one cannot be missed.
for (const k of ["after", "own", "with", "none"]) used.add(`DSMEDKIT.Effect.summonTurn_${k}`);
{
  const schema = fs.readFileSync(path.join(paths.CORE_SCRIPTS, "library", "schema.mjs"), "utf8");
  const lasts = [...(/SUMMON_LASTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(schema)?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]);
  if (!lasts.length) fail("check.cjs: cannot read SUMMON_LASTS from stef-ds-automation");
  for (const k of lasts) used.add(`DSMEDKIT.Summon.Lasts.${k}`);
  // Resource gains (describe.mjs, core 0.9.0, M7-DESIGN §5.4): the `once` words, read from the core's GAIN_ONCE.
  const once = [...(/GAIN_ONCE = Object\.freeze\(\[([^\]]*)\]\)/.exec(schema)?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]);
  if (!once.length) fail("check.cjs: cannot read GAIN_ONCE from stef-ds-automation");
  for (const k of once) used.add(`DSMEDKIT.Gain.Once.${k}`);
  // Gain resources share the effect resources' words (DSMEDKIT.Resource.*, listed above): GAIN_RESOURCES must be among them.
  const resources = [...(/GAIN_RESOURCES = Object\.freeze\(\[([^\]]*)\]\)/.exec(schema)?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]);
  if (!resources.length) fail("check.cjs: cannot read GAIN_RESOURCES from stef-ds-automation");
  for (const k of resources) used.add(`DSMEDKIT.Resource.${k}`);
}
for (const k of used) if (!(k in flat)) fail(`i18n key missing: ${k}`);
const unused = Object.keys(flat).filter(k => !used.has(k));
console.log(`i18n: ${used.size} used, ${Object.keys(flat).length} defined; unused: ${unused.join(", ") || "none"}`);

// Templates render with representative contexts.
const Handlebars = paths.handlebars();
Handlebars.registerHelper("localize", k => k);
Handlebars.registerHelper("checked", v => (v ? "checked" : ""));
const status = { id: "automated", label: "Automated", hint: "h", icon: "fa", cls: "ds-auto-status--automated" };
const contexts = {
  "automation-editor.hbs": {
    itemName: "Spitfire", areas: [{ value: "auto", label: "Automatic targeting", selected: true }],
    isGM: true, native: [{ id: "damage", name: "Damage", selected: true }], presets: [],
    rules: [{ id: "r1", ri: 0, displayName: "Damage and push", summary: "Use: selected targets, damage and push", advancedSummary: "Optional", effects: [
      { id: "e1", ri: 0, ei: 0, types: [{ value: "damage", label: "Damage", selected: true }], fields: [
        { primary: true, name: "rules.0.effects.0.value", label: "Damage", value: "@M + 2" },
        { primary: false, name: "rules.0.effects.0.tiers", label: "Tiers", value: "2, 3" },
      ] },
    ] }],
  },
  "item-medkit.hbs": {
    item: { name: "Catch Breath", img: "x.png" }, key: "ability:catch-breath", status, layer: "Library overlay",
    overlay: { version: "1.0.0", source: "stef-ds-automation.library", notes: "n" }, detachedVersion: null, native: [{ id: "a", what: "Damage", suppressed: true }],
    effects: [{ type: "heal", what: "Spend 1 Recovery", detail: "the user" }], covered: "healing", dsct: { enhanced: true, locked: false },
    config: [{ key: "x", label: "X", isCheckbox: true, value: true }, { key: "y", label: "Y", isSelect: true, options: [{ value: "a", label: "A", selected: true }] }],
    hasConfig: true, canEdit: true, disabled: false, locked: false, canDetach: true, canResync: false, canReset: false, inPack: false,
    triggers: [{ event: "damage.before", what: "before damage lands, you: half damage", detail: "uses the round's triggered action" }],
    trackers: [{ what: "Mark: new target at 0 Stamina", detail: "ends when its source is dying" }],
  },
  "actor-medkit.hbs": {
    actor: { name: "Borin", img: "b.png" }, npc: true, pinned: null, monsterKey: "goblin", canEdit: true, budget: "Triggered action this round: available",
    summary: [{ ...status, n: 3 }], rows: [{ uuid: "Actor.x.Item.y", name: "Knockback", img: "k.png", key: "ability:knockback", status, version: "1.0.0" }],
    summonsApi: true, canDismiss: true, summons: [{ summonId: "abc", line: "Source of Earth (Start)", lasts: "End of the encounter" }],
  },
  "coverage.hbs": { sources: "stef-ds-automation.library (66)", packs: [{ id: "draw-steel.abilities", title: "Abilities", total: 10, overlay: 4, native: 3, manual: 3, missing: ["A", "B", "C"], pct: 70 }] },
};
for (const [file, ctx] of Object.entries(contexts)) {
  try {
    const html = Handlebars.compile(fs.readFileSync(path.join(paths.TEMPLATES, file), "utf8"))(ctx);
    if (!html.includes("ds-medkit-body")) fail(`${file}: rendered nothing`);
    if (file === "item-medkit.hbs" && !(html.includes("DSMEDKIT.Trigger.Heading") && html.includes("Mark: new target"))) fail(`${file}: triggers / trackers not rendered`);
    if (file === "actor-medkit.hbs" && !html.includes("Triggered action this round")) fail(`${file}: budget line not rendered`);
    if (file === "actor-medkit.hbs" && !(html.includes("DSMEDKIT.Summons.Heading") && html.includes("Source of Earth (Start)") && html.includes('data-action="dismissSummon"'))) fail(`${file}: summons not rendered`);
  } catch (e) { fail(`${file}: ${e.message}`); }
}
// The summons fieldset: "none" with the core's API and no summon; hidden without the API.
{
  const render = ctx => Handlebars.compile(fs.readFileSync(path.join(paths.TEMPLATES, "actor-medkit.hbs"), "utf8"))({ ...contexts["actor-medkit.hbs"], ...ctx });
  if (!render({ summons: [] }).includes("DSMEDKIT.Summons.None")) fail("actor-medkit.hbs: an empty summons list does not say so");
  if (render({ summonsApi: false, summons: null }).includes("DSMEDKIT.Summons.Heading")) fail("actor-medkit.hbs: summons shown without the core's api.summons");
}
// 0.4.0: a feature's window shows the gains only; the actor window's Areas / Resource gains / Villain actions
// sections show with content and stay hidden without it; Release and Reset are the Director's.
{
  const item = ctx => Handlebars.compile(fs.readFileSync(path.join(paths.TEMPLATES, "item-medkit.hbs"), "utf8"))(ctx);
  const html = item({ ...contexts["item-medkit.hbs"], feature: true, gains: [{ what: "First damage taken this round: +1 heroic", detail: "" }], hasConfig: false, canDetach: false });
  if (!html.includes("DSMEDKIT.Gain.Heading") || !html.includes("First damage taken this round")) fail("item-medkit.hbs: a feature's gains not rendered");
  if (html.includes("DSMEDKIT.Item.Native") || html.includes("DSMEDKIT.Trigger.Heading") || html.includes('data-action="lock"')) fail("item-medkit.hbs: a feature shows ability layers or Lock");
  if (item(contexts["item-medkit.hbs"]).includes("DSMEDKIT.Gain.Heading")) fail("item-medkit.hbs: an ability shows a gains section");
  const actor = ctx => Handlebars.compile(fs.readFileSync(path.join(paths.TEMPLATES, "actor-medkit.hbs"), "utf8"))({ ...contexts["actor-medkit.hbs"], ...ctx });
  const full = actor({
    isGM: true, zones: [{ zoneId: "z1", line: "Wall of fire · until its creator's next turn" }],
    gains: [{ ruleKey: "ferocity:took-damage", what: "First damage: +1", detail: "", used: "used this round", encounter: false }],
    villain: [{ dsid: "oversurge", line: "Oversurge: round 2" }],
  });
  for (const s of ["DSMEDKIT.Zones.Heading", 'data-action="dismissZone"', "DSMEDKIT.Gain.Heading", 'data-action="releaseGain"', 'data-rule-key="ferocity:took-damage"', "DSMEDKIT.Villain.Heading", 'data-action="resetVillain"']) {
    if (!full.includes(s)) fail(`actor-medkit.hbs: ${s} not rendered`);
  }
  const player = actor({ isGM: false, gains: [{ ruleKey: "a", what: "x", used: "used this round" }], villain: [{ line: "v" }] });
  if (player.includes('data-action="releaseGain"') || player.includes('data-action="resetVillain"')) fail("actor-medkit.hbs: Release / Reset offered to a player");
  const none = actor({ zones: null, gains: null, villain: null });
  if (["DSMEDKIT.Zones.Heading", "DSMEDKIT.Gain.Heading", "DSMEDKIT.Villain.Heading"].some(s => none.includes(s))) fail("actor-medkit.hbs: empty M7 sections shown");
}
// Dismiss refusals (DSAUTO.Relay.* keys from the core's relay) are localized, never shown as raw keys.
{
  const src = fs.readFileSync(path.join(paths.SCRIPTS, "actor-medkit.mjs"), "utf8");
  const body = src.slice(src.indexOf("#onDismissSummon("), src.indexOf("#onUnpin("));
  if (!/startsWith\("DSAUTO\."\)\s*\?\s*game\.i18n\.localize/.test(body)) fail("actor-medkit.mjs: Dismiss refusals are not localized");
}
console.log(failures ? `\n${failures} problem(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

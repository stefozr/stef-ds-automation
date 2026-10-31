/** Versioned, item-local automation and independently copied world presets. */
import { MODULE_ID } from "../constants.mjs";
import { validateOverlay, formulaProblem } from "./schema.mjs";

export const RULE_EVENTS = Object.freeze(["use", "passive", "damage.after", "turn.start", "turn.end", "round.start", "round.end", "strike.damage", "judgement.applied", "ability.beforeRoll", "aura.continuous", "aura.exit", "ability.use"]);
export const RULE_TARGETS = Object.freeze(["targets", "self", "subject", "source", "aura", "encounter"]);
export const RULE_ENDS = Object.freeze(["", "turnEnd", "nextTurnEnd", "nextTurnStart", "sourceNextTurnStart", "sourceNextTurnEnd", "roundEnd", "encounterEnd", "passive", "aura"]);
export const MODIFIER_KEYS = Object.freeze(["system.movement.value", "system.movement.disengage", "system.combat.save.bonus", "system.damage.immunities.all", "system.damage.weaknesses.all", "system.roll.bonuses", "system.roll.edges", "system.roll.banes", "benefit:sanctuary", "benefit:entropy", "benefit:concealment", "benefit:acrobatics", "benefit:takeTwo", "benefit:radical", "benefit:dying", "benefit:moonlight", "benefit:noShift", "benefit:reflector", "benefit:peace", "benefit:targetBane", "system.movement.fly", "system.characteristics.might.resist", "system.characteristics.agility.resist", "system.characteristics.reason.resist", "system.characteristics.intuition.resist", "system.characteristics.presence.resist"]);
const clone = value => JSON.parse(JSON.stringify(value));

/** May a modifier (a feature rule's, or a library `modifier` effect's, Milestone 9) change this property? */
export function modifierKeyOk(key) {
  return MODIFIER_KEYS.includes(key) || /^system\.damage\.(immunities|weaknesses)\.[a-z]+$/.test(key ?? "");
}

export function validateAutomation(value) {
  const errors = [];
  if (!value || value.version !== 1 || !Array.isArray(value.rules)) return { ok: false, errors: ["Automation requires version 1 and a rules list."] };
  for (const k of Object.keys(value)) if (!["version", "rules", "area", "suppress", "performance", "config", "choices", "aura"].includes(k)) errors.push(`Unknown automation field: ${k}`);
  if (value.rules.length > 32) errors.push("At most 32 rules are allowed.");
  if (value.area != null && !["auto", "manual"].includes(value.area)) errors.push("Area targeting must be auto or manual.");
  if (value.suppress != null && (!Array.isArray(value.suppress) || value.suppress.some(s => typeof s !== "string"))) errors.push("Replaced native effects must be an ID list.");
  if (value.performance != null && typeof value.performance !== "boolean") errors.push("Performance must be a checkbox.");
  if (value.config != null && (!value.config || typeof value.config !== "object" || Array.isArray(value.config) || Object.entries(value.config).some(([k, v]) => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || (!["number", "boolean", "string"].includes(typeof v) || (typeof v === "number" && !Number.isFinite(v)))))) errors.push("Configuration values must be a named list of numbers, text or checkboxes.");
  if (value.choices != null && !Array.isArray(value.choices)) errors.push("Choices must be a list.");
  if (value.aura != null && (!value.aura || typeof value.aura !== "object" || Object.keys(value.aura).some(k => k !== "end") || !["", "encounter", "sourceNextTurnStart", "sourceNextTurnEnd"].includes(value.aura.end ?? ""))) errors.push("Invalid aura lifetime.");
  const ids = new Set();
  for (const [i, r] of value.rules.entries()) {
    const bad = msg => errors.push(`Rule ${i + 1}: ${msg}`);
    if (!r || typeof r !== "object") { bad("must be an object"); continue; }
    if (!/^[a-z0-9-]{1,24}$/.test(r.id ?? "") || ids.has(r.id)) bad("needs a unique lowercase ID");
    ids.add(r.id);
    for (const k of Object.keys(r)) if (!["id", "event", "activateOnUse", "targets", "optional", "once", "range", "filter", "keywords", "end", "effects", "label", "cost", "require", "limit", "special", "perTarget", "opportunity"].includes(k)) bad(`unknown field ${k}`);
    if (!RULE_EVENTS.includes(r.event)) bad("unknown activation event");
    if (!RULE_TARGETS.includes(r.targets ?? "targets")) bad("unknown targets");
    if (!RULE_ENDS.includes(r.end ?? "")) bad("unknown duration");
    if (!["each", "turn", "round", "encounter"].includes(r.once ?? "each")) bad("unknown frequency limit");
    if (r.activateOnUse != null && typeof r.activateOnUse !== "boolean") bad("activate on use must be a checkbox");
    for (const k of ["perTarget", "opportunity"]) if (r[k] != null && typeof r[k] !== "boolean") bad(`${k} must be a checkbox`);
    if (r.optional != null && typeof r.optional !== "boolean") bad("optional must be a checkbox");
    if (r.filter != null && !["all", "allies", "enemies", "selfAlly"].includes(r.filter)) bad("unknown side filter");
    if (r.keywords != null && (!Array.isArray(r.keywords) || r.keywords.some(k => typeof k !== "string" || k.length > 80))) bad("keywords must be a list");
    if (r.special != null && !["shift", "blocking", "immunityChoice", "recoveryChoices", "thunderMother", "spotlight", "auraJudgedDamage", "auraRecovery", "auraSouls"].includes(r.special)) bad("unknown special rule");
    for (const k of ["range", "limit"]) if (r[k] != null && formulaProblem(r[k])) bad(`invalid ${k} formula`);
    if (r.require != null) {
      if (!r.require || typeof r.require !== "object" || Array.isArray(r.require)) bad("requirements must be an object");
      else for (const [k, v] of Object.entries(r.require)) {
        if (!["adjacent", "sourceWithin", "subjectKeyword", "subject", "dying", "dead", "auraOption", "actionType", "costsMalice", "strike"].includes(k)) bad(`unknown requirement ${k}`);
        if (["adjacent", "dying", "dead"].includes(k) && typeof v !== "boolean") bad(`${k} must be a checkbox`);
        if (k === "sourceWithin" && formulaProblem(v)) bad("invalid source range");
        if (k === "subject" && !["self", "creature"].includes(v)) bad("subject must be self or creature");
      }
    }
    if (r.label != null && (typeof r.label !== "string" || r.label.length > 200)) bad("label must be text (at most 200 characters)");
    if (r.cost != null && (!Number.isInteger(r.cost) || r.cost < 0 || r.cost > 20)) bad("cost must be 0–20");
    if (!Array.isArray(r.effects) || r.effects.length > 24) { bad("needs an effect list (at most 24)"); continue; }
    if (!r.effects.length && !r.special) bad("needs an effect");
    const effectIds = new Set();
    for (const e of r.effects) {
      if (!e || typeof e !== "object") { bad("effect must be an object"); continue; }
      if (effectIds.has(e.id)) bad("effect IDs must be unique within a rule");
      effectIds.add(e.id);
    }
    const regular = r.effects.filter(e => e?.type !== "modifier");
    if (regular.length) {
      const checked = validateOverlay({ key: "ability:custom", name: "Custom", version: "1.0.0", effects: regular, choices: Array.isArray(value.choices) ? value.choices : [] });
      for (const msg of checked.errors) bad(msg);
    }
    for (const e of r.effects.filter(e => e?.type === "modifier")) {
      if (e.when != null && (!e.when || typeof e.when !== "object" || Object.entries(e.when).some(([k, v]) => !["spend", "strained", "config"].includes(k) || (k === "config" ? typeof v !== "string" : typeof v !== "boolean")))) bad("invalid modifier use gate");
      for (const k of Object.keys(e)) if (!["id", "type", "key", "value", "mode", "targets", "tiers", "potency", "when", "label"].includes(k)) bad(`unknown modifier field ${k}`);
      if (e.targets != null && !["self", "targets"].includes(e.targets)) bad("modifier targets must be self or targets");
      if (e.tiers != null && (!Array.isArray(e.tiers) || e.tiers.some(t => ![1, 2, 3].includes(t)))) bad("invalid modifier tier gate");
      if (e.potency != null && (!e.potency.characteristic || formulaProblem(e.potency.value))) bad("invalid modifier potency gate");
      if (!/^[a-z0-9-]{1,24}$/.test(e.id ?? "")) bad("modifier needs an ID");
      if (!modifierKeyOk(e.key)) bad("unsupported modifier property");
      if (!["add", "override"].includes(e.mode ?? "add")) bad("modifier mode must be add or override");
      if (formulaProblem(e.value)) bad("invalid modifier formula");
      if (typeof e.value !== "number" && typeof e.value !== "string") bad("modifier needs a value or formula");
    }
  }
  return { ok: !errors.length, errors };
}

export function automationFor(item, overlay = null) {
  return item?.flags?.[MODULE_ID]?.automation ?? overlay?.automation ?? null;
}

function writable(item) {
  if (!item?.isOwner) throw new Error("DSAUTO.Library.NotOwner");
  if (item.pack) throw new Error("DSAUTO.Library.InCompendium");
  if (item.flags?.[MODULE_ID]?.lock) throw new Error("DSAUTO.Library.Locked");
}

export async function saveAutomation(item, value) {
  writable(item);
  const check = validateAutomation(value);
  if (!check.ok) throw new Error(check.errors.join("\n"));
  await item.update({ [`flags.${MODULE_ID}.automation`]: clone(value) });
  return clone(value);
}

export async function clearAutomation(item) {
  writable(item);
  await item.update({ [`flags.${MODULE_ID}.automation`]: new foundry.data.operators.ForcedDeletion() });
}

export const presets = () => clone(game.settings.get(MODULE_ID, "automationPresets") ?? []);
export async function savePreset(name, automation, id = null) {
  if (!game.user?.isGM) throw new Error("DSAUTO.Library.NotOwner");
  const check = validateAutomation(automation);
  if (!check.ok) throw new Error(check.errors.join("\n"));
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("DSAUTO.Library.BadPresetName");
  const all = presets();
  const preset = { id: id ?? foundry.utils.randomID(), name: name.trim(), automation: clone(automation) };
  const index = all.findIndex(p => p.id === preset.id);
  if (index < 0) all.push(preset); else all[index] = preset;
  await game.settings.set(MODULE_ID, "automationPresets", all);
  return preset;
}
export async function deletePreset(id) {
  if (!game.user?.isGM) throw new Error("DSAUTO.Library.NotOwner");
  await game.settings.set(MODULE_ID, "automationPresets", presets().filter(p => p.id !== id));
}
/** Copy a preset into a draft, preserving existing choice/configuration semantics on append. */
export function presetDraft(value, current = null, { append = false } = {}) {
  const next = clone(value);
  const choices = new Map((next.choices ?? []).map(c => [c.id, `choice-${foundry.utils.randomID(10).toLowerCase()}`]));
  for (const choice of next.choices ?? []) choice.id = choices.get(choice.id);
  const names = new Map();
  if (append) for (const key of Object.keys(next.config ?? {})) if (key in (current?.config ?? {})) names.set(key, `p${foundry.utils.randomID(6).toLowerCase()}_${key.slice(0, 31)}`);
  for (const [key, name] of names) { next.config[name] = next.config[key]; delete next.config[key]; }
  const rewrite = obj => {
    for (const [key, v] of Object.entries(obj)) {
      if (v && typeof v === "object") rewrite(v);
      else if (typeof v === "string") for (const [old, name] of names) obj[key] = obj[key].replace(new RegExp(`@config\\.${old}(?![A-Za-z0-9_])`, "g"), `@config.${name}`);
    }
  };
  for (const r of next.rules) {
    r.id = `rule-${foundry.utils.randomID(12).toLowerCase()}`;
    rewrite(r);
    for (const e of r.effects) {
      e.id = `effect-${foundry.utils.randomID(10).toLowerCase()}`;
      if (e.choice) e.choice.group = choices.get(e.choice.group) ?? e.choice.group;
      if (names.has(e.when?.config)) e.when.config = names.get(e.when.config);
    }
  }
  if (append && current) {
    next.rules.unshift(...clone(current.rules ?? []));
    next.suppress = [...new Set([...(current.suppress ?? []), ...(next.suppress ?? [])])];
    next.performance ||= !!current.performance;
    next.config = { ...(current.config ?? {}), ...(next.config ?? {}) };
    next.choices = [...clone(current.choices ?? []), ...(next.choices ?? [])];
  }
  return next;
}
export async function applyPreset(item, id, { append = false } = {}) {
  const preset = presets().find(p => p.id === id);
  if (!preset) throw new Error("DSAUTO.Library.PresetMissing");
  return saveAutomation(item, presetDraft(preset.automation, automationFor(item), { append }));
}

export function useEffects() {
  // Item rules execute once after the native card resolves; optional rules must not bypass their prompt.
  return [];
}

export function editableAutomation(item, resolved) {
  const existing = automationFor(item, resolved?.overlay);
  if (existing) return clone(existing);
  return { version: 1, rules: (resolved?.effects ?? []).length ? [{ id: "on-use", event: "use", targets: "targets", effects: clone(resolved.effects).map(({entryId, ...e}) => e) }] : [], suppress: [...(resolved?.suppress ?? [])], config: clone(resolved?.config ?? {}), choices: clone(resolved?.choices ?? []) };
}

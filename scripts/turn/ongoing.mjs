/**
 * Ongoing damage (Milestone 2): an effect that deals damage at the start or end of each of its
 * creature's turns ticks once per such turn, through a synthetic damage card (engine/synthetic.mjs:
 * immunities, squads, Death Tracker attribution and undo like any other card).
 *
 * Where the numbers come from, first match wins:
 *   1. flag `flags["stef-ds-automation"].ongoing`: `{formula, type?, when?: "turnStart"|"turnEnd",
 *      ignoredImmunities?}` or a list of them (the M4 library writes these);
 *   2. (setting `ongoingFromDescription`) the effect text, e.g. the system's Burning effect:
 *      "takes [[/damage 1d6 fire]] damage at the start of each of their turns".
 * Card mode: world setting `ongoingDamage` (auto applies at once; off disables the feature); Milestone 8 (§4.3): the
 * creature's type mode (`modeByActorType`) replaces auto / prompt / manual, `off` stays off.
 * Milestone 5: when a triggered action could hold the tick (`mayHoldDamage`), the creature's ticks run on a
 * detached chain, so a prompt never stalls the turn queue (C12); each tick still awaits its application
 * before the next one of that creature (one Stamina write at a time).
 */
import { HOOKS, MODULE_ID, loc } from "../constants.mjs";
import { createDamageCard } from "../engine/synthetic.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { typeOverride, withTypeOverride } from "../engine/actor-category.mjs";
import { mayHoldDamage } from "../triggers/engine.mjs";
import { onBeforeEndTurn, onTurnEvent } from "./lifecycle.mjs";
import * as heroTokens from "../resources/hero-tokens.mjs";

const WHEN = new Set(["turnStart", "turnEnd"]);
const DESCRIPTION_RE = /\[\[\/damage\s+([^\]]+?)\]\](?:\{[^}]*\})?[^.<\[]*?\bat the (start|end) of each of (?:their|its|his|her|your) turns/i;

// Turn-end ticks use what was active when the turn ended, before that turn's saves could end an
// effect (the system starts the saves without awaiting them, before the turn-end refresh).
const endSnapshots = new Map(); // `${combatId}:${combatantId}:${activation}` -> effect uuids

export function registerOngoing() {
  onBeforeEndTurn(({ combat, combatant, activation }) => {
    const effects = [...(combatant?.actor?.appliedEffects ?? [])].filter(e => ongoingSpecs(e).some(s => s.when === "turnEnd"));
    endSnapshots.set(`${combat.id}:${combatant.id}:${activation}`, effects.map(e => e.uuid));
    if (endSnapshots.size > 200) endSnapshots.delete(endSnapshots.keys().next().value);
  });
  onTurnEvent(onTurn);
}

/** Effects to tick for this event: live ones, plus turn-end ones a save ended in the meantime. */
function effectsFor(event, combat, combatant, activation, actor) {
  const live = [...(actor.appliedEffects ?? [])];
  if (event !== "turnEnd") return live;
  const key = `${combat?.id}:${combatant?.id}:${activation}`;
  const uuids = endSnapshots.get(key);
  endSnapshots.delete(key);
  if (!uuids) return live;
  const extra = uuids.map(u => fromUuidSync(u)).filter(e => e && !live.includes(e));
  return [...live, ...extra];
}

/**
 * Parse "/damage" enricher arguments the way the system does (draw-steel.mjs:29016-29031): several
 * formulas joined by "&", `type=a/b`, `ignoredImmunities=a/b`, `formula=...`, bare damage-type words,
 * and the flags `scaling` / `aoe` (dropped). Returns one `{formula, type, ignoredImmunities}` per formula.
 */
export function parseDamageArgs(args) {
  const types = ds.CONFIG?.damageTypes ?? {};
  const out = [];
  for (const segment of String(args ?? "").replaceAll("&amp;", "&").split("&")) {
    const formulaParts = [];
    const typeList = [];
    let ignoredImmunities = [];
    for (const word of segment.trim().split(/\s+/).filter(Boolean)) {
      const eq = word.indexOf("=");
      if (eq > 0) {
        const key = word.slice(0, eq).toLowerCase();
        const value = word.slice(eq + 1);
        if (key === "type") typeList.push(...value.toLowerCase().split(/[/|]/).filter(Boolean));
        else if (key === "ignoredimmunities") ignoredImmunities = value.toLowerCase().split(/[/|]/).filter(Boolean);
        else if (key === "formula") formulaParts.push(value);
        continue;
      }
      const lower = word.toLowerCase();
      if (lower === "scaling" || lower === "aoe") continue;
      if (lower in types) typeList.push(lower);
      else formulaParts.push(word);
    }
    const formula = formulaParts.join(" ").trim();
    if (!formula) continue;
    // A choice of types ("fire|cold") cannot be made here: the first one is used.
    out.push({ formula, type: typeList.find(t => t in types) ?? "", ignoredImmunities });
  }
  return out;
}

/** First formula of "/damage" arguments ("1d6 fire" -> {formula: "1d6", type: "fire"}). */
export function splitDamageArgs(args) {
  const [first] = parseDamageArgs(args);
  return { formula: first?.formula ?? "", type: first?.type ?? "" };
}

/** Is a formula rollable? (Roll.validate where available.) */
function validFormula(formula) {
  const Roll = foundry.dice?.Roll;
  if (typeof Roll?.validate !== "function") return true;
  try {
    return !!Roll.validate(formula); // static method that uses `this`: keep the receiver
  } catch (_err) {
    return false;
  }
}

function normalize(spec) {
  if (!spec || typeof spec !== "object") return null;
  const formula = String(spec.formula ?? spec.amount ?? "").trim();
  if (!formula || formula.length > 100) return null;
  const when = WHEN.has(spec.when) ? spec.when : "turnStart";
  const type = typeof spec.type === "string" && (spec.type === "" || spec.type in (ds.CONFIG?.damageTypes ?? {})) ? spec.type : "";
  const ignoredImmunities = Array.isArray(spec.ignoredImmunities) ? spec.ignoredImmunities.filter(t => typeof t === "string").slice(0, 20) : [];
  return { formula, type, when, ignoredImmunities, from: spec.from ?? "flag" };
}

/** Ongoing damage specs of an effect (see the module comment). */
export function ongoingSpecs(effect) {
  const flag = effect?.flags?.[MODULE_ID]?.ongoing;
  if (flag) return [flag].flat().map(normalize).filter(Boolean);
  if (!setting("ongoingFromDescription")) return [];
  const m = DESCRIPTION_RE.exec(String(effect?.description ?? ""));
  if (!m) return [];
  const when = m[2].toLowerCase() === "end" ? "turnEnd" : "turnStart";
  return parseDamageArgs(m[1])
    .map(p => normalize({ ...p, when, from: "description" }))
    .filter(spec => spec && validFormula(spec.formula));
}

/** The actor that caused the effect, for attribution (origin item/actor, or Combat Tools' `system.source`). */
function sourceActorUuid(effect) {
  for (const uuid of [effect?.origin, effect?.system?.source]) {
    if (typeof uuid !== "string" || !uuid) continue;
    try {
      const doc = fromUuidSync(uuid);
      const actor = doc?.documentName === "Actor" ? doc : doc?.actor;
      if (actor?.uuid) return actor.uuid;
    } catch (_err) { /* compendium or stale uuid */ }
  }
  return null;
}

async function onTurn({ event, combat, combatant, actor, activation }) {
  const mode = setting("ongoingDamage");
  if (mode === "off" || !actor || !setting("enabled")) return;
  if (actor.statuses?.has?.("dead")) return;
  const tokenUuid = combatant?.token?.uuid ?? null;
  if (!tokenUuid) return;
  const typed = withTypeOverride(mode, typeOverride(actor, tokenUuid));
  const todo = [];
  for (const effect of effectsFor(event, combat, combatant, activation, actor)) {
    for (const spec of ongoingSpecs(effect)) if (spec.when === event) todo.push([effect, spec]);
  }
  if (!todo.length) return;
  // One creature's ticks apply one after another (each awaits its application): two applications at once
  // would both read the same Stamina and one tick's damage would be lost.
  const busy = chains.has(staminaKey(tokenUuid));
  const run = enqueue(tokenUuid, async () => {
    for (const [effect, spec] of todo) {
      try {
        await tick(effect, spec, { tokenUuid, combatant, mode: typed });
      } catch (err) {
        error("ongoing.tick", err, { effect: effect.uuid });
      }
    }
  });
  // A held application (a prompt) never stalls the lifecycle queue (C12): the chain runs on detached. Milestone 7 (C2):
  // a lethal tick may open the hero-token prompt too.
  if (busy || mayHoldDamage([tokenUuid]) || heroTokens.mayHoldHeroToken?.([tokenUuid])) run.catch(err => error("ongoing.tick", err));
  else await run;
}

const chains = new Map();   // staminaKey -> tail of that Stamina pool's chain

/**
 * The Stamina pool a token's damage writes: a squad member's is its squad's (every member writes the group's
 * `staminaValue`, so two members hit at once would both read the same pool, TESTING.md §14 T107), anyone else's its own.
 */
export function staminaKey(tokenUuid) {
  try {
    const token = fromUuidSync(tokenUuid);
    if (token?.documentName === "Token") {
      const sceneId = token.parent?.id ?? null;
      for (const combat of game.combats?.contents ?? []) {
        const member = (combat.combatants?.contents ?? []).find(c => c.tokenId === token.id && (c.sceneId ?? sceneId) === sceneId);
        const group = member?.group ?? null;
        if (group?.type === "squad") return `group:${group.uuid ?? `${combat.id}.${group.id}`}`;
      }
    }
  } catch (_err) { /* stale uuid: its own chain */ }
  return tokenUuid;
}

/**
 * Milestone 7: is a Stamina job of this creature (or its squad) queued or running? (read BEFORE enqueueing, C14;
 * zones/engine.mjs)
 */
export const staminaBusy = tokenUuid => chains.has(staminaKey(tokenUuid));

/**
 * Run `fn` after the creature's earlier Stamina jobs settled (ongoing ticks and, Milestone 7, zone hits: one Stamina
 * write at a time). Resolves with `fn`'s result.
 */
export function enqueueStamina(tokenUuid, fn) {
  return enqueue(tokenUuid, fn);
}

/** Run `fn` after the earlier jobs on the same Stamina pool (the creature's, or its squad's) settled. */
function enqueue(tokenUuid, fn) {
  const key = staminaKey(tokenUuid);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

/** Roll the spec and post its damage card (active GM). */
export async function tick(effect, spec, { tokenUuid, combatant = null, mode = setting("ongoingDamage") } = {}) {
  if (Hooks.call(HOOKS.preOngoing, effect, spec, { tokenUuid, combatant }) === false) return null;
  const rollData = effect.getRollData?.() ?? effect.actor?.getRollData?.() ?? {};
  const roll = new foundry.dice.Roll(spec.formula, rollData);
  await roll.evaluate();
  const amount = Math.max(0, Math.floor(Number(roll.total) || 0));
  const flavor = loc("DSAUTO.Ongoing.Flavor", { name: effect.name, formula: spec.formula });
  const result = await createDamageCard({
    targets: [tokenUuid], amount, type: spec.type, ignoredImmunities: spec.ignoredImmunities,
    source: sourceActorUuid(effect), flavor, mode: mode === "off" ? "manual" : mode,
  }, game.user, {
    rolls: [roll],
    meta: { ongoing: { effectUuid: effect.uuid, effectName: effect.name, when: spec.when, formula: spec.formula, from: spec.from } },
  });
  log("ongoing.tick", { effect: effect.name, combatant: combatant?.name, formula: spec.formula, amount, type: spec.type, messageId: result?.messageId });
  debug("ongoing.ops", result?.ops);
  return result;
}

import { auraPotencyBonus } from "../features/auras.mjs";
/**
 * Plan rows from library effects (Milestone 4): overlays and detached entries (library/resolve.mjs)
 * become ops of the same kinds as native effects, plus three new kinds:
 *   cleanse   end effects on a creature (statuses, or effects with a given end)
 *   resource  gain surges, the heroic resource, epic resource or Recoveries
 *   note      a reminder of what stays manual (never applied)
 *   summon    (Milestone 6) creatures placed on the canvas by the user's owner (always the user's own row, never by
 *             itself, never in "Apply all"; docs/M6-DESIGN.md §1.3, §3.1). Its world actors are prepared by the
 *             engine inside the card lock (summons/actors.mjs prepareSummonOps), not here.
 *   zone      (Milestone 7) a lasting area placed on the canvas (always the user's own row, never by itself, never in
 *             "Apply all"; docs/M7-DESIGN.md §1.5, §3.10.1); the GM creates its region (zones/create.mjs).
 *   modifier  (Milestone 9) an ActiveEffect that changes one actor property (a damage weakness) until `end`
 *   pick      (Milestone 9) the placeholder of a `targets: "pick"` effect on the user's row until the user's owner
 *             picked its creature(s) (engine/side-targets.mjs, ui/target-pick.mjs); never applied
 * Effects for "self" go to the ability's user (a row of its own); effects for "targets" to each target
 * on its own tier; Milestone 9: "pick" to the picked records (`t.picked`), "area" to the creatures inside the area the
 * use placed (`t.area`, the user left out). Conditions on `when` (spend, strained, config), tiers, potency and Combat Tools'
 * "choose one" picks decide which rows exist; overlay choice groups make rows wait for a pick.
 * Runs on the active GM inside buildPlan.
 */
import { OP_STATUS } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { log } from "../log.mjs";
import { effectShows } from "../library/choose-compat.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { SUMMON_DEFAULTS, ZONE_DEFAULTS, effectForTier, summonActorUuid } from "../library/schema.mjs";
import { zoneArea } from "../zones/shapes.mjs";
import { summonSourceUuid } from "../summons/actors.mjs";
import { isSummonLocked } from "../summons/registry.mjs";
import { opId } from "./keys.mjs";
import { sideOnly } from "./record.mjs";
import { alliesNear, isFlanking } from "./proximity.mjs";
import { targetedRoute } from "./plan.mjs";
import { effectDisplay, statusConfig } from "./native.mjs";

/** Feature setting that decides each library effect type's mode. */
export const LIB_KIND_MODE = Object.freeze({
  damage: "damage", heal: "heal", condition: "condition", cleanse: "condition",
  resource: "resource", forced: "forced", teleport: "teleport", note: "note", summon: "summon", zone: "zone",
  modifier: "condition",
});

/** Statuses removed by a cleanse of effects that end this way ("save" -> expiry "save"). */
const END_EXPIRY = { turn: "turnEnd", save: "save", encounter: "combatEnd", respite: "respite" };

/** 0.16.0: the expiry event of an effect end, as the system configures it (ds.CONFIG.effectEnds), else ours. */
const endExpiry = end => globalThis.ds?.CONFIG?.effectEnds?.[end]?.expiryEvent ?? END_EXPIRY[end] ?? null;

/** Combat Tools' bookkeeping effects (its "Unspent Triggered Action"), never ended by a cleanse. */
const bookkeeping = e => !!e?.flags?.["draw-steel-combat-tools"]?.effectType;

/**
 * Effects a cleanse op would end on an actor now (ids, in a stable order). 0.16.0: an end matches the effect's
 * `duration.expiry` through the system's `effectEnds` (Combat Tools' Damage & Conditions panel writes the same
 * events) or the legacy `system.end.type`; an expired effect (the world keeps expired effects on the sheet) or a
 * disabled one is not a candidate.
 */
export function cleanseCandidates(actor, { statuses = [], ends = [] } = {}) {
  const want = new Set(statuses ?? []);
  const endKeys = new Set(ends ?? []);
  const expiries = new Set([...endKeys].map(endExpiry).filter(Boolean));
  const out = [];
  for (const e of actor?.effects?.contents ?? []) {
    if (e.disabled || e.duration?.expired || bookkeeping(e)) continue;
    const st = [...(e.statuses ?? [])];
    const byStatus = want.size && st.some(s => want.has(s));
    const byEnd = expiries.size && (expiries.has(e.duration?.expiry) || endKeys.has(e.system?.end?.type));
    // The "dead" / "dying" / "winded" states are never ended; grabs end through Combat Tools (or Escape Grab).
    if (st.some(s => ["dead", "dying", "winded", "grabbed"].includes(s))) continue;
    if (byStatus || byEnd) out.push(e);
  }
  return out;
}

/**
 * 0.16.0: what a cleanse that found nothing saw on the actor (row tooltip, `cleanse.none` log): at most 12 effects
 * with their statuses, expiry and state.
 */
export function cleanseSeen(actor) {
  return (actor?.effects?.contents ?? []).slice(0, 12).map(e => ({
    name: String(e.name ?? "").slice(0, 60), statuses: [...(e.statuses ?? [])].slice(0, 6), expiry: e.duration?.expiry ?? null,
    disabled: !!e.disabled, expired: !!e.duration?.expired,
  }));
}

/** Hero resources an actor can gain (`resource` effects); null when it has none of that kind. */
export function resourcePath(actor, resource) {
  const sys = actor?.system;
  if (!sys) return null;
  switch (resource) {
    case "surge": return sys.hero && "surges" in sys.hero ? "system.hero.surges" : null;
    case "heroic": return sys.hero?.primary ? "system.hero.primary.value" : null;
    case "epic": return sys.hero?.epic ? "system.hero.epic.value" : null;
    case "recovery": return sys.recoveries && "value" in sys.recoveries ? "system.recoveries.value" : null;
  }
  return null;
}

/** Token disposition of a target record (its token, else the actor's prototype token). */
function dispositionOf(t) {
  let doc = null;
  try {
    doc = t?.tokenUuid ? fromUuidSync(t.tokenUuid) : null;
  } catch (_err) { /* invalid */ }
  if (doc && Number.isFinite(doc.disposition)) return doc.disposition;
  const actor = t?.actorUuid ? fromUuidSync(t.actorUuid) : null;
  const d = actor?.prototypeToken?.disposition;
  return Number.isFinite(d) ? d : null;
}

/** The ability user's record for side checks: their own target row, else their token / actor. */
export function userRecordOf({ targets, selfKey, sourceTokenUuid = null, item = null }) {
  return selfKey && targets?.[selfKey] ? targets[selfKey] : { tokenUuid: sourceTokenUuid, actorUuid: item?.actor?.uuid ?? null };
}

/** Is the target on the ability user's side? Unknown dispositions count as enemies. */
export function isAlly(target, self) {
  const a = dispositionOf(target);
  const b = dispositionOf(self);
  return a != null && b != null && a === b;
}

/** What the card shows about what the user chose in the roll dialog. */
export function useState(message, item) {
  const part = message?.system?.parts?.contents?.find?.(p => p.type === "abilityUse");
  const shown = new Set(part?.effects ?? []);
  let spend = false;
  let strained = false;
  for (const id of shown) {
    const e = item?.system?.effects?.get?.(id);
    if (e?.type === "spend") spend = true;
    if (e?.type === "strained") strained = true;
  }
  return { spend, strained, persistent: [...shown].some(id => item?.system?.effects?.get?.(id)?.type === "persistent") };
}

/**
 * The tier for effects on the ability's user: the card's only tier, or the highest when targets rolled
 * different tiers (then `ambiguous`). Null without a power roll.
 */
export function cardTier(tierParts) {
  const tiers = [...new Set((tierParts ?? []).map(p => p.tier))];
  if (!tiers.length) return { tier: null, partId: null, ambiguous: false };
  const tier = Math.max(...tiers);
  return { tier, partId: tierParts.find(p => p.tier === tier)?.partId ?? null, ambiguous: tiers.length > 1 };
}

/**
 * Library ops for a card.
 * @param {object} args
 * @param {object} args.lib               resolveAbility(item)
 * @param {Item} args.item
 * @param {Record<string, object>} args.targets   Targets with tier info (the self target included when present).
 * @param {string|null} args.selfKey     Key of the ability user's target record.
 * @param {object} args.self              cardTier() for effects on the user.
 * @param {{spend: boolean, strained: boolean}} args.use
 * @param {object|null} args.assignment  chooseAssignment(item, message)
 * @param {Function} args.decideMode     (kind, actor, tokenUuid) => mode (feature mode with overrides)
 * @param {Function} args.forcedRow      ({eff, td, actor, target, key, mode, id}) => op | null (plan.mjs)
 * @param {object} args.spend            Spend values of the roll dialog (for formulas).
 * @param {boolean} args.noPowerRoll
 * @param {object[]} args.warnings
 * @param {number} args.order
 * @returns {{ops: Record<string, object>, order: number, usesSelf: boolean, choices: object}}
 */
export function libraryOps({ lib, item, targets, selfKey, self, use, assignment, decideMode, forcedRow, spend, noPowerRoll, warnings, order, ambiguousSafe, sourceTokenUuid = null }) {
  const ops = {};
  // The user's side, for ally / enemy filters.
  const userRecord = userRecordOf({ targets, selfKey, sourceTokenUuid, item });
  let usesSelf = false;
  const choiceGroups = new Map((lib.choices ?? []).map(g => [g.id, g]));
  const usedChoices = {};
  const warnOnce = code => {
    if (!warnings.some(w => w.code === code)) warnings.push({ code });
  };

  for (const effect of lib.effects ?? []) {
    // Conditions on what the user chose.
    if (effect.when?.spend != null && effect.when.spend !== use.spend) continue;
    if (effect.when?.strained != null && effect.when.strained !== use.strained) continue;
    if (effect.when?.config && !lib.config?.[effect.when.config]) continue;
    // 1.1.1: an ally of the user within N squares of the card's first real target.
    if (effect.when?.alliesNearTarget != null && !alliesNearTarget(effect.when.alliesNearTarget, { item, targets, selfKey, userRecord, spend, config: lib.config })) continue;
    // Combat Tools "choose one": effects of an unpicked choice do not apply.
    let chooseGated = false;
    if (assignment && effect.name && assignment.claimed.has(String(effect.name).trim())) {
      if (assignment.picked) {
        if (!effectShows(effect.name, assignment)) continue;
      } else chooseGated = true;
    }
    const group = effect.choice ? choiceGroups.get(effect.choice.group) : null;

    // A summon or a zone always goes to the user's own row (normalizeOverlay / entryToEffect force targets "self" already).
    // Milestone 9: a pick goes to the creatures picked for this effect (engine/side-targets.mjs); none yet: one
    // placeholder row on the user's own row. "area": the creatures inside the area the use placed, never the user.
    const picked = effect.targets === "pick" ? Object.entries(targets).filter(([, t]) => t.picked?.includes(effect.id)) : null;
    const placeholder = !!picked && !picked.length;
    const toSelf = effect.targets === "self" || effect.type === "summon" || effect.type === "zone" || placeholder;
    const recipients = toSelf
      ? (selfKey ? [[selfKey, { ...targets[selfKey], tier: self.tier, partId: self.partId, ambiguous: self.ambiguous }]] : [])
      : picked ?? (effect.targets === "area"
        ? Object.entries(targets).filter(([k, t]) => !!t.area && k !== selfKey)
        : Object.entries(targets).filter(([, t]) => !sideOnly(t)));
    if (toSelf && !selfKey) {
      warnOnce("selfMissing");
      continue;
    }
    for (const [key, t] of recipients) {
      if (effect.filter && effect.targets !== "self" && !placeholder) {
        const ally = isAlly(t, userRecord);
        if ((effect.filter === "allies") !== ally) continue;
      }
      const tier = t.tier ?? null;
      if (effect.tiers?.length && (tier == null || !effect.tiers.includes(tier))) continue;
      if (tier == null && !noPowerRoll && effect.targets !== "self") continue; // no tier yet: native warns
      const actor = fromUuidSync(t.actorUuid);
      if (!actor) continue;
      const eff = effectForTier(effect, tier);
      const kind = LIB_KIND_MODE[effect.type];
      let mode = effect.type === "note" ? "manual" : decideMode(kind, actor, t.tokenUuid ?? null);
      if (mode === "off") continue;
      if (eff.manual && mode === "auto") mode = "manual";
      const ctx = { tier, spend, config: lib.config, target: actor };
      const id = opId("lib", effect.entryId ?? effect.id, tier ?? 0, key);
      const base = {
        opId: id, order: order++, mode, status: OP_STATUS.PENDING, lib: true, libEffect: effect.id,
        libType: effect.type, tier, partId: t.partId ?? null, targetKeys: [key], self: toSelf,
      };
      if (eff.label) base.label = eff.label;
      // Potency gates conditions, movement and damage: the target must fail.
      let potency = null;
      if (eff.potency && effect.targets !== "self" && !placeholder) {
        potency = potencyOf(eff.potency, item, actor, ctx);
        if (potency) base.potency = potency;
      }
      const resisted = potency && setting("potencyGate") && !potency.fails;
      let op = null;
      // Milestone 9: the damage type the picker chose for this creature (pick.damageTypes).
      const pickedType = t.pickDamageTypes?.[effect.id] ?? null;
      if (placeholder) op = pickRow(base, effect, eff, item, t, ctx, { targets, selfKey });
      else switch (effect.type) {
        case "damage": op = damageRow(base, pickedType ? { ...eff, damageType: pickedType } : eff, item, actor, ctx); break;
        case "heal": op = healRow(base, eff, item, actor, ctx, eff.spender === "self" ? fromUuidSync(userRecord?.actorUuid ?? "") : null); break;
        case "condition": op = conditionRow(base, eff, item, actor, use); break;
        case "cleanse": op = cleanseRow(base, eff, actor); break;
        case "resource": op = resourceRow(base, eff, item, actor, ctx); break;
        case "teleport": op = teleportRow(base, eff, item, t, ctx); break;
        case "note": op = { ...base, kind: "note", noApply: true, text: eff.text }; break;
        case "modifier": op = modifierRow(base, eff, effect, item, ctx); break;
        case "summon": op = summonRow(base, eff, item, t, ctx, { targets, selfKey }); break;
        case "zone": op = zoneRow(base, eff, item, t, ctx, { selfKey }); break;
        case "forced": {
          const movements = Array.isArray(eff.movement) ? [...eff.movement] : [eff.movement];
          const props = [...(eff.properties ?? [])];
          if (eff.vertical) props.push("vertical");
          if (eff.ignoresStability) props.push("ignoresImmunity");
          // Distance with the library's formula data (@tier, @spend, @config, @target); potency gated above.
          const distance = evaluateInt(eff.distance, item, ctx, { min: 0, max: 50 });
          if (distance == null) {
            op = { ...base, kind: "forced", status: OP_STATUS.FAILED, reason: "formulaInvalid", movements, distances: {} };
            break;
          }
          const td = { movements, distance: String(distance), properties: props, potency: { characteristic: "", value: "" } };
          op = forcedRow({ eff: { preId: `lib-${effect.id}`, bonuses: {} }, td, actor, target: t, key, mode, id });
          if (op) Object.assign(op, { lib: true, libEffect: effect.id, libType: "forced", order: base.order, self: base.self, potency: base.potency ?? null });
          break;
        }
      }
      if (!op) continue;
      if (resisted && op.status === OP_STATUS.PENDING) Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "resisted" });
      if (chooseGated && op.mode === "auto") {
        op.mode = "prompt";
        warnOnce("dsctChoose");
      }
      if (effect.choice && !group && op.mode === "auto") op.mode = "manual";
      if (group) {
        op.choice = { group: group.id, option: effect.choice.option };
        if (op.status === OP_STATUS.PENDING) op.awaitingChoice = true;
        usedChoices[group.id] = { id: group.id, label: group.label ?? null, options: group.options, picked: null };
      }
      if (t.ambiguous && ambiguousSafe && op.mode === "auto") op.mode = "manual";
      if (op.self) usesSelf = true;
      // Squad ops collect their minions under one id.
      if (op.group && ops[op.opId]) {
        ops[op.opId].targetKeys.push(key);
        order--;
        continue;
      }
      ops[op.opId] = op;
      if (op.kind === "teleport" && op.selfMove && eff.hideAfter) {
        const hideId = opId("lib", `${effect.entryId ?? effect.id}-hide`, tier ?? 0, key);
        ops[hideId] = {
          ...base, opId: hideId, order: order++, kind: "hide", teleportOpId: op.opId,
          mode: "manual", whileObserved: !!eff.hideWhileObserved, hideSurge: eff.hideSurge ?? 0,
          rewardMode: decideMode("resource", actor, t.tokenUuid ?? null),
          status: OP_STATUS.PENDING, reason: "awaitingTeleport",
          ...(op.choice ? { choice: op.choice, awaitingChoice: op.awaitingChoice } : {}),
        };
      }
    }
  }
  return { ops, order, usesSelf, choices: usedChoices };
}

function potencyOf(potency, item, actor, ctx) {
  const chr = potency.characteristic;
  if (!chr || !actor?.system?.characteristics?.[chr]) return null;
  const base = evaluateInt(potency.value, item, ctx, { min: -10, max: 20 });
  const value = base == null ? null : base + auraPotencyBonus(item, actor);
  if (value == null) return null;
  let fails = null;
  try {
    fails = actor.checkPotency(value, chr);
  } catch (_err) {
    return null;
  }
  const c = actor.system.characteristics[chr];
  return { value, characteristic: chr, resist: (c.value ?? 0) + (c.resist ?? 0), fails: !!fails };
}

/** Minions in one squad share one pool write (as native damage rows). */
function squadOfActor(actor) {
  try {
    if (!actor?.isMinion) return null;
    const groups = actor.system.combatGroups;
    if (groups?.size !== 1) return null;
    return actor.system.combatGroup ?? null;
  } catch (_err) {
    return null;
  }
}

function damageRow(base, eff, item, actor, ctx) {
  const amount = evaluateInt(eff.value, item, ctx);
  if (amount == null) return { ...base, kind: "damage", status: OP_STATUS.FAILED, reason: "formulaInvalid", amount: 0 };
  const op = { ...base, kind: "damage", amount, type: eff.damageType ?? "", ignoredImmunities: [...(eff.ignoredImmunities ?? [])], aoe: false };
  const squad = squadOfActor(actor);
  if (squad) {
    return { ...op, opId: opId("lib", base.libEffect, base.tier ?? 0, "group", squad.id), group: squad.uuid, groupName: squad.name };
  }
  try {
    const { immunity = 0, weakness = 0 } = actor.system.calculateImmunityAndWeakness?.({ type: op.type, ignoredImmunities: [...op.ignoredImmunities] }) ?? {};
    Object.assign(op, { immunity, weakness, finalAmount: Math.max(0, amount + weakness - immunity) });
  } catch (_err) { /* objects */ }
  return op;
}

function healRow(base, eff, item, actor, ctx, spender = null) {
  if (eff.recoveries) {
    const op = { ...base, kind: "heal", recoveries: eff.recoveries };
    // The user pays the Recovery and the target regains the user's recovery value.
    if (eff.spender === "self") {
      if (!spender) return { ...op, amount: 0, status: OP_STATUS.SKIPPED, reason: "noRecoveries" };
      op.spenderUuid = spender.uuid;
      const rec = spender.system?.recoveries;
      if (!rec || !("value" in rec)) return { ...op, amount: 0, status: OP_STATUS.SKIPPED, reason: "noRecoveries" };
      op.amount = eff.recoveries * (Number(rec.recoveryValue ?? 0) || 0);
      if (actor.isMinion) return { ...op, status: OP_STATUS.SKIPPED, reason: "minionHeal" };
      return op;
    }
    const rec = actor.system?.recoveries;
    if (!rec || !("value" in rec)) return { ...op, amount: 0, status: OP_STATUS.SKIPPED, reason: "noRecoveries" };
    op.amount = eff.recoveries * (Number(rec.recoveryValue ?? 0) || 0);
    if (actor.isMinion) return { ...op, status: OP_STATUS.SKIPPED, reason: "minionHeal" };
    return op;
  }
  // A target's own values come from its roll data (`@target.recoveries.recoveryValue`).
  const amount = evaluateInt(eff.value, item, ctx, {});
  const kind = eff.temporary ? "temp" : "heal";
  if (amount == null) return { ...base, kind, amount: 0, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  const op = { ...base, kind, amount };
  if (actor.isMinion) return { ...op, status: OP_STATUS.SKIPPED, reason: "minionHeal" };
  if (kind === "temp" && amount < (actor.system?.stamina?.temporary ?? 0)) return { ...op, status: OP_STATUS.SKIPPED, reason: "tempNotHigher" };
  return op;
}

function conditionRow(base, eff, item, actor, _use) {
  const source = eff.status ? { status: eff.status } : eff.effect ? { effect: eff.effect } : { uuid: eff.uuid };
  const effectId = eff.status ?? eff.effect ?? eff.uuid;
  const targeted = !!eff.status && !!ds.CONFIG.conditions?.[eff.status]?.targeted;
  const display = eff.uuid ? { statusId: null, name: eff.label ?? "", img: null } : effectDisplay(item, effectId);
  const op = {
    ...base, kind: "condition", effectId, libSource: source, end: eff.end ?? "", stacking: !!eff.stacking, until: eff.until ?? null,
    originDuration: false, targeted, display, condition: eff.potency ? "failure" : "always", temporaryStamina: eff.temporaryStamina ?? null,
  };
  const statuses = eff.status ? [eff.status] : (eff.effect ? [...(item?.effects?.get?.(eff.effect)?.statuses ?? [])] : []);
  const immunities = actor?.system?.statuses?.immunities;
  if (statuses.length && typeof immunities?.has === "function" && statuses.every(s => immunities.has(s))) {
    return { ...op, status: OP_STATUS.SKIPPED, reason: "statusImmune" };
  }
  if (eff.effect && !item?.effects?.get?.(eff.effect)) return { ...op, status: OP_STATUS.FAILED, reason: "effectMissing" };
  if (eff.status && !statusConfig(eff.status)) return { ...op, status: OP_STATUS.FAILED, reason: "effectMissing" };
  if (targeted) {
    // Milestone 8 (§1.4): the same route as native rows (Combat Tools, our own effect, or a manual row).
    const route = targetedRoute(eff.status);
    if (route === "off") return { ...op, mode: "manual", noApply: true, reason: "targetedManual" };
    op.route = route;
    if (eff.status === "grabbed" && !setting("autoGrab") && op.mode === "auto") op.mode = "prompt";
  }
  return op;
}

function cleanseRow(base, eff, actor) {
  const spec = { statuses: [...(eff.statuses ?? [])], ends: [...(eff.ends ?? [])] };
  const op = { ...base, kind: "cleanse", ...spec, count: eff.count ?? null, afterMoveEffect: eff.afterMove ?? null };
  const found = cleanseCandidates(actor, spec).length;
  op.candidates = found;
  if (!found) {
    const seen = cleanseSeen(actor);
    log("cleanse.none", { opId: op.opId, actor: actor?.name ?? null, statuses: spec.statuses, ends: spec.ends, seen, at: "plan" });
    return { ...op, status: OP_STATUS.SKIPPED, reason: "nothingToEnd", seen };
  }
  // More effects than may end: someone chooses which (Apply asks); never by itself.
  if (op.count != null && found > op.count) op.reason = "chooseEffects";
  return op;
}

function resourceRow(base, eff, item, actor, ctx) {
  const amount = evaluateInt(eff.value, item, ctx, { min: -50, max: 50 });
  const op = { ...base, kind: "resource", resource: eff.resource, amount: amount ?? 0 };
  if (amount == null) return { ...op, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  if (!resourcePath(actor, eff.resource)) return { ...op, status: OP_STATUS.SKIPPED, reason: "noResource" };
  if (!amount) return { ...op, status: OP_STATUS.SKIPPED, reason: "nothingGained" };
  return op;
}

function teleportRow(base, eff, item, target, ctx) {
  const distance = evaluateInt(eff.distance, item, ctx, { min: 0, max: 100 });
  const op = { ...base, kind: "teleport", distance: distance ?? 0, teleportMode: eff.mode ?? "normal", selfMove: base.self, interactive: true, autoStart: eff.autoStart !== false };
  // Milestone 9 (D6): the mover may spend a resource for extra squares (asked in the teleport step, checked on the GM).
  if (eff.boost && base.self) {
    const b = eff.boost;
    op.boost = { resource: b.resource, per: Number(b.per) || 1, max: Number.isInteger(b.max) ? b.max : null, label: b.label ?? null };
  }
  if (distance == null) return { ...op, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  if (!target.tokenUuid) return { ...op, status: OP_STATUS.SKIPPED, reason: "notOnCanvas" };
  // The square is picked on the canvas: never by itself.
  if (op.mode === "auto" && !op.autoStart) op.mode = "manual";
  return op;
}

/**
 * Milestone 9 (D1): a modifier row: an ActiveEffect on the creature that changes one property (engine/modifiers.mjs
 * applyModifier, as a feature rule's modifier), ended by `end` (applyRuleDuration: "nextTurnEnd" is the creature's own
 * next turn). Potency was checked by the common block.
 */
function modifierRow(base, eff, effect, item, ctx) {
  const value = evaluateInt(eff.value, item, ctx, { min: -50, max: 50 });
  const op = {
    ...base, kind: "modifier", property: eff.key, value: value ?? 0, modifierMode: eff.mode ?? "add", modifierId: effect.id,
    featureItemUuid: item?.uuid ?? null, ruleId: "lib", featureEnd: eff.end ?? "", label: eff.label ?? item?.name ?? "",
  };
  if (value == null) return { ...op, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  return op;
}

/**
 * Milestone 9 (D2): the placeholder of a `targets: "pick"` effect on the user's row `t` while nobody was picked. The
 * user's owner picks on their client (ui/target-pick.mjs offerPicks), or presses the row's Pick button; the GM checks
 * the answer (engine.mjs recordPick) and resolves again, which plans the real rows for the picked creature(s). It is
 * measured from the user's token (`of: "self"`) or the card's first real target (`of: "target"`). Never applied.
 */
/** The card's first real target record entry `[key, record]` (pickRow's `of: "target"` anchor), or null. */
function firstTargetEntry(targets, selfKey) {
  return Object.entries(targets ?? {}).find(([k, r]) => r?.tokenUuid && !sideOnly(r) && (k !== selfKey || r.alsoTarget)) ?? null;
}

const tokenDoc = uuid => {
  try { return uuid ? fromUuidSync(uuid) : null; } catch (_err) { return null; }
};

/** 1.1.1 `when.alliesNearTarget`: does the user have an ally within that many squares of the card's first target? */
function alliesNearTarget(formula, { item, targets, selfKey, userRecord, spend, config }) {
  const anchor = tokenDoc(firstTargetEntry(targets, selfKey)?.[1]?.tokenUuid);
  const user = tokenDoc(userRecord?.tokenUuid);
  const within = evaluateInt(formula, item, { spend, config }, { min: 0, max: 100 });
  if (!anchor || !user || within == null) return false;
  return alliesNear(anchor, user, within, { userActorUuid: userRecord?.actorUuid ?? null }).length > 0;
}

function pickRow(base, effect, eff, item, t, ctx, { targets, selfKey }) {
  const p = eff.pick ?? effect.pick ?? {};
  const of = p.of === "target" ? "target" : "self";
  const anchorEntry = of === "target" ? firstTargetEntry(targets, selfKey) : null;
  const anchor = of === "target" ? (anchorEntry?.[1]?.tokenUuid ?? null) : (t.tokenUuid ?? null);
  const within = evaluateInt(p.within, item, ctx, { min: 0, max: 100 });
  const op = {
    ...base, opId: opId("lib", `${effect.entryId ?? effect.id}-pick`, 0, selfKey), kind: "pick", mode: "manual", noApply: true,
    status: OP_STATUS.PENDING, reason: "pickTargets", self: true, targetKeys: [selfKey], anchorKey: anchorEntry?.[0] ?? null,
    label: eff.label ?? base.label ?? item?.name ?? "",
    pick: {
      effectId: effect.id, effectType: effect.type, count: Number.isInteger(p.count) ? p.count : 1, within: within ?? 0, of,
      filter: p.filter ?? null, damageTypes: [...(p.damageTypes ?? [])], anchorTokenUuid: anchor,
      ...(p.flanking ? { flanking: true } : {}),
    },
  };
  delete op.potency;
  if (within == null) return { ...op, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  if (!anchor && of === "target") return { ...op, status: OP_STATUS.SKIPPED, reason: "noAnchor" };
  if (!anchor) return { ...op, status: OP_STATUS.SKIPPED, reason: "noSourceToken" };
  // 1.1.1: a flanking pick is offered only while the user flanks the anchor (the candidates: ui/target-pick.mjs).
  if (p.flanking && !isFlanking(tokenDoc(t.tokenUuid), tokenDoc(anchor))) return { ...op, status: OP_STATUS.SKIPPED, reason: "notFlanking" };
  return op;
}

/* -------------------------------------------- */
/*  Summon (Milestone 6)                        */
/* -------------------------------------------- */

/** Distance kinds whose primary value is a range in squares (the system's ability distance types). */
const RANGED_DISTANCES = new Set(["melee", "ranged", "aura", "burst"]);

/**
 * The ability's own distance in squares (a summon effect without `distance`), or null when its distance type gives
 * none (special, self, missing). The range field per type (DSM config.abilities.distances): melee / ranged / aura /
 * burst primary; cube and wall secondary ("3 cube within 10"); line tertiary (primary x secondary is the area).
 * meleeRanged: the larger of the two.
 */
export function abilityDistance(item) {
  const d = item?.system?.distance;
  if (!d) return null;
  const at = f => evaluateInt(f, item, {}, { min: 0, max: 100 });
  if (RANGED_DISTANCES.has(d.type)) return at(d.primary);
  if (d.type === "cube" || d.type === "wall") return at(d.secondary);
  if (d.type === "line") return at(d.tertiary);
  if (d.type === "meleeRanged") {
    const both = [at(d.primary), at(d.secondary)].filter(v => v != null);
    return both.length ? Math.max(...both) : null;
  }
  return null;
}

/** Name of a compendium document from its pack index (sync; resolve-time preparation fills it anyway). */
function packIndexName(uuid) {
  const m = /^Compendium\.([\w-]+)\.([\w-]+)\.Actor\.([A-Za-z0-9]{16})$/.exec(String(uuid ?? ""));
  if (!m) return null;
  try {
    return game.packs?.get?.(`${m[1]}.${m[2]}`)?.index?.get?.(m[3])?.name ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * The summon row (docs/M6-DESIGN.md §1.3, §3.1) on the user's own record `t`. The anchor of `origin: "target"` is the
 * card's first real target; its key stays on noPowerRoll cards (engine prune). Never automatic: placed on the canvas.
 */
function summonRow(base, eff, item, t, ctx, { targets, selfKey }) {
  const pick = (k) => (eff[k] ?? SUMMON_DEFAULTS[k]);
  const labels = new Map();
  const uuids = [];
  for (const a of eff.actors ?? []) {
    const u = summonActorUuid(typeof a === "string" ? a : a?.uuid);
    if (!u || labels.has(u)) continue;
    labels.set(u, (typeof a === "object" && a?.label) || null);
    uuids.push(u);
  }
  const qty = evaluateInt(eff.quantity ?? SUMMON_DEFAULTS.quantity, item, ctx, { min: 1, max: 10 });
  const dist = eff.distance != null ? evaluateInt(eff.distance, item, ctx, { min: 0, max: 100 }) : abilityDistance(item);
  const origin = pick("origin") === "target" ? "target" : "self";
  const anchorRec = origin === "self" ? null
    : (Object.entries(targets ?? {}).find(([k, r]) => r?.tokenUuid && (k !== selfKey || r.alsoTarget))?.[1] ?? null);
  const anchor = origin === "self" ? t.tokenUuid : anchorRec?.tokenUuid;
  const op = {
    ...base, kind: "summon", interactive: true, self: true, targetKeys: [selfKey],
    choices: uuids.map(u => ({
      uuid: u, name: packIndexName(u) ?? "", img: null, width: 1, height: 1, isMinion: false, worldActorId: null, label: labels.get(u),
    })),
    quantity: qty ?? 1, distance: dist ?? null, origin, anchorTokenUuid: anchor ?? null, anchorKey: anchorRec?.key ?? null,
    summonerTokenUuid: t.tokenUuid ?? null, summonerActorUuid: t.actorUuid ?? null, itemUuid: item?.uuid ?? null,
    sourceUuid: summonSourceUuid(item),
    side: pick("side"), turn: pick("turn"), actsThisRound: pick("actsThisRound") !== false, squad: pick("squad"),
    lasts: [...(pick("lasts") ?? [])], upkeep: pick("upkeep") ?? null, carryStamina: !!pick("carryStamina"), lockOnZero: !!pick("lockOnZero"),
  };
  // Picked on the canvas: never by itself (as teleportRow).
  if (op.mode === "auto") op.mode = "prompt";
  if (!uuids.length) return { ...op, status: OP_STATUS.FAILED, reason: "noWorldActor" };
  if (qty == null || (eff.distance != null && dist == null)) return { ...op, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  if (dist == null) return { ...op, status: OP_STATUS.FAILED, reason: "noDistance" };
  // Review fix: a summon has one token and needs nobody's view; with no summoner token the row can never be placed
  // (its summonerTokenUuid is fixed at plan time), so no Summon button either.
  if (!t.tokenUuid) return { ...op, status: OP_STATUS.SKIPPED, reason: "noSummonerToken", noApply: true };
  if (origin === "target" && !anchor) return { ...op, status: OP_STATUS.SKIPPED, reason: "noAnchor" };
  let locked = false;
  try {
    locked = op.lockOnZero && isSummonLocked(item, item?.actor);
  } catch (_err) { /* no item state */ }
  if (locked) return { ...op, status: OP_STATUS.SKIPPED, reason: "summonLocked" };
  return op;
}

/** An array of a zone field that may come as an array, a Set (detached entries) or be absent. */
const listOf = (v, fallback) => (v == null ? [...(fallback ?? [])] : [...(v instanceof Set ? v : (Array.isArray(v) ? v : [v]))]);

/**
 * The zone row (docs/M7-DESIGN.md §1.5, §3.10.1) on the user's own record `t`. Every absent zone field falls back to
 * ZONE_DEFAULTS (detached entries skip normalizeOverlay). Placed on the canvas by a click (burst and aura: the GM
 * builds them around the creator on Apply, `interactive: false`); Milestone 9: with `zoneMode` auto, resolveMessage
 * applies the row itself from the area drawn on use (zones/adopt.mjs) or around the creator.
 */
function zoneRow(base, eff, item, t, ctx, { selfKey }) {
  const pick = (k) => (eff[k] ?? ZONE_DEFAULTS[k]);
  const ev = f => evaluateInt(f, item, ctx, { min: 0, max: 200 });
  let area = null;
  try {
    area = zoneArea(item, { ...eff, shape: pick("shape") }, ev);
  } catch (_err) {
    area = null;
  }
  // Milestone 9: a terrain-only zone (no `value`) deals nothing, amount 0.
  const terrain = pick("terrain") || null;
  const amount = eff.value != null ? evaluateInt(eff.value, item, ctx, { min: 0, max: 200 }) : (terrain ? 0 : null);
  const keywords = item?.system?.keywords;
  const aoe = !!(keywords?.has?.("area") ?? (Array.isArray(keywords) && keywords.includes("area")));
  const upkeep = pick("upkeep");
  const op = {
    ...base, kind: "zone", self: true, targetKeys: [selfKey ?? base.targetKeys[0]],
    interactive: !!area && !["burst", "aura"].includes(area.shape),
    creatorTokenUuid: t.tokenUuid ?? null, creatorActorUuid: t.actorUuid ?? null, itemUuid: item?.uuid ?? null,
    label: eff.label || base.label || item?.name || "",
    zone: {
      area: area ?? null,
      events: listOf(eff.zoneEvents, ZONE_DEFAULTS.zoneEvents), once: pick("once"), onceShared: !!pick("onceShared"),
      perSquare: !!pick("perSquare"), amount: amount ?? 0, damageType: eff.damageType ?? "",
      ignoredImmunities: listOf(eff.ignoredImmunities, []), affects: pick("affects"),
      exceptKeywords: listOf(eff.exceptKeywords, ZONE_DEFAULTS.exceptKeywords),
      exceptMonsters: listOf(eff.exceptMonsters, ZONE_DEFAULTS.exceptMonsters),
      lasts: listOf(eff.lasts, ZONE_DEFAULTS.lasts), upkeep: Number.isFinite(Number(upkeep)) && Number(upkeep) > 0 ? Number(upkeep) : null,
      forcedCounts: pick("forcedCounts") !== false, aoe, terrain,
    },
  };
  // Milestone 9 (D-B2): an `auto` row stays auto here; resolveMessage applies it when its area needs no click
  // (drawn on use, or built around the creator) and writes it as `prompt` otherwise. `manual` stays manual.
  if (!area) return { ...op, status: OP_STATUS.FAILED, reason: "noArea" };
  if (amount == null || area.size == null || area.width == null || area.range == null) return { ...op, status: OP_STATUS.FAILED, reason: "formulaInvalid" };
  // Nothing to measure from: the row can never be placed.
  if (!t.tokenUuid) return { ...op, status: OP_STATUS.SKIPPED, reason: "noCreatorToken", noApply: true };
  return op;
}

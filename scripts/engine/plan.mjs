import { auraPotencyBonus } from "../features/auras.mjs";
/**
 * Plan builder: turns a card (targets + tiers) and the ability's effects into ops, one per
 * (damage roll, target or squad) and per (applied effect, target), each with its own mode.
 * Runs on the active GM only; the result is persisted and every client renders the stored record.
 * Milestone 8 (docs/M8-DESIGN.md §1.4, §3.1, §4.3): on a Draw Steel 1.2 card every target has its own result part,
 * so squad damage collapses across parts by (kind, squad, amount, type, AoE, ignored immunities); the card's manual
 * potency adjustments (`potencies` per PRE) add to the potency check; modes by creature type (`modeByActorType`,
 * engine/actor-category.mjs) replace the hero override; targeted conditions are routed (`targetedRoute`).
 */
import { OP_STATUS } from "../constants.mjs";
import { dsctConditionEnabled, dsctConditionsOn } from "../compat/dsct.mjs";
import { forcedDelegate, needsPick, sizeBonus, stabilityOf } from "../delegation/forced-movement.mjs";
import { setting } from "../settings.mjs";
import { opId } from "./keys.mjs";
import { REACTIVE_PART } from "./reactive.mjs";
import { areaOnly, pickedOnly } from "./record.mjs";
import { effectDisplay, effectStatuses, nativeEffects } from "./native.mjs";
import { effectShows } from "../library/choose-compat.mjs";
import { isAlly, libraryOps, resourcePath, userRecordOf } from "./library-plan.mjs";
import { dsctCoveredTypes } from "../library/resolve.mjs";
import { featureSettingKey, typeOverride, withTypeOverride } from "./actor-category.mjs";

/** Resources a native `resource` power-roll effect may give (Milestone 7, §3.6). */
const NATIVE_RESOURCES = new Set(["surge", "heroic", "epic"]);

/** Feature mode for an op kind. */
// Milestone 7: lasting areas ("zone": always placed by a click; auto acts as prompt in library-plan zoneRow).
function featureMode(kind) {
  return setting(featureSettingKey(kind));
}

/**
 * Where a targeted condition (frightened, taunted, grabbed) goes (§3.1, D12-D13): "dsct" (Combat Tools' flagged
 * effects, when `targetedConditions` is auto and its conditions handle this one), "native" (our own effect in the
 * system's representation, engine/targeted.mjs) or "off" (a manual row). Pure on the settings and compat.
 */
export function targetedRoute(statusId) {
  const s = setting("targetedConditions") ?? "auto";
  if (s === "off") return "off";
  if (s === "auto" && dsctConditionsOn() && dsctConditionEnabled(statusId)) return "dsct";
  return "native";
}

const MODE_RANK = { auto: 0, prompt: 1, manual: 2 };
/** The more restrictive of two modes (auto < prompt < manual). */
const stricter = (a, b) => ((MODE_RANK[b] ?? 0) > (MODE_RANK[a] ?? 0) ? b : a);

/** Is the actor a minion that the system routes to a single squad pool? (DamageRoll#applyDamage rule) */
export function squadOf(actor) {
  try {
    if (!actor?.isMinion) return null;
    const groups = actor.system.combatGroups;
    if (groups?.size !== 1) return null;
    return actor.system.combatGroup ?? null;
  } catch (_err) {
    return null;
  }
}

function minionWarning(actor) {
  try {
    if (!actor?.isMinion) return null;
    const size = actor.system.combatGroups?.size ?? 0;
    if (size === 0) return "minionNoSquad";
    if (size > 1) return "minionMultiSquad";
  } catch (_err) { /* ignore */ }
  return null;
}

/**
 * Potency check of one applied effect against one target. `bonus`: the card's manual adjustment for this PRE on the
 * target's 1.2 part (`potencies`, the system's "Adjust potency"), added to the value.
 * @returns {{gated: boolean, value?: number, characteristic?: string, resist?: number, fails?: boolean}}
 */
export function evaluatePotency(eff, item, actor, bonus = 0) {
  const chr = eff.potency?.characteristic;
  const real = !!chr && chr !== "none" && !!actor?.system?.characteristics?.[chr];
  if (!real || !eff.potency?.value) return { gated: false, characteristic: chr || null };
  let value;
  try {
    value = Number(ds.utils.evaluateFormula(eff.potency.value, item.getRollData(), { contextName: item.uuid }));
  } catch (_err) {
    return { gated: false, characteristic: chr };
  }
  if (!Number.isFinite(value)) return { gated: false, characteristic: chr };
  value += (Number(bonus) || 0) + auraPotencyBonus(item, actor);
  let fails = null;
  try {
    fails = actor.checkPotency(value, chr); // true = the target fails the potency check
  } catch (_err) {
    fails = null;
  }
  if (fails === null) return { gated: false, characteristic: chr };
  const c = actor.system.characteristics[chr];
  return { gated: true, value, characteristic: chr, resist: (c.value ?? 0) + (c.resist ?? 0), fails: !!fails, bonus: Number(bonus) || 0 };
}

/** The stored potency of a row (with the card's adjustment only when there is one: older records stay unchanged). */
function potencyRecord(p) {
  if (!p?.gated) return null;
  const out = { value: p.value, characteristic: p.characteristic, resist: p.resist, fails: p.fails };
  if (p.bonus) out.bonus = p.bonus;
  return out;
}

/** Is the actor immune to all of these statuses? False for an effect without statuses. */
export function statusImmune(actor, statuses) {
  const immunities = actor?.system?.statuses?.immunities;
  if (!statuses?.length || typeof immunities?.has !== "function") return false;
  return statuses.every(id => immunities.has(id));
}

/** Does the effect apply given its potency condition? Returns {applies, warning?}. */
export function potencyApplies(eff, potency) {
  if (!setting("potencyGate") || !potency.gated) return { applies: true };
  let cond = eff.condition || "always";
  let warning = null;
  if (cond === "always") {
    // `condition` defaults to "always" in the schema while the sheet writes "failure" for new entries
    // (draw-steel.mjs:20574-20579 vs 27322-27342). An "always" entry with a real potency characteristic
    // is treated as "failure" unless the setting says otherwise.
    warning = "conditionAlwaysWithPotency";
    if (!setting("potencyAlwaysMeansFailure")) return { applies: true, warning };
    cond = "failure";
  }
  const applies = cond === "failure" ? potency.fails : !potency.fails;
  return { applies, warning };
}

/**
 * Build the plan.
 * @param {object} args
 * @param {ChatMessage} args.message
 * @param {Item} args.item                 The ability.
 * @param {Record<string, object>} args.targets   Target records keyed by target key (with tier info merged).
 * @param {boolean} args.forceManual       Private card, unknown shape or a vetoing preResolve hook.
 * @param {boolean} [args.playerAuthored]  The card's author is not a GM (setting playerAuthoredMode).
 * @param {string|null} [args.sourceTokenUuid]  The ability user's token (forced movement origin).
 * @param {number[]|null} [args.spend]     `@spend` values chosen in the roll dialog (engine/spend.mjs).
 * @param {object|null} [args.lib]         The ability's library resolution (library/resolve.mjs, Milestone 4).
 * @param {object|null} [args.assignment]  Combat Tools "choose one" picks (library/choose-compat.mjs).
 * @param {{spend: boolean, strained: boolean}} [args.use]  Special effects the card shows.
 * @param {string|null} [args.selfKey]     Target key of the ability's user (library "self" effects).
 * @param {object} [args.self]             Tier for effects on the user (library-plan cardTier).
 * @param {boolean} [args.noPowerRoll]     The ability has no power roll: targets have no tier.
 * @returns {{ops: Record<string, object>, warnings: object[], modes: object, choices: object, usesSelf: boolean}}
 */
export function buildPlan({
  message, item, targets, forceManual = false, startOrder = 0, playerAuthored = false, sourceTokenUuid = null, spend = null,
  lib = null, assignment = null, use = { spend: false, strained: false }, selfKey = null, self = { tier: null, partId: null }, noPowerRoll = false,
}) {
  const ops = {};
  const warnings = [];
  const native = nativeEffects(item);
  // An overlay may replace native effects; Combat Tools' picks drop the effects of unpicked choices.
  const suppressed = lib?.suppress ?? new Set();
  const picked = assignment?.picked ? assignment : null;
  const nativeShows = (preId, name) => !suppressed.has(preId) && effectShows(name, picked);
  native.conditions = native.conditions.filter(e => nativeShows(e.preId, e.preName));
  native.forced = native.forced.filter(e => nativeShows(e.preId, e.name));
  native.resources = (native.resources ?? []).filter(e => nativeShows(e.preId, e.name));
  // Milestone 7: Combat Tools' flat resource automation keeps priority (no native resource rows).
  const dsctResources = native.resources.length && setting("libraryDefersToCombatTools") && dsctCoveredTypes(item).has("resource");
  // Picks on the card make the old "choose" gate unnecessary for what is left.
  if (picked) native.chooseGated = false;
  // `native.filter`: the native rows are for one side only (an ability that spares allies). The other
  // side's rows stay on the card, skipped, so the Director can still apply one by hand.
  const nativeFilter = lib?.nativeFilter ?? null;
  const userRecord = nativeFilter ? userRecordOf({ targets, selfKey, sourceTokenUuid, item }) : null;
  // A disabled ability (medkit) keeps its rows but applies nothing by itself.
  if (lib?.disabled) forceManual = true;
  let order = startOrder;
  const heroOverride = setting("heroOverride") ?? "inherit";
  const byType = setting("modeByActorType") ?? null;
  const playerCap = playerAuthored ? (setting("playerAuthoredMode") ?? "inherit") : "inherit";
  const modes = {
    damage: setting("damageMode"), healing: setting("healingMode"), conditions: setting("conditionsMode"),
    forced: setting("forcedMovementMode"), resources: setting("resourceMode"), summons: setting("summonMode"), heroOverride, playerAuthored: playerAuthored ? playerCap : null,
    byType: byType && typeof byType === "object" ? { ...byType } : null,
  };

  // Feature mode, then the override for the target's creature type (heroOverride as the heroes' fallback, §4.3),
  // then the player-card cap (never looser).
  const decideMode = (kind, actor, tokenUuid = null) => {
    const base = featureMode(kind);
    if (base === "off") return "off";
    if (forceManual) return "manual";
    let mode = withTypeOverride(base, typeOverride(actor, tokenUuid, byType, heroOverride));
    if (playerCap !== "inherit" && !["forced", "teleport"].includes(kind)) mode = stricter(mode, playerCap);
    return mode;
  };

  for (const [key, t] of Object.entries(targets)) {
    // The user's own row (library "self" effects) has no native rows unless they targeted themselves.
    if (key === selfKey && !t.alsoTarget) continue;
    // Milestone 9: a picked or area-only creature gets library rows only (no native rows, no "no tier" warning).
    if (pickedOnly(t) || areaOnly(t)) continue;
    if (t.tier == null) {
      // 1.1.0: a reactive target waiting for its test is no warning (the row says so).
      if (!noPowerRoll && !t.awaitingTest) warnings.push({ code: "noTier", targetKey: key });
      continue;
    }
    const actor = fromUuidSync(t.actorUuid);
    if (!actor) {
      warnings.push({ code: "targetMissing", targetKey: key });
      continue;
    }
    const ambiguous = !!t.ambiguous && setting("mixedTierSafety");
    const filteredOut = !!nativeFilter && (nativeFilter === "allies") !== isAlly(t, userRecord);
    const firstOwn = new Set(Object.keys(ops));
    if (t.ambiguous) warnings.push({ code: "ambiguousTier", targetKey: key });
    // 1.1.0: a reactive target's damage comes from its test's tier (reactive.mjs), kept on the target record.
    const reactive = t.partId === REACTIVE_PART;
    const part = reactive ? null : message.system.parts.get(t.partId);
    const rolls = reactive ? t.reactiveRolls : part?.rolls;

    // Damage, healing and temporary stamina: one op per damage roll in the target's tier part.
    for (const rollIndex of t.damageRollIndexes ?? []) {
      const roll = rolls?.[rollIndex];
      if (!roll) continue;
      const kind = roll.isHeal ? (roll.type === "value" ? "heal" : "temp") : "damage";
      let mode = decideMode(kind, actor, t.tokenUuid);
      if (mode === "off") continue;
      if (ambiguous && mode === "auto") mode = "manual";
      const base = {
        kind, mode, partId: t.partId, rollIndex, tier: t.tier,
        nativeSurges: Number(roll.options?.dsAutoNativeSurges ?? 0), amount: roll.total, type: roll.type ?? "", ignoredImmunities: [...(roll.ignoredImmunities ?? [])],
        aoe: !!roll.aoe, status: OP_STATUS.PENDING, ...(reactive ? { reactive: true } : {}),
      };
      const squad = squadOf(actor);
      if (squad && filteredOut) continue;
      if (squad) {
        // 1.2 cards: one part (and one damage roll) per minion, so a squad's op collects every member whose roll
        // matches (one takeDamage per squad: immunity and the AoE cap once, D5) and keeps every member's part. 1.1.2
        // cards keep the per-part key (stored records stay valid).
        const perTarget = part?.type === "targetResult";
        const id = perTarget
          ? opId(kind, "sq", squad.id, roll.total, roll.type || "untyped", roll.aoe ? 1 : 0, [...(roll.ignoredImmunities ?? [])].sort().join("+") || "none")
          : opId(kind, t.partId, rollIndex, "group", squad.id);
        if (!ops[id]) {
          ops[id] = { ...base, opId: id, order: order++, targetKeys: [], group: squad.uuid, groupName: squad.name };
          if (perTarget) ops[id].parts = [];
          if (roll.isHeal) Object.assign(ops[id], { status: OP_STATUS.SKIPPED, reason: "minionHeal" });
        }
        ops[id].targetKeys.push(key);
        if (perTarget) ops[id].parts.push({ partId: t.partId, rollIndex, targetKey: key });
        continue;
      }
      const warn = minionWarning(actor);
      if (warn) warnings.push({ code: warn, targetKey: key });
      const id = opId(kind, t.partId, rollIndex, key);
      const op = { ...base, opId: id, order: order++, targetKeys: [key] };
      if (kind === "damage") {
        try {
          const { immunity = 0, weakness = 0 } = actor.system.calculateImmunityAndWeakness?.({
            type: op.type, ignoredImmunities: [...op.ignoredImmunities],
          }) ?? {};
          Object.assign(op, { immunity, weakness, finalAmount: Math.max(0, op.amount + weakness - immunity) });
        } catch (_err) { /* objects without damage data */ }
      } else if (kind === "temp" && op.amount < (actor.system.stamina?.temporary ?? 0)) {
        Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "tempNotHigher" });
      }
      ops[id] = op;
    }

    // Applied effects of this tier.
    for (const eff of native.conditions) {
      if (eff.tier !== t.tier) continue;
      let mode = decideMode("condition", actor, t.tokenUuid);
      if (mode === "off") continue;
      const targeted = !!ds.CONFIG.conditions?.[eff.effectId]?.targeted;
      const potency = evaluatePotency(eff, item, actor, t.potencies?.[eff.preId] ?? 0);
      const { applies, warning } = potencyApplies(eff, potency);
      const id = opId("condition", t.partId, eff.preId, eff.effectId, key);
      if (warning) warnings.push({ code: warning, opId: id });
      const op = {
        opId: id, order: order++, kind: "condition", mode, status: applies ? OP_STATUS.PENDING : OP_STATUS.SKIPPED,
        partId: t.partId, preId: eff.preId, effectId: eff.effectId, tier: t.tier, targetKeys: [key],
        condition: eff.condition, end: eff.end, originDuration: eff.originDuration, targeted,
        display: effectDisplay(item, eff.effectId),
        potency: potencyRecord(potency),
      };
      if (!applies) op.reason = "resisted";
      // Immune to every status the effect carries (system.statuses.immunities): the system would create
      // the effect with a warning and suppress the status (draw-steel.mjs:1391, 4134), so skip it.
      else if (statusImmune(actor, effectStatuses(item, eff.effectId))) Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "statusImmune" });
      if (targeted) {
        const route = targetedRoute(eff.effectId);
        if (route === "off") Object.assign(op, { mode: "manual", noApply: true, reason: op.reason ?? "targetedManual" });
        else {
          op.route = route;
          if (eff.effectId === "grabbed" && !setting("autoGrab") && op.mode === "auto") op.mode = "prompt";
        }
      }
      if (native.chooseGated && op.mode === "auto") {
        op.mode = "prompt";
        if (!warnings.some(w => w.code === "dsctChoose")) warnings.push({ code: "dsctChoose" });
      }
      if (ambiguous && op.mode === "auto") op.mode = "manual";
      ops[id] = op;
    }

    // Forced movement of this tier: one op per (forced effect, target).
    for (const eff of native.forced) {
      const td = eff.tiers[t.tier];
      if (!td) continue;
      const mode = decideMode("forced", actor, t.tokenUuid);
      if (mode === "off") continue;
      const op = buildForcedOp({ eff, td, item, actor, target: t, key, mode, sourceTokenUuid, spend, warnings });
      if (!op) continue;
      if (native.chooseGated && op.mode === "auto") {
        op.mode = "prompt";
        if (!warnings.some(w => w.code === "dsctChoose")) warnings.push({ code: "dsctChoose" });
      }
      if (ambiguous && op.mode === "auto") op.mode = "manual";
      op.order = order++;
      ops[op.opId] = op;
    }

    // Native resource gains of this tier (Milestone 7, §3.6): "gain N surges" for the target.
    for (const eff of dsctResources ? [] : native.resources) {
      const td = eff.tiers?.[t.tier];
      if (!td?.amount || !NATIVE_RESOURCES.has(td.type)) continue;
      const mode = decideMode("resource", actor, t.tokenUuid);
      if (mode === "off") continue;
      const id = opId("resource", t.partId, eff.preId, key);
      const op = {
        opId: id, order: order++, kind: "resource", native: true, preId: eff.preId, partId: t.partId, tier: t.tier, mode,
        status: OP_STATUS.PENDING, targetKeys: [key], resource: td.type, amount: td.amount,
      };
      if (!resourcePath(actor, td.type)) Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "noResource" });
      if (native.chooseGated && op.mode === "auto") {
        op.mode = "prompt";
        if (!warnings.some(w => w.code === "dsctChoose")) warnings.push({ code: "dsctChoose" });
      }
      if (ambiguous && op.mode === "auto") op.mode = "manual";
      ops[id] = op;
    }

    if (filteredOut) {
      for (const [id, op] of Object.entries(ops)) {
        if (firstOwn.has(id) || op.group || op.status !== OP_STATUS.PENDING) continue;
        if (nativeFilter === "enemies") Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "nativeSparesAllies" });
        else Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "nativeOnlyAllies" });
      }
    }
  }

  // Library effects (overlays, detached entries).
  let choices = {};
  let usesSelf = false;
  if (lib?.effects?.length) {
    const out = libraryOps({
      lib, item, targets, selfKey, self, use, assignment, spend, noPowerRoll, warnings, order, sourceTokenUuid,
      ambiguousSafe: setting("mixedTierSafety"),
      decideMode: (kind, actor, tokenUuid = null) => decideMode(kind, actor, tokenUuid),
      forcedRow: ({ eff, td, actor, target, key, mode, id }) => {
        const op = buildForcedOp({ eff, td, item, actor, target, key, mode, sourceTokenUuid, spend, warnings, id });
        if (op && native.chooseGated && op.mode === "auto") op.mode = "prompt";
        return op;
      },
    });
    Object.assign(ops, out.ops);
    order = out.order;
    choices = out.choices;
    usesSelf = out.usesSelf;
  }
  return { ops, warnings, modes, nextOrder: order, choices, usesSelf };
}

/** Evaluate a forced distance formula with the ability's roll data (and the dialog's `@spend`). */
export function forcedDistance(formula, item, spend = null) {
  try {
    const rollData = item.getRollData();
    if (spend) rollData.spend = spend;
    const value = Number(ds.utils.evaluateFormula(String(formula), rollData, { contextName: item.uuid }));
    return Number.isFinite(value) ? Math.floor(value) : null;
  } catch (_err) {
    return null;
  }
}

/**
 * The forced movement op of one target. Distances per movement type include the ability's bonuses
 * (kits) and the larger-creature bonus; stability is the delegate's job and only shown. A real potency
 * characteristic gates it like a "failure" effect: the target moves only when it fails.
 * Several movement types ("push or pull"), slides, vertical moves and the setting `forcedPath =
 * choose` need a choice on the canvas: such ops wait for the Director (prompt) and never apply by
 * themselves. Without a delegate for the move they are manual: the Director moves the token by hand.
 */
export function buildForcedOp({ eff, td, item, actor, target, key, mode, sourceTokenUuid, spend, warnings, id = null }) {
  id ??= opId("forced", target.partId, eff.preId, key);
  const base = forcedDistance(td.distance, item, spend);
  if (base == null) {
    warnings.push({ code: "forcedDistanceInvalid", opId: id });
    return null;
  }
  const sourceDoc = sourceTokenUuid ? fromUuidSync(sourceTokenUuid) : null;
  const bonus = sizeBonus(sourceDoc?.actor ?? item.actor, actor, item.system?.keywords);
  const distances = Object.fromEntries(td.movements.map(m => [m, Math.max(0, base + Number(eff.bonuses?.[m] ?? 0) + bonus)]));
  const props = new Set(td.properties);
  const vertical = props.has("vertical");
  const flying = !!actor.statuses?.has?.("fly");
  const choosePath = setting("forcedPath") === "choose";
  const interactive = td.movements.length > 1 || td.movements.some(m => needsPick({ movement: m, vertical, flying, choosePath }));
  // The card's potency adjustment counts for native PREs only (library rows carry a `lib-` id no part names).
  const potency = evaluatePotency({ potency: td.potency }, item, actor, target.potencies?.[eff.preId] ?? 0);
  const applies = !setting("potencyGate") || !potency.gated || potency.fails;
  const op = {
    opId: id, kind: "forced", mode, status: applies ? OP_STATUS.PENDING : OP_STATUS.SKIPPED,
    partId: target.partId, preId: eff.preId, tier: target.tier, targetKeys: [key],
    movements: [...td.movements], movement: td.movements.length === 1 ? td.movements[0] : null, distances,
    vertical, ignoreStability: props.has("ignoresImmunity") || props.has("ignore-stability"),
    properties: td.properties.filter(p => p.startsWith("no-")), sizeBonus: bonus || null,
    stability: stabilityOf(actor), interactive, flying: flying || null, choosePath: choosePath || null,
    potency: potencyRecord(potency),
  };
  if (!applies) op.reason = "resisted";
  else if (sourceDoc && sourceDoc.uuid === target.tokenUuid && !td.movements.includes("slide")) {
    Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "selfForced" });
  }
  const delegate = forcedDelegate({ interactive });
  op.delegate = delegate;
  if (!delegate) Object.assign(op, { mode: "manual", noApply: true, reason: op.reason ?? "moveByHand" });
  return op;
}

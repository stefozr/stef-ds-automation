/**
 * Condition appliers (active GM).
 *
 * Plain statuses and item-embedded effects go through the system's own
 * AppliedPowerRollEffect#applyEffect, called with ONE explicit target per call: this sidesteps the
 * system's `combatant ??=` bug that gives every target of a multi-target call the first target's
 * combatant (draw-steel.mjs:20755-20758), and explicit targets pass straight through Combat Tools'
 * MIXED wrapper (system-patches.mjs:275).
 *
 * Targeted statuses (frightened, taunted, grabbed) take their route (Milestone 8, docs/M8-DESIGN.md §3.1): the
 * plan's `op.route`, or for records planned before 0.10.0 the route of the current settings. "native" builds the
 * system's own representation (engine/targeted.mjs); otherwise they are delegated to Draw Steel: Combat Tools, which
 * models them as flagged effects with movement enforcement. DSCT sets only `duration.expiry`, so we add
 * `start.combatant` afterwards; core's turn-based expiry needs it (active-effect.mjs:930-948). The flagged effect
 * DSCT deletes is kept as `replaced` and a native static-id copy is deleted first (`replacedExtra`), both restored
 * on undo (D16).
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { dsctApi, dsctFlaggedEffect } from "../compat/dsct.mjs";
import { tokenIdFromUuid } from "./keys.mjs";
import { statusConfig } from "./native.mjs";
import { applyLibCondition } from "./library-apply.mjs";
import { applyNativeTargeted, routeFor } from "./targeted.mjs";

function combatantFor(actor) {
  return game.combat?.getCombatantsByActor?.(actor)?.[0] ?? null;
}

/** Expiry event for an effect end key ("turn" -> "turnEnd", "save" -> "save", ...). */
function expiryEvent(endKey) {
  return endKey ? (ds.CONFIG.effectEnds?.[endKey]?.expiryEvent ?? null) : null;
}

/**
 * Apply one condition op.
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function applyConditionOp(message, res, op) {
  // Library conditions (Milestone 4) have no power roll effect behind them.
  if (op.lib) {
    if (!op.targeted) return applyLibCondition(message, res, op);
    const item = await fromUuid(res.abilityUuid).catch(() => null);
    const target = res.targets?.[op.targetKeys[0]];
    const actor = fromUuidSync(target?.actorUuid);
    if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
    return applyTargeted(message, res, op, item, actor, target);
  }
  const item = await fromUuid(res.abilityUuid);
  const pre = item?.system?.power?.effects?.get(op.preId);
  const target = res.targets?.[op.targetKeys[0]];
  const actor = fromUuidSync(target?.actorUuid);
  if (!item || !pre || !actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const tierKey = `tier${op.tier}`;
  const cfg = pre.applied?.[tierKey]?.effects?.[op.effectId];
  if (!cfg) return { status: OP_STATUS.FAILED, reason: "effectMissing" };

  if (op.targeted) return applyTargeted(message, res, op, item, actor, target);

  // Which existing effect will the system replace? Statuses use a static id; non-stacking item
  // effects keep the item effect's id; stacking effects always create a new one.
  const status = statusConfig(op.effectId);
  const stacking = cfg.properties?.has?.("stacking");
  const replacedId = status ? (status._id ?? null) : (stacking ? null : op.effectId);
  const replaced = replacedId ? (actor.effects.get(replacedId)?.toObject() ?? null) : null;

  const created = await pre.applyEffect(tierKey, op.effectId, { targets: [actor] });
  const createdIds = [created].flat(Infinity).map(e => e?.id).filter(Boolean);
  if (!createdIds.length) return { status: OP_STATUS.FAILED, reason: "nothingCreated" };
  return { status: OP_STATUS.APPLIED, createdIds, replaced };
}

/** Fields of the native route cleared on a delegated apply (the row may have been applied natively before). */
const NOT_NATIVE = Object.freeze({ native: null, appended: null, idempotent: null, updatedId: null, sourceUuid: null, untilSet: null, endedReason: null });

async function applyTargeted(message, res, op, item, actor, target) {
  if ((op.route ?? routeFor(op.effectId)) === "native") return applyNativeTargeted(message, res, op, item, actor, target);
  const api = dsctApi();
  if (!api) return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  const sourceActor = fromUuidSync(res.sourceActorUuid) ?? item?.actor;
  if (!sourceActor) return { status: OP_STATUS.FAILED, reason: "sourceMissing" };
  const sourceTokenId = tokenIdFromUuid(res.sourceTokenUuid);
  const targetDoc = fromUuidSync(target.tokenUuid);
  if (!targetDoc) return { status: OP_STATUS.FAILED, reason: "targetMissing" };

  if (op.effectId === "grabbed") {
    // DSCT's grab works on placeables, so the GM must be viewing the target's scene.
    const targetTok = targetDoc.object;
    const sourceTok = fromUuidSync(res.sourceTokenUuid)?.object;
    if (!targetTok || !sourceTok) return { status: OP_STATUS.FAILED, reason: "notOnCanvas" };
    await api.grab(sourceTok, targetTok, { forceApply: true, tier: op.tier });
    if (!window._activeGrabs?.has?.(targetTok.id)) return { status: OP_STATUS.FAILED, reason: "delegateRefused" };
    return { ...NOT_NATIVE, status: OP_STATUS.APPLIED, delegated: "dsct-grab", grabbedTokenId: targetTok.id, createdIds: [], replaced: null, replacedExtra: [] };
  }

  // applyFrightened / applyTaunted only read `targetToken.actor` and `.name`, so the token document
  // works on any scene (conditions.mjs:67-83).
  const endStr = expiryEvent(op.end);
  const fn = op.effectId === "frightened" ? api.applyFrightened : api.applyTaunted;
  if (typeof fn !== "function") return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  // D16: DSCT deletes the earlier flagged effect (kept for undo); a native static-id copy (ours or the system's own)
  // would count twice next to the flagged one if DSCT is turned off later, so it goes first.
  const prior = dsctFlaggedEffect(actor, op.effectId)?.toObject() ?? null;
  const nativeCopy = actor.effects.get(statusConfig(op.effectId)?._id) ?? null;
  const replacedExtra = nativeCopy && nativeCopy.id !== prior?._id ? [nativeCopy.toObject()] : [];
  if (replacedExtra.length) await actor.deleteEmbeddedDocuments("ActiveEffect", [nativeCopy.id]);
  try {
    await fn(targetDoc, sourceActor, sourceTokenId, endStr);
  } catch (err) {
    await restoreEffects(actor, replacedExtra);
    throw err;
  }

  const ae = dsctFlaggedEffect(actor, op.effectId);
  if (!ae || ae.id === prior?._id) {
    await restoreEffects(actor, replacedExtra);
    return { status: OP_STATUS.FAILED, reason: "delegateNoEffect" };
  }
  const combatant = combatantFor(op.originDuration ? sourceActor : actor);
  if (combatant) {
    const update = { "start.combatant": combatant.id };
    if (!game.combats.isDefaultInitiativeMode) update["start.initiative"] = combatant.initiative;
    await ae.update(update);
  }
  return { ...NOT_NATIVE, status: OP_STATUS.APPLIED, delegated: `dsct-${op.effectId}`, createdIds: [ae.id], replaced: prior, replacedExtra };
}

/** Recreate deleted effects (a failed delegation); restored, not newly made (trackers skip them). */
async function restoreEffects(actor, list) {
  const back = list.filter(d => d?._id && !actor.effects.has(d._id));
  if (back.length) await actor.createEmbeddedDocuments("ActiveEffect", back, { keepId: true, [MODULE_ID]: { restore: true } });
}

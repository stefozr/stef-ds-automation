import { hasBenefit } from "../features/capabilities.mjs";
import { trackTemporaryResource, removeTemporaryResources } from "../features/temporary-resources.mjs";
/**
 * Appliers and undo for library rows (Milestone 4), on the active GM.
 *   condition  a status, the ability's own effect or a compendium effect, built like the system's
 *              "apply effect" enricher (one target per call, its own combatant as start, the end as
 *              expiry); targeted statuses go through Combat Tools as native ones (conditions.mjs)
 *   cleanse    deletes the matching effects (or the chosen ones), recreated on undo
 *   resource   adds to surges, the heroic or epic resource or Recoveries; undo takes it back
 *   heal       with `recoveries`: spends the healed creature's Recoveries and heals their value
 * Milestone 5: created conditions carry the card's id (`flags["stef-ds-automation"].messageId`) for the trackers.
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { snapStamina } from "./damage.mjs";
import { cleanseCandidates, cleanseSeen, resourcePath } from "./library-plan.mjs";
import { statusConfig } from "./native.mjs";
import { setUntil } from "../turn/until.mjs";
import { PERSISTENT_HOLD, extendsUse } from "../persistent/registry.mjs";
import { error, log } from "../log.mjs";
import { withResourceChain } from "../resources/world-resources.mjs";

const actorOf = (res, op) => fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid) ?? null;

function combatantFor(actor) {
  return game.combat?.getCombatantsByActor?.(actor)?.[0] ?? null;
}

/** The effect data to create for a library condition, or null. */
async function conditionData(op, item) {
  const src = op.libSource ?? {};
  const AE = CONFIG.ActiveEffect?.documentClass;
  if (src.status) {
    if (!statusConfig(src.status) || typeof AE?.fromStatusEffect !== "function") return null;
    const effect = await AE.fromStatusEffect(src.status);
    return { data: effect.toObject(), keepId: true };
  }
  if (src.effect) {
    const base = item?.effects?.get?.(src.effect);
    if (!base) return null;
    const keepId = !op.stacking;
    const clone = base.clone({}, { keepId, addSource: true });
    return { data: clone.toObject(), keepId };
  }
  if (src.uuid) {
    const base = await fromUuid(src.uuid).catch(() => null);
    if (!base || base.documentName !== "ActiveEffect") return null;
    const keepId = !op.stacking;
    const data = base.toObject();
    if (!keepId) delete data._id;
    foundry.utils.setProperty(data, "_stats.compendiumSource", src.uuid);
    return { data, keepId };
  }
  return null;
}

export async function applyLibCondition(message, res, op) {
  const item = await fromUuid(res.abilityUuid).catch(() => null);
  const actor = actorOf(res, op);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const built = await conditionData(op, item);
  if (!built) return { status: OP_STATUS.FAILED, reason: "effectMissing" };
  const { data, keepId } = built;
  const AE = CONFIG.ActiveEffect.documentClass;
  data.start = typeof AE.getEffectStart === "function" ? AE.getEffectStart() : (data.start ?? {});
  data.transfer = true;
  data.origin = item?.uuid ?? res.abilityUuid ?? null;
  // The card that made it (Milestone 5 trackers: "used again" ends only effects of an earlier card).
  data.flags = { ...(data.flags ?? {}), [MODULE_ID]: { ...(data.flags?.[MODULE_ID] ?? {}), messageId: message.id } };
  if (op.featureEnd === "aura") {
    data.duration = {}; data.disabled = false;
    data.flags[MODULE_ID].auraEffectKey = `${item.system._dsid}:${op.libEffect}`;
    data.flags[MODULE_ID].auraOriginalChanges = structuredClone(data.system?.changes ?? []);
  }
  if (op.temporaryStamina) {
    const grant = Object.values(res.ops ?? {}).find(o => o.kind === "temp" && o.libEffect === op.temporaryStamina && o.targetKeys?.includes(op.targetKeys[0]) && o.status === OP_STATUS.APPLIED && o.after?.temporary > o.before?.temporary);
    if (!grant || actor.system.stamina.temporary <= 0) return { status: OP_STATUS.SKIPPED, reason: "tempNotHigher" };
    data.flags[MODULE_ID].temporaryStamina = { messageId: message.id, opId: grant.opId, remaining: actor.system.stamina.temporary };
  }
  const expiry = op.end ? ds.CONFIG.effectEnds?.[op.end]?.expiryEvent : null;
  if (expiry) data.duration = { ...(data.duration ?? {}), expiry };
  const combatant = combatantFor(actor);
  if (combatant) {
    data.start.combatant = combatant.id;
    if (!game.combats.isDefaultInitiativeMode) data.start.initiative = combatant.initiative;
  }
  // The same id replaces an existing copy (kept for undo); stacking effects always add one.
  let replaced = null;
  if (keepId && data._id && actor.effects.get(data._id)) {
    replaced = actor.effects.get(data._id).toObject();
    await actor.deleteEmbeddedDocuments("ActiveEffect", [data._id]);
  }
  const created = await actor.createEmbeddedDocuments("ActiveEffect", [data], { keepId });
  const createdIds = (created ?? []).map(e => e?.id).filter(Boolean);
  if (!createdIds.length) return { status: OP_STATUS.FAILED, reason: "nothingCreated" };
  // "Until the start / end of your next turn": the user's turns end it (in combat only; Milestone 2). Milestone 9: a
  // Persistent use that extends holds "until the start of your next turn" until its user lets it go
  // (persistent/registry.mjs); "until the end of your next turn" keeps its base spec (keeping swaps it).
  let untilSet = null;
  if (op.until) {
    const user = fromUuidSync(res.sourceActorUuid ?? "") ?? item?.actor ?? null;
    const combatant = user ? combatantFor(user) : null;
    if (combatant && game.combat?.started) {
      try {
        const start = op.until === "yourNextTurnStart";
        const hold = start && extendsUse(item) ? { hold: PERSISTENT_HOLD } : {};
        await setUntil(created[0], { event: start ? "turnStart" : "turnEnd", combatantId: combatant.id, ...hold }, { keepExpiry: !!expiry });
        untilSet = op.until;
      } catch (err) {
        error("library.until", err, { opId: op.opId });
      }
    }
  }
  return { status: OP_STATUS.APPLIED, createdIds, replaced, untilSet };
}

/* -------------------------------------------- */
/*  Cleanse                                     */
/* -------------------------------------------- */

export async function applyCleanse(message, res, op) {
  if (op.afterMoveEffect && !Object.values(res.ops ?? {}).some(o => o.libEffect === op.afterMoveEffect && o.targetKeys?.includes(op.targetKeys[0]) && o.status === OP_STATUS.APPLIED)) return { status: OP_STATUS.PENDING, reason: "awaitingTeleport" };
  const actor = actorOf(res, op);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const candidates = cleanseCandidates(actor, { statuses: op.statuses, ends: op.ends });
  if (!candidates.length) {
    const seen = cleanseSeen(actor);
    log("cleanse.none", { opId: op.opId, actor: actor.name, statuses: op.statuses ?? [], ends: op.ends ?? [], seen });
    return { status: OP_STATUS.SKIPPED, reason: "nothingToEnd", seen };
  }
  let chosen = candidates;
  const picks = op.override?.effects;
  if (Array.isArray(picks) && picks.length) {
    chosen = candidates.filter(e => picks.includes(e.id));
    if (!chosen.length) return { status: OP_STATUS.SKIPPED, reason: "nothingToEnd" };
  } else if (op.count != null && candidates.length > op.count) {
    // Someone has to choose which effects end (Apply on the card asks).
    return { status: OP_STATUS.PENDING, reason: "chooseEffects", candidates: candidates.length };
  }
  if (op.count != null) chosen = chosen.slice(0, op.count);
  const removed = chosen.map(e => e.toObject());
  await actor.deleteEmbeddedDocuments("ActiveEffect", chosen.map(e => e.id));
  const moveCauseOpId = op.afterMoveEffect ? Object.values(res.ops).find(o => o.libEffect === op.afterMoveEffect && o.targetKeys?.includes(op.targetKeys[0]) && o.status === OP_STATUS.APPLIED)?.opId : null;
  return { status: OP_STATUS.APPLIED, removed, removedNames: chosen.map(e => e.name), moveCauseOpId };
}

export async function undoCleanse(res, op) {
  const actor = actorOf(res, op);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const back = (op.removed ?? []).filter(d => d?._id && !actor.effects.has(d._id));
  if (back.length) await actor.createEmbeddedDocuments("ActiveEffect", back, { keepId: true });
  return { status: OP_STATUS.UNDONE };
}

/* -------------------------------------------- */
/*  Resources                                   */
/* -------------------------------------------- */

const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

// Milestone 7 (docs/M7-DESIGN.md §2.0, §6.1): every read-modify-write of an actor's resource runs on its resource chain
// (shared with gains, upkeep cards and gain undo) and reads the value inside it, right before writing.
export async function applyResource(message, res, op) {
  if (op.hideOpId && (res.ops?.[op.hideOpId]?.status !== OP_STATUS.APPLIED || !res.ops[op.hideOpId].hideSucceeded)) {
    return { status: OP_STATUS.SKIPPED, reason: "hideFailed" };
  }
  const actor = actorOf(res, op);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const path = resourcePath(actor, op.resource);
  if (!path) return { status: OP_STATUS.SKIPPED, reason: "noResource" };
  return withResourceChain(actor.uuid, async () => {
    const before = Number(get(actor, path) ?? 0) || 0;
    if (op.minimumBefore != null && before < op.minimumBefore) return { status: OP_STATUS.SKIPPED, reason: "noResource" };
    let next = before + Number(op.amount ?? 0);
    if (op.resource === "recovery") next = Math.min(Number(actor.system.recoveries?.max ?? next), next);
    // The heroic resource may go below 0 (Talent strain); the others never do.
    if (op.resource !== "heroic") next = Math.max(0, next);
    if (next === before) return { status: OP_STATUS.SKIPPED, reason: "nothingGained" };
    await actor.update({ [path]: next });
    const temporaryResourceId = op.temporaryResource ? await trackTemporaryResource(actor, message, op, next - before) : null;
    return { status: OP_STATUS.APPLIED, before: { value: before }, after: { value: next }, finalAmount: next - before, temporaryResourceId };
  });
}

export async function undoResource(res, op) {
  if (op.temporaryResourceId) {
    const actor = actorOf(res, op);
    return actor ? await removeTemporaryResources(actor, [op.temporaryResourceId]) : { status: OP_STATUS.FAILED, reason: "targetMissing" };
  }
  const actor = actorOf(res, op);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const path = resourcePath(actor, op.resource);
  if (!path) return { status: OP_STATUS.FAILED, reason: "noResource" };
  return withResourceChain(actor.uuid, async () => {
    const current = Number(get(actor, path) ?? 0) || 0;
    const delta = Number(op.after?.value ?? 0) - Number(op.before?.value ?? 0);
    const absolute = current === op.after?.value;
    let next = absolute ? op.before.value : current - delta;
    if (op.resource !== "heroic") next = Math.max(0, next);
    await actor.update({ [path]: next });
    return { status: OP_STATUS.UNDONE, undoMode: absolute ? "absolute" : "delta" };
  });
}

/* -------------------------------------------- */
/*  Healing with Recoveries                     */
/* -------------------------------------------- */

export async function applyRecoveries(message, res, op) {
  const actor = actorOf(res, op);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  // Who pays: the healed creature, or the ability's user (`spender: "self"`).
  const payer = op.spenderUuid ? fromUuidSync(op.spenderUuid) : actor;
  if (!payer) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  return withResourceChain(payer.uuid, async () => {
  if (hasBenefit(payer, "moonlight")) return { status: OP_STATUS.SKIPPED, reason: "noRecoveries" };
  const rec = payer?.system?.recoveries;
  if (!rec || !("value" in rec)) return { status: OP_STATUS.SKIPPED, reason: "noRecoveries" };
  if (actor.isMinion) return { status: OP_STATUS.SKIPPED, reason: "minionHeal" };
  const n = Math.max(1, Number(op.recoveries) || 1);
  if ((rec.value ?? 0) < n) return { status: OP_STATUS.FAILED, reason: "noRecoveries" };
  const per = Number(rec.recoveryValue ?? 0) || 0;
  const amount = Number.isInteger(op.override?.amount) ? op.override.amount : n * per;
  const before = { ...snapStamina(actor), recoveries: rec.value };
  if (!(amount > 0) || actor.system.stamina.value >= actor.system.stamina.max) return { status: OP_STATUS.SKIPPED, reason: "nothingGained" };
  await payer.update({ "system.recoveries.value": rec.value - n });
  if (payer.system.recoveries.value !== before.recoveries - n) return { status: OP_STATUS.FAILED, reason: "noRecoveries" };
  try {
    await actor.modifyTokenAttribute("stamina", amount, true, true);
    if (actor.system.stamina.value <= before.value) throw new Error("DSAUTO.Reason.healingRefused");
  } catch (error) {
    await payer.update({ "system.recoveries.value": payer.system.recoveries.value + n });
    throw error;
  }
  const after = { ...snapStamina(actor), recoveries: payer.system.recoveries.value };
  return { status: OP_STATUS.APPLIED, amount, finalAmount: after.value - before.value, before, after, recoveriesSpent: n };
  });
}

/** Give the Recoveries back (the Stamina part is undone like any healing, undo.mjs). */
export async function refundRecoveries(res, op) {
  const actor = op.spenderUuid ? fromUuidSync(op.spenderUuid) : actorOf(res, op);
  const n = Number(op.recoveriesSpent ?? 0);
  if (!actor || !n || !actor.system?.recoveries) return;
  const max = Number(actor.system.recoveries.max ?? Infinity);
  await withResourceChain(actor.uuid, () => actor.update({ "system.recoveries.value": Math.min(max, (actor.system.recoveries.value ?? 0) + n) }));
}

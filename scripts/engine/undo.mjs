import { undoAura } from "../features/auras.mjs";
import { undoModifier } from "./modifiers.mjs";
/**
 * Undo of applied ops (active GM).
 * Stamina: restore the snapshot when nothing changed since ("absolute"); otherwise reverse only our
 * own change ("delta"), so damage dealt by someone else in between is kept.
 * Conditions: delete what we created and restore the effect we replaced. Milestone 8 (docs/M8-DESIGN.md §3.3): every
 * `replacedExtra` effect too (a Combat Tools flagged copy a native apply deleted, a native copy a delegated apply
 * deleted); a native grab append removes only its own source, an idempotent native apply has nothing to undo
 * (engine/targeted.mjs undoNativeTargeted).
 * A creature Death Tracker defeated is revived through Death Tracker after the restore (setting
 * `reviveOnUndo`); one that stays defeated (Director not viewing its scene, Death Tracker inactive)
 * flags the op `revivalPending`.
 * Movement (forced, teleport): delegation/forced-movement.mjs undoForced.
 * Budget (Milestone 5, the undo anchor of a trigger card): triggers/budget.mjs undoBudgetOp gives the
 * round's triggered action back.
 * Summon (Milestone 6): engine/summon.mjs undoSummon dismisses the summon (reason undo, no card annotation: it
 * would wait for this very card lock); the world actor stays.
 * Milestone 7: gain rows (resources/gains.mjs undoGainOp: resource back, ledger entry released), zone rows
 * (zones/create.mjs undoZoneOp: the area ends), Malice / hero-token rows (resources/world-resources.mjs) and hero-token
 * heals (resources/hero-tokens.mjs undoHeroTokenOp: Stamina and tokens back, the turn's spend freed).
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { announcePendingRevival, reviveTokens } from "../compat/death-tracker.mjs";
import { dsctApi } from "../compat/dsct.mjs";
import { undoForced } from "../delegation/forced-movement.mjs";
import { undoHideOp } from "./hide.mjs";
import { setting } from "../settings.mjs";
import { snapStamina } from "./damage.mjs";
import { refundRecoveries, undoCleanse, undoResource } from "./library-apply.mjs";
import { undoBudgetOp } from "../triggers/budget.mjs";
import { undoSummon } from "./summon.mjs";
import { undoNativeTargeted } from "./targeted.mjs";
import { undoGainOp } from "../resources/gains.mjs";
import { undoHeroTokenOp } from "../resources/hero-tokens.mjs";
import { WORLD_RESOURCES, undoWorldResource } from "../resources/world-resources.mjs";
import { undoZoneOp } from "../zones/create.mjs";

const defeatedId = () => CONFIG.specialStatusEffects?.DEFEATED ?? "dead";

function sameStamina(a, b) {
  return !!a && !!b && a.value === b.value && a.temporary === b.temporary;
}

/** @returns {Promise<object>} Fields to merge into the op record. */
export async function undoOp(message, res, op) {
  if (op.kind === "temporaryExpiry") {
    const actor = fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
    if (!actor || actor.system.stamina.temporary !== op.afterTemporary) return { status: OP_STATUS.FAILED, reason: "effectChanged" };
    await actor.update({ "system.stamina.temporary": op.temporaryBefore.value });
    return { status: OP_STATUS.UNDONE };
  }
  // Milestone 7 (docs/M7-DESIGN.md §2.2, C24): the new kinds before every generic branch (world resources before the
  // actor `resource` one, hero-token heals before the Stamina undo).
  if (["auraOption", "auraActivation"].includes(op.kind)) return undoAura(op);
  if (op.kind === "gain") return undoGainOp(res, op);
  if (op.kind === "zone") return undoZoneOp(res, op);
  if (op.kind === "resource" && WORLD_RESOURCES[op.resource]) return undoWorldResource(res, op);
  if (op.heroToken) return undoHeroTokenOp(res, op);
  if (op.kind === "condition") return undoCondition(res, op);
  if (op.kind === "modifier") return undoModifier(res, op);
  if (op.kind === "hide") return undoHideOp(res, op);
  if (op.kind === "forced" || op.kind === "teleport" || op.kind === "featureMove") return undoForced(op);
  if (op.kind === "cleanse") return undoCleanse(res, op);
  if (op.kind === "resource") return undoResource(res, op);
  if (op.kind === "budget") return undoBudgetOp(res, op);
  if (op.kind === "summon") return undoSummon(res, op);
  const patch = await undoStamina(res, op);
  // Healing that spent Recoveries gives them back (Milestone 4).
  if (patch.status === OP_STATUS.UNDONE && op.recoveriesSpent) await refundRecoveries(res, op);
  return patch;
}

/**
 * Stamina undo, with Death Tracker revival (setting `reviveOnUndo`):
 * - single creatures: restore first, then revive the target if it is defeated (Death Tracker sets
 *   Stamina to 1 when it revives a creature at 0 or below, which would turn our exact restore into a
 *   delta one);
 * - squads: revive FIRST, then write the pool. Death Tracker clamps every pool write to living minions
 *   x their Stamina (preUpdateCombatantGroup, death-tracker.mjs:1569), and the minion it defeats need
 *   not be the one that was hit (it may pick any squad member). So as many defeated minions are revived
 *   as the restored pool needs alive (`ceil(pool / minion Stamina) - living`): the op's targets first,
 *   then the minions Death Tracker killed with them, then any other defeated member.
 */
async function undoStamina(res, op) {
  if (op.group) return undoSquad(res, op);
  const revive = setting("reviveOnUndo") ? defeatedTokenUuids(res, op) : [];
  for (const uuid of revive) announcePendingRevival(uuid);
  const patch = await restoreStamina(res, op);
  if (patch.status !== OP_STATUS.UNDONE) return patch;
  if (revive.length) await safeRevive(revive);
  patch.revivalPending = anyDefeated(res, op) || null;
  return patch;
}

async function safeRevive(tokenUuids, options) {
  try {
    await reviveTokens(tokenUuids, options);
  } catch (err) {
    console.warn("stef-ds-automation | revive failed", err);
  }
}

async function undoSquad(res, op) {
  const group = fromUuidSync(op.group);
  if (!group?.system) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const current = group.system.staminaValue;
  const max = group.system.staminaMax ?? Infinity;
  const absolute = current === op.after?.staminaValue;
  const value = Math.max(0, absolute ? op.before.staminaValue : Math.min(max, current + (op.before.staminaValue - op.after.staminaValue)));
  if (setting("reviveOnUndo")) {
    const revive = squadRevivals(res, op, group, value);
    for (const uuid of revive) announcePendingRevival(uuid);
    if (revive.length) await safeRevive(revive, { expandDeathGroups: false });
  }
  // Battle Log 1.5.0 cancels the logged hit and this write only when the write says it is an undo (resource-log.mjs:866).
  await group.update({ "system.staminaValue": value }, { dsblUndo: true });
  const { short } = squadState(group, value);
  return { status: OP_STATUS.UNDONE, undoMode: absolute ? "absolute" : "delta", revivalPending: short > 0 || null };
}

/** Squad minions (combatants with their token) and how many more must be alive for `pool`. */
function squadState(group, pool) {
  const minions = [...(group.system?.minions ?? [])].map(c => {
    const token = c.token ?? null;
    const actor = c.actor ?? token?.actor ?? null;
    return { uuid: token?.uuid ?? null, tokenId: token?.id ?? c.tokenId ?? null, actor, defeated: !!(c.isDefeated ?? c.defeated) || isDefeated(actor) };
  });
  const per = Number(minions[0]?.actor?.system?.stamina?.max ?? 0) || 0;
  const living = minions.filter(m => !m.defeated).length;
  const short = per > 0 ? Math.max(0, Math.min(minions.length, Math.ceil(pool / per)) - living) : 0;
  return { minions, short };
}

/** Token uuids to revive before writing `pool`: targets, then their death-group mates, then the rest. */
function squadRevivals(res, op, group, pool) {
  const { minions, short } = squadState(group, pool);
  if (!short) return [];
  const targetUuids = new Set(op.targetKeys.map(k => res.targets?.[k]?.tokenUuid).filter(Boolean));
  const mates = new Set();
  for (const m of minions) {
    if (!targetUuids.has(m.uuid) || !m.tokenId) continue;
    for (const id of globalThis.window?._dsctDeathGroups?.get?.(m.tokenId) ?? []) mates.add(id);
  }
  const rank = m => (targetUuids.has(m.uuid) ? 0 : mates.has(m.tokenId) ? 1 : 2);
  return minions.filter(m => m.defeated && m.uuid).sort((a, b) => rank(a) - rank(b)).slice(0, short).map(m => m.uuid);
}

async function restoreStamina(res, op) {
  const actor = fromUuidSync(res.targets?.[op.targetKeys[0]]?.actorUuid);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const current = snapStamina(actor);
  let next;
  let undoMode = "absolute";
  if (sameStamina(current, op.after)) next = { ...op.before };
  else {
    undoMode = "delta";
    next = {
      value: current.value + (op.before.value - op.after.value),
      temporary: Math.max(0, current.temporary + (op.before.temporary - op.after.temporary)),
    };
  }
  const { min, max } = actor.system.stamina ?? {};
  if (Number.isFinite(max)) next.value = Math.min(max, next.value);
  if (Number.isFinite(min)) next.value = Math.max(min, next.value);
  // 0.17.0: our undo revives by itself (`reviveOnUndo`): the revive-on-heal hook leaves this write alone.
  // 0.18.0: `dsblUndo` lets Battle Log 1.5.0 cancel the logged hit instead of logging a heal (resource-log.mjs:825).
  await actor.update({ "system.stamina.value": next.value, "system.stamina.temporary": next.temporary }, { [MODULE_ID]: { undo: true }, dsblUndo: true });
  return { status: OP_STATUS.UNDONE, undoMode };
}

const isDefeated = actor => !!actor?.statuses?.has?.(defeatedId());

function anyDefeated(res, op) {
  return op.targetKeys.some(k => isDefeated(fromUuidSync(res.targets?.[k]?.actorUuid)));
}

/** Token uuids of the op's targets that are defeated now (before the restore). */
function defeatedTokenUuids(res, op) {
  return op.targetKeys
    .map(k => res.targets?.[k])
    .filter(t => t?.tokenUuid && isDefeated(fromUuidSync(t.actorUuid)))
    .map(t => t.tokenUuid);
}

async function undoCondition(res, op) {
  const actor = fromUuidSync(res.targets?.[op.targetKeys[0]]?.actorUuid);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };

  if (op.delegated === "dsct-grab") {
    const api = dsctApi();
    if (!api?.endGrab) return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
    await api.endGrab(op.grabbedTokenId);
    return { status: OP_STATUS.UNDONE };
  }

  if (op.native) {
    const patch = await undoNativeTargeted(actor, op);
    if (patch) return patch;
  }

  const ids = (op.createdIds ?? []).filter(id => actor.effects.has(id));
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [MODULE_ID]: { temporaryExpiry: true } });
  // Restored, not newly made: trackers never end older effects for it (review conc 10).
  const back = [op.replaced, ...(op.replacedExtra ?? [])].filter(d => d?._id && !actor.effects.has(d._id));
  const unique = back.filter((d, i) => back.findIndex(x => x._id === d._id) === i);
  if (unique.length) await actor.createEmbeddedDocuments("ActiveEffect", unique, { keepId: true, [MODULE_ID]: { restore: true } });
  return { status: OP_STATUS.UNDONE };
}

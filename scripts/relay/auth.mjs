/**
 * Who may press which card button. Pure and shared: the card hides buttons with these rules on
 * every client, and the active GM checks them again for every relayed request (relay/queries.mjs).
 *
 * - The Director (any GM user) may do everything.
 * - Other users need the role `cardActionRole` (default Game Master, i.e. players cannot act, as
 *   Target Damage's own `applyPermission`). Above the floor they may act on ops of cards they wrote
 *   or whose source actor they own, on ops whose targets they all own (`playerCardActions =
 *   ownSourceOrTarget`), and may always undo what they applied themselves. Skipped ops and "Ask the
 *   Director" (prompt) rows stay GM-only.
 * - The author may resolve an unresolved card, and may retarget a card while nothing on it has been
 *   applied yet (a forgotten target), or at any time above the role floor.
 * - Surges are the hero's to spend: the Director or an owner of the hero (a retainer's mentor) may
 *   spend them, whatever the role floor; the row they add follows the base row's mode, so with the
 *   default floor the Director still confirms rows that wait.
 * - Synthetic cards (api.applyDamage) are posted by Directors only.
 * - A self-teleport (library row, Milestone 4) is the mover's to make: an owner of the ability's user
 *   may apply it (they pick the square on their own screen) and undo it, whatever the role floor.
 * - Trigger holds (Milestone 5): the Director, or an owner of the held document (mayRequestHold).
 * - Trigger cards (Milestone 5, `shape: "trigger"`): only the Director undoes them (C20); an undone row of
 *   theirs is never applied again (the reaction stays revoked).
 * - Summons (Milestone 6, docs/M6-DESIGN.md §2.2): a summon row on an ability card is the summoner's to place: an
 *   owner of the ability's user may apply it (picking the squares on their own screen) and undo it, whatever the role
 *   floor and the row's mode (`isOwnSummon`, checked at the same spot as the self-teleport), while its summon is not
 *   gone (`summonGone`: dismissed, expired, died, or undone as already gone; review fix). A summon row of an
 *   `api.summon` card (synthetic) is the Director's only (apply, undo, prepare; no role floor opens it). Dismissing
 *   a summon: the Director, an owner of the summoner, or an owner of one of the summon's tokens (`mayDismissSummon`;
 *   the card's Dismiss button uses `mayDismissRow`).
 * - Zones (Milestone 7, docs/M7-DESIGN.md §2.2): a zone row is placed by an owner of the ability's user like a summon
 *   (`isOwnZone`) while its area is not gone (`zoneEnded`); gain rows get no bypass (the Director, or the role floor).
 *   Dismissing a zone: the Director or an owner of its creator (`mayDismissZone`, zones/registry.mjs).
 * - Native summons (Milestone 8): the system's Summon button relays `nativeSummon`; an owner of the ability's actor
 *   for its own token (`mayNativeSummon`). The card it posts is an own summon row (`isOwnSummon`, not synthetic).
 *   Ending a native targeted condition (`mayEndTargeted`): the role floor, owners of the actor or of its source.
 * - Picks (Milestone 9): a pick row is answered by an owner of the ability's user (`isOwnPick`, relay `pick`), whatever
 *   the role floor; a teleport's boost payment (`boostOf`) is undone by whoever may undo the teleport.
 */
import { OP_STATUS } from "../constants.mjs";
import { targetedOps } from "../engine/record.mjs";
import { setting } from "../settings.mjs";

const GAMEMASTER = 4;

/** Ownership test that never throws (missing documents, compendium uuids). */
function owns(user, doc) {
  try {
    return !!doc?.testUserPermission?.(user, "OWNER");
  } catch (_err) {
    return false;
  }
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The actor damage and undo actually write (engine/damage.mjs, undo.mjs use the record's actorUuid). */
function targetActor(target) {
  return lookup(target?.actorUuid);
}

export function isAuthor(user, message) {
  return !!user && message?.author?.id === user.id;
}

/** Does a non-GM user reach the role required for card actions? */
export function meetsRoleFloor(user) {
  if (!user) return false;
  if (user.isGM) return true;
  return (user.role ?? 0) >= Number(setting("cardActionRole") ?? GAMEMASTER);
}

/**
 * May `user` apply or undo `op`? Status checks (already applied, nothing to apply) are separate.
 * @param {User} user
 * @param {ChatMessage} message
 * @param {object} res                  The resolution record.
 * @param {object} op
 * @param {"apply"|"undo"} action
 */
export function mayAct(user, message, res, op, action) {
  if (!user || !op) return false;
  if (action === "apply" && op.kind === "hide" && res?.ops?.[op.teleportOpId]?.status !== "applied") return false;
  // An undone trigger card is final (Director included): its undo revoked the reaction on the hit, which
  // re-applying its cost and budget rows would not bring back (a new prompt does, on the hit's re-apply).
  if (res?.shape === "trigger" && action === "apply" && op.status === OP_STATUS.UNDONE) return false;
  if (user.isGM) return true;
  if (action === "apply" && !op.synthetic && ["forced", "teleport"].includes(op.kind) && op.status !== OP_STATUS.SKIPPED && !op.noApply) {
    if (owns(user, lookup(res?.sourceActorUuid))) return true;
    if (op.kind === "teleport" && owns(user, targetActor(res.targets?.[op.targetKeys?.[0]]))) return true;
  }
  // A trigger card's undo gives the budget and the cost back while its halving stays: the Director's (C20).
  if (res?.shape === "trigger" && action === "undo") return !!user?.isGM;
  // Milestone 9: a pick row is the user's owner's to answer (`pick`), a teleport's boost payment goes back with it.
  if ((isSelfTeleport(op) || (op.kind === "hide" && op.self) || (op.hideOpId && action === "undo") || (isOwnSummon(op) && !summonGone(op)) || (isOwnZone(op) && !zoneEnded(op))
    || (isOwnPick(op) && action === "apply") || (op.boostOf && action === "undo"))
    && op.status !== OP_STATUS.SKIPPED && owns(user, lookup(res?.sourceActorUuid))) return true;
  // D10: an api.summon row (synthetic) is the Director's, whatever the role floor and the row's mode (review fix).
  if (op.kind === "summon" && op.synthetic) return false;
  if (!meetsRoleFloor(user)) return false;
  // Skipped ops (resisted, minion heal, temporary Stamina not higher) are the Director's override,
  // and "Ask the Director" rows wait for the Director's confirmation.
  if (action === "apply" && (op.status === OP_STATUS.SKIPPED || op.mode === "prompt")) return false;
  if (action === "undo" && op.byUserId === user.id) return true;
  if (isAuthor(user, message) || owns(user, lookup(res?.sourceActorUuid))) return true;
  if (setting("playerCardActions") !== "ownSourceOrTarget") return false;
  const keys = op.targetKeys ?? [];
  return keys.length > 0 && keys.every(k => owns(user, targetActor(res?.targets?.[k])));
}

/** A library teleport of the ability's own user (library-plan teleportRow). */
export const isSelfTeleport = op => op?.kind === "teleport" && !!op.selfMove;

/** A summon row of an ability card on its user's own row (Milestone 6); never an api.summon card's (D10). */
export const isOwnSummon = op => op?.kind === "summon" && !!op.self && !op.synthetic;

/**
 * Review fix: a summon row whose summon is gone (dismissed, expired, died, encounter end; or an undo that found it
 * already gone) leaves the owner bypass: an Undo then Apply would bring it back without the ability or its upkeep.
 * Such a row follows the normal rules (the Director, or a raised role floor).
 */
export const summonGone = op => op?.kind === "summon"
  && ((op.status === OP_STATUS.APPLIED && !!op.dismissed) || (op.status === OP_STATUS.UNDONE && op.undoMode === "alreadyGone"));

/** Milestone 9: a pick placeholder on its user's own row (the user's owner picks the creature(s), relay `pick`). */
export const isOwnPick = op => op?.kind === "pick" && !!op.self && !op.synthetic;

/** Milestone 7: a zone row of an ability card on its user's own row (placed by the creator's owner on their canvas). */
export const isOwnZone = op => op?.kind === "zone" && !!op.self && !op.synthetic;

/**
 * Milestone 7: a zone row whose area is gone (ended, or undone as already gone) leaves the owner bypass, as summonGone:
 * Undo then Apply would bring it back without the ability or its upkeep.
 */
export const zoneEnded = op => op?.kind === "zone"
  && ((op.status === OP_STATUS.APPLIED && !!op.ended) || (op.status === OP_STATUS.UNDONE && op.undoMode === "alreadyGone"));

/** Milestone 7: dismissing a zone (relay zoneDismiss, the row's Dismiss): a GM, or an owner of the creator. */
export { mayDismissZone } from "../zones/registry.mjs";

/** The card's Dismiss button: the Director, or an owner of the summoner. */
export function mayDismissRow(user, res, op) {
  if (!user) return false;
  if (user.isGM) return true;
  return owns(user, lookup(op?.summonerActorUuid ?? res?.sourceActorUuid));
}

/**
 * Relay summonDismiss (any summon, card or not): the Director, an owner of the summoner, or an owner of one of the
 * summon's token actors. `info` is a SummonInfo (summons/registry.mjs).
 */
export function mayDismissSummon(user, info) {
  if (!user || !info) return false;
  if (user.isGM) return true;
  if (owns(user, lookup(info.summonerActorUuid))) return true;
  return (info.tokenUuids ?? []).some(u => {
    const doc = lookup(u);
    return owns(user, doc?.actor) || owns(user, doc);
  });
}

/** Has anything on the card been applied (by us or by Target Damage), now or earlier? */
export function anythingApplied(res) {
  // The user's own row (surges gained, a self teleport) does not lock the targets.
  return targetedOps(res).some(op =>
    op.status === OP_STATUS.APPLIED || op.status === OP_STATUS.UNDONE || op.status === OP_STATUS.EXTERNAL);
}

/** May `user` spend the surges of `hero` (the card's surge source, engine/surges.mjs surgeActor)? */
export function maySurge(user, hero) {
  if (!user || !hero) return false;
  return !!user.isGM || owns(user, hero);
}

/**
 * Milestone 5: may `user` relay a trigger hold, pre-roll check or movement gate (relay actions `hold`,
 * `holdDone`, `preRoll`, `moveGate`) for `doc` (the damaged actor, the rolling actor, the moving token)?
 * The Director, or an owner of that document. Not named `mayHold`: triggers/engine.mjs has a
 * `mayHold(kind, sceneId)` (a different question, asked on every client).
 */
export function mayRequestHold(user, doc) {
  return !!user && (!!user.isGM || owns(user, doc));
}

export function mayResolve(user, message) {
  return !!user && (user.isGM || isAuthor(user, message));
}

export function mayRetarget(user, message, res) {
  if (!user || res?.synthetic) return false;
  if (user.isGM) return true;
  if (!isAuthor(user, message)) return false;
  return meetsRoleFloor(user) || !anythingApplied(res);
}

/** Op is in a state where Apply does something. "external" stays retryable (see engine). */
export const canApplyStatus = op => op.status !== OP_STATUS.APPLIED && !op.noApply;
export const canUndoStatus = op => op.status === OP_STATUS.APPLIED;

/**
 * Milestone 8 (docs/M8-DESIGN.md §2.2): may `user` place a native summon of `item` (the system's own Summon button,
 * relay `nativeSummon`) for the summoner token `summonerDoc`? The Director, or an owner of the ability's actor; the
 * token must be that actor's own (the synthetic actor of an unlinked token).
 */
export function mayNativeSummon(user, item, summonerDoc) {
  if (!user || !item?.actor || !summonerDoc?.actor) return false;
  if (summonerDoc.actor !== item.actor && summonerDoc.actor.uuid !== item.actor.uuid) return false;
  return !!user.isGM || owns(user, item.actor);
}

/**
 * Milestone 8 (§3.6): may `user` end a native targeted condition on `actor` (relay `endTargeted`)? Directors and users
 * at the role floor (`cardActionRole`), owners of the affected actor, owners of the condition's source.
 */
export function mayEndTargeted(user, actor, source = null) {
  if (!user) return false;
  if (user.isGM || meetsRoleFloor(user)) return true;
  return owns(user, actor) || owns(user, source);
}

/**
 * Appliers for movement ops (active GM): forced movement of a target and teleports.
 * The move itself is delegated (delegation/forced-movement.mjs, delegation/teleport.mjs); the op keeps
 * what undo needs (Combat Tools' undo log, or the start and end positions).
 */
import { OP_STATUS } from "../constants.mjs";
import { needsPick, runForced } from "../delegation/forced-movement.mjs";
import { positionOf, runTeleport, samePosition } from "../delegation/teleport.mjs";
import { takeMove } from "./move-log.mjs";
import { askTeleportStep, stepRecipient } from "../ui/teleport-followup.mjs";
import { askMovementChoice } from "../ui/movement-choice.mjs";
import { validForcedPath, executeSelectedTeleport } from "../delegation/selected-movement.mjs";
import { dsctApi, dsctForcedOn } from "../compat/dsct.mjs";
import { forcedByPicker } from "../delegation/forced-picker.mjs";
import { distanceSquares } from "../triggers/eligibility.mjs";
import { resourcePath } from "./library-plan.mjs";
import { log } from "../log.mjs";

/**
 * Milestone 9 (D6): the most points of `op.boost.resource` the mover may spend on a teleport now: what they have
 * (never below 0), at most `boost.max` (else 20). 0 without a boost or the resource.
 */
export function boostLimit(op, actor) {
  const b = op?.boost;
  const path = b ? resourcePath(actor, b.resource) : null;
  if (!path) return 0;
  const have = Math.floor(Number(path.split(".").reduce((o, k) => o?.[k], actor)) || 0);
  return Math.max(0, Math.min(have, Number.isInteger(b.max) ? b.max : 20));
}

/** The boost points a client answered, checked against boostLimit: an invalid or over-budget answer counts as 0. */
export function boostSpend(op, actor, answered) {
  const n = Number(answered);
  if (!op?.boost || !Number.isInteger(n) || n <= 0) return 0;
  return n <= boostLimit(op, actor) ? n : 0;
}

/** The movement an op will make: the Director's pick (Edit) or the only one the ability allows. */
export function chosenMovement(op) {
  const pick = op.override?.movement;
  if (pick && op.movements?.includes(pick)) return pick;
  return op.movement ?? null;
}

/** Does Apply need a choice first ("push or pull")? */
export const needsChoice = op => op.kind === "forced" && !chosenMovement(op);

/** Will applying this op open a pick on the canvas (with the movement chosen so far)? */
export const pickOnApply = op => op.kind === "forced"
  && needsPick({ movement: chosenMovement(op), vertical: op.vertical, flying: op.flying, choosePath: op.choosePath });

/**
 * 0.16.0: a push or pull that needs no pick (one movement, not vertical or flying, setting `forcedPath` "straight")
 * is carried out at once in a straight line (Combat Tools' `fastMove`, else our own line), as before 0.12.0;
 * nobody is asked for a path.
 */
export const straightForced = op => op.kind === "forced" && !pickOnApply(op);

/** The distance an op moves (before stability): the Director's override, else the ability's. */
export function chosenDistance(op) {
  const override = op.override?.distance;
  if (Number.isFinite(override)) return override;
  const movement = chosenMovement(op);
  return movement ? Number(op.distances?.[movement] ?? 0) : 0;
}

/**
 * A teleport whose square the recipient's owner picks with Combat Tools' teleport mode on their own screen
 * (Black Ash Teleport, Flip the Script recipients, Exorcist Judgement). Without Combat Tools' teleport API the
 * local proposal picker (ui/movement-choice.mjs) is used instead.
 */
export const combatToolsTeleport = op => op.kind === "teleport" && (op.teleportMode ?? "normal") === "normal"
  && !op.synthetic && !op.destination && Number(op.distance) > 0 && typeof dsctApi()?.teleport === "function";

/** Ask the recipient's owner to teleport with Combat Tools; the active GM picks when they cannot. */
async function askCombatToolsTeleport(message, op, actor) {
  const gm = game.users.activeGM;
  const recipient = stepRecipient(message, actor);
  const isGM = !recipient || recipient.id === gm?.id;
  try {
    const asked = await askTeleportStep(message, op, actor, "teleport", { recipient });
    if (isGM || !asked.answer?.unavailable) return asked;
  } catch (error) {
    // Timed out or disconnected: the Director takes over.
    if (isGM) throw error;
  }
  return askTeleportStep(message, op, actor, "teleport", { recipient: gm });
}

function tokenDoc(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/**
 * Apply one forced movement or teleport op.
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function applyMoveOp(_message, res, op, { clientMoves = null, userId = null } = {}) {
  const target = res.targets?.[op.targetKeys?.[0]];
  const targetDoc = tokenDoc(target?.tokenUuid);
  if (!clientMoves && combatToolsTeleport(op) && targetDoc?.actor) {
    const before = positionOf(targetDoc);
    const { answer, userId: pickerId } = await askCombatToolsTeleport(_message, op, targetDoc.actor);
    if (answer?.unavailable) return { status: OP_STATUS.FAILED, reason: answer.reason === "delegateUnavailable" ? "delegateUnavailable" : "notOnCanvas" };
    // Cancelled in Combat Tools' picker: the row's Apply starts it again.
    if (samePosition(before, positionOf(targetDoc))) return { status: OP_STATUS.PENDING, reason: "notMoved" };
    // Milestone 9 (D6): the extra squares the mover paid for, checked here (the row charges them once applied).
    const boost = boostSpend(op, targetDoc.actor, answer?.boost);
    const patch = recordClientMoves(op, res, targetDoc, { userId: pickerId, asked: true, extra: boost * (Number(op.boost?.per) || 1) });
    if (boost && patch.status === OP_STATUS.APPLIED) patch.boostSpent = { resource: op.boost.resource, amount: boost };
    if (patch.status !== OP_STATUS.APPLIED) {
      // Rejected owner moves follow the same rollback as the card's own picker.
      const { moveTokenTo } = await import("../delegation/teleport.mjs");
      await moveTokenTo(targetDoc, before);
    }
    return patch;
  }
  // 0.17.0: with Combat Tools a forced move that needs a pick runs in its own picker on the ability user's screen.
  if (!clientMoves && op.kind === "forced" && !op.synthetic && targetDoc?.actor && !straightForced(op) && dsctForcedOn()) {
    return forcedByPicker(_message, res, op, targetDoc);
  }
  // Our own dialog: teleports without Combat Tools' teleport mode, and forced moves without Combat Tools.
  if (!clientMoves && !op.synthetic && !op.destination && (!op.teleportMode || op.teleportMode === "normal") && targetDoc?.actor && (op.kind === "forced" || op.kind === "teleport")
    && !straightForced(op)) {
    const start = positionOf(targetDoc);
    const movements = op.kind === "forced" ? (chosenMovement(op) ? [chosenMovement(op)] : op.movements ?? []) : [];
    const distance = op.kind === "forced" ? (chosenMovement(op) ? chosenDistance(op) : Math.max(...Object.values(op.distances ?? {}))) : op.distance;
    const usable = Math.max(0, distance - (op.kind === "forced" && !op.ignoreStability ? Number(targetDoc.actor.system?.combat?.stability ?? 0) : 0));
    if (!usable) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
    const pick = await askMovementChoice(_message, res, op, targetDoc, {
      movements, distance: usable, vertical: !!(op.vertical || op.flying),
      // Milestone 9 (D6): the owner may spend for extra squares (the dialog's number input; checked again above).
      boost: op.kind === "teleport" && op.boost ? { max: boostLimit(op, targetDoc.actor), per: Number(op.boost.per) || 1, label: op.boost.label ?? null } : null,
    });
    log("forced.pick", { opId: op.opId, kind: op.kind, by: pick?.by ?? null, declined: !!pick?.declined, path: pick?.path?.length ?? 0,
      vertical: pick?.verticalDistance ?? 0, destination: !!pick?.destination });
    if (pick?.declined) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
    // Apply with nothing chosen: the row says why nothing moved.
    if (!pick?.destination && !pick?.path?.length && !pick?.verticalDistance) return { status: OP_STATUS.SKIPPED, reason: "pickEmpty", pickEmpty: true };
    if (!samePosition(start, positionOf(targetDoc))) return { status: OP_STATUS.FAILED, reason: "badDestination" };
    if (op.kind === "teleport") {
      // Milestone 9 (D6): the fallback dialog's boost answer, checked as on the Combat Tools path.
      const boost = boostSpend(op, targetDoc.actor, pick?.boost);
      const moved = await executeSelectedTeleport(targetDoc, pick, { distance: distance + boost * (Number(op.boost?.per) || 1), closerTo: tokenDoc(op.closerToTokenUuid), ignoreLineOfEffect: !!op.closerToTokenUuid });
      if (boost && moved?.status === OP_STATUS.APPLIED) moved.boostSpent = { resource: op.boost.resource, amount: boost };
      return moved;
    }
    const sourceDoc = tokenDoc(op.sourceTokenUuid ?? res.sourceTokenUuid);
    if (!validForcedPath(targetDoc, sourceDoc, pick, { distance: Number(op.distances?.[pick.movement] ?? distance), movements, vertical: !!(op.vertical || op.flying), ignoreStability: !!op.ignoreStability })) return { status: OP_STATUS.FAILED, reason: "badDestination" };
    // Core fallback preserves walls/occupancy; collisions stay explicitly recorded for Director resolution.
    if (pick.verticalDistance) return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
    const { validDestination } = await import("../delegation/selected-movement.mjs");
    const { moveTokenTo } = await import("../delegation/teleport.mjs");
    const G = Number(targetDoc.parent.grid.size) || 100;
    let finalPos = start, moved = 0;
    for (const cell of pick.path) {
      const next = { x: cell.x * G, y: cell.y * G, elevation: start.elevation };
      if (!validDestination(targetDoc, next, { distance: usable })) break;
      finalPos = next; moved++;
    }
    if (!moved) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
    await moveTokenTo(targetDoc, finalPos);
    return { status: OP_STATUS.APPLIED, delegated: "core", startPos: start, finalPos, movedType: pick.movement, movedDistance: moved, collisionLeft: pick.path.length - moved,
      moves: [{ tokenUuid: targetDoc.uuid, startPos: start, finalPos }] };
  }
  if (op.kind === "teleport" && clientMoves) return recordClientMoves(op, res, targetDoc, { userId });
  if (op.kind === "teleport") {
    return runTeleport({
      tokenDoc: targetDoc, distance: op.distance, mode: op.teleportMode ?? "normal",
      partnerDoc: tokenDoc(op.partnerTokenUuid), destination: op.destination ?? null, animate: op.animate !== false,
      cardId: _message?.id ?? null, opId: op.opId,
    });
  }
  const movement = chosenMovement(op);
  // Left pending: the card asks for the movement type first (Edit).
  if (!movement) return { status: OP_STATUS.PENDING, reason: "chooseMovement" };
  return runForced({
    targetDoc, sourceDoc: tokenDoc(op.sourceTokenUuid ?? res.sourceTokenUuid), movement,
    distance: chosenDistance(op), vertical: !!(op.vertical || op.flying), ignoreStability: !!op.ignoreStability,
    properties: op.properties ?? [], interactive: pickOnApply(op),
  });
}

/**
 * A teleport the mover's owner carried out on their own client (Combat Tools' picker moves a token its
 * owner controls): the record only notes it for undo. A move the player reports by themselves qualifies
 * for self-teleports only; a move the active GM asked for (`asked`) may be any recipient's. The start and
 * end come from Foundry's own report of that user's move of the token since the card was resolved
 * (engine/move-log.mjs), never from the request; the move may be no longer than the row allows,
 * elevation included, and must end closer to the row's `closerToTokenUuid` when it has one.
 */
function recordClientMoves(op, res, moverDoc, { userId = null, asked = false, extra = 0 } = {}) {
  if ((!op.selfMove && !asked) || !moverDoc) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  const seen = takeMove(moverDoc.uuid, userId, positionOf(moverDoc), Number(res.resolvedAt ?? 0) || 0);
  if (!seen) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  const { startPos, finalPos } = seen;
  if (samePosition(startPos, finalPos)) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  const grid = moverDoc.parent?.grid ?? globalThis.canvas?.grid ?? {};
  const size = Number(grid.size ?? 100) || 100;
  const units = Number(grid.distance ?? 5) || 5;
  const squares = Math.max(Math.abs(finalPos.x - startPos.x) / size, Math.abs(finalPos.y - startPos.y) / size,
    Math.abs((finalPos.elevation ?? 0) - (startPos.elevation ?? 0)) / units);
  // Milestone 9 (D6): `extra` = the boost squares the GM accepted (boostSpend), never the client's own figure.
  if (squares > Number(op.distance ?? 0) + (Number(extra) || 0) + 0.01) return { status: OP_STATUS.FAILED, reason: "tooFar" };
  const closer = tokenDoc(op.closerToTokenUuid);
  if (closer) {
    const at = p => ({ x: p.x, y: p.y, width: moverDoc.width, height: moverDoc.height, parent: moverDoc.parent });
    if (distanceSquares(at(finalPos), closer) >= distanceSquares(at(startPos), closer)) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  }
  return { status: OP_STATUS.APPLIED, delegated: "dsct", byClient: true, moves: [{ tokenUuid: moverDoc.uuid, startPos, finalPos }] };
}

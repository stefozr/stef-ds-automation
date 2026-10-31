/**
 * Milestone 6: op kind "summon" on the active GM (docs/M6-DESIGN.md §3.3, §3.5, §3.12).
 *
 * `applySummonOp` runs inside the card lock (engine applyOpList) and never throws: every failure is a row reason.
 * - The summoner's TOKEN scene is the scene of the summon (never `canvas.scene`, R§ fact 9).
 * - The squares come from the requester's picker (`clientPlaces`, shapes validated by the relay) and are checked again
 *   here; a GM without squares gets the nearest free ones (`autoPlaces`); a player without squares leaves the row
 *   pending (`placeOnCanvas`: the row's own Summon button sends them).
 * - Square checks, the GM search, the `dsAuto.preSummon` veto and the token creation run under one GM-wide placement
 *   lock, so two cards (two card locks) can never claim the same square. Lock order: card lock -> placement lock;
 *   the placement lock awaits nothing but token reads and the token create.
 * - Tokens: the summoner's disposition (or hostile), `delta.ownership` 3 for the summoner's non-GM owners,
 *   `delta.flags.world.ownerUuid` for hero summoners (setting summonOwnerPotency; never the system's own summoner
 *   flag, R§ fact 36), our token flag `summon` (the truth), carried Stamina in the delta.
 * - Combat (summons/combat.mjs) when the summoner's token is a combatant of a started combat and `turn !== "none"`;
 *   then the registry index (summons/registry.mjs addSummon; also for turn "none" in that combat, without a
 *   combatant). A failed insertion deletes the tokens again.
 * - A summon row never spends the ability's cost: the system did when the ability was used (DSM:6457-6469).
 *
 * Undo dismisses the summon with reason undo and no card annotation (it would wait for this very lock, §6.1).
 * Milestone 8: a native summon row (summons/native.mjs, `op.native`) may carry `effects` (ActiveEffect data of the
 * summon portfolio's advancement): they go into each token's delta with new ids. The cost the system charged for it
 * is not refunded by undo (docs/M8-DESIGN.md Q2).
 *
 * i18n keys used here (lang/en.json, §5.1): DSAUTO.Reason.placeOnCanvas, summonerGone, summonerDown, chooseActor,
 * actorNotAllowed, summonLocked, noWorldActor, noAnchor, wrongScene, noSpace, hookVetoed, gridUnsupported, error,
 * undoError; through variables (squares.mjs reasons): badPlace, offMap, wrongLevel, tooMany, tooFar, occupied.
 */
import { HOOKS, MODULE_ID, OP_STATUS } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { ensureWorldActor } from "../summons/actors.mjs";
import { autoPlaces, gridKind, originOf, validatePlaces } from "../summons/squares.mjs";
import { deletePresent, insertSummon, summonerCombat } from "../summons/combat.mjs";
import { REMOVAL, addSummon, buildIndexEntry, carriedStamina, dismissSummon, isSummonLocked } from "../summons/registry.mjs";

const OWNER = 3;
const HOSTILE = () => globalThis.CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });

const HOOK_PRE = () => HOOKS.preSummon ?? "dsAuto.preSummon";
const HOOK_DONE = () => HOOKS.summon ?? "dsAuto.summon";

function syncDoc(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/** Dying or dead (Draw Steel status ids; the defeated status is core's special status). */
function isDown(actor) {
  const st = actor?.statuses;
  if (!st?.has) return false;
  const dead = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  return st.has("dying") || st.has(dead) || st.has("dead");
}

/** Non-GM users with OWNER on an actor (delta ownership, group ownership). */
export function summonerOwnerIds(actor) {
  if (!actor || !game.users) return [];
  try {
    return game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id);
  } catch (_err) {
    return [];
  }
}

let placementChain = Promise.resolve();

/**
 * GM-wide placement mutex (one promise chain, module-local): square validation, autoPlaces and the token creation of
 * one apply run inside it, so two cards (two card locks) can never claim the same square. It never awaits the card
 * lock or the summon chain. Allowed wait: card lock -> placement lock.
 */
export function withPlacementLock(fn) {
  const run = placementChain.catch(() => {}).then(fn);
  placementChain = run.catch(() => {});
  return run;
}

/**
 * Token source data for one square (actor.getTokenDocument with explicit level and parent, §3.5).
 * @returns {Promise<object>}
 */
export async function tokenDataFor({ actor, square, op, summonId, index, count, summonerDoc, combatId, createdRound, ownerIds, carried, message }) {
  const hostile = op.side === "hostile";
  const disposition = hostile ? HOSTILE() : summonerDoc.disposition;
  const delta = {};
  if (ownerIds?.length) delta.ownership = Object.fromEntries(ownerIds.map(id => [id, OWNER])); // R§ fact 6 (the GM may write it)
  const summoner = summonerDoc.actor;
  if ((setting("summonOwnerPotency") ?? true) !== false && summoner?.type === "hero" && !hostile) {
    delta.flags = { world: { ownerUuid: summoner.uuid } }; // R§ fact 37 (summoner-module potency)
  }
  if (Number.isFinite(carried)) delta.system = { stamina: { value: carried } };
  // Milestone 8 (§2.2): a native portfolio summon's effects (data prepared by the GM handler), new ids per token.
  if (Array.isArray(op.effects) && op.effects.length) {
    delta.effects = op.effects.map(e => ({ ...foundry.utils.deepClone(e), _id: foundry.utils.randomID(16) }));
  }
  const flag = {
    summonId, summonerActorUuid: op.summonerActorUuid ?? summoner?.uuid ?? null, summonerTokenUuid: op.summonerTokenUuid ?? summonerDoc.uuid,
    itemUuid: op.itemUuid ?? null, sourceUuid: op.sourceUuid ?? null, messageId: message?.id ?? null, opId: op.opId ?? null,
    worldActorId: actor.id, side: op.side ?? "summoner", turn: op.turn ?? "own", lasts: [...(op.lasts ?? [])],
    upkeep: op.upkeep ?? null, carryStamina: !!op.carryStamina, lockOnZero: !!op.lockOnZero, combatId, createdRound,
    createdAt: game.time?.serverTime ?? Date.now(), index, count,
  };
  const td = await actor.getTokenDocument({
    x: square.x, y: square.y, elevation: square.elevation, level: square.level, rotation: square.rotation ?? 0,
    disposition, hidden: !!summonerDoc.hidden, actorLink: false, delta,
    flags: { [MODULE_ID]: { summon: flag } },
  }, { parent: summonerDoc.parent });
  const data = td.toObject();
  delete data._id;
  return data;
}

/**
 * Applier of op kind "summon" (called by engine applyOpList inside the card lock). Never throws its own errors.
 * @param {ChatMessage} message
 * @param {object} res             The record (resLive)
 * @param {object} op
 * @param {object} [options]
 * @param {{actor?: string, squares?: object[]}|null} [options.clientPlaces]   validated shapes (queries.mjs); a GM
 *   request may carry the actor alone (the GM search places it)
 * @param {string|null} [options.userId]  The requester (engine passes it)
 * @returns {Promise<object>}      patch (§1.4)
 */
export async function applySummonOp(message, res, op, { clientPlaces = null, userId = null } = {}) {
  try {
    return await applySummon(message, res, op, { clientPlaces, userId });
  } catch (err) {
    error("summon.apply", err, { opId: op?.opId });
    return { status: OP_STATUS.FAILED, reason: "error", error: String(err?.message ?? err), index: null };
  }
}

async function applySummon(message, res, op, { clientPlaces, userId }) {
  const fail = patch => ({ index: null, ...patch });
  const user = game.users?.get?.(userId) ?? game.user;
  const summonerDoc = syncDoc(op.summonerTokenUuid);
  if (!summonerDoc) return fail({ status: OP_STATUS.FAILED, reason: "summonerGone" });
  const scene = summonerDoc.parent; // NEVER canvas.scene (R§ fact 9)
  if (!scene) return fail({ status: OP_STATUS.FAILED, reason: "summonerGone" });
  const summoner = summonerDoc.actor;
  if ((op.lasts ?? []).includes("summonerDying") && isDown(summoner)) return fail({ status: OP_STATUS.SKIPPED, reason: "summonerDown" });
  const item = op.itemUuid ? await fromUuid(op.itemUuid).catch(() => null) : null; // null on api cards
  if (op.lockOnZero && item && isSummonLocked(item, summoner)) return fail({ status: OP_STATUS.SKIPPED, reason: "summonLocked" });

  // 1. The stat block.
  const choices = op.choices ?? [];
  const pick = clientPlaces?.actor ?? (choices.length === 1 ? choices[0].uuid : null);
  if (!pick) return fail({ status: OP_STATUS.FAILED, reason: "chooseActor" });
  const choice = choices.find(c => c?.uuid === pick);
  if (!choice) return fail({ status: OP_STATUS.FAILED, reason: "actorNotAllowed" });
  const { actor } = await ensureWorldActor(choice.uuid, { sourceUuid: op.sourceUuid, allowWorld: !!op.synthetic });
  if (!actor) return fail({ status: OP_STATUS.FAILED, reason: "noWorldActor" });

  // 2. The squares' frame.
  const anchorDoc = op.origin === "target" ? syncDoc(op.anchorTokenUuid) : summonerDoc;
  if (!anchorDoc) return fail({ status: OP_STATUS.FAILED, reason: "noAnchor" });
  if (anchorDoc.parent?.id !== scene.id) return fail({ status: OP_STATUS.FAILED, reason: "wrongScene" });
  if (gridKind(scene) === "hex") return fail({ status: OP_STATUS.FAILED, reason: "gridUnsupported" });
  // Review fix: a row without a distance (self / special ability, no entry distance) keeps its own reason; the
  // square checks would report tooFar / noSpace for distance 0.
  if (op.distance == null || !Number.isFinite(Number(op.distance))) return fail({ status: OP_STATUS.FAILED, reason: "noDistance" });
  const proto = actor.prototypeToken ?? {};
  const size = { width: Math.max(1, Number(proto.width) || 1), height: Math.max(1, Number(proto.height) || 1) };
  const origin = originOf(anchorDoc);
  const level = summonerDoc.level ?? null;
  // `clientPlaces` may carry the chosen stat block alone (a Director in summonPlacement "auto"): the GM searches.
  const picked = Array.isArray(clientPlaces?.squares) ? clientPlaces.squares : null;
  if (!picked && !user?.isGM) return { status: OP_STATUS.PENDING, reason: "placeOnCanvas", index: null };

  // 3. Combat context first (the token flag records it). For every turn mode (review fix): a turn "none" summon made
  // in a running combat gets no combatant but is indexed, so its summoner-turn ends and its upkeep still fire.
  const ctx = summonerCombat(summonerDoc); // by combatant, never combat.scene (D17)
  const combatId = ctx?.combat?.id ?? null;
  const createdRound = ctx?.combat?.round ?? null;
  const summonId = foundry.utils.randomID(16);
  const ownerIds = op.side === "hostile" ? [] : summonerOwnerIds(summoner);
  const carried = op.carryStamina && item ? carriedStamina(item, combatId) : null;

  // 4-5. Squares, veto and tokens under ONE GM-wide placement lock.
  let byClient = false;
  let auto = false;
  const out = await withPlacementLock(async () => {
    let squares;
    if (picked) {
      const v = validatePlaces({ scene, origin, squares: picked, size, quantity: op.quantity, distance: op.distance, level });
      if (!v.ok) return { fail: { status: OP_STATUS.FAILED, reason: v.reason, index: v.index ?? null } };
      squares = v.squares;
      byClient = true;
    } else {
      // The elevation of the square frame's origin (the anchor for origin "target"): distance is measured from it.
      squares = autoPlaces({ scene, origin, size, quantity: op.quantity, distance: op.distance, level, elevation: anchorDoc.elevation ?? 0 });
      if (!squares.length) return { fail: fail({ status: OP_STATUS.FAILED, reason: "noSpace" }) };
      auto = true;
    }
    const veto = Hooks.call(HOOK_PRE(), message, op, { actorUuid: pick, worldActorId: actor.id, sceneId: scene.id, squares, userId });
    if (veto === false) return { fail: fail({ status: OP_STATUS.SKIPPED, reason: "hookVetoed" }) };
    const data = [];
    for (let k = 0; k < squares.length; k++) {
      data.push(await tokenDataFor({
        actor, square: squares[k], op, summonId, index: k, count: squares.length,
        summonerDoc, combatId, createdRound, ownerIds, carried, message,
      }));
    }
    return { created: await scene.createEmbeddedDocuments("Token", data, { controlObject: false, ...INTERNAL() }) };
  });
  if (out.fail) return out.fail;
  const created = out.created ?? [];
  if (!created.length) return fail({ status: OP_STATUS.FAILED, reason: "error", error: "noTokens" });

  // 6. Combat (insertSummon never throws; on failure it already removed its own combatants and group).
  let ins = { combatantIds: [], groupId: null, groupCreated: false, poolAdded: 0, held: false };
  if (ctx && op.turn !== "none") {
    ins = await insertSummon({ combat: ctx.combat, summonerCombatant: ctx.combatant, tokens: created, actor, op, summonId, ownerIds });
    if (ins.error) {
      error("summon.insert", new Error(ins.error), { summonId });
      await deletePresent(scene, "Token", created.map(t => t.id), INTERNAL()).catch(err => error("summon.cleanup", err));
      return fail({ status: OP_STATUS.FAILED, reason: "error", error: ins.error });
    }
  }

  // 7. Registry index (combat only; the tokens carry the truth anyway).
  if (ctx) {
    try {
      await addSummon(buildIndexEntry({ summonId, tokens: created, ins, ctx, op, actor, message }));
    } catch (err) {
      error("summon.index", err, { summonId });
    }
  }

  const patch = {
    status: OP_STATUS.APPLIED, summonId, actorUuid: pick, worldActorId: actor.id, sceneId: scene.id,
    tokenUuids: created.map(t => t.uuid), names: created.map(t => t.name), placed: created.length,
    requested: op.quantity, combatId, combatantIds: ins.combatantIds, groupId: ins.groupId,
    groupCreated: ins.groupCreated, poolAdded: ins.poolAdded, byClient, auto, carried: Number.isFinite(carried) ? carried : null,
    // Cleared on every apply: RESET_ON_APPLY lacks them and record patches merge (§1.4).
    dismissed: null, index: null,
  };
  try {
    Hooks.callAll(HOOK_DONE(), message, { ...op, ...patch }, {
      summonId, tokenUuids: patch.tokenUuids, combatId, combatantIds: ins.combatantIds, groupId: ins.groupId,
    });
  } catch (err) {
    error("summon.hook", err);
  }
  log("summon.apply", { summonId, name: actor.name, placed: created.length, combatId });
  return patch;
}

/** Undo of op kind "summon" (engine/undo.mjs, inside the card lock): dismissSummon(op.summonId, REMOVAL.UNDO, {annotate: false}). */
export async function undoSummon(res, op) {
  if (!op?.summonId) return { status: OP_STATUS.UNDONE, undoMode: "alreadyGone" };
  try {
    // annotate: false - the annotation would wait for this very card lock (§6.1).
    const r = await dismissSummon(op.summonId, REMOVAL.UNDO, { annotate: false });
    // Tokens may remain: never report a false undo.
    if (r?.error) return { status: OP_STATUS.FAILED, reason: "undoError", error: r.error };
    return { status: OP_STATUS.UNDONE, undoMode: r?.gone ? "alreadyGone" : null };
  } catch (err) {
    error("summon.undo", err, { summonId: op.summonId });
    return { status: OP_STATUS.FAILED, reason: "undoError", error: String(err?.message ?? err) };
  }
}

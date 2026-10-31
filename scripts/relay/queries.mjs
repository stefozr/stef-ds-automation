import { setAura, chooseNullOption } from "../features/auras.mjs";
import { radicalAvailable, consumeRadical } from "../features/capabilities.mjs";
import { grantAlone } from "../features/alone.mjs";
import { featureRules, executeRule } from "../features/engine.mjs";
import { setPerformances, isPerformance, activePerformances, canPerform } from "../features/performance.mjs";
/**
 * GM relay: every card button and console call goes through `requestOp`, which runs on the active GM
 * (the single writer) and is authorized there. Non-active GMs and players reach it through Foundry's
 * user queries (`CONFIG.queries`); the requesting user comes from core (the server-side socket
 * sender), never from the payload. No raw sockets.
 *
 * Payload: `{action, messageId, opIds?, tokenUuids?, force?, half?, opId?, count?, potency?, damage?}` with action
 *   resolve   resolve an unresolved card (GM or author; `force` re-resolves, GM only)
 *   retarget  rebuild the card for `tokenUuids` (see auth.mjs mayRetarget)
 *   heroReroll  0.16.0: reroll the card's power roll with a hero token (resources/hero-token-reroll.mjs; an owner of
 *             the hero who may retarget, or a GM)
 *   apply     apply `opIds`, or every pending op when omitted; `half` halves damage ops
 *   undo      undo `opIds`, or every applied op when omitted
 *   surge     spend `count` surges as extra damage on op `opId`, or 2 for +1 potency (`potency`)
 *   damage    post a synthetic damage/healing card from `damage` (api.applyDamage; Directors only,
 *             no messageId)
 *   move      post a forced movement or teleport card from `move` (api.forcedMovement, api.teleport;
 *             Directors only, no messageId)
 *   edit      change op `opId` before applying it (`edits`: amount, temp, distance, movement) and apply
 *             it when `apply` is true; Directors only (an edit can exceed what was rolled); a cleanse
 *             row's `effects` (which effects end) may be chosen by whoever may apply it
 *   choose    pick `option` of the card's "choose one" group `group` (Milestone 4)
 *   pick      (Milestone 9) `opId` (a pick row), `tokenUuids` (1-5), `damageType?`: the creature(s) picked; authorized like
 *             Apply on the row (auth.mjs isOwnPick: the user's owners), checked against the GM's own candidates
 *             (engine.mjs recordPick), then the card resolves again
 * Milestone 5 (triggered actions, no messageId; docs/M5-DESIGN.md §1.10):
 *   hold           `hold`: external damage about to land on an actor the requester owns; answers
 *                  `{ok, holdId, amount, halved, entries}` once the reactors answered (triggers/holds.mjs)
 *   holdDone       `holdDone`: that damage went ahead (or not); a `holdId` only from the user it was issued to
 *   preRoll        `preRoll`: a damage-dealing roll dialog of the requester's actor; edges from reactors
 *   preRollCancel  `preRollCancel`: the roller stopped waiting;  preRollDone  `preRollDone`: rolled or not
 *                  (triggers/roll-lock.mjs)
 *   moveGate       `moveGate`: a token the requester owns is about to move (triggers/external.mjs)
 *   fmActive       `fmActive`: a forced move runs on the requester's client; its collision damage passes
 *                  (window `id`; `refresh: true` keeps it open while the move runs, `end: true` closes it)
 *   trigger        `trigger`: a follow-up of a trigger card started, was cancelled or failed (triggers/card.mjs)
 *   triggerCommit  `triggerCommit`: GMs only; reactions another GM decided whose effect landed after the active GM
 *                  changed: the active GM posts their cards (triggers/engine.mjs forwardCommit)
 *   halfMark       `halfMark`: a Shift+Click half damage on the requester's client whose takeDamage may run on the
 *                  active GM (Combat Tools' socket): those actor / token uuids are marked halved for 5 s
 * `hold` and `preRoll` answer with `gmId`, the GM that holds the pending commit: `holdDone` / `preRollDone` go to
 * that GM (`requestOpVia`) and are taken there even after another GM became the active GM.
 * `apply` may carry `moves: {opId: true}`: the mover's owner made that self-teleport on their own client;
 * the active GM records it from Foundry's own report of the move (engine/forced.mjs, engine/move-log.mjs).
 * Milestone 6 (summoning, docs/M6-DESIGN.md §1.6):
 *   apply          may carry `places: {opId: {actor, squares: [{x, y, elevation, level, rotation}]}}` for summon rows:
 *                  the squares the requester picked on their canvas (shapes checked here, legality on the GM)
 *   summon         post a summon card from `summon` (api.summon; Directors only, no messageId)
 *   summonPrepare  prepare a summon row's world actors again (`opId`; `grant: true` gives the summoner's non-GM
 *                  owners OWNER on the world actor when it is missing on their client); authorized like Apply
 *   summonDismiss  `summonDismiss: {summonId}` (no card: the summon outlives its card); the GM, the summoner's
 *                  owners and the summon's owners
 * Milestone 7 (resources and zones, docs/M7-DESIGN.md §1.7):
 *   apply          may carry `zonePlaces: {opId: {shapes: [{x, y, rotation}], level, elevation}}` for zone rows: the
 *                  shapes the requester placed on their canvas (shapes only; sizes never come from the client)
 *   zoneDismiss    `zoneDismiss: {zoneId}` (no card): a GM or an owner of the zone's creator
 *   malice         `malice: {delta, reason?}` (no card): Directors; posts an undoable Malice card
 *   summonActivate `summonActivate: {combatId, combatantId}` (no card): an owner of the summon (summons/activate.mjs)
 *   holdDone       also carries `type`, `source`, `groupUuid`, `staminaLoss`, `reportOnly` (a report for resource
 *                  gains; the GM matches it to a Stamina change it saw itself)
 * Milestone 8 (docs/M8-DESIGN.md §2.2, §3.6; no card):
 *   nativeSummon   `nativeSummon: {abilityUuid, actorUuid, count, effectUuids, summonerTokenUuid, places}`: the system's
 *                  own Summon button on 1.2 (our wrapper of AbilityModel#performSummon, summons/native.mjs); the GM
 *                  checks it against the ability's summon effects, posts the summon card and places the tokens;
 *                  answers `{ok, messageId, tokenUuids, reason}`
 *   endTargeted    `endTargeted: {actorUuid, statusId, sourceUuid?}` (api.endTargeted): end one of our native targeted
 *                  conditions, or one grab source; Directors (role floor), owners of the actor or of the source
 * Milestone 9 (WP-C, docs/M9-DESIGN.md §C.5; no card):
 *   persistent     `persistent: {sub: "useStarted"|"useCancelled", parentMessageId, runId}`: a Persistent re-roll's
 *                  follow-up report (persistent/reroll.mjs); the GM's expectation of that use and runId, and the
 *                  sender a GM or an owner of the use's user
 * Errors cross the socket as their message only, so denials throw an i18n key (`DSAUTO.Relay.*`)
 * that the requesting client localizes; any other message reads as `DSAUTO.Relay.Failed` (logged as is).
 *
 * i18n keys (Milestone 8): DSAUTO.Relay.Failed, DSAUTO.Relay.NativeSummonRefused.
 */
import { QUERY_OP, MODULE_ID, loc } from "../constants.mjs";
import { addSurge, applyOps, chooseOption, editOp, isActiveGM, prepareSummon, recordPick, resolveMessage, retarget, undoOps } from "../engine/engine.mjs";
import { createDamageCard, createMoveCard, createSummonCard, validSquares } from "../engine/synthetic.mjs";
import { getResolution } from "../engine/record.mjs";
import { debug, log, warn } from "../log.mjs";
import { mayAct, mayDismissSummon, mayEndTargeted, mayRequestHold, mayResolve, mayRetarget, maySurge } from "./auth.mjs";
import { externalDone, externalHold, hasExternalPending } from "../triggers/holds.mjs";
import { handlePreRoll, handlePreRollCancel, handlePreRollDone, hasPreRollPending } from "../triggers/roll-lock.mjs";
import { handleFmActive, handleMoveGate, markExternalHalf, pauseExternalHalf } from "../triggers/external.mjs";
import { handleTriggerCommit } from "../triggers/engine.mjs";
import { handleTriggerReport } from "../triggers/card.mjs";
import { externalPromptMs, promptMs } from "../triggers/prompt.mjs";
import { REMOVAL, dismissSummon, summonInfo } from "../summons/registry.mjs";
import { MAX_ZONE_SQUARES } from "../library/schema.mjs";
import { postMaliceCard } from "../resources/world-resources.mjs";
import { rerollPowerRoll } from "../resources/hero-token-reroll.mjs";
import { ZONE_END, endZone, mayDismissZone, zoneInfo } from "../zones/registry.mjs";
import { handleSummonActivate } from "../summons/activate.mjs";
import { handleNativeSummon, validNativeSummon } from "../summons/native.mjs";

/**
 * The native targeted builder (engine/targeted.mjs, docs/M8-DESIGN.md §3.6) is loaded when `endTargeted` first
 * arrives: the action answers BadRequest while that module or its `handleEndTargeted` is missing.
 */
let targetedNs;
async function targetedModule() {
  if (targetedNs === undefined) targetedNs = await import("../engine/targeted.mjs").catch(() => null);
  return targetedNs;
}

/** Milestone 9 (WP-C): persistent/reroll.mjs (GM side), loaded when `persistent` first arrives. */
let persistentNs;
async function persistentModule() {
  if (persistentNs === undefined) persistentNs = await import("../persistent/reroll.mjs").catch(() => null);
  return persistentNs;
}

/** `persistent: {sub, parentMessageId, runId}` (no card): validated, then re-validated against the GM's expectation. */
async function handlePersistentAction(payload, user) {
  const mod = await persistentModule();
  const data = payload?.persistent;
  if (typeof mod?.validPersistentReport !== "function" || !mod.validPersistentReport(data)) throw new Error("DSAUTO.Relay.BadRequest");
  const out = await mod.handlePersistentReport(data, user);
  logAllowed(user, "persistent", data.parentMessageId, { sub: data.sub, ok: !!out?.ok });
  return { ok: !!out?.ok };
}

const ACTIONS = new Set([
  "resolve", "retarget", "apply", "undo", "surge", "damage", "move", "edit", "choose",
  // Milestone 5: triggered actions.
  "hold", "holdDone", "preRoll", "preRollCancel", "preRollDone", "moveGate", "fmActive", "trigger", "triggerCommit", "halfMark",
  // Milestone 6: summoning.
  "summon", "summonPrepare", "summonDismiss",
  // Milestone 7: zones, Malice, summon activation.
  "zoneDismiss", "malice", "summonActivate",
  // Milestone 8: native summons, ending a native targeted condition.
  "nativeSummon", "endTargeted", "featureUse", "performanceSet", "featureRadical", "aloneGrant", "auraControl",
  // Milestone 9 (WP-A): the creature(s) of a pick row.
  "pick",
  // Milestone 9 (WP-C): a Persistent re-roll's report.
  "persistent",
  // 0.16.0: a hero token rerolls a card's power roll.
  "heroReroll",
]);
/** Milestone 6 actions that carry no card (the payload object of the same name). */
const SUMMON_NOCARD = new Set(["summonDismiss"]);
/** Milestone 7 actions that carry no card (the payload object of the same name). */
const M7_NOCARD = new Set(["zoneDismiss", "malice", "summonActivate"]);
/** Milestone 8 actions that carry no card (the payload object of the same name). */
const M8_NOCARD = new Set(["nativeSummon", "endTargeted"]);
/** Milestone 5 actions that carry no card (the payload object of the same name). */
const TRIGGER_ACTIONS = new Set([
  "hold", "holdDone", "preRoll", "preRollCancel", "preRollDone", "moveGate", "fmActive", "trigger", "triggerCommit", "halfMark",
]);
const MAX_IDS = 200;
const TIMEOUT_MS = 30_000;
/**
 * Apply and edit may wait for a pick on the active Director's canvas (forced movement, teleport), and every
 * action that applies damage may wait for triggered-action prompts (Milestone 5, C13).
 */
const LONG_TIMEOUT_MS = 300_000;
const LONG_ACTIONS = new Set(["apply", "edit", "move", "resolve", "retarget", "heroReroll", "choose", "damage", "summon", "nativeSummon", "auraControl", "pick"]);
/** The GM side of a forced-move notice never prompts. */
const FM_ACTIVE_TIMEOUT_MS = 10_000;

/**
 * The longest a card action can queue behind a hold of that card: the card's lock is held while our pre-pass
 * prompts (deadline 2T + 6 s, plus the GM's 3 s slack), then while the hero-token step asks (Milestone 7, §6.1: at
 * most 5 s to start an ask, then T + 3 s): 3T + 20 s.
 */
export const holdWaitMs = () => 3 * promptMs() + 20_000;

/**
 * How long a requester waits for the active GM (§6.2): longer than every GM-side offer deadline (P + 5 s),
 * so the GM always answers first. Surge and undo never prompt, but they queue behind a held apply of the
 * same card; long actions may queue behind two.
 */
export function timeoutFor(action) {
  if (action === "hold") return externalPromptMs() + 15_000;
  if (action === "preRoll" || action === "moveGate") return promptMs() + 15_000;
  if (action === "fmActive" || action === "halfMark") return FM_ACTIVE_TIMEOUT_MS;
  if (action === "surge" || action === "undo") return TIMEOUT_MS + holdWaitMs();
  if (action === "summonPrepare" || action === "summonDismiss" || action === "zoneDismiss" || action === "endTargeted") return TIMEOUT_MS + holdWaitMs();
  if (action === "malice" || action === "summonActivate") return TIMEOUT_MS;
  return LONG_ACTIONS.has(action) ? Math.max(LONG_TIMEOUT_MS, 2 * holdWaitMs() + 60_000) : TIMEOUT_MS;
}

export function registerRelay() {
  CONFIG.queries[QUERY_OP] = handleOp;
}

/** Run a card action on the active GM. Resolves with `{ok, refused?}`; rejects with an Error. */
export async function requestOp(payload) {
  const gm = game.users.activeGM;
  if (!gm) throw new Error("DSAUTO.Relay.NoActiveGM");
  if (gm.isSelf) return handleOp(payload, { user: game.user });
  return gm.query(QUERY_OP, payload, { timeout: timeoutFor(payload?.action) });
}

/**
 * The second phase of a two-phase commit (`holdDone`, `preRollDone`): to the GM that issued the hold (`gmId`,
 * it keeps the pending commit in memory) while that GM is connected, else to the active GM (§6.4).
 */
export async function requestOpVia(gmId, payload) {
  const gm = gmId ? game.users?.get?.(gmId) ?? null : null;
  if (!gm?.active) return requestOp(payload);
  if (gm.isSelf) return handleOp(payload, { user: game.user });
  return gm.query(QUERY_OP, payload, { timeout: timeoutFor(payload?.action) });
}

/** A commit whose hold this client issued (it may no longer be the active GM). */
function ownCommit(payload) {
  if (payload?.action === "holdDone") return hasExternalPending(payload.holdDone?.holdId);
  if (payload?.action === "preRollDone") return hasPreRollPending(payload.preRollDone?.holdId);
  return false;
}

/**
 * Localized text for an error thrown by requestOp: our i18n keys (`DSAUTO.*`) localized; anything else (a raw error of
 * the GM side, a timeout) reads as DSAUTO.Relay.Failed and its message goes to the console (Milestone 8, §8.1).
 */
export function relayErrorText(err) {
  const msg = String(err?.message ?? err ?? "");
  if (msg.startsWith("DSAUTO.")) return loc(msg);
  warn("relay.error", { message: msg });
  return loc("DSAUTO.Relay.Failed");
}

const strings = (value, max = MAX_IDS) =>
  Array.isArray(value) && value.length <= max && value.every(v => typeof v === "string" && v.length && v.length < 300);

function deny(user, action, messageId, data = {}) {
  warn("relay.in", { user: user?.name, userId: user?.id, action, messageId, allowed: false, ...data });
  return new Error("DSAUTO.Relay.Denied");
}

function logAllowed(user, action, messageId, data = {}) {
  const entry = { user: user.name, userId: user.id, action, messageId, allowed: true, ...data };
  if (user.isSelf) debug("relay.in", entry);
  else log("relay.in", entry);
}

/** Players may retarget only to visible tokens on the active scene or the scene the Director views. */
function playerTargetable(uuid) {
  let doc = null;
  try {
    doc = fromUuidSync(uuid);
  } catch (_err) {
    return false;
  }
  if (!doc?.actor || doc.hidden) return false;
  const sceneId = doc.parent?.id;
  return !!sceneId && (sceneId === game.scenes?.active?.id || sceneId === globalThis.canvas?.scene?.id);
}

/** `moves` of an apply request: `{opId: true}` for named ops only. */
function validMoves(moves, opIds) {
  if (moves == null) return true;
  if (!moves || typeof moves !== "object" || Array.isArray(moves)) return false;
  return Object.entries(moves).every(([id, v]) => Array.isArray(opIds) && opIds.includes(id) && v === true);
}

/**
 * `places` of an apply request (Milestone 6, §1.6), shapes only: `{opId: {actor?, squares}}` for named ops; `actor` a
 * string of 1-300 characters; `squares` 1-10 squares. The GM decides whether a square is legal (summons/squares.mjs).
 */
export function validPlaces(places, opIds) {
  if (places == null) return true;
  if (!places || typeof places !== "object" || Array.isArray(places)) return false;
  return Object.entries(places).every(([id, v]) => Array.isArray(opIds) && opIds.includes(id)
    && !!v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).every(k => k === "actor" || k === "squares")
    && (v.actor === undefined || (typeof v.actor === "string" && v.actor.length >= 1 && v.actor.length <= 300))
    // The chosen stat block alone (a Director with summonPlacement "auto": the GM searches the squares).
    && (v.squares === undefined ? typeof v.actor === "string" : validSquares(v.squares)));
}

const finiteWithin = (v, max) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;

/**
 * `zonePlaces` of an apply request (Milestone 7, §1.7), shapes only: `{opId: {shapes, level?, elevation?}}` for named
 * ops; 1-MAX_ZONE_SQUARES shapes `{x, y, rotation?}` (|x|, |y| <= 1e6, rotation in [0, 360)); `level` a string of 1-40
 * characters or null; `elevation` finite, |v| <= 1e5. Sizes never come from the client (the GM builds them).
 */
export function validZonePlaces(places, opIds) {
  if (places == null) return true;
  if (!places || typeof places !== "object" || Array.isArray(places)) return false;
  const max = Number(MAX_ZONE_SQUARES) || 30;
  return Object.entries(places).every(([id, v]) => Array.isArray(opIds) && opIds.includes(id)
    && !!v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).every(k => k === "shapes" || k === "level" || k === "elevation")
    && Array.isArray(v.shapes) && v.shapes.length >= 1 && v.shapes.length <= max
    && v.shapes.every(s => !!s && typeof s === "object" && !Array.isArray(s)
      && Object.keys(s).every(k => k === "x" || k === "y" || k === "rotation")
      && finiteWithin(s.x, 1e6) && finiteWithin(s.y, 1e6)
      && (s.rotation === undefined || (typeof s.rotation === "number" && Number.isFinite(s.rotation) && s.rotation >= 0 && s.rotation < 360)))
    && (v.level == null || (typeof v.level === "string" && v.level.length >= 1 && v.level.length <= 40))
    && (v.elevation === undefined || finiteWithin(v.elevation, 1e5)));
}

/** Log a refusal; return the decision (the engine throws DSAUTO.Relay.Denied on false). */
function checked(allowed, user, action, messageId) {
  if (!allowed) deny(user, action, messageId);
  return allowed;
}

/** Query handler on the active GM. */
export async function handleOp(payload, { user } = {}) {
  if (!isActiveGM() && !ownCommit(payload)) throw new Error("DSAUTO.Relay.NotActiveGM");
  if (!user) throw new Error("DSAUTO.Relay.BadRequest");
  const { action, messageId } = payload ?? {};
  if (!ACTIONS.has(action)) throw new Error("DSAUTO.Relay.BadRequest");
  if (action === "featureUse" || action === "performanceSet" || action === "featureRadical" || action === "aloneGrant" || action === "auraControl") {
    if (typeof payload.itemUuid !== "string" || payload.itemUuid.length > 300) throw new Error("DSAUTO.Relay.BadRequest");
    const item = fromUuidSync(payload.itemUuid);
    if (!item?.actor || item.pack || (!user.isGM && !item.testUserPermission?.(user, "OWNER"))) throw deny(user, action, null);
    if (action === "auraControl") {
      if (payload.enhance === true) return chooseNullOption(item);
      if (payload.active !== false) throw new Error("DSAUTO.Relay.BadRequest");
      await setAura(item, false); return { ok: true };
    }
    if (action === "aloneGrant") return grantAlone(item, payload, user);
    if (action === "featureRadical") {
      const actor = item.actor;
      if (item.system?.type !== "triggered" || !game.combat?.started) throw new Error("DSAUTO.Relay.BadRequest");
      if (payload.cancel) {
        const credit = actor.flags?.[MODULE_ID]?.radicalCard;
        if (typeof payload.creditId !== "string" || credit?.creditId !== payload.creditId || credit.used) throw new Error("DSAUTO.Relay.BadRequest");
        await actor.update({ [`flags.${MODULE_ID}.radicalUsed`]: new foundry.data.operators.ForcedDeletion(), [`flags.${MODULE_ID}.radicalCard`]: new foundry.data.operators.ForcedDeletion() });
        return { ok: true };
      }
      if (!radicalAvailable(actor) || !await consumeRadical(actor)) return { ok: false };
      const creditId = foundry.utils.randomID();
      await actor.update({ [`flags.${MODULE_ID}.radicalCard`]: { itemUuid: item.uuid, creditId, combatId: game.combat.id, round: game.combat.round, used: false } });
      return { ok: true, creditId };
    }
    if (action === "performanceSet") {
      if (payload.active != null && typeof payload.active !== "boolean") throw new Error("DSAUTO.Relay.BadRequest");
      if (item.flags?.[MODULE_ID]?.disabled || !isPerformance(item) || !game.combat?.started || !canPerform(item.actor)) throw new Error("DSAUTO.Relay.BadRequest");
      const active = activePerformances(item.actor).filter(uuid => uuid !== item.uuid);
      const medley = [...item.actor.items].some(i => i.system?._dsid === "medley" && !i.flags?.[MODULE_ID]?.disabled);
      const items = payload.active === false ? active : [...(medley ? active.slice(-1) : []), item.uuid];
      await setPerformances(item.actor, items, game.combat);
      return { ok: true };
    }
    if (!strings(payload.tokenUuids ?? [], 100) || (!user.isGM && !(payload.tokenUuids ?? []).every(playerTargetable))) throw new Error("DSAUTO.Relay.BadRequest");
    const results = [];
    for (const rule of featureRules(item).filter(r => r.event === "use")) results.push(await executeRule(item, rule, { targetDocs: (payload.tokenUuids ?? []).map(uuid => fromUuidSync(uuid)), user }));
    return { ok: true, results };
  }
  if (action === "persistent") return handlePersistentAction(payload, user);
  if (TRIGGER_ACTIONS.has(action)) return handleTriggerAction(action, payload, user);
  if (SUMMON_NOCARD.has(action)) return handleSummonAction(action, payload, user);
  if (M7_NOCARD.has(action)) return handleM7Action(action, payload, user);
  if (M8_NOCARD.has(action)) return handleM8Action(action, payload, user);
  if (action === "summon") {
    if (!user.isGM) throw deny(user, action, null);
    if (!payload.summon || typeof payload.summon !== "object" || Array.isArray(payload.summon)) throw new Error("DSAUTO.Relay.BadRequest");
    const result = await createSummonCard(payload.summon, user);
    logAllowed(user, action, result.messageId);
    return { ok: true, messageId: result.messageId, ops: result.ops };
  }
  if (action === "damage") {
    if (!user.isGM) throw deny(user, action, null);
    if (!payload.damage || typeof payload.damage !== "object") throw new Error("DSAUTO.Relay.BadRequest");
    const result = await createDamageCard(payload.damage, user);
    logAllowed(user, action, result.messageId);
    return { ok: true, messageId: result.messageId, ops: result.ops };
  }
  if (action === "move") {
    if (!user.isGM) throw deny(user, action, null);
    if (!payload.move || typeof payload.move !== "object") throw new Error("DSAUTO.Relay.BadRequest");
    const result = await createMoveCard(payload.move, user);
    logAllowed(user, action, result.messageId, { kind: payload.move.kind });
    return { ok: true, messageId: result.messageId, ops: result.ops };
  }
  if (typeof messageId !== "string") throw new Error("DSAUTO.Relay.BadRequest");
  if (payload.opIds != null && !strings(payload.opIds)) throw new Error("DSAUTO.Relay.BadRequest");
  const message = game.messages.get(messageId);
  if (!getResolution(message)) throw new Error("DSAUTO.Relay.UnknownCard");

  switch (action) {
    case "resolve": {
      const force = !!payload.force;
      if (force && !user.isGM) throw deny(user, action, messageId, { force });
      await resolveMessage(message, {
        force, reason: user.isSelf ? "button" : `relay:${user.id}`,
        guard: (_res, msg) => checked(mayResolve(user, msg), user, action, messageId),
      });
      logAllowed(user, action, messageId, { force });
      return { ok: true };
    }
    case "retarget": {
      if (!strings(payload.tokenUuids, 100)) throw new Error("DSAUTO.Relay.BadRequest");
      if (!user.isGM && !(payload.tokenUuids ?? []).every(playerTargetable)) throw deny(user, action, messageId, { refused: "tokens" });
      await retarget(message, payload.tokenUuids, user.isSelf ? "button" : `relay:${user.id}`, {
        guard: (res, msg) => checked(mayRetarget(user, msg, res), user, action, messageId),
      });
      logAllowed(user, action, messageId, { count: payload.tokenUuids.length });
      return { ok: true };
    }
    case "heroReroll": {
      const result = await rerollPowerRoll(message, { user });
      logAllowed(user, action, messageId, { ok: !!result?.ok, refused: result?.refused ?? null });
      return result;
    }
    case "surge": {
      const { opId } = payload;
      const potency = payload.potency === true;
      if (typeof opId !== "string" || opId.length > 300) throw new Error("DSAUTO.Relay.BadRequest");
      if (!potency && !Number.isInteger(payload.count)) throw new Error("DSAUTO.Relay.BadRequest");
      const result = await addSurge(message, opId, {
        count: payload.count, potency, user,
        authorize: (_op, _res, _msg, hero) => checked(maySurge(user, hero), user, action, messageId),
      });
      logAllowed(user, action, messageId, { opId, count: payload.count ?? null, potency });
      return { ok: true, ...(result ?? {}) };
    }
    case "pick": {
      const { opId } = payload;
      const damageType = payload.damageType ?? null;
      if (typeof opId !== "string" || !opId.length || opId.length > 300 || !strings(payload.tokenUuids, 5) || !payload.tokenUuids.length) throw new Error("DSAUTO.Relay.BadRequest");
      if (damageType !== null && !(typeof damageType === "string" && /^[a-z]{1,20}$/.test(damageType))) throw new Error("DSAUTO.Relay.BadRequest");
      const result = await recordPick(message, opId, { tokenUuids: payload.tokenUuids, damageType }, {
        userId: user.id,
        authorize: (op, res, msg) => checked(mayAct(user, msg, res, op, "apply"), user, action, messageId),
      });
      logAllowed(user, action, messageId, { opId, count: payload.tokenUuids.length, damageType });
      return { ok: true, effectId: result?.effectId ?? null };
    }
    case "choose": {
      const { group, option } = payload;
      if (typeof group !== "string" || typeof option !== "string" || group.length > 40 || option.length > 40) throw new Error("DSAUTO.Relay.BadRequest");
      const result = await chooseOption(message, group, option, {
        userId: user.id,
        authorize: (op, res, msg) => mayAct(user, msg, res, op, "apply"),
      });
      logAllowed(user, action, messageId, { group, option });
      return { ok: true, ...(result ?? {}) };
    }
    case "summonPrepare": {
      const { opId } = payload;
      if (typeof opId !== "string" || !opId.length || opId.length > 300) throw new Error("DSAUTO.Relay.BadRequest");
      if (payload.grant != null && typeof payload.grant !== "boolean") throw new Error("DSAUTO.Relay.BadRequest");
      const grant = payload.grant === true;
      const result = await prepareSummon(message, opId, {
        userId: user.id, grant,
        authorize: (op, res, msg) => checked(mayAct(user, msg, res, op, "apply"), user, action, messageId),
      });
      logAllowed(user, action, messageId, { opId, grant });
      return { ok: true, choices: result?.choices ?? [] };
    }
    case "edit": {
      const { opId, edits } = payload;
      if (typeof opId !== "string" || opId.length > 300 || !edits || typeof edits !== "object") throw new Error("DSAUTO.Relay.BadRequest");
      // Choosing which effects a cleanse row ends is part of applying it; everything else is the Director's.
      const onlyEffects = Object.keys(edits).length === 1 && Array.isArray(edits.effects);
      if (!user.isGM && !onlyEffects) throw deny(user, action, messageId, { opId });
      const result = await editOp(message, opId, edits, {
        user, apply: payload.apply === true,
        authorize: (op, res, msg) => checked(mayAct(user, msg, res, op, "apply"), user, action, messageId),
      });
      logAllowed(user, action, messageId, { opId, apply: payload.apply === true });
      return { ok: true, ...(result ?? {}) };
    }
    case "apply":
    case "undo": {
      // null = every pending (apply) or applied (undo) op; an empty list does nothing.
      const opIds = Array.isArray(payload.opIds) ? payload.opIds : null;
      const authorize = (op, res, msg) => {
        const allowed = mayAct(user, msg, res, op, action);
        if (allowed) logAllowed(user, action, messageId, { opId: op.opId });
        else deny(user, action, messageId, { opId: op.opId });
        return allowed;
      };
      // Explicit ops the record no longer offers (already applied, not applied) are no-ops.
      const run = action === "apply" ? applyOps : undoOps;
      if (action === "apply" && !validMoves(payload.moves, opIds)) throw new Error("DSAUTO.Relay.BadRequest");
      if (action === "apply" && !validPlaces(payload.places, opIds)) throw new Error("DSAUTO.Relay.BadRequest");
      if (action === "apply" && !validZonePlaces(payload.zonePlaces, opIds)) throw new Error("DSAUTO.Relay.BadRequest");
      // One kind of placement per op: a zone's shapes never double as a summon's squares or a move.
      if (action === "apply" && payload.zonePlaces && Object.keys(payload.zonePlaces).some(id => (payload.places && id in payload.places)
        || (payload.moves && id in payload.moves))) throw new Error("DSAUTO.Relay.BadRequest");
      const result = await run(message, opIds, {
        userId: user.id, authorize, half: action === "apply" && payload.half === true,
        clientMoves: action === "apply" ? (payload.moves ?? null) : null,
        clientPlaces: action === "apply" ? (payload.places ?? null) : null,
        clientZones: action === "apply" ? (payload.zonePlaces ?? null) : null,
      });
      const refused = result?.refused ?? [];
      // An explicit request whose every op was refused is a denial, not a no-op.
      if (opIds && refused.length && !Object.keys(result?.patches ?? {}).length) throw new Error("DSAUTO.Relay.Denied");
      return { ok: true, refused };
    }
  }
  throw new Error("DSAUTO.Relay.BadRequest");
}

/* -------------------------------------------- */
/*  Milestone 5: triggered actions              */
/* -------------------------------------------- */

const isObject = v => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = v => typeof v === "string" && v.length > 0 && v.length < 300;
const optionalUuid = v => v == null || uuid(v);
const shortId = v => typeof v === "string" && v.length > 0 && v.length <= 40;
const stamina = v => v == null || (isObject(v) && Number.isFinite(Number(v.value ?? 0)) && Number.isFinite(Number(v.temporary ?? 0)));

function lookup(u) {
  if (!uuid(u)) return null;
  try {
    return fromUuidSync(u);
  } catch (_err) {
    return null;
  }
}

/** §1.10 payload checks (types and lengths); the handlers check ownership and hold ids again. */
const VALID = {
  hold: h => isObject(h) && uuid(h.actorUuid) && optionalUuid(h.tokenUuid)
    && Number.isInteger(h.amount) && h.amount >= 0 && h.amount <= 10_000
    && typeof (h.type ?? "") === "string" && String(h.type ?? "").length <= 40
    && (h.ignoredImmunities == null || (Array.isArray(h.ignoredImmunities) && h.ignoredImmunities.length <= 20
      && h.ignoredImmunities.every(t => typeof t === "string" && t.length < 50)))
    && (h.halved == null || typeof h.halved === "boolean")
    && (h.source == null || (isObject(h.source) && optionalUuid(h.source.actorUuid) && optionalUuid(h.source.tokenUuid))),
  holdDone: d => isObject(d) && (d.holdId == null || shortId(d.holdId)) && typeof d.applied === "boolean"
    && uuid(d.actorUuid) && optionalUuid(d.tokenUuid) && stamina(d.before) && stamina(d.after)
    // Milestone 7 (§1.7): what a report adds for resource gains.
    && (d.type == null || (typeof d.type === "string" && d.type.length <= 40))
    && (d.source == null || (isObject(d.source) && optionalUuid(d.source.actorUuid) && optionalUuid(d.source.tokenUuid)))
    && (d.reportOnly == null || typeof d.reportOnly === "boolean") && (d.staminaLoss == null || typeof d.staminaLoss === "boolean")
    && (d.groupUuid == null || uuid(d.groupUuid))
    // A report a non-active GM forwards names its reporter (only a GM relay is believed, gain-card.mjs).
    && (d.reporter == null || shortId(d.reporter)),
  preRoll: r => isObject(r) && shortId(r.dialogId) && uuid(r.abilityUuid) && uuid(r.actorUuid) && optionalUuid(r.tokenUuid),
  preRollCancel: r => isObject(r) && shortId(r.dialogId),
  preRollDone: r => isObject(r) && shortId(r.holdId) && typeof r.applied === "boolean",
  moveGate: m => isObject(m) && uuid(m.tokenUuid) && (m.kind === "move" || m.kind === "forced")
    && (m.movementId == null || shortId(m.movementId)) && (m.type == null || (typeof m.type === "string" && m.type.length <= 20))
    && (m.distance == null || (Number.isFinite(m.distance) && m.distance >= 0 && m.distance <= 100)),
  fmActive: f => isObject(f) && optionalUuid(f.targetTokenUuid) && optionalUuid(f.sourceTokenUuid) && optionalUuid(f.sourceActorUuid)
    && (f.id == null || shortId(f.id)) && (f.end == null || typeof f.end === "boolean") && (f.refresh == null || typeof f.refresh === "boolean")
    && (!!(f.targetTokenUuid || f.sourceTokenUuid || f.sourceActorUuid) || (!!f.id && (f.end === true || f.refresh === true))),
  trigger: t => isObject(t) && typeof t.sub === "string" && t.sub.length <= 40 && shortId(t.triggerMessageId),
  triggerCommit: t => isObject(t) && Array.isArray(t.decisions) && t.decisions.length <= 20
    && (t.afterEvents == null || (Array.isArray(t.afterEvents) && t.afterEvents.length <= 20
      && t.afterEvents.every(e => isObject(e) && e.kind === "damage.after" && isObject(e.subject) && uuid(e.subject.actorUuid)
        && isObject(e.damage) && Number.isFinite(e.damage.amount))))
    && t.decisions.length + (t.afterEvents?.length ?? 0) >= 1
    && t.decisions.every(x => isObject(x) && isObject(x.decision) && shortId(x.decision.id)) && (t.origin == null || isObject(t.origin)),
  halfMark: h => isObject(h) && Array.isArray(h.uuids) && h.uuids.length >= 1 && h.uuids.length <= 40 && h.uuids.every(uuid),
  // Milestone 6.
  summonDismiss: d => isObject(d) && typeof d.summonId === "string" && /^[A-Za-z0-9]{1,40}$/.test(d.summonId),
  // Milestone 7.
  zoneDismiss: d => isObject(d) && typeof d.zoneId === "string" && /^[A-Za-z0-9]{16}$/.test(d.zoneId),
  malice: m => isObject(m) && Number.isInteger(m.delta) && m.delta !== 0 && Math.abs(m.delta) <= 50
    && (m.reason == null || (typeof m.reason === "string" && m.reason.length <= 100 && !/[<>]/.test(m.reason))),
  summonActivate: a => isObject(a) && shortId(a.combatId) && shortId(a.combatantId),
  // Milestone 8.
  nativeSummon: n => validNativeSummon(n),
  endTargeted: e => isObject(e) && Object.keys(e).every(k => k === "actorUuid" || k === "statusId" || k === "sourceUuid")
    && uuid(e.actorUuid) && typeof e.statusId === "string" && /^[A-Za-z][\w-]{0,39}$/.test(e.statusId) && optionalUuid(e.sourceUuid),
};

/**
 * The triggered-action actions (no card): validate the payload object, check who may ask, run the GM side.
 * Denials throw `DSAUTO.Relay.Denied` (the handlers also refuse a hold id of another user themselves).
 */
async function handleTriggerAction(action, payload, user) {
  const data = payload?.[action];
  if (!VALID[action]?.(data)) throw new Error("DSAUTO.Relay.BadRequest");
  switch (action) {
    case "hold": {
      if (!mayRequestHold(user, lookup(data.actorUuid))) throw deny(user, action, null, { actorUuid: data.actorUuid });
      // Half marks set here for that click's other targets wait while this hold does (C16).
      const resume = pauseExternalHalf();
      let out = null;
      try {
        out = await externalHold(data, user);
      } finally {
        resume();
      }
      logAllowed(user, action, null, { actorUuid: data.actorUuid, amount: data.amount, held: out?.amount, holdId: out?.holdId ?? null });
      return {
        ok: true, holdId: out?.holdId ?? null, amount: out?.amount ?? data.amount, halved: !!out?.halved, entries: out?.entries ?? [],
        gmId: game.userId,
      };
    }
    case "holdDone": {
      if (!mayRequestHold(user, lookup(data.actorUuid))) throw deny(user, action, null, { actorUuid: data.actorUuid });
      await externalDone(data, user);
      logAllowed(user, action, null, { holdId: data.holdId ?? null, applied: data.applied });
      return { ok: true };
    }
    case "preRoll": {
      if (!mayRequestHold(user, lookup(data.actorUuid))) throw deny(user, action, null, { actorUuid: data.actorUuid });
      const out = await handlePreRoll(data, user);
      logAllowed(user, action, null, { dialogId: data.dialogId, edges: out?.edges ?? 0 });
      return { ok: true, holdId: out?.holdId ?? null, edges: out?.edges ?? 0, sources: out?.sources ?? [], gmId: game.userId };
    }
    case "preRollCancel":
      await handlePreRollCancel(data, user);
      return { ok: true };
    case "preRollDone":
      await handlePreRollDone(data, user);
      logAllowed(user, action, null, { holdId: data.holdId, applied: data.applied });
      return { ok: true };
    case "moveGate": {
      if (!mayRequestHold(user, lookup(data.tokenUuid))) throw deny(user, action, null, { tokenUuid: data.tokenUuid });
      const out = await handleMoveGate(data, user);
      return { ok: true, allow: out?.allow !== false, ...(Number.isInteger(out?.distance) ? { distance: out.distance } : {}) };
    }
    case "fmActive":
      handleFmActive(data, user);
      return { ok: true };
    case "triggerCommit": {
      const out = await handleTriggerCommit(data, user);
      logAllowed(user, action, null, { decisions: out?.count ?? 0 });
      return { ok: true, count: out?.count ?? 0 };
    }
    case "halfMark":
      // It can only make a halve step moot for 5 s of unheld time (halving never stacks, C16).
      markExternalHalf(data.uuids);
      return { ok: true };
    case "trigger": {
      const out = await handleTriggerReport(data, user);
      logAllowed(user, action, data.triggerMessageId, { sub: data.sub });
      return { ok: true, ...(out ?? {}) };
    }
  }
  throw new Error("DSAUTO.Relay.BadRequest");
}

/* -------------------------------------------- */
/*  Milestone 6: summoning                      */
/* -------------------------------------------- */

/** The summon actions without a card (a summon outlives its card): validate, check ownership on the GM, run. */
async function handleSummonAction(action, payload, user) {
  const data = payload?.[action];
  if (!VALID[action]?.(data)) throw new Error("DSAUTO.Relay.BadRequest");
  switch (action) {
    case "summonDismiss": {
      const info = summonInfo(data.summonId);
      if (!info) throw new Error("DSAUTO.Relay.UnknownSummon");
      if (!mayDismissSummon(user, info)) throw deny(user, action, null, { summonId: data.summonId });
      const out = await dismissSummon(data.summonId, REMOVAL.DISMISS, { userId: user.id });
      if (out?.error) throw new Error(out.error);
      logAllowed(user, action, info.messageId ?? null, { summonId: data.summonId, removed: out?.removed ?? 0 });
      return { ok: true, removed: out?.removed ?? 0, gone: !!out?.gone };
    }
  }
  throw new Error("DSAUTO.Relay.BadRequest");
}

/* -------------------------------------------- */
/*  Milestone 7: zones, Malice, activation      */
/* -------------------------------------------- */

/** The Milestone 7 actions without a card: validate, authorize on the GM, run. */
async function handleM7Action(action, payload, user) {
  const data = payload?.[action];
  if (!VALID[action]?.(data)) throw new Error("DSAUTO.Relay.BadRequest");
  switch (action) {
    case "zoneDismiss": {
      const info = zoneInfo(data.zoneId);
      if (!info) throw new Error("DSAUTO.Relay.UnknownZone");
      if (!mayDismissZone(user, info)) throw deny(user, action, null, { zoneId: data.zoneId });
      const out = await endZone(data.zoneId, ZONE_END.DISMISS, { userId: user.id });
      if (out?.error) throw new Error(out.error);
      logAllowed(user, action, info.messageId ?? null, { zoneId: data.zoneId, ended: !!out?.ended });
      return { ok: true, ended: !!out?.ended };
    }
    case "malice": {
      if (!user.isGM) throw deny(user, action, null);
      const out = await postMaliceCard({ delta: data.delta, reason: data.reason ?? null, user });
      logAllowed(user, action, out?.messageId ?? null, { delta: data.delta });
      return { ok: !!out?.ok, messageId: out?.messageId ?? null, before: out?.before ?? null, after: out?.after ?? null };
    }
    case "summonActivate": {
      // Ownership and the turn rules are checked by the handler (it throws DSAUTO.Relay.*).
      const out = await handleSummonActivate(data, user);
      logAllowed(user, action, null, { combatId: data.combatId, combatantId: data.combatantId });
      return { ok: true, activated: out?.activated !== false };
    }
  }
  throw new Error("DSAUTO.Relay.BadRequest");
}

/* -------------------------------------------- */
/*  Milestone 8: native summons, targeted        */
/* -------------------------------------------- */

/** The Milestone 8 actions without a card: validate, authorize on the GM, run. */
async function handleM8Action(action, payload, user) {
  const data = payload?.[action];
  if (!VALID[action]?.(data)) throw new Error("DSAUTO.Relay.BadRequest");
  switch (action) {
    case "nativeSummon": {
      // Authorization (an owner of the ability's actor, its own token) and the content check are the handler's.
      const out = await handleNativeSummon(data, user);
      logAllowed(user, action, out?.messageId ?? null, { actorUuid: data.actorUuid, count: data.count, ok: !!out?.ok });
      return { ok: !!out?.ok, messageId: out?.messageId ?? null, tokenUuids: out?.tokenUuids ?? [], reason: out?.reason ?? null };
    }
    case "endTargeted": {
      const mod = await targetedModule();
      if (typeof mod?.handleEndTargeted !== "function") throw new Error("DSAUTO.Relay.BadRequest");
      if (!mayEndTargeted(user, lookup(data.actorUuid), lookup(data.sourceUuid))) {
        throw deny(user, action, null, { actorUuid: data.actorUuid, statusId: data.statusId });
      }
      const out = await mod.handleEndTargeted(data, user);
      logAllowed(user, action, null, { actorUuid: data.actorUuid, statusId: data.statusId, ended: out?.ended ?? null });
      return { ok: out?.ok !== false, ended: out?.ended ?? "none" };
    }
  }
  throw new Error("DSAUTO.Relay.BadRequest");
}

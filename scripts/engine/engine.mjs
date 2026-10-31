import { undoAloneUse } from "../features/alone.mjs";
import { claimFeature, releaseFeatureClaim } from "../features/claims.mjs";
import { prepareSurgeChoice } from "../ui/surge-choice.mjs";
import { prepareCleanseChoice } from "../ui/cleanse-choice.mjs";
import { offerPicks, pickCandidates } from "../ui/target-pick.mjs";
import { attachSideTargets } from "./side-targets.mjs";
import { prepareJudgementBenefits, releaseJudgementOpportunity } from "../features/judgement.mjs";
import { temporarySnapshot, temporaryExplosionOps, reconcileTemporaryStamina, restoreTemporaryEffects } from "../features/temporary-stamina.mjs";
import { preparePerformanceRolls } from "../features/rolls.mjs";
import { applyFeatureMove } from "../features/specials.mjs";
import { prepareStrikeBonuses, settleStrikeBonus, releaseStrikeReservations } from "../features/strike.mjs";
import { applyAuraOption, prepareAuraInterception, setAura } from "../features/auras.mjs";
import { applyModifier, applyRuleDuration } from "./modifiers.mjs";
/**
 * RESOLVE / APPLY / UNDO on the active GM, the single writer of stamina, effects and the record.
 *
 * - `createChatMessage` (active GM): resolve a seeded card, apply its `auto` ops, persist every op
 *   (applied, pending, skipped, failed) in ONE message update.
 * - Card buttons (any user, relayed to the active GM and authorized there): apply or undo single ops
 *   or all of them, one message update per click.
 * - `updateChatMessage` (active GM): late targets from Target Damage's area auto-targeting, and
 *   rolls appended later by the system's context menu (surges, modified damage).
 * - `ready` (active GM): optional sweep over recent unresolved cards.
 * - Surges (M1.5): a hero's surges add a damage op for one target or raise one target's potency;
 *   they are paid when the op is applied and refunded when it is undone (engine/surges.mjs).
 * - Movement (M3): forced movement and teleport ops, applied after damage and conditions through
 *   Combat Tools or our own straight line (engine/forced.mjs, delegation/*).
 * - Edit (M3): whoever may apply a row changes its amount, distance or movement type, or applies a
 *   heal as temporary Stamina, before applying it.
 * - Library (M4): overlay and detached effects add rows (engine/library-plan.mjs), effects on the
 *   ability's user get a row of their own, "choose one" groups wait for a pick (chooseOption), and a
 *   card nobody seeded is taken over by the active GM when the library automates its ability.
 * - Triggered actions (M5, docs/M5-DESIGN.md §2.2): a pre-pass at the top of applyOpList holds the damage
 *   ops while reactors are asked (triggers/holds.mjs), before the Death Tracker note and the ctlib batch;
 *   nothing is written meanwhile except, once a prompt is really sent, the card's `hold` marker. Trigger
 *   cards and damage.after offers run after the record write (`runAfterWrite`), outside the lock. Another
 *   GM's live hold refuses every action on the card (`DSAUTO.Relay.Busy`). Movement after a resolve is
 *   taken from the final op states (a push a trigger made resisted does not move).
 * - Summoning (M6, docs/M6-DESIGN.md §2.2): summon rows (engine/summon.mjs) are never applied by themselves and never
 *   by "Apply all"; they run in their own phase after movement, with the squares the requester picked (`clientPlaces`,
 *   relay `places`) or, for a Director without squares, the nearest free ones. Their world actors are prepared inside
 *   the card lock before the single resolve write (summons/actors.mjs; actors only, never the message). A record write
 *   that fails after a summon's tokens exist removes them again (no orphans).
 * - Resources and zones (M7, docs/M7-DESIGN.md §2.2, §3.1, §3.7): after the M5 pre-pass a hero-token step may insert a
 *   heal row (`heroToken`) before a lethal damage row; it is tied to that row (undone at once when the damage does not
 *   land, undone with it). After the batch, the call's own damage and forced moves become facts and the matching gain
 *   rules of the combat's heroes become `gain` rows (auto ones applied at once). Ops created during an apply are
 *   registered out of band (`registerCreated`: the patch objects stay the ones `runOne` mutates) and every writer
 *   writes them as full ops (`opWrite`) with their gain-only target records. Zone rows are placed like summons (their
 *   own button, never "Apply all", the requester's shapes in `clientZones`; Milestone 9: with `zoneMode` auto, a new
 *   zone row is applied at resolve from the area drawn on use or around its creator, zones/adopt.mjs). Malice and
 *   hero-token rows are world resources (resources/world-resources.mjs). A write that fails after side effects undoes gains and heals and ends
 *   created zones (fire-and-forget).
 * - Draw Steel 1.2 (M8, docs/M8-DESIGN.md §1.3): cards are read per card (engine/readers.mjs readCard: "tierParts",
 *   "targetResult" with one part per target, "unknown" for a development build that may mis-pair targets: every row
 *   manual). A manual potency adjustment on a resolved card's target part (`potencies`) re-plans that target's pending
 *   condition and forced rows (one write). While the uninstall pass strips cards (WP-D maintenance/strip.mjs) the
 *   engine writes nothing.
 * - Persistent (M9, docs/M9-DESIGN.md §C): the resolve write carries `persistent` (persistent/registry.mjs
 *   persistentRecord; a fresh card is matched against a pending free re-roll there), indexed on HOOKS.resolved.
 */
import { DSTD_ID, HOOKS, MODULE_ID, OP_STATUS } from "../constants.mjs";
import { damageBatch } from "../compat/ctlib.mjs";
import { noteDamageCause } from "../compat/death-tracker.mjs";
import { dstdActive, dstdCoveredTokens, dstdTargetTokenUuids } from "../compat/dstd.mjs";
import { debug, error, log, warn } from "../log.mjs";
import { setting } from "../settings.mjs";
import { applyConditionOp } from "./conditions.mjs";
import { applyDamageOp } from "./damage.mjs";
import { applyMoveOp, needsChoice } from "./forced.mjs";
import { applyHideOp } from "./hide.mjs";
import { applyCleanse, applyRecoveries, applyResource } from "./library-apply.mjs";
import { opId } from "./keys.mjs";
import { integrity, sign } from "./ledger.mjs";
import { buildPlan } from "./plan.mjs";
import { assignCard, readCard, rollCounts } from "./readers.mjs";
import {
  PLACED_KINDS, effectiveUntil, getResolution, hasPart, isApplied, nextSeq, ownButtonOnly, partSource, realTargets, recordPath, selfOnly,
  targetedOps, areaOnly, pickedOnly,
} from "./record.mjs";
import { spendValues } from "./spend.mjs";
import { targetFromTokenDoc, targetsFromTokenUuids } from "./targets.mjs";
import { undoOp as undoOneOp } from "./undo.mjs";
import { adoptionUpdate } from "./seed.mjs";
import { cardTier, useState } from "./library-plan.mjs";
import { chooseAssignment, dsctPickedOption } from "../library/choose-compat.mjs";
import { resolveAbility } from "../library/resolve.mjs";
import {
  MAX_SURGES, POTENCY_SURGE_COST, availableSurges, liveSurgeOps, paySurges, potencySurgePatch, potencySurgeable, refundSurges,
  surgeActor, surgeDamage, surgeableDamage,
} from "./surges.mjs";
import { PART_ID } from "../constants.mjs";
import { waitForDice } from "../relay/dice-wait.mjs";
import {
  EMPTY_PREPASS, finishPrePass, potencyFails, potencyStatus, prePass, settlePrePass, triggerHalved,
} from "../triggers/holds.mjs";
import { applyBudgetOp } from "../triggers/budget.mjs";
import { applySummonOp, summonerOwnerIds } from "./summon.mjs";
import { prepareSummonOps } from "../summons/actors.mjs";
import { REMOVAL, dismissSummon } from "../summons/registry.mjs";
import { factsFromPatches } from "../resources/facts.mjs";
import { applyGainOp, cascadeGainIds, cleanupGains, planGains, releaseGainClaims } from "../resources/gains.mjs";
import { EMPTY_HERO_PASS, applyHeroTokenOp, heroTokenPrePass, undoHeroTokenOp } from "../resources/hero-tokens.mjs";
import { compat } from "../compat/version-gate.mjs";

// The uninstall pass (Milestone 8, WP-D): loaded lazily, so a partial install without the file still loads the engine.
let stripMod = null;
import("../maintenance/strip.mjs").then(m => { stripMod = m; }).catch(() => {});
/** True while `api.stripParts` runs: the engine writes nothing then. */
const stripping = () => {
  try {
    return !!(stripMod?.stripInProgress?.() ?? false);
  } catch (_err) {
    return false;
  }
};
import { gainsActive } from "../resources/rules.mjs";
import { villainWarnings } from "../resources/villain.mjs";
import { WORLD_RESOURCES, applyWorldResource } from "../resources/world-resources.mjs";
import { applyZoneOp, cleanupZones } from "../zones/create.mjs";
import { persistentRecord } from "../persistent/registry.mjs";
import { adoptZoneTemplates, deleteAdoptedTemplates } from "../zones/adopt.mjs";

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

export const isActiveGM = () => !!game.users.activeGM?.isSelf;

const locks = new Map();
/** actorUuid -> messageId while that message's apply list targets the actor (trackers, C14). */
const applying = new Map();

/** Serialize all engine work per message (resolve, buttons, observers, sweep). */
export function withMessageLock(messageId, fn) {
  const prev = locks.get(messageId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(messageId, tail);
  tail.then(() => {
    if (locks.get(messageId) !== tail) return;
    locks.delete(messageId);
    for (const [actorUuid, id] of applying) if (id === messageId) applying.delete(actorUuid);
  });
  return run;
}

/** Resolves when no engine work for the message is queued (polls every 100 ms, at most `maxMs`). */
export async function messageIdle(messageId, maxMs = 15_000) {
  if (!messageId) return true;
  const end = Date.now() + Math.max(0, Number(maxMs) || 0);
  while (locks.has(messageId)) {
    if (Date.now() >= end) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return true;
}

/** Is an engine apply list running (or held) on this client? (Death Tracker's one cause slot is its, §6.3) */
export const damageInFlight = () => applying.size > 0;

/** The message whose apply list targets this actor while its lock is held (trackers), else null. */
export function applyingMessageFor(actorUuid) {
  return (actorUuid && applying.get(actorUuid)) || null;
}

/* -------------------------------------------- */
/*  Triggered-action holds (Milestone 5)        */
/* -------------------------------------------- */

const heldMessages = new Map();          // messageId -> res.hold written by this client in the running action
const afterWrite = new WeakMap();        // patches object -> PrePass, taken by the caller after its write
const serverNow = () => game.time?.serverTime ?? Date.now();

/**
 * Inside the message lock, called (once) by the pre-pass right before the first prompt is sent (deviation 3).
 * A resolved card is signed after the write (else it reads as tampered); a fresh card (resolve in progress,
 * never signed) is NOT signed, so it stays "fresh" (ledger.mjs integrity) and the resolve still rebuilds its
 * author-written targets from the tokens.
 */
async function writeHold(message, info) {
  const res = getResolution(message);
  if (res?.resolvedAt) await writeRecord(message, { [recordPath("hold")]: info });
  else await message.update({ [recordPath("hold")]: info });
  heldMessages.set(message.id, info);
}

/** The final write of the action that held the card removes its hold marker. */
const holdCleanup = (message, update) => {
  if (heldMessages.delete(message.id)) update[recordPath("hold")] = ForcedDeletion();
};

/** Another GM holds this card for triggered actions (review conc 6): refuse until its hold ran out. */
function assertNotHeld(message, res) {
  const h = res?.hold;
  if (!h || h.by === game.userId) return;
  if (serverNow() < effectiveUntil(res, message) + 10_000) throw new Error("DSAUTO.Relay.Busy");
}

/** Caller, after its record write: schedule after-reactions and trigger cards of the pre-pass. */
function runAfterWrite(message, patches) {
  const pre = afterWrite.get(patches);
  if (!pre) return;
  afterWrite.delete(patches);
  try {
    finishPrePass(message, pre, patches);
  } catch (err) {
    error("triggers.finish", err);
  }
}

/* -------------------------------------------- */
/*  Ops created during an apply (Milestone 7)   */
/* -------------------------------------------- */

// Gain rows and hero-token heals are built while a list is applied (docs/M7-DESIGN.md §1.5, C1): they are registered
// out of band, keyed by the call's patches object, so the patch objects themselves stay the ones runOne mutates after
// `done` (seq, byUserId, RESET_ON_APPLY). The op objects carry no marker field.
const createdOps = new WeakMap();       // patches -> Map<opId, op>
const createdTargets = new WeakMap();   // patches -> Record<key, target record> (gain-only records)

/** Register an op built during the apply list of `patches` (and the new target records it needs). */
export function registerCreated(patches, op, targets = null) {
  if (!patches || !op?.opId) return;
  if (!createdOps.has(patches)) createdOps.set(patches, new Map());
  createdOps.get(patches).set(op.opId, op);
  if (targets && Object.keys(targets).length) {
    if (!createdTargets.has(patches)) createdTargets.set(patches, {});
    const into = createdTargets.get(patches);
    for (const [k, t] of Object.entries(targets)) if (t && !into[k]) into[k] = t;
  }
}

export const createdOf = patches => (patches && createdOps.get(patches)) || null;
export const createdTargetsOf = patches => (patches && createdTargets.get(patches)) || null;

/** The record write of one patch: the full op for an op created in this call, else the patch itself. */
export function opWrite(patches, id, patch) {
  const op = createdOf(patches)?.get(id);
  return op ? { ...op, ...patch } : patch;
}

/** Target records the created ops need (`targets.<key>`); existing keys of the record are never touched (C26). */
function addTargetWrites(update, patches, res = null) {
  for (const [k, t] of Object.entries(createdTargetsOf(patches) ?? {})) {
    if (res?.targets?.[k]) continue;
    const key = recordPath(`targets.${k}`);
    if (!(key in update)) update[key] = t;
  }
}

/** Write every patch of an apply list that the caller's own update does not carry yet (pre-pass `extra`, created ops). */
function addPatchWrites(update, patches, res = null) {
  for (const [id, p] of Object.entries(patches ?? {})) {
    const key = recordPath(`ops.${id}`);
    if (!(key in update)) update[key] = opWrite(patches, id, p);
  }
  addTargetWrites(update, patches, res);
}

/**
 * A record write failed after side effects (Milestone 6/7): dismiss created summons, undo applied gains and hero-token
 * heals, end created zones and release gain claims. All fire-and-forget (§6.5).
 */
function cleanupFailedWrite(res, patches) {
  cleanupSummons(patches);
  try {
    const gainOps = new Map(createdOf(patches) ?? []);
    for (const id of Object.keys(patches ?? {})) {
      const op = res?.ops?.[id];
      if (op?.kind === "gain" && !gainOps.has(id)) gainOps.set(id, op);
    }
    cleanupGains(patches, gainOps);
    cleanupZones(patches);
    const targets = { ...(res?.targets ?? {}), ...(createdTargetsOf(patches) ?? {}) };
    for (const [id, p] of Object.entries(patches ?? {})) {
      const op = createdOf(patches)?.get(id) ?? res?.ops?.[id];
      if (!op?.heroToken || p?.status !== OP_STATUS.APPLIED) continue;
      undoHeroTokenOp({ ...res, targets }, { ...op, ...p }).catch(err => error("heroToken.writeFailed", err, { opId: id }));
    }
    // The teleport/Hide sequence is transactional with its record, including its surge reward.
    const sequence = Object.entries(patches ?? {}).map(([id, p]) => ({ ...(createdOf(patches)?.get(id) ?? res?.ops?.[id]), ...p }))
      .filter(op => op.status === OP_STATUS.APPLIED && (op.kind === "hide" || op.hideOpId || (op.kind === "teleport" && op.autoStart)))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    Promise.resolve().then(async () => {
      for (const op of sequence) await undoOneOp(null, { ...res, targets }, op);
    }).catch(err => error("teleport.writeFailed", err));
  } catch (err) {
    error("writeFailed.cleanup", err);
  }
}

/** One signed record write of an apply; a failure cleans up the side effects first (cleanupFailedWrite). */
async function writeApplied(message, update, res, patches) {
  try {
    await writeRecord(message, update);
  } catch (err) {
    cleanupFailedWrite(res, patches);
    throw err;
  }
}

/**
 * Active GM: write op patches on a card under its lock (trigger revocation, budget re-tag). `patches` is
 * `{opId: {field: value}}` or `(res, message) => patches`, computed inside the lock on the fresh record.
 * One signed write; nothing when there is nothing to patch. False when the card is gone or untrusted.
 */
export async function annotateOps(message, patches) {
  if (!isActiveGM() || !message?.id || stripping()) return false;
  return withMessageLock(message.id, async () => {
    const current = game.messages.get(message.id);
    const res = getResolution(current);
    if (!current || !res) return false;
    try {
      await requireTrusted(current);
    } catch (_err) {
      return false;
    }
    const list = typeof patches === "function" ? patches(res, current) : patches;
    const update = {};
    for (const [id, p] of Object.entries(list ?? {})) {
      if (!res.ops?.[id] || !p || typeof p !== "object" || !Object.keys(p).length) continue;
      update[recordPath(`ops.${id}`)] = p;
    }
    if (!Object.keys(update).length) return true;
    await writeRecord(current, update);
    log("annotate", { messageId: current.id, ops: Object.keys(update).length });
    return true;
  });
}

/** Can the GM (current user) see the content of this card? Player self/whisper rolls exclude the GM. */
function contentVisibleToMe(message) {
  const { whisper, blind } = message;
  if (!whisper?.length) return true;
  return whisper.includes(game.user.id) || (message.isAuthor && !blind);
}

/** CONST.USER_ROLES.ASSISTANT: authors below it wrote a "player card" (setting playerAuthoredMode). */
const ROLE_ASSISTANT = 3;

const ForcedDeletion = () => new foundry.data.operators.ForcedDeletion();

/** Fields cleared whenever an op is (re)applied or undone, so stale details never linger. */
const RESET_ON_APPLY = {
  reason: null, error: null, undoMode: null, undoneBy: null, undoneAt: null, revivalPending: null, grabsLost: null,
  // Milestone 7: a zone row re-applied after an "already gone" undo, a gain row re-applied after undo (C21).
  ended: null, ledgerReleased: null,
};

/* -------------------------------------------- */
/*  Record integrity (see ledger.mjs)           */
/* -------------------------------------------- */

/** Write our record and sign the result: every engine write goes through here. */
async function writeRecord(message, update) {
  await message.update(update);
  sign(game.messages.get(message.id) ?? message);
}

/** The card's author as the server knows it (the seeded authorUserId/authorRole are author-written). */
function serverAuthor(message) {
  const id = message?._source?.author ?? message?.author?.id ?? null;
  return (id && game.users.get?.(id)) || message?.author || null;
}

/** Lock a card whose record was changed outside the engine (not signed: it stays locked). */
async function markTampered(message, state) {
  const res = getResolution(message);
  warn("integrity", { messageId: message.id, state });
  if (res?.tampered?.state === state) return;
  await message.update({ [recordPath("tampered")]: { state, at: Date.now() } });
}

/** Throw unless the record may be acted on: "ok", or "fresh" when `allowFresh` (first resolution). */
async function requireTrusted(message, { allowFresh = false } = {}) {
  const state = integrity(message);
  if (state === "ok" || (allowFresh && state === "fresh")) return state;
  if (state === "tampered" || state === "unsigned") await markTampered(message, state);
  throw new Error(state === "fresh" ? "DSAUTO.Relay.Unresolved" : "DSAUTO.Relay.Tampered");
}

/** Seeded target records rebuilt from their token documents (the seed is written by the author). */
function rebuildTargets(seeded) {
  const out = {};
  for (const t of Object.values(seeded ?? {})) {
    let doc = null;
    try {
      doc = t?.tokenUuid ? fromUuidSync(t.tokenUuid) : null;
    } catch (_err) { /* invalid uuid */ }
    const rebuilt = targetFromTokenDoc(doc, t?.fromRoll ? { fromRoll: true } : {});
    if (rebuilt) out[rebuilt.key] = rebuilt;
  }
  return out;
}

/** Re-sign a card after a GM checked it (`api.trustCard`). Active GM only. */
export async function trustCard(message) {
  if (!isActiveGM() || !getResolution(message)) return false;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    await writeRecord(message, { [recordPath("tampered")]: ForcedDeletion() });
    log("integrity.trusted", { messageId: message.id });
    return true;
  });
}

/* -------------------------------------------- */
/*  Applying ops                                */
/* -------------------------------------------- */

const EXTERNAL_REASONS = new Set(["appliedByTargetDamage", "partlyAppliedByTargetDamage"]);

/** Milestone 7: a Malice or hero-token row (world settings, resources/world-resources.mjs). */
const isWorldResource = op => op?.kind === "resource" && typeof op.resource === "string" && Object.hasOwn(WORLD_RESOURCES, op.resource);

/**
 * How Target Damage's own applications cover an op, as a record patch, or null when they do not:
 * every target covered -> "external" (stays so until Target Damage undoes it); only some targets of a
 * squad op covered -> "skipped" (applying the whole hit would double the covered minions' share, so the
 * Director finishes the rest from Target Damage's rows).
 */
function externalPatch(message, res, op) {
  if (!dstdActive() || !setting("respectDstdApplications")) return null;
  // Surge rows, movement rows and synthetic cards have no Target Damage counterpart.
  if (op.surge?.kind === "damage" || op.synthetic || op.lib || MOVE_KINDS.has(op.kind)) return null;
  // Milestone 7: gain, zone, hero-token and world-resource rows are ours alone.
  if (op.kind === "gain" || op.kind === "zone" || op.heroToken || isWorldResource(op)) return null;
  const uuids = (op.targetKeys ?? []).map(k => res.targets?.[k]?.tokenUuid).filter(Boolean);
  const covered = dstdCoveredTokens(message, op, uuids);
  if (!covered.size) return null;
  if (covered.size >= new Set(uuids).size) return { status: OP_STATUS.EXTERNAL, reason: "appliedByTargetDamage" };
  return { status: OP_STATUS.SKIPPED, reason: "partlyAppliedByTargetDamage" };
}

/**
 * Apply a list of ops (any kind) and return patches keyed by op id. Damage ops run inside one
 * ctlib damage batch with one Death Tracker attribution note.
 * Milestone 5: a pre-pass first holds the damage ops for triggered actions (triggers/holds.mjs); its
 * decisions reach the record only through the returned patches (`skip`, `listed`, `extra`), and the caller
 * runs `runAfterWrite(message, patches)` after its record write.
 * Milestone 9: `adopted` ({opId: {source}}, zones/adopt.mjs) marks zone rows whose `clientZones` shapes came from
 * the area drawn on use; the applied row records the source.
 */
async function applyOpList(message, res, opList, { userId = game.userId, clientMoves = null, clientPlaces = null, clientZones = null, adopted = null } = {}) {
  const patches = {};
  if (!opList.length) return patches;
  // The call's own list: the hero-token step inserts heal rows into it (Milestone 7).
  const ops = [...opList];
  for (const follower of opList) {
    const cost = res.ops?.[follower.costOpId];
    if (cost?.featureCost && cost.status !== OP_STATUS.APPLIED && !ops.some(o => o.opId === cost.opId)) ops.unshift(cost);
  }
  // The appliers read this copy: the pre-pass replaces halved and re-potencied ops in it (surges read the
  // halved base op).
  const resLive = { ...res, targets: { ...(res.targets ?? {}) }, ops: { ...(res.ops ?? {}) } };
  for (const op of ops) {
    for (const k of op.targetKeys ?? []) {
      const a = res.targets?.[k]?.actorUuid;
      if (a) applying.set(a, message.id);
    }
  }
  await prepareAuraInterception(message, resLive, ops, patches, registerCreated);
  await prepareStrikeBonuses(message, resLive, ops);
  // 0.17.0: the same dialog may spend 2 surges on +1 potency (a condition joins `ops`, a move gets a pending patch).
  await prepareSurgeChoice(message, resLive, ops, { covered: op => !!externalPatch(game.messages.get(message.id) ?? message, res, op),
    potencyBlocked: op => !!partPotencyBonus(message, op), patches });
  // Milestone 9 (D4): the affected creature's owner chooses which effects a cleanse row ends (unanswered: it waits).
  await prepareCleanseChoice(message, resLive, ops);
  let pre = EMPTY_PREPASS;
  if (ops.some(o => o.kind === "damage" && !o.surge)) {
    try {
      pre = await prePass(message, resLive, ops, {
        userId, markHold: info => writeHold(message, info),
        // Target Damage applied it already: no instance to hold.
        covered: op => !!externalPatch(game.messages.get(message.id) ?? message, res, op),
      });
    } catch (err) {
      error("triggers.prePass", err);
      pre = EMPTY_PREPASS;
    }
    // Deleted while held: write nothing (review conc 26).
    if (pre.gone) {
      heldMessages.delete(message.id);
      releaseStrikeReservations(message.id);
      throw new Error("DSAUTO.Relay.UnknownCard");
    }
  }
  // Milestone 7 (§3.7): a lethal hit on a hero may be met with 2 hero tokens: a heal row inserted before its damage row.
  if (ops.some(o => o.kind === "damage")) {
    let ht = EMPTY_HERO_PASS;
    try {
      ht = await heroTokenPrePass(message, resLive, ops, {
        userId, markHold: info => writeHold(message, info), skip: pre.skip,
        covered: op => !!externalPatch(game.messages.get(message.id) ?? message, res, op),
      });
    } catch (err) {
      error("heroToken.prePass", err);
      ht = EMPTY_HERO_PASS;
    }
    if (ht.gone) {
      heldMessages.delete(message.id);
      releaseStrikeReservations(message.id);
      throw new Error("DSAUTO.Relay.UnknownCard");
    }
    // An earlier spend's row for a hit whose prompt was now declined (0.9.1).
    // noApply: its Apply would spend outside the prompt; a later spend writes the row anew (same opId).
    for (const id of ht.declined ?? []) patches[id] = { status: OP_STATUS.SKIPPED, reason: "heroTokenDeclined", noApply: true };
    for (const heal of ht.ops ?? []) {
      registerCreated(patches, heal);
      resLive.ops[heal.opId] = heal;
      const at = ops.findIndex(o => o.opId === ht.before?.get?.(heal.opId));
      ops.splice(at < 0 ? 0 : at, 0, heal);
    }
  }
  let seq = nextSeq(res);
  const runOne = async (op) => {
    if (op.auraNegated) { patches[op.opId] = { status: OP_STATUS.SKIPPED, reason: "auraNegated", noApply: true }; return; }
    if (!await claimFeature(op, message.id)) { patches[op.opId] = { status: OP_STATUS.SKIPPED, reason: "featureAlreadyUsed" }; return; }
    if (op.costOpId && resLive.ops[op.costOpId]?.status !== OP_STATUS.APPLIED) {
      patches[op.opId] = { status: OP_STATUS.SKIPPED, reason: "notEnoughMalice" };
      return;
    }
    // Every patch carries what the pre-pass decided for the op (trigger entries, halving, potency).
    const done = (p) => {
      Object.assign(p, pre.listed.get(op.opId) ?? {});
      patches[op.opId] = p;
      return p;
    };
    const ps = pre.skip.get(op.opId);
    if (ps) {
      done({ ...ps });
      log("op.skip", { opId: op.opId, status: ps.status, reason: ps.reason, why: "trigger" });
      return;
    }
    // The pre-pass asked the hook for the damage ops it looked at already (once per op).
    if (!pre.asked?.has(op.opId) && Hooks.call(HOOKS.preApplyOp, message, op) === false) {
      done({ status: OP_STATUS.SKIPPED, reason: "hookVetoed" });
      return;
    }
    // Target Damage applied this row itself (its own button or Combat Tools' Apply All): applying
    // it again would double it. See externalPatch.
    const ext = externalPatch(game.messages.get(message.id) ?? message, res, op);
    if (ext) {
      done({ ...ext });
      log("op.skip", { opId: op.opId, status: ext.status, reason: ext.reason });
      return;
    }
    // Surges are paid when the op lands (and given back if it does not).
    const surgeCount = Number((op.surge ?? op.surgeSpend)?.count ?? 0);
    if (surgeCount && !(await paySurges(op))) {
      done({ status: OP_STATUS.FAILED, reason: "noSurges" });
      log("op.skip", { opId: op.opId, status: OP_STATUS.FAILED, reason: "noSurges" });
      return;
    }
    let patch;
    const staminaActor = ["damage", "heal", "temp"].includes(op.kind) && !op.group ? fromUuidSync(resLive.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "") : null;
    const temporaryBefore = staminaActor ? temporarySnapshot(staminaActor) : null;
    try {
      // Milestone 7 (C24): the new kinds before every generic branch (world resources before `resource`, hero-token
      // heals before the Stamina path).
      if (op.kind === "auraActivation") { const result = await setAura(fromUuidSync(op.auraItemUuid), true); patch = { status: OP_STATUS.APPLIED, auraBefore: result.before }; }
      else if (op.kind === "auraOption") patch = await applyAuraOption(message, op);
      else if (op.kind === "gain") patch = await applyGainOp(message, resLive, op);
      else if (op.kind === "zone") patch = await applyZoneOp(message, resLive, op, { clientZone: clientZones?.[op.opId] ?? null, userId, adopted: adopted?.[op.opId]?.source ?? null });
      else if (isWorldResource(op)) patch = await applyWorldResource(message, resLive, op);
      else if (op.heroToken) patch = await applyHeroTokenOp(message, resLive, op);
      else if (op.kind === "condition") patch = await applyConditionOp(message, resLive, op);
      else if (op.kind === "featureMove") patch = await applyFeatureMove(message, resLive, op);
      else if (op.kind === "modifier") patch = await applyModifier(message, resLive, op);
      else if (op.kind === "hide") patch = await applyHideOp(message, resLive, op);
      else if (MOVE_KINDS.has(op.kind)) patch = await applyMoveOp(message, resLive, op, { clientMoves: clientMoves?.[op.opId] ?? null, userId });
      else if (op.kind === "summon") patch = await applySummonOp(message, resLive, op, { clientPlaces: clientPlaces?.[op.opId] ?? null, userId });
      else if (op.kind === "cleanse") patch = await applyCleanse(message, resLive, op);
      else if (op.kind === "resource") patch = await applyResource(message, resLive, op);
      else if (op.kind === "note") patch = { status: OP_STATUS.PENDING };
      else if (op.kind === "budget") patch = await applyBudgetOp(message, resLive, op);
      else if (op.recoveries) patch = await applyRecoveries(message, resLive, op);
      else patch = await applyDamageOp(message, resLive, op);
    } catch (err) {
      error("applyOp", err, { opId: op.opId });
      patch = { status: OP_STATUS.FAILED, reason: "error", error: String(err?.message ?? err) };
    }
    if (surgeCount) {
      if (patch.status === OP_STATUS.APPLIED) patch.surgesPaid = surgeCount;
      else await refundSurges(op, surgeCount).catch(err => error("refundSurges", err));
    }
    if (staminaActor && patch.status === OP_STATUS.APPLIED && temporaryBefore?.effects.length) {
      patch.temporaryBefore = temporaryBefore;
      patch.temporaryExpired = await reconcileTemporaryStamina(staminaActor, temporaryBefore);
    }
    if (patch.status === OP_STATUS.APPLIED && op.featureEnd && op.kind !== "modifier") {
      const target = fromUuidSync(resLive.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
      for (const id of patch.createdIds ?? []) await applyRuleDuration(target?.effects?.get(id), resLive, op);
    }
    await settleStrikeBonus(message, op, patch);
    done(patch);
    if (op.surgeChoiceDone) patch.surgeChoiceDone = true;
    // 0.17.0: a potency spend from the surge dialog keeps its raised potency once applied; otherwise the row goes back to
    // how it was (the surges were refunded above).
    if (op.potencyChoiceDone) {
      patch.potencyChoiceDone = true;
      if (patch.status === OP_STATUS.APPLIED) Object.assign(patch, { potency: op.potency, surge: op.surge });
      else if (op.potencyBefore) Object.assign(patch, { status: op.potencyBefore.status, reason: op.potencyBefore.reason, potency: op.potencyBefore.potency });
    }
    if (op.surgeSpend && patch.status === OP_STATUS.APPLIED) patch.surgeSpend = op.surgeSpend;
    // Milestone 9 (D4): the owner's cleanse choice stays on the applied row (`override.by` names who chose).
    if (op.kind === "cleanse" && op.override?.effects?.length && patch.status === OP_STATUS.APPLIED) patch.override = { ...op.override };
    // The owner was asked (cleanse-choice.mjs): remembered on the record so the prompt is not repeated.
    if (op.kind === "cleanse" && op.cleanseAsked && !patch.cleanseAsked) patch.cleanseAsked = op.cleanseAsked;
    if (op.half !== undefined) patch.half = !!op.half;
    if (patch.status === OP_STATUS.APPLIED) Object.assign(patch, RESET_ON_APPLY, { seq: seq++, byUserId: userId, at: Date.now() });
    // A later surge op of the same base in this list counts this one as an earlier surge (applySurgeOp's
    // `earlier`): with a halved hit (g = floor(x / 2)) the per-op differences only add up that way.
    resLive.ops[op.opId] = { ...op, ...patch };
    log(patch.status === OP_STATUS.APPLIED ? "op.apply" : "op.skip", {
      opId: op.opId, status: patch.status, reason: patch.reason, amount: patch.amount, immunity: patch.immunity,
      weakness: patch.weakness, final: patch.finalAmount, before: patch.before, after: patch.after,
    });
    Hooks.callAll(HOOKS.applyOp, message, { ...op, ...patch }, patch);
    if (patch.temporaryExpired?.length) {
      const burst = temporaryExplosionOps(staminaActor, patch.temporaryExpired, op.opId);
      Object.assign(resLive.targets, burst.targets);
      for (const followup of Object.values(burst.ops)) {
        registerCreated(patches, followup, burst.targets); resLive.ops[followup.opId] = followup; ops.push(followup);
        await runOne(followup);
      }
    }
  };

  // Damage first (one batch), then conditions, then movement: collision damage comes after the hit. Summons and zones
  // last (Milestones 6, 7): they appear after the card's movement.
  const DAMAGE_KINDS = new Set(["damage", "heal", "temp"]);
  const damageOps = ops.filter(o => DAMAGE_KINDS.has(o.kind));
  const conditionOps = ops.filter(o => o.kind !== "hide" && !o.featureCost && !DAMAGE_KINDS.has(o.kind) && !MOVE_KINDS.has(o.kind) && !PLACED_KINDS.has(o.kind));
  const moveOps = ops.filter(o => MOVE_KINDS.has(o.kind));
  const placedOps = ops.filter(o => PLACED_KINDS.has(o.kind));
  for (const op of ops.filter(o => o.featureCost)) await runOne(op);
  if (damageOps.length) {
    noteDamageCause({ userId: res.authorUserId, sourceActorUuid: res.sourceActorUuid, messageId: message.id });
    await damageBatch(async () => {
      for (const op of damageOps) await runOne(op);
    });
    await settleHeroTokenHeals(resLive, damageOps, patches);
  }
  for (const op of conditionOps) await runOne(op);
  for (const op of moveOps) await runOne(op);
  // Milestone 9 (D6): a teleport's boost is paid once the teleport landed: a resource row tied to it (undone with it).
  for (const op of moveOps) await chargeBoost(op, patches, resLive, runOne);
  for (const op of Object.values(resLive.ops).filter(o => o.kind === "cleanse" && o.afterMoveEffect && o.status !== OP_STATUS.APPLIED
    && moveOps.some(m => m.libEffect === o.afterMoveEffect && m.targetKeys?.includes(o.targetKeys[0]) && patches[m.opId]?.status === OP_STATUS.APPLIED))) await runOne(op);
  // Hide is dependent on a completed teleport, and is offered once after that move (also on manual Apply).
  const hideOps = Object.values(resLive.ops ?? {}).filter(op => op.kind === "hide"
    && op.status !== OP_STATUS.APPLIED && !op.awaitingChoice
    && (ops.some(o => o.opId === op.opId) || moveOps.some(o => o.opId === op.teleportOpId && patches[o.opId]?.status === OP_STATUS.APPLIED)));
  for (const op of hideOps) {
    await runOne({ ...op, noApply: false });
    const hidden = resLive.ops[op.opId];
    if (hidden?.status !== OP_STATUS.APPLIED || !hidden.hideSucceeded || !(op.hideSurge > 0) || op.rewardMode === "off") continue;
    const rewardId = `${op.opId}-surge`;
    if (resLive.ops[rewardId]?.status === OP_STATUS.APPLIED) continue;
    const reward = {
      opId: rewardId, kind: "resource", resource: "surge", amount: op.hideSurge,
      targetKeys: op.targetKeys, self: true, lib: true, mode: op.rewardMode ?? "auto", status: OP_STATUS.PENDING,
      order: op.order + 0.1, hideOpId: op.opId, noApply: (op.rewardMode ?? "auto") === "auto",
    };
    registerCreated(patches, reward);
    resLive.ops[rewardId] = reward;
    if (reward.mode === "auto") await runOne(reward);
    else patches[rewardId] = { status: OP_STATUS.PENDING };
  }
  for (const op of placedOps) await runOne(op);
  // Pre-pass patches of ops outside the list (a manual condition or a move whose potency changed).
  for (const [id, p] of Object.entries(pre.extra ?? {})) if (!patches[id]) patches[id] = p;
  // Milestone 7 (§3.1): the gain rules this call's damage and forced moves meet.
  await prepareJudgementBenefits(message, resLive, ops, patches, runOne, registerCreated);
  await runGainStep(message, resLive, ops, patches, runOne);
  if (pre !== EMPTY_PREPASS) {
    settlePrePass(pre, patches, resLive);
    afterWrite.set(patches, pre);
  }
  for (const cost of ops.filter(o => o.featureCost)) {
    if (patches[cost.opId]?.status === OP_STATUS.APPLIED && !Object.values(resLive.ops).some(o => o.costOpId === cost.opId && o.status === OP_STATUS.APPLIED)) {
      patches[cost.opId] = await undoOneOp(message, resLive, { ...cost, ...patches[cost.opId] });
      resLive.ops[cost.opId] = { ...cost, ...patches[cost.opId] };
    }
  }
  for (const op of ops) await releaseFeatureClaim(op, message.id, Object.values(resLive.ops));
  releaseStrikeReservations(message.id);
  return patches;
}

/**
 * Milestone 7 (§3.7): a hero-token heal of this call whose damage row did not end applied (a veto, a missing roll or
 * target, Target Damage applied it) is undone at once: tokens back, spend freed. Still inside the card lock.
 */
async function settleHeroTokenHeals(resLive, damageOps, patches) {
  for (const op of damageOps) {
    const p = patches[op.opId];
    if (!op.heroToken || p?.status !== OP_STATUS.APPLIED) continue;
    if (patches[op.heroToken.damageOpId]?.status === OP_STATUS.APPLIED) continue;
    try {
      const u = await undoHeroTokenOp(resLive, { ...op, ...p });
      if (u?.status === OP_STATUS.UNDONE) Object.assign(p, { status: OP_STATUS.UNDONE, reason: "damageNotApplied", undoMode: u.undoMode ?? null, undoneAt: Date.now() });
      else error("heroToken.settle", new Error(u?.reason ?? "undo failed"), { opId: op.opId });
    } catch (err) {
      error("heroToken.settle", err, { opId: op.opId });
    }
    log("heroToken.damageNotApplied", { opId: op.opId, damageOpId: op.heroToken.damageOpId, status: p.status });
  }
}

/**
 * Milestone 7 (§3.1): facts of this call's applied damage and forced moves -> gain rows on this card. Each new row is
 * registered as created (with its gain-only target record); auto rows apply now through `runOne` (they depend on the
 * final damage), waiting rows are written pending. Claims of rows that did not end applied or pending are released
 * (C22). Never throws.
 */
async function runGainStep(message, resLive, ops, patches, runOne) {
  try {
    if (!gainsActive()) return;
    const facts = factsFromPatches(message, resLive, ops, patches);
    if (!facts.length) return;
    const { ops: gainOps, targets } = planGains(facts, { message, resLive, origin: "card" });
    if (!gainOps?.length) return;
    // A copy: never mutate the stored record (getResolution).
    resLive.targets = { ...(resLive.targets ?? {}), ...(targets ?? {}) };
    const sorted = [...gainOps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    try {
      for (const g of sorted) {
        const own = Object.fromEntries((g.targetKeys ?? []).filter(k => targets?.[k]).map(k => [k, targets[k]]));
        registerCreated(patches, g, own);
        resLive.ops[g.opId] = g;
        if (g.mode === "auto") await runOne(g);
        else patches[g.opId] = { status: OP_STATUS.PENDING };
      }
    } finally {
      releaseGainClaims(gainOps.filter(g => ![OP_STATUS.APPLIED, OP_STATUS.PENDING].includes(patches[g.opId]?.status)));
    }
  } catch (err) {
    error("gains.step", err, { messageId: message?.id });
  }
}

const MOVE_KINDS = new Set(["forced", "teleport"]);

/**
 * Milestone 9 (D6): the boost of a teleport that landed with `boostSpent` (engine/forced.mjs checked the amount): a
 * created `resource` row (`boostOf`, never applied by itself) charges the mover; undoOps undoes it with the teleport.
 * When it cannot be paid the teleport stays and says so (`boostUnpaid`). Inside the card lock (applyOpList).
 */
async function chargeBoost(op, patches, resLive, runOne) {
  const p = patches[op.opId];
  const amount = Math.floor(Number(p?.boostSpent?.amount) || 0);
  if (op.kind !== "teleport" || !op.boost || p?.status !== OP_STATUS.APPLIED || amount <= 0) return;
  const row = {
    opId: `${op.opId}-boost`, kind: "resource", resource: op.boost.resource, amount: -amount, targetKeys: [...(op.targetKeys ?? [])],
    self: true, lib: true, mode: "auto", status: OP_STATUS.PENDING, order: (op.order ?? 0) + 0.2, boostOf: op.opId, noApply: true,
  };
  registerCreated(patches, row);
  resLive.ops[row.opId] = row;
  await runOne(row);
  if (patches[row.opId]?.status !== OP_STATUS.APPLIED) Object.assign(p, { reason: "boostUnpaid" });
}
// Milestone 6 / 7: PLACED_KINDS (summon, zone: placed on the canvas, applied in the last phase) and ownButtonOnly (rows
// only their own button applies) live in record.mjs so the view reads them without importing the engine.
export { PLACED_KINDS, ownButtonOnly };

/**
 * Rebuilt plan ops (same deterministic id) whose previous record op carried live trigger potency deltas
 * (holds.mjs applyPotencyDelta, card.mjs revokeEntry): the deltas apply to the new base value, the check and
 * status are recomputed as the pre-pass does. Mutates the plan ops.
 */
function carryTriggerPotency(planOps, prevOps, targets, kept) {
  for (const [id, op] of Object.entries(planOps ?? {})) {
    const prev = prevOps?.[id];
    const deltas = prev?.potency?.triggerDeltas;
    if (kept[id] || !Array.isArray(deltas) || !deltas.length || !op?.potency?.characteristic) continue;
    if (op.status !== OP_STATUS.PENDING && !(op.status === OP_STATUS.SKIPPED && op.reason === "resisted")) continue;
    const base = Number(op.potency.value) || 0;
    const value = base + deltas.reduce((sum, x) => sum + (Number(x?.delta) || 0), 0);
    let actor = null;
    try {
      actor = fromUuidSync(targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
    } catch (_err) { /* target gone */ }
    const fails = potencyFails(actor, op, value);
    const status = potencyStatus(op, fails);
    op.potency = { ...op.potency, value, fails, baseValue: base, triggerDeltas: deltas };
    Object.assign(op, status);
    debug("trigger.potencyCarried", { opId: id, base, value, status: op.status });
  }
}

/* -------------------------------------------- */
/*  Resolve                                     */
/* -------------------------------------------- */

/**
 * Resolve a card: build ops from targets and tiers, apply `auto` ops, write the record once.
 * @param {ChatMessage} message
 * @param {object} [options]
 * @param {boolean} [options.force]          Resolve again although the card is resolved.
 * @param {object} [options.targets]         Replacement target records (retarget / late targets).
 * @param {string} [options.reason]          For the log.
 * @param {Function} [options.guard]         (res, message) => boolean, checked inside the message lock
 *                                           (relayed requests); false throws `DSAUTO.Relay.Denied`.
 * @param {boolean} [options.rebuildUndone]  0.16.0 (hero-token reroll): undone rows are rebuilt from the new tiers
 *                                           instead of being kept as history.
 */
export async function resolveMessage(message, { force = false, targets: newTargets = null, reason = "create", guard = null, rebuildUndone = false } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    // A synthetic card (api.applyDamage) has no ability to resolve: its ops are final.
    if (res.synthetic) throw new Error("DSAUTO.Relay.Synthetic");
    if (guard && !guard(res, message)) throw new Error("DSAUTO.Relay.Denied");
    // A resolved card is acted on only with a valid signature. A fresh (never resolved) card is the
    // author's seed: only its ability and target tokens are used, seeded ops and fields are replaced.
    const state = await requireTrusted(message, { allowFresh: true });
    assertNotHeld(message, res);
    const fresh = state === "fresh";
    if (res.resolvedAt && !force && !newTargets) return null;
    log("resolve.start", { messageId: message.id, reason });

    const author = serverAuthor(message);
    const item = await fromUuid(res.abilityUuid).catch(() => null);
    const identity = {
      authorUserId: author?.id ?? null, authorRole: author?.role ?? null,
      sourceActorUuid: item?.actor?.uuid ?? (fresh ? null : res.sourceActorUuid ?? null),
      sourceTokenUuid: sourceToken(res.sourceTokenUuid, item),
    };
    const seededOpDeletions = fresh ? Object.fromEntries(Object.keys(res.ops ?? {}).map(id => [id, ForcedDeletion()])) : {};
    const update = {};
    if (!hasPart(message)) update[`system.parts.${PART_ID}`] = partSource();
    if (!item) {
      update[recordPath()] = {
        ...identity, ops: seededOpDeletions, resolvedAt: Date.now(), resolvedBy: game.userId,
        warnings: [...(res.warnings ?? []), { code: "itemMissing" }],
      };
      await writeRecord(message, update);
      return null;
    }

    // Targets: replacement > seeded > Target Damage's list (area abilities targeted after the roll).
    let targets = newTargets ?? (fresh ? rebuildTargets(res.targets) : foundry.utils.deepClone(res.targets ?? {}));
    // Milestone 7 (C10): gain-only records (a gainer on the card only for its gain rows) are never tiered, planned or
    // dropped: set aside here, written back unchanged below. A gainer who is now a real target gets a normal record.
    const gainKeep = {};
    if (!fresh) {
      for (const [key, t] of Object.entries(res.targets ?? {})) {
        if (!t?.gainOnly || t.alsoTarget) continue;
        if (newTargets?.[key] && !newTargets[key].gainOnly) continue;
        gainKeep[key] = t;
        delete targets[key];
      }
    }
    for (const [key, t] of Object.entries(targets)) {
      if (t.dropped) delete targets[key];
      else delete t.dropped;
    }
    // The user's own row is rebuilt every time (library "self" effects).
    for (const [key, t] of Object.entries(targets)) {
      if (selfOnly(t)) delete targets[key];
      else if (t.self) {
        delete t.self;
        delete t.alsoTarget;
      }
    }
    if (!Object.keys(targets).length && !newTargets) targets = targetsFromTokenUuids(dstdTargetTokenUuids(message));

    if (fresh) await preparePerformanceRolls(message, item);
    const read = readCard(game.messages.get(message.id) ?? message);
    const { shape, parts } = read;
    const tiers = assignCard(targets, read);
    for (const [key, t] of Object.entries(targets)) Object.assign(t, tiers[key] ?? { tier: null, partId: null, damageRollIndexes: [] });

    // Library (Milestone 4): what the ability does beyond its native effects, and its user's row.
    const lib = resolveAbility(item);
    const self = selfTarget(identity, item);
    let selfKey = null;
    // Milestone 9: a pick's placeholder row sits on the user's own row too.
    if (self && lib.effects.some(e => e.targets === "self" || e.targets === "pick" || e.type === "summon" || e.type === "zone")) {
      selfKey = self.key;
      if (targets[selfKey]) Object.assign(targets[selfKey], { self: true, alsoTarget: true });
      else targets[selfKey] = { ...self, self: true, tier: null, partId: null, damageRollIndexes: [] };
    }
    const noPowerRoll = shape !== "unknown" && !parts.length && item.system?.power?.roll?.enabled === false;

    const isPrivate = !contentVisibleToMe(message);
    const warnings = (res.warnings ?? []).filter(w => w.code === "targetsChanged" || w.code === "adoptedCard");
    if (shape === "unknown") {
      warnings.push({ code: "unsupportedShape" });
      // Why: a Draw Steel 1.2 development build older than 2026-10-05 (no token on its target parts).
      if (compat.targetResult) warnings.push({ code: "devBuildPairing" });
    }
    if (isPrivate) warnings.push({ code: "privateCard" });
    // Milestone 9 (D2, D3): picked creatures and the creatures inside the area the use placed get records of their own.
    attachSideTargets({
      res, targets, item, lib, message, selfKey, sourceTokenUuid: identity.sourceTokenUuid, cardTier: cardTier(parts), fresh, warnings,
    });

    // Ops already applied in an earlier resolution stay as history and are never rebuilt.
    // "external" ops are rebuilt instead: applyOpList checks Target Damage's records again.
    // Milestone 7: gain rows (any status: a waiting gain row is no plan product) and hero-token heals are history too.
    const kept = fresh ? {} : Object.fromEntries(Object.entries(res.ops ?? {}).filter(([, op]) => op.status === OP_STATUS.APPLIED
      || (op.status === OP_STATUS.UNDONE && !rebuildUndone) || op.kind === "gain" || !!op.heroToken));
    const startOrder = fresh ? 0 : Math.max(0, ...Object.values(res.ops ?? {}).map(o => (o.order ?? 0) + 1));
    const plan = buildPlan({
      message, item, targets, forceManual: shape === "unknown" || isPrivate, startOrder,
      playerAuthored: (author?.role ?? ROLE_ASSISTANT) < ROLE_ASSISTANT,
      sourceTokenUuid: identity.sourceTokenUuid, spend: spendValues(res.spend),
      lib, assignment: chooseAssignment(item, message), use: useState(message, item), selfKey,
      self: cardTier(parts), noPowerRoll,
    });
    warnings.push(...plan.warnings);
    if (lib.dsctCovered.length) warnings.push({ code: "libraryDefersToCombatTools" });
    // Milestone 7 (§3.9): a villain action used again this encounter, or a second one this round (banner warnings).
    if (setting("villainActionTracking") !== false) warnings.push(...villainWarnings(item, message));
    // Without a power roll, targets that get nothing are only noise. A summon's anchor (origin target) is kept: the
    // row measures from it and a re-resolve must still find it (Milestone 6).
    if (noPowerRoll) {
      const used = new Set(Object.values(plan.ops).flatMap(o => [...(o.targetKeys ?? []), ...(o.anchorKey ? [o.anchorKey] : [])]));
      for (const key of Object.keys(targets)) if (!used.has(key) && key !== selfKey) delete targets[key];
    }
    // Milestone 9: a picked or area-only creature whose effects made no row (a filter, an unpicked option) is not shown
    // (one with kept history is written as dropped below).
    {
      const used = new Set([...Object.values(plan.ops), ...Object.values(kept)].flatMap(o => o.targetKeys ?? []));
      for (const [key, t] of Object.entries(targets)) if ((pickedOnly(t) || areaOnly(t)) && !used.has(key)) delete targets[key];
    }
    if (selfKey && !Object.values(plan.ops).some(o => o.targetKeys?.includes(selfKey))) {
      if (targets[selfKey]?.alsoTarget) {
        delete targets[selfKey].self;
        delete targets[selfKey].alsoTarget;
      } else delete targets[selfKey];
    }
    // Choice groups keep an earlier pick when the card is resolved again.
    const choices = {};
    for (const [g, group] of Object.entries(plan.choices ?? {})) {
      // 0.17.0: an option that names Combat Tools' pick on this card (Practical Magic) is picked already.
      const picked = res.choices?.[g]?.picked ?? dsctPickedOption(item, message, group) ?? null;
      const valid = group.options.some(o => o.id === picked);
      // 0.15.0: who picked (the card's button, or the Use Ability dialog through the seed) stays with the pick.
      choices[g] = { ...group, picked: valid ? picked : null, ...(valid && res.choices?.[g]?.by ? { by: res.choices[g].by } : {}) };
      if (choices[g].picked) applyPick(plan.ops, g, choices[g].picked);
    }
    // Summon rows (Milestone 6): the world actors of their stat blocks, imported or reused now, inside the lock and
    // before the single write (actors only, never the message). The objects are the plan's own: the choices land there.
    const summons = Object.fromEntries(Object.entries(plan.ops).filter(([id, o]) => o.kind === "summon" && o.status === OP_STATUS.PENDING && !kept[id]));
    if (Object.keys(summons).length) {
      try {
        await prepareSummonOps(summons, { item });
      } catch (err) {
        error("summon.prepare", err, { messageId: message.id });
      }
    }
    if (Hooks.call(HOOKS.preResolve, message, res, plan) === false) {
      for (const op of Object.values(plan.ops)) if (op.mode === "auto") op.mode = "manual";
      warnings.push({ code: "hookManual" });
    }

    const ops = { ...plan.ops };
    for (const [id, op] of Object.entries(kept)) ops[id] = op;
    // A potency change of a used triggered action that is still live stays on the rebuilt row (Use my targets,
    // a forced resolve): the reaction stays spent, so its effect must stay too (`triggerDeltas` per entry).
    if (!fresh) carryTriggerPotency(plan.ops, res.ops, targets, kept);
    // Milestone 9: a cleanse row whose owner was already asked keeps that mark across re-resolves (no second prompt).
    if (!fresh) for (const [id, op] of Object.entries(plan.ops)) if (!kept[id] && op.kind === "cleanse" && res.ops?.[id]?.cleanseAsked) op.cleanseAsked = res.ops[id].cleanseAsked;
    const autoOps = Object.values(plan.ops)
      // Milestone 9 (D4): a cleanse row that needs a choice goes too: applyOpList asks the creature's owner first, the
      // row stays pending ("chooseEffects") when nobody answers.
      .filter(op => !kept[op.opId] && op.mode === "auto" && op.status === OP_STATUS.PENDING && !op.noApply && !op.awaitingChoice)
      .sort((a, b) => a.order - b.order);
    // Movement goes after the card is written: Combat Tools may still ask something (friendly fire, a
    // fall), and the damage and conditions should not wait for that answer.
    const toApply = autoOps.filter(op => op.kind !== "hide" && !MOVE_KINDS.has(op.kind) && !PLACED_KINDS.has(op.kind));
    // Milestone 9 (D-B2): an auto zone row built by this resolve for the first time applies now when its area needs
    // no click: a burst / aura around the creator, or the area drawn on use (zones/adopt.mjs). Every other zone row
    // is written as "prompt" below (its Place button), as before.
    const zoneAuto = autoOps.filter(op => op.kind === "zone" && (fresh || !res.ops?.[op.opId]));
    const zoneAdopt = zoneAuto.length
      ? adoptZoneTemplates(message, { ...res, ...identity, ops }, zoneAuto.filter(op => op.interactive !== false))
      : { clientZones: {}, adopted: {} };
    const zoneNow = zoneAuto.filter(op => op.interactive === false || zoneAdopt.adopted[op.opId]);
    // Appliers resolve targets through the record: give them the new target set, not the stored one (gain-only
    // records included: a gainer keeps its record, §3.2 gainerRecord).
    const patches = await applyOpList(message, { ...res, ...identity, targets: { ...gainKeep, ...targets }, ops }, [...toApply, ...zoneNow],
      { clientZones: zoneAdopt.clientZones, adopted: zoneAdopt.adopted });
    // Ops created during the apply (gain rows, hero-token heals) join the written ops as full ops (§1.5, C1).
    for (const [id, patch] of Object.entries(patches)) {
      if (createdOf(patches)?.has(id)) ops[id] = opWrite(patches, id, patch);
      else if (ops[id]) Object.assign(ops[id], patch);
    }
    // Milestone 9: a zone row this resolve did not apply waits for its Place button (a refusal stays failed).
    for (const op of Object.values(plan.ops)) {
      if (op.kind === "zone" && !kept[op.opId] && op.mode === "auto" && ops[op.opId]?.status !== OP_STATUS.APPLIED) ops[op.opId].mode = "prompt";
    }
    const areaTemplateUsed = !!res.areaTemplate && Object.keys(zoneAdopt.adopted).some(id => patches[id]?.status === OP_STATUS.APPLIED);
    // Moves from the final state (review conc 1): a push a triggered action made resisted does not move.
    const autoMoves = autoOps
      .filter(op => MOVE_KINDS.has(op.kind) && ops[op.opId]?.status === OP_STATUS.PENDING && ops[op.opId]?.mode === "auto")
      .map(op => op.opId);
    // 0.17.0: a resisted move the surge dialog raised the potency of moves now too.
    for (const [id, p] of Object.entries(patches)) {
      if (p?.potencyChoiceDone && p.status === OP_STATUS.PENDING && MOVE_KINDS.has(ops[id]?.kind) && ops[id]?.mode === "auto" && !autoMoves.includes(id)) autoMoves.push(id);
    }

    // Remove targets and unapplied ops of a previous resolution that the new one dropped. The
    // deletion operators sit inside the written maps (a separate dotted key would be overwritten by
    // the parent object during expansion).
    // Targets that still own applied or undone history stay in the record (marked dropped) so
    // their ops can be shown and undone.
    // A 1.2 part's potency adjustments are read from the card each time, never stored on the target record.
    const writeTargets = Object.fromEntries(Object.entries(targets).map(([k, { potencies: _p, ...t }]) => [k, { ...t, dropped: false }]));
    const writeOps = { ...ops };
    const historyKeys = new Set(Object.values(kept).flatMap(op => op.targetKeys ?? []));
    for (const op of createdOf(patches)?.values() ?? []) for (const k of op.targetKeys ?? []) historyKeys.add(k);
    for (const [key, old] of Object.entries(res.targets ?? {})) {
      if (targets[key]) continue;
      // A gain-only record stays as it is while it owns kept rows (never dropped).
      if (gainKeep[key]) writeTargets[key] = historyKeys.has(key) ? gainKeep[key] : ForcedDeletion();
      else writeTargets[key] = historyKeys.has(key) ? { ...old, dropped: true } : ForcedDeletion();
    }
    // Gain-only records of this resolve's own gain rows (existing keys untouched).
    for (const [key, t] of Object.entries(createdTargetsOf(patches) ?? {})) {
      if (!(key in writeTargets)) writeTargets[key] = t;
    }
    for (const id of Object.keys(res.ops ?? {})) if (!ops[id]) writeOps[id] = ForcedDeletion();
    // Stale fields (M6 follow-up, TESTING.md:836): a rebuilt row whose stored op had keys the new one lacks (a
    // `reason: noAnchor` that no longer applies) gets them cleared.
    if (!fresh) {
      for (const [id, op] of Object.entries(plan.ops)) {
        const old = res.ops?.[id];
        if (!old || kept[id] || createdOf(patches)?.has(id)) continue;
        const nulls = {};
        for (const k of Object.keys(old)) if (!(k in op)) nulls[k] = null;
        if (Object.keys(nulls).length) writeOps[id] = { ...nulls, ...ops[id] };
      }
    }

    const writeChoices = { ...choices };
    for (const g of Object.keys(res.choices ?? {})) if (!choices[g]) writeChoices[g] = ForcedDeletion();
    update[recordPath()] = {
      ...identity, shape, modes: plan.modes, targets: writeTargets, ops: writeOps, warnings, choices: writeChoices,
      library: { layer: lib.layer, key: lib.key, version: lib.version, notes: lib.notes ?? null },
      noPowerRoll,
      // Milestone 9 (docs/M9-DESIGN.md §C.3): the Persistent use (null clears a stale one); a re-roll is matched here.
      persistent: persistentRecord({ lib, item, message, res, fresh }),
      rollCounts: rollCounts(parts), resolvedAt: Date.now(), resolvedBy: game.userId,
      generation: fresh ? 1 : (res.generation ?? 1) + (res.resolvedAt ? 1 : 0),
      // The hold marker of this resolution goes with its final write (deletions sit inside the written map),
      // and so does a dead one: assertNotHeld let this resolve through, so a marker it found is this GM's from
      // before a reload, or ran out.
      ...(heldMessages.delete(message.id) || res.hold ? { hold: ForcedDeletion() } : {}),
      // Milestone 9 (D2): picks and pick prompts are the GM's own writes (recordPick, offerPicks): a seeded one goes.
      ...(fresh && res.picks ? { picks: ForcedDeletion() } : {}),
      ...(fresh && res.pickAsked ? { pickAsked: ForcedDeletion() } : {}),
      // Milestone 9: the seeded drawn area is spent once a zone row was applied from it (or from its template).
      ...(areaTemplateUsed ? { areaTemplate: ForcedDeletion() } : {}),
    };
    await writeApplied(message, update, res, patches);
    runAfterWrite(message, patches);
    deleteAdoptedTemplates(zoneAdopt.adopted, patches);
    const counts = Object.values(ops).reduce((acc, o) => ((acc[o.status] = (acc[o.status] ?? 0) + 1), acc), {});
    log("resolve.finish", { messageId: message.id, shape, targets: Object.keys(targets).length, ops: counts });
    Hooks.callAll(HOOKS.resolved, message, getResolution(game.messages.get(message.id) ?? message), { reason });
    return { record: getResolution(game.messages.get(message.id) ?? message), autoMoves };
  }).then(async (out) => {
    if (!out?.autoMoves) return out;
    if (out.autoMoves.length) {
      const current = game.messages.get(message.id) ?? message;
      await applyOps(current, out.autoMoves, { userId: getResolution(current)?.resolvedBy ?? game.userId });
    }
    // Milestone 9 (D2): ask the user's owner for the picks of this card's pick rows (once per row; never awaited).
    await offerPicks(game.messages.get(message.id) ?? message, { recordPick, notePicksAsked });
    return getResolution(game.messages.get(message.id) ?? message);
  });
}

/**
 * The ability user's token (forced movement origin). The seeded speaker token is author-written, so it
 * counts only when it belongs to the ability's actor; otherwise the actor's token on the scene.
 */
function sourceToken(seeded, item) {
  const actor = item?.actor;
  if (!actor) return null;
  let doc = null;
  try {
    doc = seeded ? fromUuidSync(seeded) : null;
  } catch (_err) { /* invalid uuid */ }
  const sameActor = d => !!d?.actor && (d.actor === actor || d.actor.uuid === actor.uuid || (!actor.isToken && d.actorId === actor.id));
  if (sameActor(doc)) return doc.uuid;
  const token = actor.token ?? actor.getActiveTokens?.(true, true)?.[0] ?? null;
  return token?.uuid ?? null;
}

/** The ability user's target record (its token, else the actor alone). */
function selfTarget(identity, item) {
  let doc = null;
  try {
    doc = identity.sourceTokenUuid ? fromUuidSync(identity.sourceTokenUuid) : null;
  } catch (_err) { /* invalid uuid */ }
  const t = targetFromTokenDoc(doc);
  if (t) return t;
  const actor = item?.actor;
  if (!actor) return null;
  return { key: actor.uuid.replace(/\./g, "__"), tokenUuid: null, actorUuid: actor.uuid, name: actor.name, img: actor.img ?? null };
}

/** Mark the ops of a choice group: the picked option's rows go ahead, the others are skipped. */
function applyPick(ops, group, option) {
  for (const op of Object.values(ops)) {
    if (op.choice?.group !== group) continue;
    if (op.choice.option === option) {
      op.awaitingChoice = false;
      if (op.reason === "notChosen") Object.assign(op, { status: OP_STATUS.PENDING, reason: null });
    } else if (op.status === OP_STATUS.PENDING || op.status === OP_STATUS.UNDONE) Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "notChosen", awaitingChoice: false });
  }
}

/** Rebuild the card for a new set of tokens (button "Use my targets", late area targets). */
export function retarget(message, tokenUuids, reason = "retarget", { guard = null } = {}) {
  const targets = targetsFromTokenUuids(tokenUuids);
  return resolveMessage(message, { force: true, targets, reason, guard });
}

/* -------------------------------------------- */
/*  Buttons: apply / undo                       */
/* -------------------------------------------- */

/**
 * Apply the given ops (or every pending op) of a card. Active GM only; other clients go through the
 * relay (relay/queries.mjs), which passes the requesting user and an authorization check that runs
 * inside the message lock on the fresh record.
 * @param {ChatMessage} message
 * @param {string[]|null} [opIds]           null: every pending or "external" op.
 * @param {object} [options]
 * @param {string} [options.userId]         Recorded as `byUserId`.
 * @param {Function} [options.authorize]    (op, res, message) => boolean; refused ops are left alone.
 * @param {boolean} [options.half]          Damage ops deal half damage (rounded down); a plain apply
 *                                          deals full damage again.
 * @returns {Promise<{patches: object, refused: string[]}|null>}
 */
export async function applyOps(message, opIds = null, { userId = game.userId, authorize = null, half = false, clientMoves = null, clientPlaces = null, clientZones = null } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    const ops = Object.values(res.ops ?? {})
      // "Apply all" leaves rows that need a choice (movement type) to their own button.
      // Milestone 9 (D4): a cleanse row that needs a choice is offered to the creature's owner (applyOpList).
      .filter(op => (opIds ? opIds.includes(op.opId) : ((op.status === OP_STATUS.PENDING || op.status === OP_STATUS.EXTERNAL) && (!op.synthetic || !needsChoice(op)))))
      // A row of a choice group waits for the pick, even when named; teleports picked on the canvas, summons, zones
      // and gain rows that wait for the Director (`confirm`) are applied one by one (their own button), never by
      // "Apply all".
      .filter(op => !op.awaitingChoice)
      .filter(op => opIds || !((op.kind === "teleport" && op.interactive) || ownButtonOnly(op)))
      // "external" ops may be retried: the check in applyOpList keeps them external while Target
      // Damage's record is live.
      .filter(op => op.status !== OP_STATUS.APPLIED && !op.noApply)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      // In-memory copies (the pre-pass changes `half`, `trigger` and `potency` on them). A plain apply deals
      // full damage again, unless a used triggered action halved the op (re-apply after undo, C17).
      .map(op => (op.kind === "damage" && !op.surge ? { ...op, half: !!half || triggerHalved(op) } : { ...op }));
    const { allowed, refused } = splitAuthorized(ops, authorize, res, message);
    if (!allowed.length) return { patches: {}, refused };
    const patches = await applyOpList(message, res, allowed, { userId, clientMoves, clientPlaces, clientZones });
    const update = {};
    addPatchWrites(update, patches, res);
    holdCleanup(message, update);
    // The card cannot record summons whose tokens exist, zones whose region exists or gains already paid (deleted
    // mid-apply, a trust failure): undo them again. Not awaited: each runs on its own chain (§6.1, §6.4, §6.5).
    await writeApplied(message, update, res, patches);
    runAfterWrite(message, patches);
    return { patches, refused };
  });
}

/**
 * Pick an option of a "choose one" group (Milestone 4): its rows go ahead (automatic ones are applied
 * now), the other options' rows are skipped. Allowed while nothing of the group was applied. Active GM;
 * relayed and authorized like Apply on the group's rows.
 * @returns {Promise<{group: string, option: string, applied: string[]}|null>}
 */
export async function chooseOption(message, group, option, { userId = game.userId, authorize = null } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    const g = res.choices?.[group];
    if (!g || !g.options?.some(o => o.id === option)) throw new Error("DSAUTO.Relay.BadRequest");
    const groupOps = Object.values(res.ops ?? {}).filter(op => op.choice?.group === group);
    if (groupOps.some(op => op.status === OP_STATUS.APPLIED)) throw new Error("DSAUTO.Relay.ChoiceLocked");
    if (authorize && !groupOps.some(op => authorize(op, res, message))) throw new Error("DSAUTO.Relay.Denied");
    const ops = foundry.utils.deepClone(res.ops);
    applyPick(ops, group, option);
    const changed = groupOps.map(op => ops[op.opId]);
    // Milestone 9 (D4): cleanse rows that need a choice included (the owner is asked in applyOpList).
    const autoRows = changed.filter(op => op.choice.option === option && op.mode === "auto" && op.status === OP_STATUS.PENDING && !op.noApply);
    const toApply = autoRows.filter(op => !MOVE_KINDS.has(op.kind) && !PLACED_KINDS.has(op.kind));
    const patches = await applyOpList(message, { ...res, ops }, toApply, { userId });
    // Moves from the merged state (review conc 1): still pending and automatic after the pre-pass.
    const moveIds = autoRows
      .filter(op => MOVE_KINDS.has(op.kind) && !PLACED_KINDS.has(op.kind))
      .filter(op => {
        const merged = { ...op, ...(patches[op.opId] ?? {}) };
        return merged.status === OP_STATUS.PENDING && merged.mode === "auto";
      })
      .map(op => op.opId);
    const update = { [recordPath(`choices.${group}.picked`)]: option, [recordPath(`choices.${group}.by`)]: userId };
    for (const op of changed) {
      update[recordPath(`ops.${op.opId}`)] = {
        status: op.status, reason: op.reason ?? null, awaitingChoice: !!op.awaitingChoice, ...(patches[op.opId] ?? {}),
      };
    }
    addPatchWrites(update, patches, res);
    holdCleanup(message, update);
    await writeApplied(message, update, res, patches);
    runAfterWrite(message, patches);
    log("choice", { messageId: message.id, group, option, applied: Object.keys(patches) });
    return { group, option, applied: Object.keys(patches), moveIds };
  }).then(async (out) => {
    // Movement goes after the write, as on resolution.
    if (out?.moveIds?.length) await applyOps(game.messages.get(message.id) ?? message, out.moveIds, { userId });
    // Milestone 9 (D2): the picked option's pick rows are offered now.
    if (out) await offerPicks(game.messages.get(message.id) ?? message, { recordPick, notePicksAsked });
    return out;
  });
}

/* -------------------------------------------- */
/*  Picks (Milestone 9)                         */
/* -------------------------------------------- */

const pickRefused = () => new Error("DSAUTO.Relay.PickRefused");

/**
 * Record the creature(s) picked for a pick row (Milestone 9, D2) and resolve the card again outside the lock, which
 * plans the real rows for them (engine/side-targets.mjs). Active GM; relayed (`pick`) or from the owner's prompt
 * (ui/target-pick.mjs). Inside the lock the pick is checked against the candidates recomputed here (pickCandidates:
 * range, filter, never the user), the row's count and its damage types; only then `res.picks[effectId]` is written
 * (signed). Throws DSAUTO.Relay.PickRefused (a bad pick) or DSAUTO.Relay.Denied (`authorize`).
 * @param {ChatMessage} message
 * @param {string} opId                         The pick row.
 * @param {{tokenUuids: string[], damageType?: string|null}} answer
 * @param {{userId?: string, authorize?: Function}} [options]
 * @returns {Promise<{effectId: string, tokenUuids: string[], damageType: string|null}|null>}
 */
export async function recordPick(message, opId, { tokenUuids = [], damageType = null } = {}, { userId = game.userId, authorize = null } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    const op = res.ops?.[opId];
    if (!op || op.kind !== "pick" || op.status !== OP_STATUS.PENDING || op.awaitingChoice || !op.pick?.effectId) throw pickRefused();
    if (authorize && !authorize(op, res, message)) throw new Error("DSAUTO.Relay.Denied");
    const p = op.pick;
    const list = Array.isArray(tokenUuids) ? tokenUuids : [];
    const uuids = [...new Set(list)];
    const allowed = new Set(pickCandidates(op, res).map(c => c.tokenUuid));
    if (!uuids.length || uuids.length !== list.length || uuids.length > (Number(p.count) || 1) || !uuids.every(u => allowed.has(u))) throw pickRefused();
    const types = p.damageTypes ?? [];
    if (types.length ? !types.includes(damageType) : damageType != null) throw pickRefused();
    const pick = { tokenUuids: uuids, damageType: types.length ? damageType : null, by: userId, at: Date.now() };
    await writeRecord(message, { [recordPath(`picks.${p.effectId}`)]: pick });
    log("pick", { messageId: message.id, opId, count: uuids.length, damageType: pick.damageType, userId });
    return { effectId: p.effectId, tokenUuids: uuids, damageType: pick.damageType };
  }).then(async (out) => {
    if (out) await resolveMessage(game.messages.get(message.id) ?? message, { force: true, reason: "pick" });
    return out;
  });
}

/**
 * Mark pick rows as offered (Milestone 9, `res.pickAsked[opId]`, signed): a reload or a second resolve does not ask
 * again (the row's Pick button stays). Returns the ids this call marked (a concurrent call gets none of them).
 * @param {ChatMessage} message
 * @param {string[]} opIds
 * @returns {Promise<string[]>}
 */
export async function notePicksAsked(message, opIds) {
  if (!isActiveGM() || !message || stripping() || !opIds?.length) return [];
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res || integrity(message) !== "ok" || res.hold) return [];
    const ids = opIds.filter(id => res.ops?.[id]?.kind === "pick" && res.ops[id].status === OP_STATUS.PENDING && !res.pickAsked?.[id]);
    if (!ids.length) return [];
    const at = Date.now();
    await writeRecord(message, Object.fromEntries(ids.map(id => [recordPath(`pickAsked.${id}`), at])));
    return ids;
  });
}

/** Applied summon patches of a write that failed: dismiss them (REMOVAL.UNDO, no annotation, quiet), fire-and-forget. */
function cleanupSummons(patches) {
  for (const p of Object.values(patches ?? {})) {
    if (p?.status !== OP_STATUS.APPLIED || !p.summonId) continue;
    log("summon.writeFailed", { summonId: p.summonId });
    Promise.resolve()
      .then(() => dismissSummon(p.summonId, REMOVAL.UNDO, { annotate: false, quiet: true }))
      .catch(err => error("summon.writeFailed", err, { summonId: p.summonId }));
  }
}

/**
 * Re-prepare a summon row's world actors (relay summonPrepare, card lock). `grant`: CH8 fallback (OWNER on the world
 * actor for the summoner's non-GM owners). One signed write of `choices`. Throws DSAUTO.Relay.* like editOp.
 * A row that failed noWorldActor is re-opened first (CH11): it is pending again once a choice has a world actor.
 * @returns {Promise<{choices: object[]}>}
 */
export async function prepareSummon(message, opId, { userId = game.userId, authorize = null, grant = false } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    const op = res.ops?.[opId];
    if (!op || op.kind !== "summon" || op.status === OP_STATUS.APPLIED) throw new Error("DSAUTO.Relay.BadRequest");
    if (authorize && !authorize(op, res, message)) throw new Error("DSAUTO.Relay.Denied");
    const item = res.synthetic ? null : await fromUuid(res.abilityUuid ?? "").catch(() => null);
    const copy = foundry.utils.deepClone(op);
    // CH11: prepareSummonOps only prepares pending rows.
    const reopened = copy.status === OP_STATUS.FAILED && copy.reason === "noWorldActor";
    if (reopened) Object.assign(copy, { status: OP_STATUS.PENDING, reason: null });
    let grantUserIds = [];
    // D10: an api.summon row is the Director's; its stat blocks are never granted to players (review fix).
    if (grant && !op.synthetic && !res.synthetic) {
      let summoner = null;
      try {
        summoner = fromUuidSync(copy.summonerActorUuid ?? res.sourceActorUuid ?? "");
      } catch (_err) { /* gone */ }
      grantUserIds = summonerOwnerIds(summoner);
    }
    await prepareSummonOps({ [opId]: copy }, { item, grantUserIds });
    const ready = (copy.choices ?? []).some(c => c?.worldActorId);
    const patch = { choices: copy.choices };
    // Only a pending or re-opened row changes state (a skipped or undone row keeps its own).
    if (reopened || op.status === OP_STATUS.PENDING) {
      Object.assign(patch, ready ? { status: OP_STATUS.PENDING, reason: null } : { status: OP_STATUS.FAILED, reason: "noWorldActor" });
    }
    await writeRecord(message, { [recordPath(`ops.${opId}`)]: patch });
    log("summon.prepare", { messageId: message.id, opId, ready, grant: grantUserIds.length, userId });
    return { choices: copy.choices };
  });
}

function splitAuthorized(ops, authorize, res, message) {
  if (!authorize) return { allowed: ops, refused: [] };
  const allowed = [];
  const refused = [];
  for (const op of ops) (authorize(op, res, message) ? allowed : refused).push(op);
  return { allowed, refused: refused.map(op => op.opId) };
}

/** Undo the given ops (or every applied op, newest first) of a card. Active GM only; see applyOps. */
export async function undoOps(message, opIds = null, { userId = game.userId, authorize = null } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    // Milestone 7 (§3.3): undoing named rows also undoes the gain rows and hero-token heals they caused ("Undo all"
    // has them already). Newest first: a heal is undone after its damage, a gain before it.
    let named = null;
    if (opIds) {
      named = new Set(opIds);
      for (const op of Object.values(res.ops ?? {})) if (op.kind === "hide" && named.has(op.teleportOpId)) named.add(op.opId);
      for (const op of Object.values(res.ops ?? {})) if (op.hideOpId && named.has(op.hideOpId)) named.add(op.opId);
      for (const op of Object.values(res.ops ?? {})) if (op.judgementCause && named.has(op.judgementCause)) named.add(op.opId);
      for (const op of Object.values(res.ops ?? {})) if (op.temporaryCauseOpId && named.has(op.temporaryCauseOpId)) named.add(op.opId);
      for (const op of Object.values(res.ops ?? {})) if (op.auraCauseOpId && named.has(op.auraCauseOpId)) named.add(op.opId);
      for (const op of Object.values(res.ops ?? {})) if (op.moveCauseOpId && named.has(op.moveCauseOpId)) named.add(op.opId);
      // Milestone 9 (D6): a teleport's boost payment goes back with the teleport.
      for (const op of Object.values(res.ops ?? {})) if (op.boostOf && named.has(op.boostOf)) named.add(op.opId);
      try {
        for (const id of cascadeGainIds(res, new Set(opIds))) named.add(id);
      } catch (err) {
        error("gains.cascade", err, { messageId: message.id });
      }
    }
    const ops = Object.values(res.ops ?? {})
      .filter(op => op.status === OP_STATUS.APPLIED && (!named || named.has(op.opId)))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    const { allowed, refused } = splitAuthorized(ops, authorize, res, message);
    if (!allowed.length) return { patches: {}, refused };
    const patches = {};
    for (const op of allowed) {
      let patch;
      try {
        if (op.featureCost && Object.values(res.ops).some(o => o.costOpId === op.opId && o.status === OP_STATUS.APPLIED && !allowed.some(a => a.opId === o.opId))) patch = { status: OP_STATUS.APPLIED, reason: "featureCostInUse" };
        else patch = await undoOneOp(message, res, op);
      } catch (err) {
        error("undoOp", err, { opId: op.opId });
        patch = { status: OP_STATUS.FAILED, reason: "undoError", error: String(err?.message ?? err) };
      }
      if (patch.status === OP_STATUS.UNDONE) {
        await releaseJudgementOpportunity(message, op);
        await restoreTemporaryEffects(fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? ""), op);
        Object.assign(patch, { undoneBy: userId, undoneAt: Date.now() });
        if (op.surgesPaid) {
          await refundSurges(op).catch(err => error("refundSurges", err));
          patch.surgesPaid = 0;
        }
      }
      patches[op.opId] = patch;
      log("op.undo", { opId: op.opId, status: patch.status, undoMode: patch.undoMode, revivalPending: patch.revivalPending });
      Hooks.callAll(HOOKS.undoOp, message, { ...op, ...patch }, patch);
    }
    const update = {};
    for (const [id, patch] of Object.entries(patches)) update[recordPath(`ops.${id}`)] = patch;
    await writeRecord(message, update);
    for (const op of allowed) await releaseFeatureClaim(op, message.id, Object.values(getResolution(message).ops));
    if (!opIds && Object.values(getResolution(message).ops).every(o => o.status !== OP_STATUS.APPLIED)) await undoAloneUse(message);
    return { patches, refused };
  });
}

/* -------------------------------------------- */
/*  Edit                                        */
/* -------------------------------------------- */

const EDITABLE = new Set(["damage", "heal", "temp", "forced", "cleanse"]);
const MAX_AMOUNT = 10_000;
const MAX_DISTANCE = 50;

/**
 * Validate an edit of an op. Throws `DSAUTO.Relay.BadRequest`; returns the new `override`.
 * - damage / heal / temp: `amount` (0-10000) replaces the roll's total; `temp` (heal rows) applies the
 *   healing as temporary Stamina instead (or back).
 * - forced: `distance` (0-50, before stability) and `movement` (one of the ability's types).
 */
export function editOverride(op, edits = {}) {
  const bad = () => new Error("DSAUTO.Relay.BadRequest");
  if (!op || !EDITABLE.has(op.kind) || op.surge || op.status === OP_STATUS.APPLIED || op.noApply) throw bad();
  // Milestone 7 (C25): a hero-token heal is the recovery value the tokens bought; gain rows are never edited.
  if (op.heroToken || op.kind === "gain") throw bad();
  const out = { ...(op.override ?? {}) };
  delete out.by;
  delete out.at;
  const int = (v, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw bad();
    return n;
  };
  // undefined keeps a field, null clears it (back to the ability's value).
  const set = (key, value, check) => {
    if (value === undefined) return;
    if (value === null) delete out[key];
    else out[key] = check(value);
  };
  if (op.kind === "cleanse") {
    // Which of the creature's effects end (ids; checked against the live effects when applied).
    if (Object.keys(edits).some(k => k !== "effects")) throw bad();
    set("effects", edits.effects, v => {
      if (!Array.isArray(v) || !v.length || v.length > 10 || !v.every(id => typeof id === "string" && /^[A-Za-z0-9]{16}$/.test(id))) throw bad();
      if (op.count != null && v.length > op.count) throw bad();
      return [...new Set(v)];
    });
    return out;
  }
  if (edits.effects !== undefined) throw bad();
  if (op.recoveries && edits.temp !== undefined) throw bad();
  if (op.kind === "forced") {
    if (edits.amount !== undefined || edits.temp !== undefined) throw bad();
    set("distance", edits.distance, v => int(v, MAX_DISTANCE));
    set("movement", edits.movement, v => {
      if (!op.movements?.includes(v)) throw bad();
      return v;
    });
  } else {
    if (edits.distance !== undefined || edits.movement !== undefined) throw bad();
    set("amount", edits.amount, v => int(v, MAX_AMOUNT));
    set("temp", edits.temp, v => {
      if (op.kind === "damage" || typeof v !== "boolean") throw bad();
      return v;
    });
  }
  return out;
}

/**
 * Change an op before applying it, and optionally apply it. Active GM; relayed and authorized like
 * Apply: whoever may apply the row may edit it.
 * @param {ChatMessage} message
 * @param {string} id
 * @param {object} edits                      See editOverride.
 * @param {object} [options]
 * @param {User} [options.user]
 * @param {Function} [options.authorize]      (op, res, message) => boolean, inside the lock.
 * @param {boolean} [options.apply]           Apply the edited op right away.
 * @returns {Promise<{opId: string, status: string}|null>}
 */
export async function editOp(message, id, edits, { user = game.user, authorize = null, apply = false } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    const op = res.ops?.[id];
    if (!op) throw new Error("DSAUTO.Relay.BadRequest");
    if (authorize && !authorize(op, res, message)) throw new Error("DSAUTO.Relay.Denied");
    // Rows of a "choose one" group wait for the pick (and the other options' rows stay out).
    if (apply && (op.awaitingChoice || op.reason === "notChosen")) throw new Error("DSAUTO.Relay.ChoiceFirst");
    const override = { ...editOverride(op, edits), by: user?.id ?? null, at: Date.now() };
    const next = { ...op, override };
    // A merge update keeps stored keys: cleared fields are deleted explicitly.
    const written = { ...override };
    for (const key of Object.keys(op.override ?? {})) if (!(key in override)) written[key] = ForcedDeletion();
    const patch = { override: written };
    // Applying from Edit deals the full (edited) amount, like a plain Apply, unless a used triggered
    // action halved the op (Milestone 5).
    if (apply && op.kind === "damage") next.half = triggerHalved(op);
    if (op.reason === "chooseMovement" && !needsChoice(next)) {
      next.reason = null;
      patch.reason = null;
    }
    if (op.reason === "chooseEffects" && override.effects?.length) {
      next.reason = null;
      patch.reason = null;
    }
    let patches = null;
    if (apply) {
      patches = await applyOpList(message, { ...res, ops: { ...res.ops, [id]: next } }, [next], { userId: user?.id ?? game.userId });
      Object.assign(patch, patches[id], { override: written });
    }
    const update = { [recordPath(`ops.${id}`)]: patch };
    addPatchWrites(update, patches, res);
    holdCleanup(message, update);
    if (patches) await writeApplied(message, update, res, patches);
    else await writeRecord(message, update);
    if (patches) runAfterWrite(message, patches);
    log("op.edit", { messageId: message.id, opId: id, override, apply, status: patch.status ?? op.status, user: user?.name });
    return { opId: id, status: patch.status ?? op.status };
  });
}

/* -------------------------------------------- */
/*  Surges                                      */
/* -------------------------------------------- */

/**
 * Spend a hero's surges on one op of a card (active GM; relayed and authorized like the buttons).
 * - `count` (1-3): extra damage on a damage op's target, `count` x the hero's highest characteristic,
 *   as a new damage op that adds to the base op (at most 3 surges per base op in total).
 * - `potency`: +1 potency for 2 surges on a condition op the target resisted by exactly one.
 * The new or changed op follows the base op's mode: it lands at once when the base op was applied
 * automatically (damage) or its mode is automatic (potency), or when a Director asked; otherwise it
 * waits like the base op. Surges are paid when it lands.
 * @param {ChatMessage} message
 * @param {string} baseOpId
 * @param {object} options
 * @param {number} [options.count]
 * @param {boolean} [options.potency]
 * @param {User} options.user                    The requesting user.
 * @param {Function} [options.authorize]         (op, res, message, hero) => boolean, inside the lock.
 * @returns {Promise<{opId: string, status: string}|null>}
 */
export async function addSurge(message, baseOpId, { count = 0, potency = false, user = game.user, authorize = null } = {}) {
  if (!isActiveGM() || !message || stripping()) return null;
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (!res) return null;
    await requireTrusted(message);
    assertNotHeld(message, res);
    const op = res.ops?.[baseOpId];
    const hero = res.synthetic ? null : surgeActor(res.sourceActorUuid);
    if (!op || !hero) throw new Error("DSAUTO.Relay.SurgeNotPossible");
    if (authorize && !authorize(op, res, message, hero)) throw new Error("DSAUTO.Relay.Denied");
    const available = availableSurges(hero);
    let next;
    let landsNow;
    if (potency) {
      // 1.2: the system's "Adjust potency" (2 surges for +1, `potencies` on the target's part) was used on this row's
      // effect already (CH5): ours would pay a second time.
      if (partPotencyBonus(message, op)) throw new Error("DSAUTO.Warning.potencyAdjusted");
      if (!potencySurgeable(op)) throw new Error("DSAUTO.Relay.SurgeNotPossible");
      if (available < POTENCY_SURGE_COST) throw new Error("DSAUTO.Relay.NotEnoughSurges");
      next = potencySurgePatch(op, hero.uuid);
      landsNow = op.mode === "auto" || !!user?.isGM;
    } else {
      const n = Number(count);
      if (!surgeableDamage(op) || !Number.isInteger(n) || n < 1 || n > MAX_SURGES) throw new Error("DSAUTO.Relay.SurgeNotPossible");
      const used = Number(op.surgeSpend?.count ?? op.nativeSurges ?? 0) + liveSurgeOps(res, op.opId).reduce((sum, o) => sum + Number(o.surge?.count ?? 0), 0);
      if (used + n > MAX_SURGES) throw new Error("DSAUTO.Relay.SurgeNotPossible");
      if (available < n) throw new Error("DSAUTO.Relay.NotEnoughSurges");
      const perSurge = surgeDamage(hero);
      if (!perSurge) throw new Error("DSAUTO.Relay.SurgeNotPossible");
      const index = Object.values(res.ops ?? {}).filter(o => o.surge?.baseOpId === op.opId).length + 1;
      const id = opId("surge", index, op.opId);
      next = {
        opId: id, order: (op.order ?? 0) + index / 10, kind: "damage", mode: op.mode, status: OP_STATUS.PENDING,
        tier: op.tier, targetKeys: [op.targetKeys[0]], type: op.type ?? "", ignoredImmunities: [...(op.ignoredImmunities ?? [])],
        aoe: !!op.aoe, amount: n * perSurge,
        surge: { kind: "damage", count: n, perSurge, actorUuid: hero.uuid, baseOpId: op.opId },
        requestedBy: user?.id ?? null,
      };
      if (op.group) Object.assign(next, { group: op.group, groupName: op.groupName ?? "" });
      landsNow = op.status === OP_STATUS.APPLIED && (op.mode === "auto" || !!user?.isGM);
    }
    // Surge ops never prompt (the pre-pass skips them); the extra writes keep the code path uniform.
    let patches = null;
    if (landsNow) {
      patches = await applyOpList(message, { ...res, ops: { ...res.ops, [next.opId]: next } }, [next], { userId: user?.id ?? game.userId });
      Object.assign(next, patches[next.opId]);
    }
    const update = { [recordPath(`ops.${next.opId}`)]: next };
    addPatchWrites(update, patches, res);
    holdCleanup(message, update);
    if (patches) await writeApplied(message, update, res, patches);
    else await writeRecord(message, update);
    if (patches) runAfterWrite(message, patches);
    log("surge", { messageId: message.id, baseOpId, opId: next.opId, kind: next.surge.kind, count: next.surge.count, status: next.status, user: user?.name });
    return { opId: next.opId, status: next.status };
  });
}

/* -------------------------------------------- */
/*  Observers                                   */
/* -------------------------------------------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait before auto-resolving a new card: `autoApplyDelayMs`, then (setting `waitForDiceSoNice`) until
 * Dice So Nice finished rolling the card's dice, at most 15 s
 * (`game.dice3d.waitFor3DAnimationByMessageID` resolves on its `diceSoNiceRollComplete` hook).
 * 0.17.1: on the roller's screen while this client is hidden (relay/dice-wait.mjs).
 */
export async function resolveDelay(message) {
  const ms = Math.max(0, Number(setting("autoApplyDelayMs") ?? 0) || 0);
  if (ms) await sleep(ms);
  const dice3d = game.dice3d;
  if (!setting("waitForDiceSoNice") || typeof dice3d?.waitFor3DAnimationByMessageID !== "function") return;
  if (!message.rolls?.length && !message.system?.parts?.contents?.some?.(p => p.rolls?.length)) return;
  const started = Date.now();
  const how = await waitForDice(message);
  log("resolve.wait", { messageId: message.id, how, ms: Date.now() - started });
}

/** Cards older than this are never taken over (a reload must not adopt the chat log). */
const ADOPT_WITHIN_MS = 60_000;

export function onCreateChatMessage(message) {
  if (!isActiveGM() || !setting("enabled") || stripping()) return;
  const res = getResolution(message);
  if (!res) {
    if (Date.now() - (message.timestamp ?? 0) <= ADOPT_WITHIN_MS) adoptCard(message).catch(err => error("adopt", err, { messageId: message.id }));
    return;
  }
  if (res.resolvedAt) return;
  resolveDelay(message)
    .then(() => {
      const current = game.messages.get(message.id);
      return current ? resolveMessage(current, { reason: "create" }) : null; // deleted while waiting
    })
    .catch(err => error("resolve", err, { messageId: message.id }));
}

/** Insert a record and our part into an unseeded card the engine automates, then resolve it. */
async function adoptCard(message) {
  if (stripping()) return;
  const update = await withMessageLock(message.id, async () => {
    const current = game.messages.get(message.id);
    const data = current ? adoptionUpdate(current) : null;
    if (!data) return null;
    await current.update(data);
    log("adopt", { messageId: message.id });
    return data;
  });
  if (!update) return;
  await resolveDelay(message);
  const current = game.messages.get(message.id);
  if (current) await resolveMessage(current, { reason: "adopt" });
}

export function onUpdateChatMessage(message, changed, options, userId) {
  if (!isActiveGM()) return;
  // The uninstall pass's own writes, and anything while it runs (Milestone 8, WP-D).
  if (options?.[MODULE_ID]?.strip || stripping()) return;
  // Only the engine (a GM) writes our record after creation: a player's write locks the card.
  if (changed?.flags?.[MODULE_ID] && !game.users.get?.(userId)?.isGM) {
    const state = integrity(message);
    if (state === "tampered" || state === "unsigned") {
      withMessageLock(message.id, () => markTampered(game.messages.get(message.id) ?? message, state))
        .catch(err => error("integrity", err));
    }
    return;
  }
  if (!setting("enabled")) return;
  const res = getResolution(message);
  // Rolls appended to a tier part after resolution: new manual ops for that part's targets. Queued behind the
  // card's lock before the resolvedAt test: a fresh card held for triggered actions (Milestone 5) is still
  // unresolved here, and the call then runs after the resolve's write (it re-checks resolvedAt inside the lock).
  // 0.16.0: a hero-token reroll replaces the result parts and resolves the card again itself.
  if (res && changed?.system?.parts && !options?.[MODULE_ID]?.heroReroll) appendNewRolls(message).catch(err => error("newRolls", err));
  if (!res?.resolvedAt) return;
  // Integrity is checked inside the locked handlers below: our own write is signed only after this
  // hook ran for it.

  // 1.2: the system's "Adjust potency" wrote a target part's `potencies`: re-plan that target's waiting rows.
  for (const [partId, p] of Object.entries(changed?.system?.parts ?? {})) {
    if (!p || typeof p !== "object" || !("potencies" in p)) continue;
    if (message.system?.parts?.get?.(partId)?.type !== "targetResult") continue;
    replanPotency(message, partId).catch(err => error("potency.replan", err, { messageId: message.id, partId }));
  }

  // Late targets: Target Damage rewrote its target list (area auto-targeting) and we have none yet.
  const dstdTargets = changed?.flags?.[DSTD_ID]?.state?.targets;
  if (Array.isArray(dstdTargets) && dstdTargets.length && !Object.keys(realTargets(res)).length
    && !targetedOps(res).some(isApplied)) {
    const uuids = dstdTargetTokenUuids(message);
    log("lateTargets", { messageId: message.id, count: uuids.length });
    retarget(message, uuids, "lateTargets").catch(err => error("lateTargets", err));
    return;
  }

  // Target Damage applied or undid rows: keep our ops' "applied elsewhere" state in step.
  if (changed?.flags?.[DSTD_ID]?.state && dstdActive() && setting("respectDstdApplications")) {
    reconcileExternal(message).catch(err => error("reconcile", err));
  }

}

/**
 * Re-evaluate ops against Target Damage's applications after it changed them: rows it applied that
 * we have not (pending, undone, skipped) become "external"; "external" rows it undid become pending
 * again. Ops we applied are never touched. One message update, only when something changed.
 */
async function reconcileExternal(message) {
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (stripping() || !res?.resolvedAt || integrity(message) !== "ok") return;
    const update = {};
    for (const op of Object.values(res.ops ?? {})) {
      if (op.status === OP_STATUS.APPLIED || op.status === OP_STATUS.FAILED || op.noApply) continue;
      const wasExternal = EXTERNAL_REASONS.has(op.reason);
      if (op.status === OP_STATUS.SKIPPED && op.reason && !wasExternal) continue;
      const ext = externalPatch(message, res, op);
      let patch = null;
      if (ext && (ext.status !== op.status || ext.reason !== op.reason)) patch = ext;
      else if (!ext && wasExternal) patch = { status: OP_STATUS.PENDING, reason: null };
      if (patch) update[recordPath(`ops.${op.opId}`)] = patch;
    }
    if (!Object.keys(update).length) return;
    debug("reconcile", { messageId: message.id, ops: Object.keys(update).length });
    await writeRecord(message, update);
  });
}

/** Shapes whose rolls can be appended to (a modified damage roll lands in one tier part, or one target's part on 1.2). */
const APPENDABLE = new Set(["tierParts", "targetResult"]);

async function appendNewRolls(message) {
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (stripping() || !res?.resolvedAt || !APPENDABLE.has(res.shape) || integrity(message) !== "ok") return;
    const read = readCard(message);
    if (read.shape !== res.shape) return;
    const { parts } = read;
    const known = res.rollCounts ?? {};
    const update = {};
    let order = Math.max(0, ...Object.values(res.ops ?? {}).map(o => (o.order ?? 0) + 1));
    for (const p of parts) {
      const before = known[p.partId];
      if (before == null || p.rollCount <= before) continue;
      const part = message.system.parts.get(p.partId);
      for (const rollIndex of p.damageRollIndexes.filter(i => i >= before)) {
        const roll = part.rolls[rollIndex];
        const kind = roll.isHeal ? (roll.type === "value" ? "heal" : "temp") : "damage";
        for (const [key, t] of Object.entries(res.targets ?? {})) {
          if (t.partId !== p.partId) continue;
          const id = opId(kind, p.partId, rollIndex, key);
          if (res.ops?.[id]) continue;
          update[recordPath(`ops.${id}`)] = {
            opId: id, order: order++, kind, mode: "manual", status: OP_STATUS.PENDING, reason: "addedRoll",
            partId: p.partId, rollIndex, tier: p.tier, targetKeys: [key], amount: roll.total, type: roll.type ?? "",
            ignoredImmunities: [...(roll.ignoredImmunities ?? [])], aoe: !!roll.aoe,
          };
        }
      }
      update[recordPath(`rollCounts.${p.partId}`)] = p.rollCount;
    }
    if (!Object.keys(update).length) return;
    update[recordPath("generation")] = (res.generation ?? 1) + 1;
    debug("newRolls", { messageId: message.id, writes: Object.keys(update).length });
    await writeRecord(message, update);
  });
}

/** The card's manual potency adjustment for an op's effect on its 1.2 target part (0 when none). */
function partPotencyBonus(message, op) {
  if (!op?.partId || !op.preId) return 0;
  const part = message?.system?.parts?.get?.(op.partId);
  if (part?.type !== "targetResult") return 0;
  return Number(part.potencies?.[op.preId] ?? 0) || 0;
}

/**
 * 1.2: a target part's `potencies` changed after the card was resolved (the system's "Adjust potency"). The native
 * condition and forced rows of the targets on that part are planned again with the new bonus and replace the stored
 * ones while they wait (pending or skipped, never applied, undone, failed, applied elsewhere or surged: those are
 * history). Nothing is applied here: a row that now lands waits for its button. One record write, on the card lock.
 */
async function replanPotency(message, partId) {
  return withMessageLock(message.id, async () => {
    message = game.messages.get(message.id) ?? message;
    const res = getResolution(message);
    if (stripping() || !res?.resolvedAt || res.synthetic || res.shape !== "targetResult" || integrity(message) !== "ok") return;
    const read = readCard(message);
    if (read.shape !== "targetResult") return;
    const subset = {};
    for (const [key, t] of Object.entries(res.targets ?? {})) {
      if (!t || t.partId !== partId || t.dropped || selfOnly(t) || (t.gainOnly && !t.alsoTarget)) continue;
      subset[key] = foundry.utils.deepClone(t);
    }
    if (!Object.keys(subset).length) return;
    const tiers = assignCard(subset, read);
    for (const [key, t] of Object.entries(subset)) Object.assign(t, tiers[key] ?? { tier: null, partId: null, damageRollIndexes: [] });
    const item = await fromUuid(res.abilityUuid).catch(() => null);
    if (!item) return;
    const author = serverAuthor(message);
    const plan = buildPlan({
      message, item, targets: subset, forceManual: !contentVisibleToMe(message),
      playerAuthored: (author?.role ?? ROLE_ASSISTANT) < ROLE_ASSISTANT,
      sourceTokenUuid: res.sourceTokenUuid ?? null, spend: spendValues(res.spend),
      lib: resolveAbility(item), assignment: chooseAssignment(item, message), use: useState(message, item), selfKey: null,
      self: cardTier(read.parts),
    });
    const replaced = {};
    for (const op of Object.values(plan.ops)) {
      if ((op.kind !== "condition" && op.kind !== "forced") || op.lib) continue;
      const old = res.ops?.[op.opId];
      if (!old || old.lib || old.surge || EXTERNAL_REASONS.has(old.reason)) continue;
      if (old.status !== OP_STATUS.PENDING && old.status !== OP_STATUS.SKIPPED) continue;
      replaced[op.opId] = { ...op, order: old.order };
    }
    carryTriggerPotency(replaced, res.ops, subset, {});
    const update = {};
    for (const [id, op] of Object.entries(replaced)) {
      const old = res.ops[id];
      const nulls = {};
      for (const k of Object.keys(old)) if (!(k in op) && k !== "override" && k !== "requestedBy") nulls[k] = null;
      update[recordPath(`ops.${id}`)] = { ...nulls, ...op };
    }
    if (!Object.keys(update).length) return;
    update[recordPath("generation")] = (res.generation ?? 1) + 1;
    await writeRecord(message, update);
    log("potency.replan", { messageId: message.id, partId, ops: Object.keys(replaced).length });
  });
}

/** On ready: resolve recent unresolved cards when `sweepOnReady` is "auto" (banner mode is render-only). */
export async function sweepOnReady() {
  if (!isActiveGM() || !setting("enabled") || setting("sweepOnReady") !== "auto" || stripping()) return;
  const windowMs = Number(setting("sweepWindowMinutes") ?? 15) * 60_000;
  const now = Date.now();
  const pending = game.messages.contents.filter(m => {
    const res = getResolution(m);
    if (!res || res.resolvedAt || (now - (res.createdAt ?? m.timestamp ?? 0)) > windowMs) return false;
    // A card another GM holds for triggered actions is left alone until its hold ran out (deviation 3), then
    // swept again: nothing else resolves it if that GM left mid-prompt. A hold this GM wrote is dead unless its
    // action still runs here: a reload lost it.
    if (res.hold && (res.hold.by !== game.userId || heldMessages.has(m.id))) {
      const left = effectiveUntil(res, m) + 10_000 - serverNow();
      if (left > 0) {
        resweepLater(m.id, left);
        return false;
      }
    }
    return true;
  });
  log("sweep", { count: pending.length });
  for (const m of pending) await resolveMessage(m, { reason: "sweep" }).catch(err => error("sweep", err));
}

const resweeps = new Map();   // messageId -> timer: a held card swept once its hold ran out

/** Sweep one held card again once its hold ran out (it re-renders either way: the waiting banner goes). */
function resweepLater(messageId, ms) {
  if (resweeps.has(messageId)) return;
  const timer = setTimeout(() => {
    resweeps.delete(messageId);
    const m = game.messages?.get?.(messageId);
    if (!m) return;
    const res = getResolution(m);
    if (res && !res.resolvedAt && isActiveGM() && setting("enabled") && setting("sweepOnReady") === "auto") {
      if (res.hold && serverNow() < effectiveUntil(res, m) + 10_000) resweepLater(messageId, effectiveUntil(res, m) + 10_000 - serverNow());
      else resolveMessage(m, { reason: "sweep" }).catch(err => error("sweep", err));
    } else globalThis.ui?.chat?.updateMessage?.(m)?.catch?.(() => {});
  }, Math.min(Math.max(0, ms) + 250, 2_147_000_000));
  timer?.unref?.();   // Node (offline tests) only
  resweeps.set(messageId, timer);
}

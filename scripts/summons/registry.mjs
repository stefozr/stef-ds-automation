/**
 * Summon registry and end triggers (Milestone 6, docs/M6-DESIGN.md §1.5, §3.8-§3.10). The token flag
 * `flags["stef-ds-automation"].summon` is the truth: written once at creation, never updated. The Combat carries an
 * index (`flags["stef-ds-automation"].summons`, entries keyed to the summoner's TOKEN id, so a Death Tracker revival that
 * re-creates the summoner's combatant keeps them); the ability item carries `summonState` (Stamina carry, zero lock).
 *
 * - One promise chain (`withSummonChain`, as triggers/budget.mjs writeEntry) serializes index writes, dismissals,
 *   chain turns, holds and the upkeep payment. Allowed waits (§6.1): card lock -> chain; lifecycle -> chain;
 *   chain -> a NEW card's lock. Never: lifecycle or chain -> an existing card's lock, so the card annotation of a
 *   dismissal (`annotateDismissed`) is fired without awaiting it.
 * - End triggers (active GM): the summoner's turn start / end (activation-aware arms, round fallback after a GM
 *   reload), the end of the encounter (`deleteCombat`, setting `summonEncounterEnd`), the summoner dying, zero
 *   Stamina (re-checked after 2 s, CH4), manual Dismiss (relay `summonDismiss`).
 * - Token cache (`summonId -> token uuids`), kept on every client by the create / delete hooks and rebuilt from
 *   the scenes on ready; every reader re-resolves the uuids and drops missing documents, so a stale cache can never
 *   resurrect a dismissed summon. A token created without our `internal` option (copy-paste, duplicate) is not part
 *   of a summon: the GM strips its flag.
 * Our lifecycle listener is registered BEFORE registerTurnOrder (main.mjs): the lifecycle awaits listeners in
 * registration order, so the chain's turn write lands before Hesitation is Weakness looks (R§ C6).
 *
 * i18n keys used here: DSAUTO.Summon.Whisper, DSAUTO.Summon.Removal.{dismiss, undo, death, encounterEnd, expired}
 * (dynamic), DSAUTO.Summon.EncounterEnd.
 */
import { HOOKS, MODULE_ID, loc } from "../constants.mjs";
import { annotateOps } from "../engine/engine.mjs";
import { integrity } from "../engine/ledger.mjs";
import { getResolution } from "../engine/record.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { clock } from "../triggers/prompt.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { combatsWith, deletePresent, endTurnIfCurrent, removeFromCombat } from "./combat.mjs";
import { chainAfter, holdActive, holdSummons } from "./turn-chain.mjs";
import { cancelUpkeep, cancelUpkeepsOf, offerUpkeep, registerUpkeepGM } from "./upkeep.mjs";

export const REMOVAL = Object.freeze({ DISMISS: "dismiss", UNDO: "undo", DEATH: "death", ENCOUNTER_END: "encounterEnd", EXPIRED: "expired" });

const ZERO_DELAY_MS = 2_000;
// A FRESH object per write (review fix): core assigns `operation.parent` (and more) to the object it is given
// (CC/abstract/document.mjs:742, :878, :896); a frozen or shared object throws in strict mode.
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });
const dismissing = new Set();     // summonIds whose dismissal is running (the chain skips them)
const zeroPending = new Set();    // summonIds with a zero-Stamina re-check armed
const cache = new Map();          // summonId -> Set<token uuid> (every client)
let cacheBuilt = false;
let chain = Promise.resolve();
let orderSeq = 0;
let registered = false;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const summonPath = id => `flags.${MODULE_ID}.summons.${id}`;
const flagOf = doc => doc?.flags?.[MODULE_ID]?.summon ?? null;
const serverNow = () => game.time?.serverTime ?? Date.now();
const finite = v => typeof v === "number" && Number.isFinite(v);

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** A key removal in an update: ForcedDeletion (v14), else the legacy `-=` form. */
function removalUpdate(path) {
  const Op = globalThis.foundry?.data?.operators?.ForcedDeletion;
  if (Op) return { [path]: new Op() };
  const i = path.lastIndexOf(".");
  return { [`${path.slice(0, i)}.-=${path.slice(i + 1)}`]: null };
}

function isDefeatedActor(actor) {
  const statuses = actor?.statuses;
  if (!statuses?.has) return false;
  const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  return statuses.has(defeated) || statuses.has("dead");
}

/* -------------------------------------------- */
/*  Chain                                       */
/* -------------------------------------------- */

/** Serialize registry work on one promise chain (as S/triggers/budget.mjs writeEntry). Resolves with fn's value. */
export function withSummonChain(fn) {
  const run = chain.catch(() => {}).then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/** summonIds whose dismissal has started (filled before endTurnIfCurrent, cleared when it ends). The chain skips them. */
export function isDismissing(summonId) {
  return dismissing.has(summonId);
}

/* -------------------------------------------- */
/*  Token cache (every client)                  */
/* -------------------------------------------- */

function cacheAdd(token) {
  const id = flagOf(token)?.summonId;
  if (!id || !token?.uuid) return;
  if (!cache.has(id)) cache.set(id, new Set());
  cache.get(id).add(token.uuid);
}

function cacheRemove(token) {
  const id = flagOf(token)?.summonId;
  const set = id ? cache.get(id) : null;
  if (!set) return;
  set.delete(token.uuid);
  if (!set.size) cache.delete(id);
}

/** Rebuild the cache from every scene's tokens (ready, canvasReady, a new active GM). */
function cacheRebuild() {
  if (!game.scenes) return;
  cache.clear();
  for (const scene of list(game.scenes)) {
    for (const t of list(scene?.tokens)) if (flagOf(t)?.summonId) cacheAdd(t);
  }
  cacheBuilt = true;
  debug("summon.cache", { summons: cache.size });
}

function ensureCache() {
  if (!cacheBuilt) cacheRebuild();
}

/**
 * The members of a summon by a GM-written record (review fix): the combat index entry's `tokenIds` (combat flags,
 * GM-written), else the card row's `tokenUuids` (op.summonId matching) on a record whose ledger hash is "ok" (the
 * author owns the message and could rewrite it). A Set of token ids and uuids, or null when no such record exists
 * (tokens just created, the card deleted and no combat): then the token flags alone decide. The token flag is
 * writable by the token's owner, so a flag a player wrote onto their own token never makes it part of another summon.
 */
function recordedMembers(summonId, docs) {
  for (const c of list(game.combats)) {
    const e = c?.flags?.[MODULE_ID]?.summons?.[summonId];
    if (e && Array.isArray(e.tokenIds) && e.tokenIds.length) return new Set(e.tokenIds);
  }
  const seen = new Set();
  for (const d of docs) {
    const f = flagOf(d);
    const key = `${f?.messageId}:${f?.opId}`;
    if (!f?.messageId || !f?.opId || seen.has(key)) continue;
    seen.add(key);
    const message = game.messages?.get?.(f.messageId);
    const op = getResolution(message)?.ops?.[f.opId];
    if (op?.summonId !== summonId || !Array.isArray(op.tokenUuids) || !op.tokenUuids.length) continue;
    try {
      if (integrity(message) !== "ok") continue;
    } catch (_err) {
      continue;
    }
    return new Set(op.tokenUuids);
  }
  return null;
}

/** Token documents of a summon on every scene: cached uuids re-resolved, missing ones dropped (§3.8). */
export function summonTokens(summonId) {
  try {
    if (!summonId) return [];
    ensureCache();
    const set = cache.get(summonId);
    if (!set) return [];
    let out = [];
    for (const uuid of [...set]) {
      const doc = lookup(uuid);
      if (doc && flagOf(doc)?.summonId === summonId) out.push(doc);
      else set.delete(uuid);
    }
    if (!set.size) cache.delete(summonId);
    const members = out.length ? recordedMembers(summonId, out) : null;
    if (members) out = out.filter(d => members.has(d.id) || members.has(d.uuid));
    return out.sort((a, b) => (flagOf(a)?.index ?? 0) - (flagOf(b)?.index ?? 0));
  } catch (err) {
    error("summon.tokens", err, { summonId });
    return [];
  }
}

/* -------------------------------------------- */
/*  Readers (any client)                        */
/* -------------------------------------------- */

/** SummonInfo (§1.9) from a token flag and the tokens. `alive` = how many tokens' actors are not defeated. */
export function infoFrom(meta, tokens = []) {
  const docs = list(tokens);
  return {
    summonId: meta?.summonId ?? null,
    tokenUuids: docs.map(t => t.uuid),
    names: docs.map(t => t.name),
    sceneId: docs[0]?.parent?.id ?? null,
    summonerActorUuid: meta?.summonerActorUuid ?? null,
    summonerTokenUuid: meta?.summonerTokenUuid ?? null,
    itemUuid: meta?.itemUuid ?? null,
    messageId: meta?.messageId ?? null,
    opId: meta?.opId ?? null,
    lasts: [...(meta?.lasts ?? [])],
    turn: meta?.turn ?? null,
    combatId: meta?.combatId ?? null,
    createdRound: meta?.createdRound ?? null,
    worldActorId: meta?.worldActorId ?? null,
    alive: docs.filter(t => t.actor && !isDefeatedActor(t.actor)).length,
  };
}

/** Live summons from token flags. filter {summonerActorUuid?, sceneId?, combatId?, summonId?}. Any client. */
export function listSummons(filter = {}) {
  try {
    if (!game.scenes) return [];
    ensureCache();
    const f = filter ?? {};
    const ids = f.summonId ? [f.summonId] : [...cache.keys()];
    const out = [];
    for (const id of ids) {
      const tokens = summonTokens(id);
      if (!tokens.length) continue;
      const info = infoFrom(flagOf(tokens[0]), tokens);
      if (f.summonerActorUuid && info.summonerActorUuid !== f.summonerActorUuid) continue;
      if (f.sceneId && info.sceneId !== f.sceneId) continue;
      if (f.combatId !== undefined && f.combatId !== null && info.combatId !== f.combatId) continue;
      info.createdAt = flagOf(tokens[0])?.createdAt ?? 0;
      out.push(info);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt).map(({ createdAt: _c, ...info }) => info);
  } catch (err) {
    error("summon.list", err);
    return [];
  }
}

export function summonInfo(summonId) {
  const tokens = summonTokens(summonId);
  return tokens.length ? infoFrom(flagOf(tokens[0]), tokens) : null;
}

/** Index entries of a combat (§1.5), [] when none, in creation order. Any client. */
export function indexEntries(combat) {
  const index = combat?.flags?.[MODULE_ID]?.summons;
  if (!index || typeof index !== "object") return [];
  return Object.values(index).filter(e => e && typeof e === "object" && e.summonId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Live index entries of a summoner, by the summoner's token id (CH10), in creation order. */
export function summonsOf(combat, summonerTokenId) {
  if (!summonerTokenId) return [];
  return indexEntries(combat).filter(e => e.summonerTokenId === summonerTokenId);
}

/* -------------------------------------------- */
/*  Index writes (active GM, on the chain)      */
/* -------------------------------------------- */

/** The index entry of a new summon (§1.5), arms from lifecycle.currentActivation (§3.3). Pure apart from the lifecycle read. */
export function buildIndexEntry({ summonId, tokens, ins, ctx, op, actor, message }) {
  const combat = ctx?.combat ?? null;
  const sc = ctx?.combatant ?? null;
  let act = null;
  try {
    act = combat && sc ? (lifecycle.currentActivation?.(combat.id, sc.id) ?? null) : null;
  } catch (_err) {
    act = null;
  }
  const round = combat?.round ?? null;
  const counter = { open: !!act?.open, epoch: lifecycle.activationEpoch ?? null, combatantId: sc?.id ?? null };
  const docs = list(tokens);
  // Creation order: server time, ties broken by a per-client sequence.
  const order = serverNow() + ((orderSeq++ % 1000) / 1000);
  return {
    summonId,
    combatId: combat?.id ?? null,
    sceneId: docs[0]?.parent?.id ?? null,
    tokenIds: docs.map(t => t.id),
    combatantIds: [...(ins?.combatantIds ?? [])],
    groupId: ins?.groupId ?? null,
    groupCreated: !!ins?.groupCreated,
    summonerTokenId: sc?.tokenId ?? null,
    summonerCombatantId: sc?.id ?? null,
    summonerActorUuid: op?.summonerActorUuid ?? null,
    worldActorId: actor?.id ?? null,
    messageId: message?.id ?? null,
    opId: op?.opId ?? null,
    itemUuid: op?.itemUuid ?? null,
    turn: op?.turn ?? null,
    lasts: [...(op?.lasts ?? [])],
    upkeep: op?.upkeep ?? null,
    order,
    createdRound: round,
    // turnStart counts when activation > n (a later turn), turnEnd when activation >= the open one (or the next).
    // epoch + combatantId: the counter's identity (a GM reload, another active GM or a Death Tracker revival
    // restarts it at 1); `open`: the arm was made inside the summoner's running activation (see counts).
    armStart: { round, activation: act?.n ?? 0, ...counter },
    armEnd: { round, activation: act ? (act.open ? act.n : act.n + 1) : 0, ...counter },
    upkeptRound: null,
    held: !!ins?.held,
    chainedRound: op?.actsThisRound ? null : round,
  };
}

/** Active GM: add the index entry of a new summon (no-op when entry.combatId is null). On the chain. */
export async function addSummon(entry) {
  if (!isActiveGM() || !entry?.combatId || !entry.summonId) return false;
  try {
    return await withSummonChain(async () => {
      const combat = game.combats?.get?.(entry.combatId);
      if (!combat) return false;
      await combat.update({ [summonPath(entry.summonId)]: entry });
      debug("summon.index", { summonId: entry.summonId, combatId: entry.combatId });
      return true;
    });
  } catch (err) {
    error("summon.addIndex", err, { summonId: entry.summonId });
    return false;
  }
}

async function writePatch(combat, summonId, patch) {
  // Never a stale document when the world collection exists (review fix): a deleted Combat keeps its flags.
  const live = game.combats ? (game.combats.get?.(combat?.id ?? combat) ?? null) : (typeof combat === "object" ? combat : null);
  if (!live || !indexEntries(live).some(e => e.summonId === summonId)) return false;
  await live.update({ [summonPath(summonId)]: patch });
  return true;
}

/**
 * Active GM: merge `patch` into one index entry. Queued on the chain; `{onChain: true}` writes at once and is only
 * for callers already running on the chain (awaiting a queued call from inside the chain would deadlock).
 */
export async function patchIndex(combat, summonId, patch, { onChain = false } = {}) {
  if (!isActiveGM() || !summonId || !patch) return false;
  if (onChain) return writePatch(combat, summonId, patch);
  return withSummonChain(() => writePatch(combat, summonId, patch));
}

/** Drop the index entry of a summon from every combat holding it (missing keys: nothing written). On the chain. */
async function dropIndex(summonId, combatId = null) {
  const combats = combatId ? [game.combats?.get?.(combatId)].filter(Boolean) : [];
  for (const c of list(game.combats)) if (!combats.includes(c)) combats.push(c);
  for (const c of combats) {
    if (!c?.flags?.[MODULE_ID]?.summons?.[summonId]) continue;
    await c.update(removalUpdate(summonPath(summonId)));
  }
}

/* -------------------------------------------- */
/*  Item summon state                           */
/* -------------------------------------------- */

/** Item summon state (§1.5): {combatId, stamina, at, lockedAt}, or null. */
export function summonStateOf(item) {
  const s = item?.flags?.[MODULE_ID]?.summonState;
  return s && typeof s === "object" ? s : null;
}

const heroTotal = actor => (Number(actor?.system?.hero?.xp) || 0) + (Number(actor?.system?.hero?.victories) || 0);

/** Stamina a new summon of this item starts with in this combat (carryStamina), or null (full). */
export function carriedStamina(item, combatId) {
  const s = summonStateOf(item);
  return combatId && s?.combatId === combatId && finite(s.stamina) ? Math.max(1, s.stamina) : null;
}

/** Locked at 0 Stamina until the hero's XP + Victories grow (lockOnZero). */
export function isSummonLocked(item, actor) {
  const s = summonStateOf(item);
  return s?.lockedAt != null && heroTotal(actor) <= s.lockedAt;
}

export async function snapshotSummonState(item, { combatId = null, stamina = null, lockOnZero = false, actor = null } = {}) {
  if (!item?.update) return false;
  const state = { combatId: combatId ?? null, stamina: finite(stamina) ? stamina : null, at: Date.now(), lockedAt: summonStateOf(item)?.lockedAt ?? null };
  if (lockOnZero && finite(stamina) && stamina <= 0) state.lockedAt = heroTotal(actor ?? item.actor);
  await item.update({ [`flags.${MODULE_ID}.summonState`]: state });
  return true;
}

/* -------------------------------------------- */
/*  Messages                                    */
/* -------------------------------------------- */

/** Whisper every GM (ChatMessage, `whisper: game.users.filter(u => u.isGM)`, speaker none). */
export async function whisperGMs(content) {
  try {
    if (!globalThis.ChatMessage || !content) return null;
    const esc = globalThis.foundry?.utils?.escapeHTML ?? (v => String(v));
    const gms = game.users?.filter?.(u => u.isGM).map(u => u.id) ?? [];
    return await ChatMessage.implementation.create({
      content: `<p>${esc(content)}</p>`,
      whisper: gms, speaker: { alias: game.modules?.get?.(MODULE_ID)?.title ?? MODULE_ID },
    });
  } catch (err) {
    error("summon.whisper", err);
    return null;
  }
}

/** Card row annotation `{dismissed}` (fire-and-forget, own catch; function form: decided inside the card lock). */
function annotateDismissed(meta, reason, userId) {
  try {
    const message = meta?.messageId ? game.messages?.get?.(meta.messageId) : null;
    if (!message || !meta.opId) return;
    annotateOps(message, res => {
      const op = res?.ops?.[meta.opId];
      // A re-applied row (a newer summon) is left alone.
      return op?.status === "applied" && op.summonId === meta.summonId
        ? { [meta.opId]: { dismissed: { reason, at: Date.now(), by: userId ?? null } } } : {};
    }).catch(err => error("summon.annotate", err));
  } catch (err) {
    error("summon.annotate", err);
  }
}

/* -------------------------------------------- */
/*  Dismissal                                   */
/* -------------------------------------------- */

/**
 * Active GM: remove a summon (§3.9). The card annotation is never awaited (fire-and-forget, guarded by summonId);
 * `annotate: false` skips it (undo, write-failure cleanup). Never throws: a failure inside returns `{error}`.
 * @returns {Promise<{removed: number, gone: boolean, names?: string[], error?: string}>}
 */
export async function dismissSummon(summonId, reason, { annotate = true, userId = null, quiet = false, staminaTokenUuid = null } = {}) {
  if (!isActiveGM() || !summonId) return { removed: 0, gone: true };
  // Its continuation will not dismiss again (§3.11).
  if (reason !== REMOVAL.UNDO) cancelUpkeep(summonId, "dismissed");
  let result;
  try {
    result = await withSummonChain(async () => {
      const tokens = summonTokens(summonId);
      const meta0 = flagOf(tokens[0]);
      if (!tokens.length) {
        await dropIndex(summonId);
        return { removed: 0, gone: true, meta: null, tokens: [] };
      }
      dismissing.add(summonId);   // BEFORE endTurnIfCurrent: the chain skips it
      try {
        const meta = meta0;
        // 1. Stamina snapshot (carry, lock), on the ability item.
        if (meta.carryStamina || meta.lockOnZero) {
          let item = null;
          try {
            item = meta.itemUuid ? await fromUuid(meta.itemUuid) : null;
          } catch (_err) {
            item = null;
          }
          // The creature that reached 0 (zeroStamina, review fix), else the first.
          const from = (staminaTokenUuid && tokens.find(t => t.uuid === staminaTokenUuid)) || tokens[0];
          const stamina = Number(from.actor?.system?.stamina?.value);
          if (item) await snapshotSummonState(item, { combatId: meta.combatId, stamina, lockOnZero: !!meta.lockOnZero, actor: item.actor });
        }
        // 2-5. Combat, per combat holding one of our tokens (by combatant, never combat.scene): the current turn
        // first (R§ fact 19), then combatants, pools and our empty groups.
        const ids = tokens.map(t => t.id);
        for (const combat of combatsWith(ids) ?? []) {
          await endTurnIfCurrent(combat, ids);
          await removeFromCombat({ combat, tokenIds: ids });
        }
        // 6. Tokens, per scene (present ids only), with our option: core and Death Tracker find nothing to do.
        const byScene = new Map();
        for (const t of tokens) {
          const scene = t.parent;
          if (!scene) continue;
          if (!byScene.has(scene)) byScene.set(scene, []);
          byScene.get(scene).push(t.id);
        }
        for (const [scene, sceneIds] of byScene) await deletePresent(scene, "Token", sceneIds, INTERNAL());
        // 7. Index.
        await dropIndex(summonId, meta.combatId ?? null);
        return { removed: tokens.length, gone: false, meta, tokens };
      } finally {
        dismissing.delete(summonId);
      }
    });
  } catch (err) {
    error("summon.dismiss", err, { summonId });
    return { removed: 0, gone: false, error: String(err?.message ?? err) };
  }
  const names = [...new Set((result.tokens ?? []).map(t => t.name).filter(Boolean))];
  if (result.meta) {
    try {
      if (annotate && result.meta.messageId && reason !== REMOVAL.UNDO) annotateDismissed(result.meta, reason, userId);
      if (!quiet && reason !== REMOVAL.UNDO) {
        whisperGMs(loc("DSAUTO.Summon.Whisper", { names: names.join(", "), reason: loc(`DSAUTO.Summon.Removal.${reason}`) }));
      }
      Hooks.callAll(HOOKS.dismissSummon ?? "dsAuto.dismissSummon", infoFrom(result.meta, result.tokens), { reason, userId });
    } catch (err) {
      error("summon.dismissAfter", err, { summonId });
    }
    log("summon.dismiss", { summonId, reason, removed: result.removed });
  }
  return { removed: result.removed, gone: result.gone, names };
}

/* -------------------------------------------- */
/*  End triggers (active GM)                    */
/* -------------------------------------------- */

/**
 * Does a turn event count against an arm? A later round always does. Within the arm's round the activation numbers
 * decide, but only when they come from the same counter: an arm of another epoch (GM reload, another active GM) or
 * another summoner combatant (Death Tracker revival) holds a number the restarted counter cannot be compared with.
 * Then a turnEnd ('>=') counts (no turn of the arm's activation or an earlier one can end after the arm was made
 * without ending it), and a turnStart ('>') counts unless the arm was made inside the then-open activation and this
 * may be a repeat of its start (the restarted counter's first activation); a second one (activation > 1) counts.
 * Without an activation number the round decides.
 */
function counts(arm, { round, activation, combatantId = null }, op) {
  if (!arm) return true;
  if (finite(round) && finite(arm.round) && round > arm.round) return true;
  const sameCounter = arm.epoch === lifecycle.activationEpoch && (!arm.combatantId || !combatantId || arm.combatantId === combatantId);
  if (!sameCounter) {
    if (!finite(round) || !finite(arm.round) || round !== arm.round) return false;
    if (op !== ">") return true;
    return !arm.open || (finite(activation) && activation > 1);
  }
  if (!finite(activation) || !finite(arm.activation)) return false;
  return op === ">" ? activation > arm.activation : activation >= arm.activation;
}

/** The lifecycle turn listener (awaited by the lifecycle queue: never await a prompt or a card lock here). */
async function onTurn(payload) {
  try {
    const { event, combat, combatant, round, activation } = payload ?? {};
    if (!isActiveGM() || !combat || !combatant) return;
    if (event !== "turnStart" && event !== "turnEnd") return;
    const live = game.combats?.get?.(combat.id) ?? combat;
    const entries = summonsOf(live, combatant.tokenId);
    const at = { round, activation: activation ?? null, combatantId: combatant.id ?? null };
    if (event === "turnStart") {
      for (const e of entries) {
        if (!counts(e.armStart, at, ">")) continue;
        if (!(e.lasts ?? []).includes("summonerTurnStart")) continue;
        if (e.upkeep && e.upkeptRound === round) continue;   // already paid this round (a repeated turnStart)
        if (e.upkeep) {
          offerUpkeep(e, { combat: live, round });            // fire-and-forget (§3.11)
          continue;
        }
        await dismissSummon(e.summonId, REMOVAL.EXPIRED);
      }
      return;
    }
    for (const e of entries) {
      // Unanswered at turn end: let it go (Q16), dismissed HERE, before the chain (no phantom turn).
      if (cancelUpkeep(e.summonId, "turnEnd")) {
        await dismissSummon(e.summonId, REMOVAL.EXPIRED);
        continue;
      }
      if ((e.lasts ?? []).includes("summonerTurnEnd") && counts(e.armEnd, at, ">=")) await dismissSummon(e.summonId, REMOVAL.EXPIRED);
    }
    // A chained summon's own turnEnd has no entries of its own: chainAfter reads the marker.
    await chainAfter({ event, combat: live, combatant, round });
  } catch (err) {
    error("summon.turn", err, { event: payload?.event });
  }
}

/** CH9: put a held summon back to 0 when something raised it before its summoner finished (§3.7). */
function onInitiativeRaised(combat, doc, changes, options) {
  try {
    if (!isActiveGM() || !combat || !changes || !("initiative" in changes)) return;
    const mine = options?.[MODULE_ID];
    if (mine?.chain || mine?.hold) return;
    if (!((doc?.initiative ?? 0) > 0)) return;
    const flags = doc?.flags?.[MODULE_ID];
    const isGroup = doc?.documentName === "CombatantGroup" || !!flags?.summonGroup;
    const id = flags?.summonId ?? flags?.summonGroup?.summonId ?? null;
    // A group: every entry sharing it (the creator's entry may be gone while a joined summon remains).
    const held = indexEntries(combat).filter(x => (id && x.summonId === id) || (isGroup && doc.id && x.groupId === doc.id))
      .filter(x => holdActive(combat, x));
    if (!held.length) return;
    withSummonChain(() => holdSummons(game.combats?.get?.(combat.id) ?? combat, held)).catch(err => error("summon.hold", err));
  } catch (err) {
    error("summon.hold", err);
  }
}

const staminaOf = doc => Number(doc?.actor?.system?.stamina?.value);

/**
 * zeroStamina of a summon with several creatures (review fix): only the creatures at 0 go (combatants first, then the
 * tokens), the index entry keeps the others. On the chain; a summon being dismissed is left to its dismissal.
 */
async function removeZeroed(summonId, zeroed) {
  const out = await withSummonChain(async () => {
    if (dismissing.has(summonId)) return null;
    const docs = zeroed.filter(d => lookup(d.uuid));
    if (!docs.length) return null;
    const ids = docs.map(d => d.id);
    for (const combat of combatsWith(ids) ?? []) {
      await endTurnIfCurrent(combat, ids);
      await removeFromCombat({ combat, tokenIds: ids });
    }
    const byScene = new Map();
    for (const t of docs) {
      if (!t.parent) continue;
      if (!byScene.has(t.parent)) byScene.set(t.parent, []);
      byScene.get(t.parent).push(t.id);
    }
    for (const [scene, sceneIds] of byScene) await deletePresent(scene, "Token", sceneIds, INTERNAL());
    for (const c of list(game.combats)) {
      const e = c?.flags?.[MODULE_ID]?.summons?.[summonId];
      if (!e) continue;
      const live = new Set(list(c.combatants).map(x => x.id));
      await writePatch(c, summonId, {
        tokenIds: (e.tokenIds ?? []).filter(id => !ids.includes(id)),
        combatantIds: (e.combatantIds ?? []).filter(id => live.has(id)),
      });
    }
    return docs;
  });
  if (!out?.length) return;
  whisperGMs(loc("DSAUTO.Summon.Whisper", { names: [...new Set(out.map(t => t.name).filter(Boolean))].join(", "), reason: loc(`DSAUTO.Summon.Removal.${REMOVAL.DEATH}`) }));
  log("summon.zeroMember", { summonId, removed: out.length });
}

/**
 * lasts zeroStamina (CH4): 2 s after a creature's Stamina hit 0, if still at 0 and present: the summon is dismissed
 * when none of its creatures has Stamina left, else only the creatures at 0 go (review fix).
 */
function checkZero(actor) {
  try {
    if (!isActiveGM() || !actor) return;
    const tok = actor.token ?? null;   // the synthetic actor of an unlinked summon
    const flag = flagOf(tok);
    if (!flag?.summonId || !(flag.lasts ?? []).includes("zeroStamina")) return;
    const isMember = doc => summonTokens(flag.summonId).some(t => t.uuid === doc?.uuid);
    if (!isMember(tok)) return;   // a flag written onto a token that is not one of the summon's (review fix)
    const value = Number(actor.system?.stamina?.value);
    if (!Number.isFinite(value) || value > 0) return;
    if (zeroPending.has(flag.summonId)) return;
    zeroPending.add(flag.summonId);
    const tokenUuid = tok.uuid;
    clock.setTimeout(() => {
      zeroPending.delete(flag.summonId);   // always cleared: a later drop re-arms it
      try {
        const doc = lookup(tokenUuid);
        const now = Number(doc?.actor?.system?.stamina?.value);
        if (!doc || flagOf(doc)?.summonId !== flag.summonId || !isMember(doc) || !Number.isFinite(now) || now > 0) return;
        const members = summonTokens(flag.summonId);
        const zeroed = members.filter(t => Number.isFinite(staminaOf(t)) && staminaOf(t) <= 0);
        if (members.length > 1 && zeroed.length < members.length) {
          removeZeroed(flag.summonId, zeroed).catch(err => error("summon.zero", err));
          return;
        }
        dismissSummon(flag.summonId, REMOVAL.DEATH, { staminaTokenUuid: tokenUuid }).catch(err => error("summon.zero", err));
      } catch (err) {
        error("summon.zero", err);
      }
    }, ZERO_DELAY_MS);
  } catch (err) {
    error("summon.zero", err);
  }
}

/** lasts summonerDying: the summoner is dying or dead. */
function checkSummonerDown(actor) {
  try {
    if (!isActiveGM() || !actor?.uuid || !actor.statuses?.has) return;
    if (!actor.statuses.has("dying") && !actor.statuses.has("dead")) return;
    ensureCache();
    if (!cache.size) return;
    for (const info of listSummons({ summonerActorUuid: actor.uuid })) {
      if (!info.lasts.includes("summonerDying") || isDismissing(info.summonId)) continue;
      dismissSummon(info.summonId, REMOVAL.EXPIRED).catch(err => error("summon.summonerDown", err));
    }
  } catch (err) {
    error("summon.summonerDown", err);
  }
}

function onTokenCreated(token, options) {
  try {
    const flag = flagOf(token);
    if (!flag?.summonId) return;
    if (!options?.[MODULE_ID]?.internal) {
      // A copy-paste, duplicate or scene copy: not part of the summon (never cached, never deleted with it).
      if (isActiveGM()) token.update(removalUpdate(`flags.${MODULE_ID}.summon`)).catch(err => error("summon.stripCopy", err));
      return;
    }
    cacheAdd(token);
  } catch (err) {
    error("summon.tokenCreated", err);
  }
}

function onTokenGone(token, options) {
  try {
    const flag = flagOf(token);
    if (!flag?.summonId) return;
    cacheRemove(token);   // FIRST, on every client, internal or not
    if (!isActiveGM() || options?.[MODULE_ID]?.internal) return;   // our own deletions: dismissSummon does the rest
    if (summonTokens(flag.summonId).length) return;
    // Someone else deleted the last one.
    withSummonChain(() => dropIndex(flag.summonId, flag.combatId ?? null)).catch(err => error("summon.tokenGone", err));
    annotateDismissed(flag, REMOVAL.DISMISS, null);
    log("summon.gone", { summonId: flag.summonId });
  } catch (err) {
    error("summon.tokenGone", err);
  }
}

/**
 * Review fix: the summon flag is written by the GM at creation only. A token's owner may update its flags (core gates
 * only token create and delete), so a non-GM write of `flags.stef-ds-automation.summon` is stripped again by the active GM
 * (and never cached). True when it stripped.
 */
function onSummonFlagWritten(token, changes, options, userId) {
  const written = changes?.flags?.[MODULE_ID];
  if (!written || typeof written !== "object" || !("summon" in written)) return false;
  if (options?.[MODULE_ID]?.internal) return false;
  const user = game.users?.get?.(userId);
  if (!user || user.isGM) return false;
  cacheRemove(token);
  if (!isActiveGM() || !flagOf(token)) return true;
  log("summon.flagStripped", { token: token?.name, userId });
  token.update(removalUpdate(`flags.${MODULE_ID}.summon`), INTERNAL()).catch(err => error("summon.stripFlag", err));
  return true;
}

/** A duplicated scene's tokens carry summon flags of the original: strip them (they are not part of a summon). */
function onSceneCreated(scene) {
  try {
    if (!isActiveGM()) return;
    const copies = list(scene?.tokens).filter(t => flagOf(t)?.summonId);
    if (!copies.length) return;
    scene.updateEmbeddedDocuments("Token", copies.map(t => ({ _id: t.id, ...removalUpdate(`flags.${MODULE_ID}.summon`) })), INTERNAL())
      .catch(err => error("summon.stripScene", err));
  } catch (err) {
    error("summon.stripScene", err);
  }
}

/** End of the encounter (§3.10): a STARTED combat was deleted. */
async function onEncounterEnd(combat) {
  try {
    if (!isActiveGM() || !combat) return;
    if (!(combat.started || (combat.round ?? 0) > 0)) return;   // an encounter that never started removes nothing
    const policy = setting("summonEncounterEnd") ?? "listed";
    if (policy === "none") return;
    const sceneIds = new Set(list(combat.combatants).map(c => c?.sceneId).filter(Boolean));
    if (combat.scene?.id) sceneIds.add(combat.scene.id);
    const index = combat.flags?.[MODULE_ID]?.summons ?? {};
    const picked = [];
    for (const info of listSummons()) {
      const inThis = info.combatId === combat.id || !!index[info.summonId];
      const sameSceneNoCombat = info.combatId == null && sceneIds.has(info.sceneId);   // CH7
      const listed = info.lasts.includes("encounterEnd");
      if ((policy === "listed" && listed && (inThis || sameSceneNoCombat)) || (policy === "all" && (inThis || (listed && sameSceneNoCombat)))) {
        picked.push(info);
      }
    }
    if (!picked.length) return;
    // Core's "combatEnd" effect refresh is still writing expired effects on these tokens: let it land first (T88).
    await lifecycle.combatEndSettled(combat.id);
    const names = [];
    const items = new Set();
    for (const info of picked) {
      const carry = flagOf(summonTokens(info.summonId)[0])?.carryStamina;
      const r = await dismissSummon(info.summonId, REMOVAL.ENCOUNTER_END, { quiet: true });
      if (r.removed) names.push(...(r.names ?? info.names));
      if (carry && info.itemUuid) items.add(info.itemUuid);
    }
    // A new encounter starts at full Stamina; the lock stays.
    for (const uuid of items) {
      try {
        const item = await fromUuid(uuid);
        const s = summonStateOf(item);
        if (item && s && s.stamina != null) await item.update({ [`flags.${MODULE_ID}.summonState.stamina`]: null });
      } catch (err) {
        error("summon.encounterEndState", err);
      }
    }
    if (names.length) await whisperGMs(loc("DSAUTO.Summon.EncounterEnd", { names: [...new Set(names)].join(", ") }));
    log("summon.encounterEnd", { combatId: combat.id, removed: names.length, policy });
  } catch (err) {
    error("summon.encounterEnd", err);
  }
}

/** init (main.mjs, BEFORE registerTurnOrder): the lifecycle turn listener and the hooks of §3.8-3.10. */
export function registerSummons() {
  if (registered) return;
  registered = true;
  lifecycle.onTurnEvent(onTurn);
  registerUpkeepGM();
  Hooks.on("deleteCombat", combat => {
    try {
      // Review fix: an upkeep prompt of this combat never charges after it (also with policy "none").
      if (isActiveGM()) cancelUpkeepsOf(combat?.id);
    } catch (err) {
      error("summon.encounterEnd", err);
    }
    onEncounterEnd(combat).catch(err => error("summon.encounterEnd", err));
  });
  Hooks.on("updateActor", actor => {
    checkZero(actor);
    checkSummonerDown(actor);
  });
  // An unlinked summon's Stamina lives in its token's delta.
  Hooks.on("updateToken", (token, changes, options, userId) => {
    try {
      if (onSummonFlagWritten(token, changes, options, userId)) return;
      if (changes?.delta && flagOf(token)) checkZero(token.actor);
    } catch (err) {
      error("summon.updateToken", err);
    }
  });
  Hooks.on("createActiveEffect", effect => {
    try {
      const actor = effect?.parent?.documentName === "Actor" ? effect.parent : (effect?.parent?.parent ?? null);
      if (actor?.documentName !== "Actor") return;
      checkSummonerDown(actor);
      checkZero(actor);
    } catch (err) {
      error("summon.effect", err);
    }
  });
  Hooks.on("createToken", (token, options) => onTokenCreated(token, options));
  Hooks.on("deleteToken", (token, options) => onTokenGone(token, options));
  Hooks.on("createScene", scene => onSceneCreated(scene));
  Hooks.on("updateCombatant", (c, changes, options) => onInitiativeRaised(c?.parent ?? c?.combat, c, changes, options));
  Hooks.on("updateCombatantGroup", (g, changes, options) => onInitiativeRaised(g?.parent ?? g?.combat, g, changes, options));
  const rebuild = () => {
    try {
      cacheRebuild();
    } catch (err) {
      error("summon.cache", err);
    }
  };
  Hooks.on("ready", rebuild);
  Hooks.on("canvasReady", rebuild);
  Hooks.on("userConnected", () => {
    if (isActiveGM()) rebuild();
  });
}

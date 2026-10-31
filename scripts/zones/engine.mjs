/**
 * Milestone 7 (docs/M7-DESIGN.md §2.1 WP-B, §3.10.4-§3.10.8, §6.2-§6.3): zone hits on the active GM.
 *
 * - Movement (`onZoneMovement`, from the behavior's static tokenMoveIn / tokenMoveWithin / tokenMoveOut handlers):
 *   squares in the area are tallied per (zone, token) for the whole movement: a ruler drag's continued segments
 *   (pending waypoints until the last one), a Combat Tools push (one complete one-square movement per update, joined
 *   while the updates keep coming within 1.2 s), a 6 s cap for a stalled movement. The credit is claimed when the
 *   tally opens (synchronously), the hit is posted when it flushes; a zone ended meanwhile releases it (C16).
 *   A move that started inside is not an entry; `tokenEnter` (also fired with `movement: null` when a region is
 *   created over a creature or moved onto it) is never subscribed: placing an area on creatures hurts nobody until
 *   they move or start a turn (Q7).
 * - Turn start / end (`onZoneTurn`, a lifecycle listener registered after registerOngoing): one event per activation
 *   and per squad member (S/turn/lifecycle.mjs), never the region's own turn events (Combat Tools doubles them, CH11).
 *   `busy` (the creature's Stamina chain, a trigger that may hold the damage, a hero-token prompt that may open) is
 *   read BEFORE enqueueing (C14): then the hit runs detached and never stalls the lifecycle queue.
 * - One hit (`hitZone`): a synthetic damage card (`createDamageCard`, meta `zone`) on the creature's ongoing-damage
 *   Stamina chain (`enqueueStamina`, WP-E), so immunities, squads (area cap with `aoe`), Death Tracker, the M5 pre-pass,
 *   hero tokens and gains all apply. Behavior values are trusted because only GMs can change them (OBSERVER for the
 *   creator's owners).
 * - Undo / re-apply of a zone card's damage (`registerZoneEngine`): undo releases that creature's credit while the
 *   entry is still that card's; a re-apply writes it back only when it is free (fire-and-forget; these listeners
 *   run inside the card lock).
 *
 * i18n keys used here: DSAUTO.Zone.HitFlavor, DSAUTO.Zone.HitFlavorOne.
 */
import * as constants from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { createDamageCard } from "../engine/synthetic.mjs";
import { monsterKeys } from "../library/identity.mjs";
import { debug, error, log } from "../log.mjs";
import * as heroTokens from "../resources/hero-tokens.mjs";
import { setting } from "../settings.mjs";
import { typeOverride, withTypeOverride } from "../engine/actor-category.mjs";
import { combatFor } from "../triggers/budget.mjs";
import { notCreature } from "../triggers/eligibility.mjs";
import { mayHoldDamage } from "../triggers/engine.mjs";
import { clock } from "../triggers/prompt.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import * as ongoing from "../turn/ongoing.mjs";
import { claimZoneHit, creditKey, releaseClaim, releaseZoneHit, writeZoneHit } from "./ledger.mjs";
import { list, zoneBehavior, zoneFlag, zoneOf } from "./registry.mjs";
import { footprintSquares, pathSquares } from "./shapes.mjs";

const { loc } = constants;

const FORCED_IDLE_MS = 1_200;
const SEGMENT_WAIT_MS = 4_000;
const TALLY_CAP_MS = 6_000;
const HOOK_PRE = () => constants.HOOKS?.preZoneHit ?? "dsAuto.preZoneHit";
const HOOK_HIT = () => constants.HOOKS?.zoneHit ?? "dsAuto.zoneHit";
const MODES = new Set(["auto", "prompt", "manual"]);

/** `${zoneId}:${tokenUuid}` -> {zoneId, regionUuid, tokenUuid, actorUuid, via, creditKey, claim, squares, movementIds, forced, firstAt, timer, cap, combatId} */
const tallies = new Map();
let registered = false;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/** The polarity of a token disposition: 1 friendly, -1 hostile / secret, 0 neutral or unknown. */
function polarity(disposition) {
  const d = Number(disposition);
  if (!Number.isFinite(d) || d === 0) return 0;
  return d > 0 ? 1 : -1;
}

function isDead(actor) {
  const st = actor?.statuses;
  if (!st?.has) return false;
  const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  return st.has(defeated) || st.has("dead");
}

function keywordsOf(actor) {
  const k = actor?.system?.monster?.keywords;
  if (!k) return [];
  if (typeof k === "string") return [k];
  try {
    return [...k].map(v => String(v).toLowerCase());
  } catch (_err) {
    return [];
  }
}

/**
 * §3.10.6: is this creature hit by the zone? Not the creator; a creature (no object), not dead; `affects` against the
 * creator token's disposition (enemies: opposite polarity, allies: the same, all); no `exceptKeywords` keyword; no
 * `exceptMonsters` key.
 */
export function affected(system, region, tokenDoc) {
  try {
    const actor = tokenDoc?.actor;
    if (!system || !actor) return false;
    const flag = zoneFlag(region);
    if (flag?.creatorTokenId && tokenDoc.id === flag.creatorTokenId) return false;
    if (flag?.creatorActorUuid && actor.uuid === flag.creatorActorUuid) return false;
    if (system.sourceActorUuid && actor.uuid === system.sourceActorUuid) return false;
    if (notCreature(actor) || isDead(actor)) return false;
    const affects = system.affects ?? "enemies";
    if (affects !== "all") {
      const creatorDoc = lookup(flag?.creatorTokenUuid) ?? region?.parent?.tokens?.get?.(flag?.creatorTokenId) ?? null;
      const creatorActor = creatorDoc?.actor ?? lookup(flag?.creatorActorUuid ?? system.sourceActorUuid);
      const a = polarity(creatorDoc?.disposition ?? creatorActor?.prototypeToken?.disposition);
      const b = polarity(tokenDoc.disposition);
      if (!a || !b) return false;
      if (affects === "enemies" && a === b) return false;
      if (affects === "allies" && a !== b) return false;
    }
    const except = new Set([...(system.exceptKeywords ?? [])].map(k => String(k).toLowerCase()));
    if (except.size && keywordsOf(actor).some(k => except.has(k))) return false;
    const monsters = new Set([...(system.exceptMonsters ?? [])].map(String));
    if (monsters.size && monsterKeys(actor).some(k => monsters.has(k))) return false;
    return true;
  } catch (err) {
    error("zones.affected", err);
    return false;
  }
}

/* -------------------------------------------- */
/*  Movement tallies                            */
/* -------------------------------------------- */

/**
 * Region movement events (the behavior's static handlers call it on the active GM). Never throws.
 * @param {object} system       the behavior's system (TypeDataModel instance)
 * @param {object} event        RegionEvent {name, data: {token, movement}, region, user}
 */
export function onZoneMovement(system, event) {
  try {
    if (!isActiveGM()) return;
    const behavior = system?.parent ?? null;
    const region = behavior?.region ?? system?.region ?? event?.region ?? null;
    if (!region || behavior?.disabled) return;
    if (!(Number(system?.amount) > 0)) return;   // Milestone 9 (D-B6): a terrain-only zone never tallies
    if (!zoneOf(region, system)) return;
    const token = event?.data?.token;
    const movement = event?.data?.movement;
    if (!token?.actor || !movement) return;
    const actions = [...(movement.passed?.waypoints ?? [])].map(w => w?.action);
    const forced = actions.some(a => a === "forced" || a === "displace");
    if (!system.forcedCounts && forced) return;
    if (!affected(system, region, token)) return;
    const combat = combatFor(region.parent?.id ?? null);
    if (!combat?.started) return;   // zones hit in combat only (the rules count in rounds)
    const triggers = system.triggers ?? new Set();
    const has = e => (typeof triggers.has === "function" ? triggers.has(e) : [...triggers].includes(e));
    const key = `${system.zoneId}:${token.uuid}`;
    let t = tallies.get(key);
    if (!t) {
      const move = has("move");
      const enter = has("enter");
      if (!move && !(enter && event.name === "tokenMoveIn")) return;   // a move that started inside is not an entry
      const via = move ? "move" : "enter";
      const ck = creditKey(system, via);
      const claim = claimZoneHit(combat, system.zoneId, token.actor.uuid, ck);
      if (!claim) {
        debug("zones.move", { zoneId: system.zoneId, token: token.name, why: "creditTaken" });
        return;
      }
      t = {
        zoneId: system.zoneId, regionUuid: region.uuid, tokenUuid: token.uuid, actorUuid: token.actor.uuid, via, creditKey: ck,
        claim, squares: new Set(), movementIds: new Set(), forced, firstAt: Date.now(), timer: null, cap: null, combatId: combat.id,
      };
      t.cap = clock.setTimeout(() => flush(key), TALLY_CAP_MS);
      tallies.set(key, t);
    }
    if (movement.id) t.movementIds.add(movement.id);
    t.forced ||= forced;
    for (const sq of pathSquares(token, region, movement)) t.squares.add(sq);
    const done = event.name === "tokenMoveOut" || !(movement.pending?.waypoints?.length);
    if (t.timer) clock.clearTimeout(t.timer);
    t.timer = clock.setTimeout(() => flush(key), t.forced ? FORCED_IDLE_MS : (done ? 0 : SEGMENT_WAIT_MS));
    debug("zones.move", {
      zoneId: system.zoneId, token: token.name, event: event.name, movementId: movement.id, squares: t.squares.size, forced: t.forced, done,
      pending: movement.pending?.waypoints?.length ?? 0,
    });
  } catch (err) {
    error("zones.move", err);
  }
}

/** Close a tally: post its hit, or release its claim when the zone is gone or nothing was covered. */
function flush(key) {
  try {
    const t = tallies.get(key);
    if (!t) return;
    tallies.delete(key);
    clock.clearTimeout(t.timer);
    clock.clearTimeout(t.cap);
    const region = lookup(t.regionUuid);
    const behavior = region ? zoneBehavior(region) : null;
    const tokenDoc = lookup(t.tokenUuid);
    if (!region || !behavior || behavior.disabled || !zoneOf(region, behavior.system) || !t.squares.size || !tokenDoc?.actor) {
      releaseClaim(t.claim);
      debug("zones.flush", { zoneId: t.zoneId, why: t.squares.size ? "gone" : "noSquares" });
      return;
    }
    hitZone(region, tokenDoc, { via: t.via, squares: t.squares.size, creditKey: t.creditKey, claim: t.claim })
      .catch(err => error("zones.hit", err));
  } catch (err) {
    error("zones.flush", err);
  }
}

/** Drop the open tallies of a zone and release their claims (endZone, deleteRegion). */
export function dropTallies(zoneId) {
  for (const [key, t] of [...tallies]) {
    if (zoneId && t.zoneId !== zoneId) continue;
    tallies.delete(key);
    clock.clearTimeout(t.timer);
    clock.clearTimeout(t.cap);
    releaseClaim(t.claim);
  }
}

/** Open tallies (selfCheck, harness). */
export function openTallies() {
  return [...tallies.values()].map(t => ({ zoneId: t.zoneId, tokenUuid: t.tokenUuid, via: t.via, squares: t.squares.size, forced: t.forced }));
}

/* -------------------------------------------- */
/*  Turn start / end                            */
/* -------------------------------------------- */

const triggerHas = (system, e) => {
  const t = system?.triggers;
  if (!t) return false;
  return typeof t.has === "function" ? t.has(e) : [...t].includes(e);
};

/** Is the token inside the region (core's test, else its footprint)? Milestone 9: also engine/side-targets.mjs. */
export function insideRegion(tokenDoc, region) {
  try {
    if (typeof tokenDoc.testInsideRegion === "function") return !!tokenDoc.testInsideRegion(region);
  } catch (_err) {
    // another scene or a mock: fall back to the footprint
  }
  return footprintSquares(tokenDoc, region).size > 0;
}

/** Lifecycle turn listener: turnStart / turnEnd hits for the combatant's token (squad members included). */
export async function onZoneTurn(payload) {
  try {
    const { event, combat, combatant, activation } = payload ?? {};
    if (!isActiveGM() || (event !== "turnStart" && event !== "turnEnd")) return;
    const tokenDoc = combatant?.token ?? null;
    const scene = tokenDoc?.parent;
    const actor = tokenDoc?.actor ?? payload?.actor ?? null;
    if (!scene || !actor || !combat) return;
    const regions = list(scene.regions).filter(r => zoneFlag(r));
    if (!regions.length) return;
    const uuid = tokenDoc.uuid;
    // BEFORE enqueueing (C14): a busy chain or a possible hold/prompt detaches the hit.
    let busy = false;
    try {
      busy = !!(ongoing.staminaBusy?.(uuid)) || !!mayHoldDamage([uuid]) || !!(heroTokens.mayHoldHeroToken?.([uuid]));
    } catch (_err) {
      busy = true;
    }
    const runs = [];
    for (const region of regions) {
      const behavior = zoneBehavior(region);
      if (!behavior || behavior.disabled) continue;
      const system = behavior.system;
      if (!(Number(system?.amount) > 0)) continue;   // Milestone 9 (D-B6): terrain-only, no credit claimed
      if (!triggerHas(system, event)) continue;
      if (!zoneOf(region, system)) continue;
      if (!insideRegion(tokenDoc, region) || !affected(system, region, tokenDoc)) continue;
      const ck = creditKey(system, event, activation);
      const claim = claimZoneHit(combat, system.zoneId, actor.uuid, ck);
      if (!claim) continue;
      const squares = system.perSquare ? Math.max(1, footprintSquares(tokenDoc, region).size) : 1;
      runs.push(hitZone(region, tokenDoc, { via: event, squares, creditKey: ck, claim, combat }));
    }
    if (!runs.length) return;
    const all = Promise.all(runs);
    if (busy) all.catch(err => error("zones.turnHit", err));
    else await all;
  } catch (err) {
    error("zones.turn", err, { event: payload?.event });
  }
}

/* -------------------------------------------- */
/*  One hit                                     */
/* -------------------------------------------- */

const validType = type => {
  if (!type || typeof type !== "string") return "";
  try {
    const types = globalThis.ds?.CONFIG?.damageTypes;
    if (types && !(type in types)) return "";
  } catch (_err) { /* no system config */ }
  return type;
};

/**
 * One hit on the creature's Stamina chain (§3.10.7). `claim` null: the credit is claimed here unless `force`
 * (api.zones.hit); a claim token: the caller claimed already (it is released here whatever happens). Never rejects.
 * @param {RegionDocument} region
 * @param {TokenDocument} tokenDoc
 * @param {object} options
 * @param {string} options.via               "enter" | "move" | "turnStart" | "turnEnd" | "manual"
 * @param {number} options.squares
 * @param {string|null} [options.creditKey]
 * @param {object|null} [options.claim]
 * @param {boolean} [options.force]
 * @param {Combat|null} [options.combat]     internal: the turn's combat (default combatFor(scene))
 * @returns {Promise<{messageId: string, ops: object}|null>}
 */
export function hitZone(region, tokenDoc, { via, squares = 1, creditKey: ck = null, claim = null, force = false, combat = null } = {}) {
  let held = claim;
  try {
    if (!isActiveGM()) {
      releaseClaim(held);
      return Promise.resolve(null);
    }
    const behavior = zoneBehavior(region);
    const system = behavior?.system;
    const zone = zoneOf(region, system);
    const actor = tokenDoc?.actor;
    if (!zone || !system || !actor) {
      releaseClaim(held);
      return Promise.resolve(null);
    }
    const fight = combat ?? combatFor(region.parent?.id ?? null);
    if (held === null && !force && ck) {
      held = claimZoneHit(fight, zone.zoneId, actor.uuid, ck);
      if (!held) return Promise.resolve(null);
    }
    const n = Math.max(1, Math.floor(Number(squares) || 1));
    const amount = Math.max(0, Math.floor((Number(system.amount) || 0) * (system.perSquare ? n : 1)));
    // Milestone 8 (§4.3): the creature's type mode replaces auto / prompt / manual; off stays off.
    const mode = withTypeOverride(setting("zoneDamage") ?? "auto", typeOverride(actor, tokenDoc.uuid));
    if (amount <= 0 || mode === "off") {
      releaseClaim(held);
      return Promise.resolve(null);
    }
    const info = { zoneId: zone.zoneId, via, squares: n, amount };
    if (Hooks.call(HOOK_PRE(), region, tokenDoc, info) === false) {
      releaseClaim(held);
      return Promise.resolve(null);
    }
    const round = fight?.started ? fight.round : null;
    const meta = {
      zone: {
        v: 1, zoneId: zone.zoneId, regionUuid: region.uuid, combatId: fight?.id ?? null, round, via, creditKey: ck, squares: n,
        actorUuid: actor.uuid, tokenUuid: tokenDoc.uuid,
      },
    };
    const label = String(system.label || zone.label || region.name || "").slice(0, 120);
    const run = () => createDamageCard({
      targets: [tokenDoc.uuid], amount, type: validType(system.damageType), ignoredImmunities: [...(system.ignoredImmunities ?? [])].slice(0, 20),
      source: system.sourceActorUuid || zone.creatorActorUuid || null, aoe: !!system.aoe, mode: MODES.has(mode) ? mode : "auto",
      flavor: loc(n === 1 ? "DSAUTO.Zone.HitFlavorOne" : "DSAUTO.Zone.HitFlavor", { label, squares: n }).slice(0, 200),
    }, game.user, { meta });
    let started;
    try {
      started = ongoing.enqueueStamina?.(tokenDoc.uuid, run) ?? run();
    } catch (err) {
      started = Promise.reject(err);
    }
    return Promise.resolve(started)
      .then(async r => {
        try {
          if (ck && fight?.started && r?.messageId) {
            await writeZoneHit(fight, zone.zoneId, actor.uuid, ck, { at: Date.now(), messageId: r.messageId, via }, { round });
          }
          Hooks.callAll(HOOK_HIT(), region, tokenDoc, { ...info, messageId: r?.messageId ?? null });
        } catch (err) {
          error("zones.hitAfter", err);
        }
        log("zones.hit", { zoneId: zone.zoneId, token: tokenDoc.name, via, squares: n, amount, messageId: r?.messageId ?? null });
        return r ?? null;
      })
      .catch(err => {
        error("zones.hit", err, { zoneId: zone.zoneId });
        return null;
      })
      .finally(() => releaseClaim(held));
  } catch (err) {
    releaseClaim(held);
    error("zones.hit", err);
    return Promise.resolve(null);
  }
}

/* -------------------------------------------- */
/*  Undo / re-apply of zone cards               */
/* -------------------------------------------- */

function zoneCardOp(message, op, patch, status) {
  if (!isActiveGM() || !message) return null;
  if (op?.kind !== "damage" || patch?.status !== status) return null;
  const zone = getResolution(message)?.zone;
  if (!zone?.zoneId || !zone.creditKey || !zone.actorUuid || !zone.combatId) return null;
  return zone;
}

/** init (main.mjs, after registerZones): the lifecycle hit listener and the applyOp / undoOp listeners (§3.10.8). */
export function registerZoneEngine() {
  if (registered) return;
  registered = true;
  try {
    lifecycle.onTurnEvent?.(onZoneTurn);
    Hooks.on(constants.HOOKS?.undoOp ?? "dsAuto.undoOp", (message, op, patch) => {
      try {
        const zone = zoneCardOp(message, op, patch, "undone");
        if (!zone) return;
        releaseZoneHit(zone.combatId, zone.zoneId, zone.actorUuid, zone.creditKey, { messageId: message.id })
          .catch(err => error("zones.undoHit", err));
      } catch (err) {
        error("zones.undoHit", err);
      }
    });
    Hooks.on(constants.HOOKS?.applyOp ?? "dsAuto.applyOp", (message, op, patch) => {
      try {
        const zone = zoneCardOp(message, op, patch, "applied");
        if (!zone) return;
        writeZoneHit(zone.combatId, zone.zoneId, zone.actorUuid, zone.creditKey, { at: Date.now(), messageId: message.id, via: zone.via },
          { round: zone.round ?? null, ifFree: true }).catch(err => error("zones.reapplyHit", err));
      } catch (err) {
        error("zones.reapplyHit", err);
      }
    });
    Hooks.on("deleteCombat", combat => {
      try {
        for (const [key, t] of [...tallies]) {
          if (t.combatId !== combat?.id) continue;
          tallies.delete(key);
          clock.clearTimeout(t.timer);
          clock.clearTimeout(t.cap);
          releaseClaim(t.claim);
        }
      } catch (err) {
        error("zones.deleteCombat", err);
      }
    });
  } catch (err) {
    error("zones.registerEngine", err);
  }
}


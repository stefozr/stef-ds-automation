/**
 * Synthetic resolution cards: `api.applyDamage(...)` posts a chat card that carries only our part and a
 * GM-signed record whose ops hold their own amounts (no ability, no rolls). The ops are applied and
 * undone exactly like ability ops (squad pools, immunities, temporary Stamina, Death Tracker
 * attribution and revival), so later milestones (ongoing damage, triggered damage, zones) reuse it.
 * Milestone 3: `api.forcedMovement(...)` and `api.teleport(...)` post movement cards the same way.
 * Milestone 5: `postRecordCard` also posts the trigger cards (`shape: "trigger"`, with warnings and a
 * `trigger` record field). `applyAsync` (resolve before the ops applied) is kept for callers; ongoing ticks no
 * longer use it: they run on a per-creature chain off the lifecycle queue (turn/ongoing.mjs).
 * Milestone 6: `api.summon(...)` posts a summon card (one row on the summoner's own record, `synthetic: true`, so the
 * summoner's owners cannot place it: docs/M6-DESIGN.md D10) and applies it with the Director's squares or the
 * nearest free ones.
 * Milestone 8: `createNativeSummonCard` posts the card of a native 1.2 summon (the system's Summon button, relayed by
 * summons/native.mjs): one own summon row of the summoner (not synthetic: the summoner's owners may undo and dismiss
 * it like an ability card's summon row) applied at once with the clicking user's squares.
 * i18n keys (Milestone 8): DSAUTO.Card.Synthetic.nativeSummon, DSAUTO.Summon.NativeCostNote.
 * Active GM only; other clients reach it through the relay (actions "damage" and "move", Directors only).
 */
import { MODULE_ID, OP_STATUS, RECORD_VERSION, loc } from "../constants.mjs";
import { forcedDelegate, stabilityOf } from "../delegation/forced-movement.mjs";
import { TELEPORT_MODES } from "../delegation/teleport.mjs";
import { FORCED_MOVEMENTS } from "./native.mjs";
import {
  MAX_SUMMON_ACTORS, MAX_SUMMON_QUANTITY, SUMMON_LASTS, SUMMON_ORIGINS, SUMMON_SIDES, SUMMON_SQUADS, SUMMON_TURNS, summonActorUuid,
} from "../library/schema.mjs";
import { prepareSummonOps, summonSourceUuid } from "../summons/actors.mjs";
import { error, log } from "../log.mjs";
import { applyOps, isActiveGM } from "./engine.mjs";
import { opId } from "./keys.mjs";
import { sign } from "./ledger.mjs";
import { squadOf } from "./plan.mjs";
import { partSource } from "./record.mjs";
import { targetFromTokenDoc, targetsFromTokenUuids } from "./targets.mjs";
import { PART_ID } from "../constants.mjs";

export const SYNTHETIC_KINDS = Object.freeze(["damage", "heal", "temp"]);
const MODES = new Set(["auto", "prompt", "manual"]);

/** Token uuids from uuids, Token placeables or TokenDocuments. */
export function tokenUuidsOf(targets) {
  const list = targets == null ? [] : (Array.isArray(targets) || targets instanceof Set ? [...targets] : [targets]);
  return list.map(t => (typeof t === "string" ? t : (t?.document?.uuid ?? t?.uuid ?? null))).filter(Boolean);
}

function actorUuidOf(source) {
  if (!source) return null;
  if (typeof source === "string") return source;
  return source.actor?.uuid ?? source.uuid ?? null; // token placeable or document, or actor
}

/**
 * Validate and normalize the options of `api.applyDamage`. Throws `DSAUTO.Relay.BadRequest`.
 * @returns {object}
 */
export function normalizeDamageRequest(opts = {}) {
  const bad = () => new Error("DSAUTO.Relay.BadRequest");
  const tokenUuids = tokenUuidsOf(opts.targets);
  if (!tokenUuids.length || tokenUuids.length > 100 || !tokenUuids.every(u => typeof u === "string" && u.length < 300)) throw bad();
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000) throw bad();
  const kind = opts.kind ?? "damage";
  if (!SYNTHETIC_KINDS.includes(kind)) throw bad();
  const type = opts.type ?? "";
  if (typeof type !== "string" || (type && !(type in (ds.CONFIG.damageTypes ?? {})))) throw bad();
  const ignoredImmunities = opts.ignoredImmunities ?? [];
  if (!Array.isArray(ignoredImmunities) || ignoredImmunities.length > 20 || !ignoredImmunities.every(t => typeof t === "string" && t.length < 50)) throw bad();
  const flavor = opts.flavor ?? "";
  if (typeof flavor !== "string" || flavor.length > 200) throw bad();
  const mode = opts.mode ?? (opts.apply === false ? "manual" : "auto");
  if (!MODES.has(mode)) throw bad();
  const source = actorUuidOf(opts.source);
  if (source != null && (typeof source !== "string" || source.length > 300)) throw bad();
  return {
    tokenUuids, amount: Math.floor(amount), kind, type: kind === "damage" ? type : "", ignoredImmunities,
    aoe: !!opts.aoe, half: kind === "damage" && !!opts.half, flavor, mode, source,
  };
}

/** Ops for the targets: one per target, one per minion squad (pool, area cap and immunities once). */
function buildOps(targets, req) {
  const ops = {};
  let order = 0;
  const base = {
    kind: req.kind, mode: req.mode, status: OP_STATUS.PENDING, synthetic: true, rawAmount: req.amount,
    amount: req.half ? Math.floor(req.amount / 2) : req.amount, half: req.half, type: req.type,
    ignoredImmunities: [...req.ignoredImmunities], aoe: req.aoe, tier: null,
  };
  for (const [key, t] of Object.entries(targets)) {
    const actor = fromUuidSync(t.actorUuid);
    if (!actor) continue;
    const squad = squadOf(actor);
    if (squad) {
      const id = opId(req.kind, "syn", "group", squad.id);
      if (!ops[id]) {
        ops[id] = { ...base, opId: id, order: order++, targetKeys: [], group: squad.uuid, groupName: squad.name };
        if (req.kind !== "damage") Object.assign(ops[id], { status: OP_STATUS.SKIPPED, reason: "minionHeal" });
      }
      ops[id].targetKeys.push(key);
      continue;
    }
    const id = opId(req.kind, "syn", key);
    const op = { ...base, opId: id, order: order++, targetKeys: [key] };
    if (req.kind === "temp" && op.amount < (actor.system?.stamina?.temporary ?? 0)) {
      Object.assign(op, { status: OP_STATUS.SKIPPED, reason: "tempNotHigher" });
    }
    ops[id] = op;
  }
  return ops;
}

/**
 * Post a synthetic card and apply its automatic ops (active GM).
 * @param {object} opts                       See `api.applyDamage` in main.mjs.
 * @param {User} [user]                       The requesting user (recorded as author and applier).
 * @param {object} [extra]                     Internal callers only (never from the relay):
 * @param {Roll[]} [extra.rolls]                 Evaluated rolls shown on the card (Dice So Nice).
 * @param {object} [extra.meta]                  Stored on the record, e.g. `ongoing: {effectUuid, ...}`.
 * @param {boolean} [extra.applyAsync]           Resolve once the card is posted, not after its ops applied.
 * @returns {Promise<{messageId: string, ops: object}>}
 */
export async function createDamageCard(opts, user = game.user, { rolls = [], meta = null, applyAsync = false } = {}) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const req = normalizeDamageRequest(opts);
  const targets = targetsFromTokenUuids(req.tokenUuids);
  if (!Object.keys(targets).length) throw new Error("DSAUTO.Relay.BadRequest");
  const ops = buildOps(targets, req);
  const sourceActor = req.source ? fromUuidSync(req.source) : null;
  const result = await postSyntheticCard({
    title: req.flavor || loc(`DSAUTO.Card.Synthetic.${req.kind}`), sourceActor, sourceTokenUuid: null, targets, ops,
    modes: { [req.kind === "damage" ? "damage" : "healing"]: req.mode }, meta, rolls, user, half: req.half, applyAsync,
  });
  log("synthetic", { messageId: result.messageId, kind: req.kind, amount: req.amount, targets: Object.keys(targets).length, user: user?.name });
  return result;
}

/**
 * Post a card with a GM-signed record and apply its automatic ops (active GM). Synthetic cards, and
 * Milestone 5's trigger cards (`shape: "trigger"`, triggers/card.mjs).
 * @param {object} options
 * @param {string} options.title                 Card title (also the record's abilityName).
 * @param {Actor|null} options.sourceActor        Speaker and source of the record.
 * @param {string|null} options.sourceTokenUuid
 * @param {object} options.targets               Target records by key.
 * @param {object} options.ops                   Op records by id.
 * @param {object} options.modes
 * @param {object|null} [options.meta]            Extra record fields (e.g. `ongoing`, `trigger`); the record's own fields win.
 * @param {Roll[]} [options.rolls]
 * @param {User} [options.user]                   Recorded as author and applier.
 * @param {boolean} [options.half]                Damage ops deal half damage.
 * @param {string} [options.shape]                "synthetic" | "trigger".
 * @param {object[]} [options.warnings]           Record warnings (e.g. `{code, targetKey}`).
 * @param {boolean} [options.applyAsync]          Do not wait for the automatic ops (a hold may prompt, C12).
 * @returns {Promise<{messageId: string, ops: object}>}
 */
export async function postRecordCard({
  title, sourceActor, sourceTokenUuid, targets, ops, modes, meta = null, rolls = [], user = game.user, half = false,
  shape = "synthetic", warnings = [], applyAsync = false, abilityUuid = null,
}) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const now = Date.now();
  const record = {
    ...(meta && typeof meta === "object" ? foundry.utils.deepClone(meta) : {}), // record fields below win
    v: RECORD_VERSION, shape, synthetic: true,
    abilityUuid, abilityName: title, sourceActorUuid: sourceActor?.uuid ?? null, sourceTokenUuid: sourceTokenUuid ?? null,
    authorUserId: user?.id ?? game.userId, authorRole: user?.role ?? game.user.role,
    createdAt: now, resolvedAt: now, resolvedBy: game.userId, generation: 1,
    modes, targets, ops, warnings: Array.isArray(warnings) ? foundry.utils.deepClone(warnings) : [],
  };
  const speaker = sourceActor ? ChatMessage.getSpeaker({ actor: sourceActor }) : ChatMessage.getSpeaker({ user: game.user });
  const message = await ChatMessage.create({
    type: "standard", speaker, flavor: title,
    ...(rolls.length ? { rolls, sound: CONFIG.sounds?.dice } : {}),
    system: { parts: { [PART_ID]: partSource() } },
    flags: { [MODULE_ID]: { resolution: record } },
  });
  if (!message) throw new Error("DSAUTO.Relay.Vetoed");
  sign(game.messages.get(message.id) ?? message);
  const auto = Object.values(ops).filter(op => op.mode === "auto" && op.status === OP_STATUS.PENDING && !op.noApply).map(op => op.opId);
  if (auto.length) {
    const run = applyOps(game.messages.get(message.id) ?? message, auto, { userId: user?.id ?? game.userId, half });
    // A caller that must not wait on a held application (a prompt).
    if (applyAsync) Promise.resolve(run).catch(err => error("synthetic.apply", err));
    else await run;
  }
  return { messageId: message.id, ops: foundry.utils.deepClone(game.messages.get(message.id)?.flags?.[MODULE_ID]?.resolution?.ops ?? {}) };
}

/** Internal name of the synthetic path (M1.5 to M4). */
const postSyntheticCard = postRecordCard;

/* -------------------------------------------- */
/*  Movement cards (Milestone 3)                */
/* -------------------------------------------- */

const MOVE_PROPERTIES = new Set(["no-collision-damage", "no-mover-collision-damage", "no-obstacle-collision-damage"]);
const isUuid = u => typeof u === "string" && u.length > 0 && u.length < 300;
const optionalUuid = u => u == null || isUuid(u);

/**
 * Validate `api.forcedMovement` / `api.teleport` options. Throws `DSAUTO.Relay.BadRequest`.
 * forced:   {targets, movement: push|pull|slide, distance, source (token), vertical?, ignoreStability?,
 *            properties?, path?: straight|choose, mode?, flavor?}
 * teleport: {token, distance?, teleportMode?: normal|swap|adjacent, partner?, destination?, animate?, mode?, flavor?}
 */
export function normalizeMoveRequest(opts = {}) {
  const bad = () => new Error("DSAUTO.Relay.BadRequest");
  const mode = opts.mode ?? "auto";
  const flavor = opts.flavor ?? "";
  if (!MODES.has(mode) || typeof flavor !== "string" || flavor.length > 200) throw bad();
  const int = (v, min, max, fallback) => {
    const n = v == null ? fallback : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw bad();
    return n;
  };
  if (opts.kind === "forced") {
    const tokenUuids = tokenUuidsOf(opts.targets);
    if (!tokenUuids.length || tokenUuids.length > 50 || !tokenUuids.every(isUuid)) throw bad();
    if (!FORCED_MOVEMENTS.includes(opts.movement)) throw bad();
    const source = tokenUuidsOf(opts.source)[0] ?? null;
    if (!optionalUuid(source)) throw bad();
    const properties = opts.properties ?? [];
    if (!Array.isArray(properties) || !properties.every(p => MOVE_PROPERTIES.has(p))) throw bad();
    const path = opts.path ?? "straight";
    if (path !== "straight" && path !== "choose") throw bad();
    return {
      kind: "forced", tokenUuids, movement: opts.movement, distance: int(opts.distance, 0, 50), source,
      vertical: !!opts.vertical, ignoreStability: !!opts.ignoreStability, properties: [...properties], path, mode, flavor,
    };
  }
  if (opts.kind === "teleport") {
    const token = tokenUuidsOf(opts.token)[0] ?? null;
    if (!isUuid(token)) throw bad();
    const partner = tokenUuidsOf(opts.partner)[0] ?? null;
    if (!optionalUuid(partner)) throw bad();
    const teleportMode = opts.teleportMode ?? "normal";
    if (!TELEPORT_MODES.includes(teleportMode)) throw bad();
    let destination = null;
    if (opts.destination != null) {
      const d = opts.destination;
      const nums = [d?.x, d?.y, d?.elevation ?? 0].map(Number);
      if (!nums.every(Number.isFinite)) throw bad();
      destination = { x: nums[0], y: nums[1], ...(d.elevation != null ? { elevation: nums[2] } : {}) };
    }
    return {
      kind: "teleport", token, partner, teleportMode, destination, distance: int(opts.distance, 1, 100, 5),
      animate: opts.animate !== false, mode, flavor,
    };
  }
  throw bad();
}

/**
 * Post a forced movement or teleport card and apply it when its mode is automatic (active GM).
 * Moves that need a pick on the canvas (slides, vertical moves, `path: "choose"`, teleports without a
 * destination) show Combat Tools' picker on the active GM's screen.
 * @param {object} opts         See normalizeMoveRequest; `kind` is "forced" or "teleport".
 * @param {User} [user]
 */
export async function createMoveCard(opts, user = game.user) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const req = normalizeMoveRequest(opts);
  const ops = {};
  let targets;
  let sourceTokenUuid = null;
  if (req.kind === "forced") {
    targets = targetsFromTokenUuids(req.tokenUuids);
    sourceTokenUuid = req.source;
    const interactive = req.path === "choose" || req.movement === "slide" || req.vertical;
    const delegate = forcedDelegate({ interactive });
    let order = 0;
    for (const [key, t] of Object.entries(targets)) {
      const id = opId("forced", "syn", key);
      ops[id] = {
        opId: id, order: order++, kind: "forced", mode: req.mode, status: OP_STATUS.PENDING, synthetic: true, tier: null,
        targetKeys: [key], movements: [req.movement], movement: req.movement, distances: { [req.movement]: req.distance },
        vertical: req.vertical, ignoreStability: req.ignoreStability, properties: req.properties, interactive, delegate,
        choosePath: req.path === "choose" || null, flying: !!fromUuidSync(t.actorUuid)?.statuses?.has?.("fly") || null,
        stability: stabilityOf(fromUuidSync(t.actorUuid)), sourceTokenUuid,
      };
      if (!delegate) Object.assign(ops[id], { mode: "manual", noApply: true, reason: "moveByHand" });
      // A pick would open on the active Director's screen, not the requester's: let them click it.
      else if (interactive && req.mode === "auto" && !user?.isSelf) ops[id].mode = "prompt";
    }
  } else {
    targets = targetsFromTokenUuids([req.token]);
    const [key] = Object.keys(targets);
    if (key) {
      const id = opId("teleport", "syn", key);
      ops[id] = {
        opId: id, order: 0, kind: "teleport", mode: req.mode, status: OP_STATUS.PENDING, synthetic: true, tier: null,
        targetKeys: [key], distance: req.distance, teleportMode: req.teleportMode, partnerTokenUuid: req.partner,
        destination: req.destination, animate: req.animate,
      };
      if (!req.destination && req.mode === "auto" && !user?.isSelf) ops[id].mode = "prompt";
    }
  }
  if (!Object.keys(targets).length) throw new Error("DSAUTO.Relay.BadRequest");
  const sourceDoc = sourceTokenUuid ? fromUuidSync(sourceTokenUuid) : null;
  const sourceActor = sourceDoc?.actor ?? (req.kind === "teleport" ? fromUuidSync(Object.values(targets)[0].actorUuid) : null);
  const result = await postSyntheticCard({
    title: req.flavor || loc(`DSAUTO.Card.Synthetic.${req.kind}`), sourceActor, sourceTokenUuid, targets, ops,
    modes: { [req.kind]: req.mode }, user,
  });
  log("synthetic", { messageId: result.messageId, kind: req.kind, targets: Object.keys(targets).length, user: user?.name });
  return result;
}

/* -------------------------------------------- */
/*  Summon cards (Milestone 6)                  */
/* -------------------------------------------- */

const SQUARE_KEYS = new Set(["x", "y", "elevation", "level", "rotation"]);
const MAX_SQUARES = 10;
const plainObject = v => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * One square of a summon request, shape only (docs/M6-DESIGN.md §1.6): keys of {x, y, elevation, level, rotation};
 * x, y finite with |v| <= 1e6; elevation finite with |v| <= 1e5; level a string of 1-40 characters or null; rotation
 * finite in [0, 360]. Whether the square is legal is the GM's check (summons/squares.mjs).
 */
export function validSquare(sq, { partial = false } = {}) {
  if (!plainObject(sq) || !Object.keys(sq).every(k => SQUARE_KEYS.has(k))) return false;
  const coord = (v, max) => Number.isFinite(v) && Math.abs(v) <= max;
  if (!coord(sq.x, 1e6) || !coord(sq.y, 1e6)) return false;
  if (sq.elevation !== undefined || !partial) {
    if (!coord(sq.elevation, 1e5)) return false;
  }
  if (sq.level !== undefined || !partial) {
    if (!(sq.level === null || (typeof sq.level === "string" && sq.level.length >= 1 && sq.level.length <= 40))) return false;
  }
  if (sq.rotation !== undefined && !(Number.isFinite(sq.rotation) && sq.rotation >= 0 && sq.rotation <= 360)) return false;
  return true;
}

/** 1-10 squares (§1.6); `partial`: elevation and level may be missing (api.summon fills them from the summoner). */
export function validSquares(squares, { partial = false } = {}) {
  return Array.isArray(squares) && squares.length >= 1 && squares.length <= MAX_SQUARES && squares.every(sq => validSquare(sq, { partial }));
}

/** A stat block reference of api.summon: a compendium Actor uuid, or a world actor "Actor.<id>". */
const summonRef = u => typeof u === "string" && u.length <= 300 && !!summonActorUuid(u);

/**
 * Validate `api.summon` options (Directors). Throws `DSAUTO.Relay.BadRequest`. §1.9
 * `places`: undefined / null / "pick" (the card waits for the Summon button), "auto" (the GM searches free squares),
 * or an array of squares (shape rules of §1.6; a missing level / elevation is taken from the summoner's token).
 * @returns {object}
 */
export function normalizeSummonRequest(opts = {}) {
  const bad = () => new Error("DSAUTO.Relay.BadRequest");
  if (!plainObject(opts)) throw bad();
  const summoner = tokenUuidsOf(opts.summoner)[0] ?? null;
  if (!isUuid(summoner)) throw bad();
  const list = opts.actors != null ? (Array.isArray(opts.actors) ? opts.actors : [opts.actors]) : (opts.actor != null ? [opts.actor] : []);
  if (!list.length || list.length > MAX_SUMMON_ACTORS || !list.every(summonRef)) throw bad();
  const actors = [...new Set(list.map(u => u.trim()))];
  const int = (v, min, max, fallback) => {
    const n = v == null ? fallback : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw bad();
    return n;
  };
  const oneOf = (v, choices, fallback) => {
    const out = v ?? fallback;
    if (!choices.includes(out)) throw bad();
    return out;
  };
  const bool = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v !== "boolean") throw bad();
    return v;
  };
  const quantity = int(opts.quantity, 1, MAX_SUMMON_QUANTITY, 1);
  const distance = int(opts.distance, 0, 100, 10);
  const origin = oneOf(opts.origin, SUMMON_ORIGINS, "self");
  const anchor = opts.anchor == null ? null : (tokenUuidsOf(opts.anchor)[0] ?? null);
  if (anchor != null && !isUuid(anchor)) throw bad();
  if (origin === "target" && !anchor) throw bad();
  const lasts = opts.lasts == null ? ["encounterEnd"] : opts.lasts;
  if (!Array.isArray(lasts) || !lasts.length || !lasts.every(v => SUMMON_LASTS.includes(v)) || new Set(lasts).size !== lasts.length) throw bad();
  if (lasts.includes("manual") && lasts.length > 1) throw bad();
  const upkeep = opts.upkeep == null ? null : int(opts.upkeep, 1, 10, null);
  if (upkeep != null && !lasts.includes("summonerTurnStart")) throw bad();
  const pick = opts.pick == null ? null : opts.pick;
  if (pick != null && !(typeof pick === "string" && actors.includes(pick.trim()))) throw bad();
  let places = opts.places ?? null;
  if (places === "pick") places = null;
  if (places != null && places !== "auto") {
    if (!validSquares(places, { partial: true })) throw bad();
    places = places.map(sq => ({ ...sq }));
  }
  const flavor = opts.flavor ?? "";
  if (typeof flavor !== "string" || flavor.length > 200) throw bad();
  const mode = opts.mode ?? "auto";
  if (!MODES.has(mode)) throw bad();
  return {
    summoner, actors, quantity, distance, origin, anchor: origin === "target" ? anchor : null,
    side: oneOf(opts.side, SUMMON_SIDES, "summoner"), turn: oneOf(opts.turn, SUMMON_TURNS, "own"),
    actsThisRound: bool(opts.actsThisRound, true), squad: oneOf(opts.squad, SUMMON_SQUADS, "join"), lasts: [...lasts], upkeep,
    // No item behind an api card: nothing to carry or lock (accepted for shape, never used).
    carryStamina: false, lockOnZero: false,
    places, pick: pick?.trim() ?? null, flavor, mode,
  };
}

/** Display name of a stat block reference before it is prepared (world actor, else the pack index). */
function summonRefName(u) {
  try {
    const world = /^Actor\.([A-Za-z0-9]{16})$/.exec(u);
    if (world && game.actors?.get?.(world[1])) return game.actors.get(world[1]).name ?? "";
    const m = /^Compendium\.([\w-]+)\.([\w-]+)\.Actor\.([A-Za-z0-9]{16})$/.exec(summonActorUuid(u) ?? "");
    return (m && game.packs?.get?.(`${m[1]}.${m[2]}`)?.index?.get?.(m[3])?.name) || "";
  } catch (_err) {
    return "";
  }
}

/**
 * Active GM: post the summon card (one row, `synthetic: true`, posted in mode prompt so nothing applies it by
 * itself), prepare its world actors, then apply the row with the given squares or the GM search (`places: "auto"`).
 * Without squares the card waits for the Summon button.
 * @param {object} opts                See normalizeSummonRequest.
 * @param {User} [user]
 * @returns {Promise<{messageId: string, ops: object}>}
 */
export async function createSummonCard(opts, user = game.user) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const req = normalizeSummonRequest(opts);
  let summonerDoc = null;
  try {
    summonerDoc = fromUuidSync(req.summoner);
  } catch (_err) { /* invalid uuid */ }
  const target = targetFromTokenDoc(summonerDoc);
  if (!target || (summonerDoc.documentName && summonerDoc.documentName !== "Token")) throw new Error("DSAUTO.Relay.BadRequest");
  const id = opId("summon", "syn", target.key);
  // A places array without level / elevation: the summoner's level (checkSquare needs it) and the elevation of the
  // squares' origin (the anchor for origin "target", D12; review fix): distance is measured from it.
  let anchorDoc = summonerDoc;
  if (req.origin === "target") {
    try {
      anchorDoc = fromUuidSync(req.anchor) ?? null;
    } catch (_err) {
      anchorDoc = null;
    }
  }
  const squares = Array.isArray(req.places)
    ? req.places.map(sq => ({
      x: sq.x, y: sq.y, elevation: sq.elevation ?? anchorDoc?.elevation ?? summonerDoc.elevation ?? 0,
      level: sq.level !== undefined ? sq.level : (summonerDoc.level ?? null),
      rotation: sq.rotation ?? 0,
    }))
    : null;
  const op = {
    opId: id, order: 0, kind: "summon", mode: req.mode === "manual" ? "manual" : "prompt", status: OP_STATUS.PENDING,
    synthetic: true, tier: null, self: true, targetKeys: [target.key], interactive: true,
    choices: req.actors.map(u => ({ uuid: u, name: summonRefName(u), img: null, width: 1, height: 1, isMinion: false, worldActorId: null, label: null })),
    quantity: req.quantity, distance: req.distance, origin: req.origin,
    anchorTokenUuid: req.origin === "target" ? req.anchor : summonerDoc.uuid, anchorKey: null,
    summonerTokenUuid: summonerDoc.uuid, summonerActorUuid: summonerDoc.actor.uuid, itemUuid: null,
    // Api summons get their own world actor per summoner, never shared with an item's (§3.13).
    sourceUuid: `api:${summonerDoc.actor.uuid}`,
    side: req.side, turn: req.turn, actsThisRound: req.actsThisRound, squad: req.squad, lasts: [...req.lasts], upkeep: req.upkeep,
    carryStamina: false, lockOnZero: false,
  };
  await prepareSummonOps({ [id]: op }, { item: null });
  const posted = await postSyntheticCard({
    title: req.flavor || loc("DSAUTO.Card.Synthetic.summon"), sourceActor: summonerDoc.actor, sourceTokenUuid: summonerDoc.uuid,
    targets: { [target.key]: { ...target, self: true } }, ops: { [id]: op }, modes: { summons: req.mode }, user,
  });
  if ((req.places === "auto" || squares) && op.status === OP_STATUS.PENDING) {
    const message = game.messages.get(posted.messageId);
    // places "auto": the GM search, with the caller's pick when several stat blocks are offered (review fix).
    const clientPlaces = squares ? { [id]: { actor: req.pick ?? op.choices[0]?.uuid, squares } } : (req.pick ? { [id]: { actor: req.pick } } : null);
    if (message) await applyOps(message, [id], { userId: user?.id ?? game.userId, clientPlaces });
  }
  log("synthetic", { messageId: posted.messageId, kind: "summon", actors: req.actors.length, places: squares ? "squares" : (req.places ?? "pick"), user: user?.name });
  return {
    messageId: posted.messageId,
    ops: foundry.utils.deepClone(game.messages.get(posted.messageId)?.flags?.[MODULE_ID]?.resolution?.ops ?? posted.ops),
  };
}

/* -------------------------------------------- */
/*  Native summons (Milestone 8)                 */
/* -------------------------------------------- */

/**
 * Active GM: the card of a native summon (docs/M8-DESIGN.md §2.2): one summon row on the summoner's own record, posted
 * in mode prompt, its world actor prepared (the M6 key: `summonSourceUuid(item)`), then applied with the requester's
 * squares (`places`, shapes checked by the relay; legality by the summon engine). The caller checked who asks and what.
 * @param {object} args
 * @param {Item} args.item                       The ability (its AbilityModel#performSummon was wrapped).
 * @param {TokenDocument} args.summonerDoc
 * @param {string} args.actorUuid                The stat block the system's dialog chose.
 * @param {number} args.count
 * @param {object[]} [args.effects]              ActiveEffect data for each token (a portfolio's advancement effects).
 * @param {object[]} args.places                 1-10 squares {x, y, elevation, level, rotation}.
 * @param {number} args.distance
 * @param {object} args.defaults                 side, turn, squadMinions, squadOthers, lasts (summons/native.mjs).
 * @param {boolean} [args.costNote]              The system charged a cost undo does not refund (a portfolio summon).
 * @param {User} [args.user]                     The requester (author; the apply runs as them).
 * @returns {Promise<{messageId: string, op: object|null}>}
 */
export async function createNativeSummonCard({ item, summonerDoc, actorUuid, count, effects = [], places, distance, defaults, costNote = false, user = game.user }) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const target = targetFromTokenDoc(summonerDoc);
  if (!target) throw new Error("DSAUTO.Relay.BadRequest");
  const id = opId("summon", "native", target.key);
  const op = {
    opId: id, order: 0, kind: "summon", mode: "prompt", status: OP_STATUS.PENDING,
    native: true, tier: null, self: true, targetKeys: [target.key], interactive: true,
    choices: [{ uuid: actorUuid, name: summonRefName(actorUuid), img: null, width: 1, height: 1, isMinion: false, worldActorId: null, label: null }],
    quantity: count, distance, origin: "self", anchorTokenUuid: summonerDoc.uuid, anchorKey: null,
    summonerTokenUuid: summonerDoc.uuid, summonerActorUuid: summonerDoc.actor.uuid, itemUuid: item.uuid,
    // The M6 reuse key: one world actor per base item, shared with the ability's library rows (CH3).
    sourceUuid: summonSourceUuid(item),
    side: defaults.side, turn: defaults.turn, actsThisRound: true, squad: defaults.squadOthers, lasts: [...defaults.lasts], upkeep: null,
    carryStamina: false, lockOnZero: false,
    effects: foundry.utils.deepClone(effects ?? []),
  };
  await prepareSummonOps({ [id]: op }, { item });
  // Squads by the stat block (prepared): minions join the summoner's squad of them, others stand alone.
  if (op.choices[0]?.isMinion) op.squad = defaults.squadMinions;
  const posted = await postSyntheticCard({
    title: loc("DSAUTO.Card.Synthetic.nativeSummon", { name: item.name ?? "" }), sourceActor: summonerDoc.actor, sourceTokenUuid: summonerDoc.uuid,
    targets: { [target.key]: { ...target, self: true } }, ops: { [id]: op }, modes: { summons: "auto" }, user,
    meta: { itemUuid: item.uuid, native: true, ...(costNote ? { library: { layer: null, key: null, version: null, notes: loc("DSAUTO.Summon.NativeCostNote") } } : {}) },
  });
  const message = game.messages.get(posted.messageId);
  if (message && op.status === OP_STATUS.PENDING) {
    await applyOps(message, [id], { userId: user?.id ?? game.userId, clientPlaces: { [id]: { actor: actorUuid, squares: places.map(sq => ({ ...sq })) } } });
  }
  const after = game.messages.get(posted.messageId)?.flags?.[MODULE_ID]?.resolution?.ops?.[id] ?? null;
  log("synthetic", { messageId: posted.messageId, kind: "nativeSummon", status: after?.status ?? null, user: user?.name });
  return { messageId: posted.messageId, op: after ? foundry.utils.deepClone(after) : null };
}

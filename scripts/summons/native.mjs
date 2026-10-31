/**
 * Native summons on Draw Steel 1.2 (Milestone 8, docs/M8-DESIGN.md §2, D10, D11).
 *
 * 1.2 summons through `AbilityModel#performSummon(uuid, {count, effects})`, called by the `summon` and
 * `portfolioSummon` special effects behind the ability card's Summon button (R/data/item/ability.mjs:966-1001). The
 * system then imports the stat block (needs ACTOR_CREATE) and places it with `canvas.tokens.placeActor` (needs
 * TOKEN_CREATE): players without those rights cannot summon, and the tokens get none of our summon handling.
 *
 * A MIXED wrapper (setting `summonInterceptNative`, registered only where the method exists) keeps the system's own
 * choice and cost dialogs and replaces only the placement:
 *   1. the summoner token is the ability actor's token on the clicking user's viewed scene;
 *   2. the user picks the squares on their own canvas (the M6 picker: stand-in previews for players, compendium
 *      previews for the Director through `pickForApi`); Escape resolves null (a portfolio summon then charges nothing);
 *   3. relay `nativeSummon` to the active GM, which validates the request against the ability's summon effects
 *      (`handleNativeSummon`), posts a summon card with one own summon row and applies it with those squares through
 *      the M6 engine (world actor by the M6 key, ownership, disposition, combat, squads, dismissal, undo);
 *   4. the wrapper resolves the created TokenDocuments (non-empty), so the portfolio path charges its cost as designed.
 * With the setting off, no GM connected, or the module disabled the system's own path runs unchanged. Once the relay
 * started, an error never falls back to the system's placement (no double summon): it warns and resolves null.
 *
 * i18n keys: DSAUTO.Summon.NativeNoToken, DSAUTO.Relay.NativeSummonRefused (thrown), DSAUTO.Relay.BadRequest,
 * DSAUTO.Relay.Denied, DSAUTO.Relay.Failed (through relayErrorText); the row's reason through summonReasonText.
 */
import { OP_STATUS, loc } from "../constants.mjs";
import { compat } from "../compat/version-gate.mjs";
import { registrations, wrap } from "../compat/lib-wrapper.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { createNativeSummonCard, validSquares } from "../engine/synthetic.mjs";
import { mayNativeSummon } from "../relay/auth.mjs";
import { relayErrorText, requestOp } from "../relay/queries.mjs";
import { gridKind } from "./squares.mjs";
import { pickForApi, pickSquares, standInData, summonReasonText } from "./place.mjs";

/**
 * D11: native summon data has no side, turn or duration: M6's hero-summon defaults. A Dismiss is always offered
 * (relay summonDismiss), so `lasts` is the encounter only (`manual` cannot be combined with other ends, library schema).
 */
export const NATIVE_DEFAULTS = Object.freeze({
  side: "summoner", turn: "after", squadMinions: "join", squadOthers: "none",
  lasts: Object.freeze(["encounterEnd"]), distanceFallback: 10,
});

const WRAP_TARGET = "ds.data.Item.AbilityModel.prototype.performSummon";
const MAX_COUNT = 10;
const MAX_EFFECTS = 10;
const DISTANCE_TYPES = new Set(["ranged", "melee", "burst", "aura"]);

const isObject = v => !!v && typeof v === "object" && !Array.isArray(v);
const uuidString = v => typeof v === "string" && v.length > 0 && v.length < 300;

/** init (after detectCompat): MIXED wrap where the system has AbilityModel#performSummon (1.2); false otherwise. */
export function registerNativeSummon() {
  if (!compat.performSummon) return false;
  return wrap(WRAP_TARGET, nativeSummonWrapper, "MIXED");
}

/** selfCheck row (§2.3): "installed" | "not needed" (no such method) | "setting off" | "not installed". */
export function nativeSummonStatus() {
  if (!compat.performSummon) return "not needed";
  if ((setting("summonInterceptNative") ?? true) === false) return "setting off";
  return registrations.some(r => r.target === WRAP_TARGET && r.ok) ? "installed" : "not installed";
}

/** The ability's distance in squares: its primary distance for ranged / melee / burst / aura, else the fallback. */
export function nativeDistance(item) {
  const d = item?.system?.distance;
  const n = Number(d?.primary);
  return DISTANCE_TYPES.has(d?.type) && Number.isFinite(n) && n >= 0 ? n : NATIVE_DEFAULTS.distanceFallback;
}

/**
 * The summoner's token on the scene this client views: a synthetic actor's own token, else a linked actor's active
 * token there (any of them owned first). Null when there is none.
 */
export function summonerTokenFor(actor) {
  const scene = globalThis.canvas?.scene;
  if (!actor || !scene) return null;
  if (actor.isToken) {
    const doc = actor.token ?? null;
    return doc?.parent?.id === scene.id ? doc : null;
  }
  let docs = [];
  try {
    docs = (actor.getActiveTokens?.(false, true) ?? []).filter(d => d?.parent?.id === scene.id);
  } catch (_err) { /* fall back to the scene's tokens */ }
  if (!docs.length) docs = (scene.tokens?.contents ?? [...(scene.tokens?.values?.() ?? [])]).filter(t => t?.actorLink && t.actorId === actor.id);
  return docs.find(d => d.isOwner) ?? docs[0] ?? null;
}

/* -------------------------------------------- */
/*  The wrapper (clicking client)                */
/* -------------------------------------------- */

/** @this {AbilityModel} */
async function nativeSummonWrapper(wrapped, uuid, options = {}) {
  const { count = 1, effects = [] } = options ?? {};
  if (!setting("enabled") || (setting("summonInterceptNative") ?? true) === false || !game.users?.activeGM) {
    return wrapped(uuid, options);
  }
  const item = this?.parent;
  if (!item?.actor) return wrapped(uuid, options);
  try {
    const summonerDoc = summonerTokenFor(item.actor);
    if (!summonerDoc) {
      ui.notifications.warn(loc("DSAUTO.Summon.NativeNoToken"));
      return null;
    }
    const n = Math.floor(Number(count) || 1);
    const distance = nativeDistance(item);
    const places = await pickNative({ summonerDoc, uuid, count: Math.min(MAX_COUNT, Math.max(1, n)), distance });
    if (!places) return null;                                      // cancelled: a portfolio summon charges nothing
    const res = await requestOp({
      action: "nativeSummon",
      nativeSummon: {
        abilityUuid: item.uuid, actorUuid: uuid, count: n,
        effectUuids: (effects ?? []).map(e => e?.uuid).filter(Boolean),
        summonerTokenUuid: summonerDoc.uuid, places,
      },
    });
    if (!res?.ok || !res.tokenUuids?.length) {
      if (res?.reason) ui.notifications.warn(loc("DSAUTO.Summon.Refused", { why: summonReasonText(res.reason) }));
      log("summon.native", { item: item.name, outcome: res?.reason ?? "notPlaced" });
      return null;
    }
    const tokens = (await Promise.all(res.tokenUuids.map(u => fromUuid(u).catch(() => null)))).filter(Boolean);
    log("summon.native", { item: item.name, placed: tokens.length, messageId: res.messageId ?? null });
    return tokens.length ? tokens : null;
  } catch (err) {
    ui.notifications.warn(relayErrorText(err));
    if (!String(err?.message ?? "").startsWith("DSAUTO.")) error("summon.native", err, { item: item?.uuid ?? null });
    return null;
  }
}

/**
 * The squares on this client's canvas, or null (cancelled, not on the canvas). The Director picks with compendium
 * previews (`pickForApi`); a player with a stand-in made from the summoner's own token (always theirs to preview),
 * sized and named from the stat block when this client can read it.
 */
async function pickNative({ summonerDoc, uuid, count, distance }) {
  if (game.user?.isGM) {
    const picked = await pickForApi({ summonerDoc, choice: { uuid }, quantity: count, distance });
    return picked?.squares?.length ? picked.squares : null;
  }
  const cv = globalThis.canvas;
  if (!cv?.scene || typeof cv.tokens?.placeTokens !== "function" || summonerDoc.parent?.id !== cv.scene.id) {
    ui.notifications.warn(loc("DSAUTO.Summon.NeedsCanvas"));
    return null;
  }
  const viewed = cv.level?.id ?? null;
  if (viewed && summonerDoc.level && viewed !== summonerDoc.level) {
    ui.notifications.warn(loc("DSAUTO.Summon.NeedsCanvas"));
    return null;
  }
  if (gridKind(cv.scene) === "hex") {
    ui.notifications.warn(loc("DSAUTO.Summon.Picker.gridUnsupported"));
    return null;
  }
  let doc = null;
  try {
    doc = await fromUuid(uuid);
  } catch (err) {
    debug("summon.nativeActor", { uuid, why: String(err?.message ?? err) });
  }
  const proto = doc?.prototypeToken ?? {};
  const choice = {
    uuid, name: doc?.name ?? summonerDoc.name, img: proto.texture?.src || doc?.img || null,
    width: Math.max(1, Number(proto.width) || 1), height: Math.max(1, Number(proto.height) || 1),
  };
  const d = { ...standInData({ choice, summonerDoc }), elevation: summonerDoc.elevation ?? 0 };
  const previews = [];
  for (let k = 0; k < count; k++) previews.push(foundry.utils.deepClone(d));
  const squares = await pickSquares({ op: { quantity: count, distance }, choice, summonerDoc, anchorDoc: summonerDoc, previews });
  return squares?.length ? squares : null;
}

/* -------------------------------------------- */
/*  The active GM                                */
/* -------------------------------------------- */

/** Payload shape of relay `nativeSummon` (§2.2 step 1); the GM handler checks the rest. */
export function validNativeSummon(n) {
  return isObject(n)
    && Object.keys(n).every(k => ["abilityUuid", "actorUuid", "count", "effectUuids", "summonerTokenUuid", "places"].includes(k))
    && uuidString(n.abilityUuid) && uuidString(n.actorUuid) && uuidString(n.summonerTokenUuid)
    && Number.isInteger(n.count) && n.count >= 1 && n.count <= MAX_COUNT
    && (n.effectUuids == null || (Array.isArray(n.effectUuids) && n.effectUuids.length <= MAX_EFFECTS && n.effectUuids.every(uuidString)))
    && validSquares(n.places);
}

function syncDoc(uuid) {
  try {
    return uuid ? fromUuidSync(uuid) ?? null : null;
  } catch (_err) {
    return null;
  }
}

/** The ability's special effects (1.2: `system.effects`, a collection of pseudo-documents). */
function specialEffects(item) {
  const c = item?.system?.effects;
  if (!c) return [];
  try {
    return c.contents ?? [...(c.values?.() ?? c)];
  } catch (_err) {
    return [];
  }
}

/** A Set, array or collection of uuids has `uuid`. */
function poolHas(pool, uuid) {
  if (!pool) return false;
  if (typeof pool.has === "function") return pool.has(uuid);
  return Array.isArray(pool) && pool.includes(uuid);
}

/**
 * §2.2 step 3: may this ability summon `actorUuid` × `count` with these effects? A `summon` effect whose pool holds
 * the stat block (count within its own, no effects), or a `portfolioSummon` effect whose actor's portfolio for this
 * ability holds it (count up to 10; every effect one of that entry's advancement effects).
 * @returns {{ok: boolean, portfolio: boolean}}
 */
export function nativeSummonAllowed(item, { actorUuid, count, effectUuids = [] }) {
  const list = specialEffects(item);
  for (const e of list) {
    if (e?.type !== "summon") continue;
    if (poolHas(e.summoning?.pool, actorUuid) && count <= (Number(e.summoning?.count) || 1) && !effectUuids.length) return { ok: true, portfolio: false };
  }
  if (!list.some(e => e?.type === "portfolioSummon")) return { ok: false, portfolio: false };
  const dsid = item.dsid ?? item.system?._dsid;
  const entries = (item.actor?.system?._summonPortfolios?.[dsid] ?? []).filter(o => o?.uuid === actorUuid);
  for (const entry of entries) {
    if (count > MAX_COUNT) continue;
    const advancement = syncDoc(entry.advancementUuid);
    const allowed = new Set((advancement?.effects ?? []).map(x => x?.uuid).filter(Boolean));
    if (effectUuids.every(u => allowed.has(u))) return { ok: true, portfolio: true };
  }
  return { ok: false, portfolio: true };
}

/**
 * §2.2 step 4: ActiveEffect data of the portfolio's effects, with `@` references of their changes replaced from the
 * ability's roll data (as the system's own performSummon, R/data/item/ability.mjs:989-998).
 */
async function effectData(item, effectUuids) {
  const rollData = item.getRollData?.() ?? {};
  const AE = CONFIG.ActiveEffect?.documentClass;
  const replace = value => (typeof AE?._replaceDataRefs === "function"
    ? AE._replaceDataRefs(value, rollData)
    : (globalThis.Roll?.replaceFormulaData ? Roll.replaceFormulaData(value, rollData) : value));
  const out = [];
  for (const u of effectUuids) {
    const doc = await fromUuid(u).catch(() => null);
    if (!doc) throw new Error("DSAUTO.Relay.NativeSummonRefused");
    const data = typeof game.items?.fromCompendium === "function"
      ? game.items.fromCompendium(doc, { keepId: true, clearFolder: true })
      : (doc.toObject?.() ?? foundry.utils.deepClone(doc));
    for (const change of data?.system?.changes ?? data?.changes ?? []) {
      if (typeof change?.value === "string") change.value = replace(change.value);
    }
    out.push(data);
  }
  return out;
}

/**
 * Relay `nativeSummon` on the active GM (payload shape already checked): who asks, what the ability may summon, then
 * the card. Throws DSAUTO.Relay.*; resolves `{ok, messageId, tokenUuids, reason}` from the applied row.
 * @param {object} req      validNativeSummon
 * @param {User} user       The requester (from core).
 */
export async function handleNativeSummon(req, user) {
  if (!game.users.activeGM?.isSelf) throw new Error("DSAUTO.Relay.NotActiveGM");
  const item = await fromUuid(req.abilityUuid).catch(() => null);
  const summonerDoc = syncDoc(req.summonerTokenUuid);
  if (!item?.actor || !summonerDoc || (summonerDoc.documentName && summonerDoc.documentName !== "Token")) throw new Error("DSAUTO.Relay.BadRequest");
  if (!mayNativeSummon(user, item, summonerDoc)) {
    log("relay.in", { user: user?.name, action: "nativeSummon", allowed: false, abilityUuid: req.abilityUuid });
    throw new Error("DSAUTO.Relay.Denied");
  }
  const effectUuids = req.effectUuids ?? [];
  const allowed = nativeSummonAllowed(item, { actorUuid: req.actorUuid, count: req.count, effectUuids });
  if (!allowed.ok) throw new Error("DSAUTO.Relay.NativeSummonRefused");
  const effects = effectUuids.length ? await effectData(item, effectUuids) : [];
  const { messageId, op } = await createNativeSummonCard({
    item, summonerDoc, actorUuid: req.actorUuid, count: req.count, effects, places: req.places,
    distance: nativeDistance(item), defaults: NATIVE_DEFAULTS, costNote: allowed.portfolio, user,
  });
  const ok = op?.status === OP_STATUS.APPLIED && (op.tokenUuids?.length ?? 0) > 0;
  debug("summon.nativeHandled", { messageId, ok, reason: op?.reason ?? null });
  return { ok, messageId, tokenUuids: ok ? [...op.tokenUuids] : [], reason: ok ? null : (op?.reason ?? "error") };
}

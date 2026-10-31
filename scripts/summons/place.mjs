/**
 * Summon placement on the clicking client (Milestone 6, docs/M6-DESIGN.md §3.2, §3.13). Every client: the
 * summoner's owner (player cards), the Director (monster cards, synthetic cards, api.summon).
 *
 * The row's Summon button (resolution-part `dsAutoSummon`) runs `runSummonPick`:
 *   1. the summoner's token (and the anchor, origin "target") must be on the viewed scene and level: core
 *      `placeTokens` always builds its previews with `parent: canvas.scene` (CL/canvas/layers/tokens.mjs:884);
 *   2. one stat block is chosen (a dialog only when the row has several);
 *   3. a choice without a world actor (the resolve-time import failed) asks the GM to prepare it again
 *      (relay `summonPrepare`); a world actor this client does not hold (probe P1 negative, CH8) asks for the
 *      OWNER grant (`summonPrepare {grant: true}`) and waits up to 2 s for it;
 *   4. previews: the world actor's token with a LOCAL `delta.ownership` for this user (never written), or, when
 *      that preview is not owned (probe P2 negative) or the actor is still missing, a stand-in made from the
 *      summoner's own token with the summon's name, size and art;
 *   5. `canvas.tokens.placeTokens(previews, {create: false, preConfirm, preCommit})`: preConfirm is called
 *      WITHOUT await (:1183-1190), so it is synchronous: range, occupancy (squares already picked in this batch
 *      included), scene rectangle, level and grid snapping are checked through squares.mjs and a refusal warns
 *      here (core shows nothing). Right-click skips one preview (fewer than `quantity` is fine), Escape
 *      resolves [] and nothing is sent;
 *   6. the squares go to the active GM in `apply` (`places: {[opId]: {actor, squares}}`), which checks
 *      everything again against the summoner's token scene (§3.3). A refusal is read back from the record.
 * A Director with summonPlacement "auto" reaches this only for a row offering several stat blocks (view.mjs): the
 * choice dialog, then `places: {[opId]: {actor}}` without squares (the GM search places it).
 * A second click on the same row while its picker is open is ignored (`busy`); a click on another row (or any
 * other placeTokens caller) cancels the open picker through core's `_cancelPlacement` (the first sends nothing).
 *
 * `pickForApi` is the Director's `api.summon` pick: compendium prototype previews (`actorId: null`, a GM owns
 * any preview, CL/documents/token.mjs:272-276), the same checks; a non-GM is refused before any picker.
 *
 * No engine or relay imports: resolution-part.mjs imports this file and must stay free of them
 * (S/parts/resolution-part.mjs:19-22); the relay function arrives as `request`, errors are localized here.
 *
 * i18n keys: DSAUTO.Summon.{NeedsCanvas, Refused, ChooseTitle, ChooseIntro}, DSAUTO.Summon.Picker.{Hint,
 * badPlace, offMap, wrongLevel, tooFar, occupied, gridUnsupported} (dynamic: §5.6),
 * DSAUTO.Reason.{noWorldActor, summonerGone, noAnchor, wrongScene, noDistance, error} and the row's own reason
 * (dynamic), DSAUTO.Relay.Denied.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { debug, error, log } from "../log.mjs";
import { checkSquare, gridKind, occupiedRects, originOf, rectOf } from "./squares.mjs";

/** How long the CH8 fallback waits for the granted world actor to reach this client. */
const GRANT_WAIT_MS = 2_000;
const POLL_MS = 100;
/** The same picker warning is not repeated within this window (a click on an occupied square twice). */
const WARN_THROTTLE_MS = 1_200;
const MAX_QUANTITY = 10;

const busy = new Set();          // message.id:opId of rows whose picker is open on this client
const lastWarn = { text: null, at: 0 };

const esc = v => {
  const s = String(v ?? "");
  const fn = foundry.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const warn = text => globalThis.ui?.notifications?.warn?.(text);
const info = text => globalThis.ui?.notifications?.info?.(text);
const sizeOf = v => Math.max(1, Number(v) || 1);

/** Square-check reasons with summon wording of their own (DSAUTO.Summon.Picker.*); DSAUTO.Reason.* is forced movement's. */
const PICKER_REASONS = new Set(["badPlace", "offMap", "wrongLevel", "tooFar", "occupied", "gridUnsupported"]);

/**
 * The text of a summon row's reason (review fix): the square checks' reasons in the picker's summon wording, any
 * other reason (tooMany, noSpace, summonerGone, ...) as DSAUTO.Reason.<reason>. Used by the card and the warnings.
 */
export function summonReasonText(reason) {
  const r = reason || "error";
  return PICKER_REASONS.has(r) ? loc(`DSAUTO.Summon.Picker.${r}`) : loc(`DSAUTO.Reason.${r}`);
}

/** A picker refusal: one warning per distinct text and short window (preConfirm runs on every click). */
function warnThrottled(text) {
  const now = Date.now();
  if (lastWarn.text === text && now - lastWarn.at < WARN_THROTTLE_MS) return;
  lastWarn.text = text;
  lastWarn.at = now;
  warn(text);
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** Resolve after `ms` (polling helper). */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll `test` until it is truthy or `ms` ran out; resolves its last value. */
async function waitFor(test, ms) {
  const end = Date.now() + ms;
  let value = test();
  while (!value && Date.now() < end) {
    await sleep(POLL_MS);
    value = test();
  }
  return value;
}

/** The row as the record holds it now (re-read after every relay call). */
function freshOp(message, opId) {
  const live = globalThis.game?.messages?.get?.(message?.id) ?? message;
  return getResolution(live)?.ops?.[opId] ?? null;
}

/** A relay refusal or failure as text: i18n keys (DSAUTO.*) are localized, anything else shown as is. */
function errorText(err) {
  const msg = String(err?.message ?? err ?? "");
  return msg.startsWith("DSAUTO.") ? loc(msg) : msg;
}

/**
 * Can this client place for the summoner now? Null when it can, else the warning text. Previews are always
 * built on canvas.scene (CL/canvas/layers/tokens.mjs:884), so the summoner's scene and level must be viewed.
 */
function canvasProblem(summonerDoc, anchorDoc, origin) {
  if (!summonerDoc) return loc("DSAUTO.Reason.summonerGone");
  if (!anchorDoc) return loc(origin === "target" ? "DSAUTO.Reason.noAnchor" : "DSAUTO.Reason.summonerGone");
  if (anchorDoc.parent?.id !== summonerDoc.parent?.id) return loc("DSAUTO.Reason.wrongScene");
  const cv = globalThis.canvas;
  const scene = cv?.scene;
  if (!scene || typeof cv?.tokens?.placeTokens !== "function" || summonerDoc.parent?.id !== scene.id) return loc("DSAUTO.Summon.NeedsCanvas");
  const viewed = cv.level?.id ?? null;
  if (viewed && summonerDoc.level && viewed !== summonerDoc.level) return loc("DSAUTO.Summon.NeedsCanvas");
  if (gridKind(scene) === "hex") return loc("DSAUTO.Summon.Picker.gridUnsupported");
  return null;
}

/* -------------------------------------------- */
/*  The row's Summon button                      */
/* -------------------------------------------- */

/**
 * The row's Summon button (resolution-part dsAutoSummon), on the clicking client: choose, prepare, pick, relay
 * apply with places, warn on refusal. `request` = partActions.request (relay requestOp). Never throws.
 */
export async function runSummonPick({ message, res, op, request }) {
  if (!message?.id || !op?.opId || typeof request !== "function") return;
  const key = `${message.id}:${op.opId}`;
  if (busy.has(key)) return;                                      // double click: the first picker goes on
  busy.add(key);
  try {
    // A Director with summonPlacement "auto" (a row offering several stat blocks): choose, then the GM searches.
    if (game.user?.isGM && globalThis.game?.settings?.get?.(MODULE_ID, "summonPlacement") === "auto") {
      const uuid = await chooseActor(op);
      if (!uuid) return;
      const out = await request({ action: "apply", messageId: message.id, opIds: [op.opId], places: { [op.opId]: { actor: uuid } } });
      const after = freshOp(message, op.opId);
      log("summon.pick", { messageId: message.id, opId: op.opId, outcome: after?.status ?? null, auto: true });
      if (after?.status !== "applied" || out?.refused?.length) warn(loc("DSAUTO.Summon.Refused", { why: summonReasonText(after?.reason) }));
      return;
    }
    const summonerDoc = lookup(op.summonerTokenUuid);
    const anchorDoc = op.origin === "target" ? lookup(op.anchorTokenUuid) : summonerDoc;
    const problem = canvasProblem(summonerDoc, anchorDoc, op.origin);
    if (problem) {
      warn(problem);
      log("summon.pick", { messageId: message.id, opId: op.opId, outcome: "noCanvas" });
      return;
    }
    if (op.distance == null || !Number.isFinite(Number(op.distance))) {
      warn(loc("DSAUTO.Reason.noDistance"));
      return;
    }
    const uuid = await chooseActor(op);
    if (!uuid) return;
    let choice = (op.choices ?? []).find(c => c?.uuid === uuid) ?? null;
    if (!choice) return;

    // The resolve-time import failed (CH11): the GM prepares the row again (card action, one signed write).
    if (!choice.worldActorId) {
      await request({ action: "summonPrepare", messageId: message.id, opId: op.opId });
      choice = (freshOp(message, op.opId)?.choices ?? []).find(c => c?.uuid === uuid) ?? null;
      if (!choice?.worldActorId) {
        warn(loc("DSAUTO.Reason.noWorldActor"));
        return;
      }
    }

    // Probe P1 negative (CH8): this client does not hold the world actor. Ask for OWNER on it, wait briefly;
    // the stand-in preview covers the rest (the GM creates the real summon either way).
    const worldActorId = choice.worldActorId;
    if (!game.actors?.get?.(worldActorId) && !game.user?.isGM) {
      try {
        await request({ action: "summonPrepare", messageId: message.id, opId: op.opId, grant: true });
      } catch (err) {
        debug("summon.grantFailed", { opId: op.opId, why: String(err?.message ?? err) });
      }
      await waitFor(() => game.actors?.get?.(worldActorId), GRANT_WAIT_MS);
    }

    const quantity = Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(op.quantity) || 1)));
    const { data, standIn } = await buildPreviews({ choice, summonerDoc, anchorDoc, quantity });
    // Review fix: the dialog, the relay calls and the grant wait may have changed the viewed scene or level (the GM
    // pulled the players elsewhere): the previews and the occupancy would be another map's. Checked again here.
    const later = canvasProblem(lookup(op.summonerTokenUuid), op.origin === "target" ? lookup(op.anchorTokenUuid) : lookup(op.summonerTokenUuid), op.origin);
    if (later) {
      warn(later);
      log("summon.pick", { messageId: message.id, opId: op.opId, outcome: "noCanvas" });
      return;
    }
    log("summon.preview", { mode: standIn ? "standIn" : "worldActor", name: choice.name, quantity });
    const squares = await pickSquares({ op: { ...op, quantity }, choice, summonerDoc, anchorDoc, previews: data });
    if (!squares?.length) {
      log("summon.pick", { messageId: message.id, opId: op.opId, outcome: "cancelled" });
      return;                                                     // Esc or every preview skipped: nothing sent
    }

    const out = await request({
      action: "apply", messageId: message.id, opIds: [op.opId],
      places: { [op.opId]: { actor: uuid, squares } },
    });
    const after = freshOp(message, op.opId);
    log("summon.pick", { messageId: message.id, opId: op.opId, outcome: after?.status ?? null, placed: squares.length });
    if (after?.status !== "applied" || out?.refused?.length) {
      warn(loc("DSAUTO.Summon.Refused", { why: summonReasonText(after?.reason) }));
    }
  } catch (err) {
    const text = errorText(err);
    if (text) warn(text);
    if (!String(err?.message ?? "").startsWith("DSAUTO.")) error("summons.pick", err, { opId: op?.opId });
  } finally {
    busy.delete(key);
  }
}

/* -------------------------------------------- */
/*  Choice dialog                                */
/* -------------------------------------------- */

/**
 * Choose one of several stat blocks (DialogV2: one radio per choice with its art, name and label, and a Summon
 * button); the only one without a dialog; null when cancelled or closed.
 * @param {{choices: object[]}} op
 * @returns {Promise<string|null>} the chosen uuid
 */
export async function chooseActor(op) {
  const choices = (op?.choices ?? []).filter(c => typeof c?.uuid === "string" && c.uuid);
  if (!choices.length) return null;
  if (choices.length === 1) return choices[0].uuid;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return null;
  const rows = choices.map((c, i) => {
    const img = c.img ? `<img src="${esc(c.img)}" alt="" width="36" height="36">` : "";
    const label = c.label ? `<span class="ds-auto-summon-choice-label">${esc(c.label)}</span>` : "";
    return `<li><label class="ds-auto-summon-choice-row"><input type="radio" name="ds-auto-summon-choice" value="${i}"${i === 0 ? " checked" : ""}>`
      + `${img}<span class="ds-auto-summon-choice-name">${esc(c.name ?? c.uuid)}</span>${label}</label></li>`;
  }).join("");
  const read = (_event, button) => {
    const picked = Number(button?.form?.querySelector?.('input[name="ds-auto-summon-choice"]:checked')?.value);
    return Number.isInteger(picked) && picked >= 0 && picked < choices.length ? choices[picked].uuid : null;
  };
  try {
    const result = await DialogV2.wait({
      window: { title: "DSAUTO.Summon.ChooseTitle", icon: "fa-solid fa-person-circle-plus" },
      classes: ["ds-auto-summon-dialog"],
      position: { width: 380 },
      content: `<div class="ds-auto-summon-choice"><p>${esc(loc("DSAUTO.Summon.ChooseIntro"))}</p><ul>${rows}</ul></div>`,
      rejectClose: false,
      buttons: [{ action: "summon", label: "DSAUTO.Summon.ChooseTitle", icon: "fa-solid fa-person-circle-plus", default: true, callback: read }],
    });
    return typeof result === "string" && choices.some(c => c.uuid === result) ? result : null;
  } catch (err) {
    error("summons.chooseActor", err);
    return null;
  }
}

/* -------------------------------------------- */
/*  Previews                                     */
/* -------------------------------------------- */

/** `count` independent copies of a preview's source data. */
function copies(d, count) {
  const out = [];
  for (let k = 0; k < count; k++) out.push(foundry.utils?.deepClone ? foundry.utils.deepClone(d) : structuredClone(d));
  return out;
}

/**
 * Preview data: from the world actor with a LOCAL delta.ownership (never written anywhere, R§ C4), else the
 * stand-in (probe P2 negative, or the world actor still missing on this client). The previews sit at the elevation
 * of the square frame's origin (`anchorDoc`, the summoner for origin "self"): the range is measured from it, so a
 * target-origin summon next to an anchor at another elevation than the summoner's stays in range.
 * @returns {Promise<{data: object[], standIn: boolean}>}
 */
export async function buildPreviews({ choice, summonerDoc, anchorDoc = null, quantity }) {
  const count = Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(quantity) || 1)));
  const elevation = (anchorDoc ?? summonerDoc).elevation ?? 0;
  const base = {
    x: summonerDoc.x, y: summonerDoc.y, elevation, level: summonerDoc.level ?? null, rotation: 0,
  };
  const actor = choice?.worldActorId ? game.actors?.get?.(choice.worldActorId) ?? null : null;
  if (actor && typeof actor.getTokenDocument === "function") {
    try {
      const userId = game.user?.id;
      const td = await actor.getTokenDocument({ ...base, delta: { ownership: { [userId]: 3 } } }, { parent: globalThis.canvas?.scene });
      if (td?.isOwner) {
        const d = td.toObject();
        delete d._id;
        d.width = sizeOf(d.width);
        d.height = sizeOf(d.height);
        d.hidden = false;
        return { data: copies(d, count), standIn: false };
      }
    } catch (err) {
      debug("summon.previewFailed", { actor: actor.name, why: String(err?.message ?? err) });
    }
  }
  return { data: copies({ ...standInData({ choice, summonerDoc }), elevation }, count), standIn: true };
}

/**
 * Stand-in preview data from the summoner's token (always owned by the summoner's owner) with the summon's size,
 * art and name. Pure. Never created: the GM builds the real token from the world actor.
 */
export function standInData({ choice, summonerDoc }) {
  const d = summonerDoc.toObject();
  delete d._id;
  d.name = choice?.name ?? d.name;
  d.width = sizeOf(choice?.width);
  d.height = sizeOf(choice?.height);
  d.texture = { ...(d.texture ?? {}), src: choice?.img || d.texture?.src };
  d.ring = { ...(d.ring ?? {}), enabled: false };
  d.sight = { ...(d.sight ?? {}), enabled: false };
  d.hidden = false;
  d.rotation = 0;
  return d;
}

/* -------------------------------------------- */
/*  The picker                                   */
/* -------------------------------------------- */

/**
 * placeTokens(create:false) with the synchronous preConfirm and the preCommit re-check; null on Esc / nothing
 * placed. `op` needs `quantity` and `distance`. The squares are {x, y, elevation, level, rotation}.
 * @returns {Promise<object[]|null>}
 */
export async function pickSquares({ op, choice, summonerDoc, anchorDoc, previews }) {
  const cv = globalThis.canvas;
  const scene = cv?.scene;
  if (!scene || typeof cv?.tokens?.placeTokens !== "function" || !previews?.length) return null;
  const origin = originOf(anchorDoc);
  const level = summonerDoc.level ?? null;
  const size = { width: sizeOf(choice?.width), height: sizeOf(choice?.height) };
  const distance = Number(op.distance);
  // Q15: the player's picker never reveals hidden tokens it does not own (the GM still refuses them).
  const occupied = occupiedRects(scene, { level, viewer: game.user?.isGM ? null : game.user });
  const taken = [];
  info(loc("DSAUTO.Summon.Picker.Hint", { name: choice?.name ?? "", count: previews.length, distance }));

  // SYNCHRONOUS: core does not await it (CL/canvas/layers/tokens.mjs:1183-1190), only `=== false` blocks.
  const preConfirm = ({ document }) => {
    try {
      const s = document?._source ?? {};
      const square = { x: s.x, y: s.y, elevation: s.elevation ?? 0, level: s.level ?? level };
      const why = checkSquare({ scene, origin, square, size, distance, level, taken, occupied });
      if (why) {
        warnThrottled(loc(`DSAUTO.Summon.Picker.${why}`));
        return false;
      }
      taken.push(rectOf({ x: s.x, y: s.y, ...size }, scene));
      return true;
    } catch (err) {
      error("summons.preConfirm", err);
      return false;
    }
  };
  // Awaited by core (:1237-1241): nothing placed resolves [] (every preview skipped).
  const preCommit = async placed => (placed?.length ?? 0) > 0;

  const placed = await cv.tokens.placeTokens(previews, { create: false, allowRotation: true, preConfirm, preCommit });
  if (!Array.isArray(placed) || !placed.length) return null;
  return placed.map(d => {
    const s = d?._source ?? d ?? {};
    return { x: s.x, y: s.y, elevation: s.elevation ?? 0, level: s.level ?? level, rotation: Number.isFinite(s.rotation) ? s.rotation : 0 };
  });
}

/* -------------------------------------------- */
/*  api.summon (Director)                        */
/* -------------------------------------------- */

/**
 * Director's api.summon pick on the calling GM's canvas (compendium prototype previews, `actorId: null`).
 * Throws DSAUTO.Relay.Denied for a non-GM before any picker (core placeTokens would throw "You must be an owner"
 * on actorless previews, CL/canvas/layers/tokens.mjs:887). Resolves {actor, squares} or null (cancelled, not on
 * the canvas, no stat block).
 * @param {object} args
 * @param {TokenDocument} args.summonerDoc
 * @param {TokenDocument} [args.anchorDoc]       origin "target": the anchor; else the summoner
 * @param {{uuid: string, name?: string, img?: string, width?: number, height?: number}} args.choice
 * @param {number} args.quantity
 * @param {number} args.distance
 * @param {"self"|"target"} [args.origin]        "target" with no anchorDoc: the anchor is gone (noAnchor)
 */
export async function pickForApi({ summonerDoc, anchorDoc = null, choice, quantity, distance, origin = null }) {
  if (!game.user?.isGM) throw new Error("DSAUTO.Relay.Denied");
  const target = origin === "target" || (!!anchorDoc && anchorDoc !== summonerDoc);
  const anchor = target ? anchorDoc : summonerDoc;
  const problem = canvasProblem(summonerDoc, anchor, target ? "target" : "self");
  if (problem) {
    warn(problem);
    return null;
  }
  if (!Number.isFinite(Number(distance))) {
    warn(loc("DSAUTO.Reason.noDistance"));
    return null;
  }
  let doc = null;
  try {
    doc = choice?.uuid ? await fromUuid(choice.uuid) : null;
  } catch (err) {
    debug("summon.apiPickActor", { uuid: choice?.uuid ?? null, why: String(err?.message ?? err) });
  }
  // Review fix: the viewed scene or level may have changed while the stat block loaded.
  const later = canvasProblem(summonerDoc, anchor, target ? "target" : "self");
  if (later) {
    warn(later);
    return null;
  }
  const proto = doc?.prototypeToken;
  if (!proto) {
    warn(loc("DSAUTO.Reason.noWorldActor"));
    return null;
  }
  const d = typeof proto.toObject === "function" ? proto.toObject() : foundry.utils.deepClone(proto);
  delete d._id;
  const width = sizeOf(choice.width ?? d.width);
  const height = sizeOf(choice.height ?? d.height);
  Object.assign(d, {
    actorId: null, x: summonerDoc.x, y: summonerDoc.y, elevation: anchor.elevation ?? 0,
    level: summonerDoc.level ?? null, rotation: 0, width, height, hidden: false,
  });
  const count = Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(quantity) || 1)));
  const c = { uuid: choice.uuid, name: choice.name ?? doc.name ?? "", img: choice.img ?? d.texture?.src ?? null, width, height };
  const squares = await pickSquares({ op: { quantity: count, distance: Number(distance) }, choice: c, summonerDoc, anchorDoc: anchor, previews: copies(d, count) });
  log("summon.apiPick", { name: c.name, placed: squares?.length ?? 0 });
  return squares?.length ? { actor: choice.uuid, squares } : null;
}

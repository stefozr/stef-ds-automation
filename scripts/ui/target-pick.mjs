/**
 * Target picks (Milestone 9, docs/M9-DESIGN.md §A, D2): the creature(s) of a `targets: "pick"` effect are picked by the
 * ability user's owner at resolve time.
 *
 * - The plan (library-plan pickRow) leaves a placeholder `pick` row on the user's own row. After the resolve write (and
 *   after a choice-group pick) the active GM runs `offerPicks`: every pending pick row not offered yet is marked
 *   (`res.pickAsked[opId]`, engine.mjs notePicksAsked: a reload never asks twice) and offered to an owner of the user
 *   (the card's author when they own it, else the first active owner; the Director's own dialog without one) as the
 *   prompt `targetPick` (122 s). Its answer goes to engine.mjs recordPick, which checks it against `pickCandidates`
 *   recomputed on the GM and resolves the card again: real rows appear for the picked creature(s).
 * - Unanswered (closed, timed out, offline): the row's Pick button (resolution-part `dsAutoPick`) opens the same picker
 *   on the clicking client (`localPick`) and relays `pick` (relay/queries.mjs; relay/auth.mjs isOwnPick).
 * - The picker: Combat Tools' `colorTokenPicker` when one creature is picked and every candidate is on this canvas,
 *   else a checkbox list; a damage-type select when the effect lets the picker choose one (`pick.damageTypes`).
 *
 * `pickCandidates` is pure (both sides compute the same list): scene tokens with an actor that are creatures, not
 * hidden, never the user, within `pick.within` squares of the anchor (the user's token, or the card's first real
 * target: library-plan pickRow), of the side `pick.filter` names, at most MAX_CANDIDATES.
 * No engine imports (resolution-part.mjs imports this file): engine.mjs hands `recordPick` and `notePicksAsked` to
 * `offerPicks`.
 *
 * i18n keys: DSAUTO.Pick.{Title, Intro, Hint, DamageType, Confirm, None, TooMany}, DSAUTO.Relay.{Denied, BadRequest}.
 */
import { OP_STATUS, QUERY_PROMPT, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { distanceSquares, notCreature, relation } from "../triggers/eligibility.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { routePrompt } from "../relay/prompt-router.mjs";
import { dsctApi } from "../compat/dsct.mjs";
import { error, log } from "../log.mjs";

export const MAX_CANDIDATES = 60;
/** The GM waits this long for the owner; the owner's dialog closes a little earlier. */
export const PICK_ASK_MS = 122_000;
const DIALOG_MS = 120_000;
const MAX_PICK = 5;
const TYPE_RE = /^[a-z]{1,20}$/;

const list = c => c?.contents ?? [...(c ?? [])];
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const esc = v => {
  const fn = globalThis.foundry?.utils?.escapeHTML;
  return typeof fn === "function" ? fn(String(v ?? "")) : String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
};

function doc(uuid) {
  if (typeof uuid !== "string" || !uuid || uuid.length >= 300) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * The creatures a pick row may pick now: `[{tokenUuid, name, img}]` (see the header). Pure; the GM recomputes it to
 * check an answer (engine.mjs recordPick).
 * @param {object} op    The pick row (`op.pick`).
 * @param {object} res   The card's record.
 * @returns {{tokenUuid: string, name: string, img: string|null}[]}
 */
export function pickCandidates(op, res) {
  const p = op?.pick;
  const anchor = doc(p?.anchorTokenUuid);
  const scene = anchor?.parent;
  if (!p || !scene) return [];
  const within = Math.max(0, Number(p.within) || 0);
  const userToken = doc(res?.sourceTokenUuid);
  const userActorUuid = res?.sourceActorUuid ?? null;
  const out = [];
  for (const t of list(scene.tokens)) {
    if (!t?.actor || t.hidden || notCreature(t.actor)) continue;
    if (t.actor.uuid === userActorUuid || (userToken && t.uuid === userToken.uuid)) continue;
    if (distanceSquares(anchor, t) > within) continue;
    if (p.filter) {
      const rel = relation(userToken, t);
      if (p.filter === "allies" ? rel !== "ally" : rel !== "enemy") continue;
    }
    out.push({ tokenUuid: t.uuid, name: String(t.name ?? t.actor.name ?? "").slice(0, 100), img: t.texture?.src ?? t.actor.img ?? null });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** The text of the picker: "Practical Magic: pick up to 1 creature(s) within 10 squares of the caster." */
function introOf(op, res) {
  const p = op?.pick ?? {};
  const anchorName = (p.of === "target" ? res?.targets?.[op.anchorKey]?.name : null) ?? doc(p.anchorTokenUuid)?.name ?? "";
  return loc("DSAUTO.Pick.Intro", { ability: res?.abilityName ?? "", count: p.count ?? 1, distance: p.within ?? 0, name: anchorName });
}

/** The damage-type select (empty without `damageTypes`). */
function typeSelect(damageTypes) {
  if (!damageTypes?.length) return "";
  const label = t => {
    const key = globalThis.ds?.CONFIG?.damageTypes?.[t]?.label;
    return key ? game.i18n.localize(key) : t;
  };
  const options = damageTypes.map(t => `<option value="${esc(t)}">${esc(label(t))}</option>`).join("");
  return `<div class="form-group"><label>${esc(loc("DSAUTO.Pick.DamageType"))}</label><div class="form-fields"><select name="damageType">${options}</select></div></div>`;
}

/** A small dialog for the damage type alone (after Combat Tools' token picker). */
async function askType(label, damageTypes, timeoutMs) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.input) return null;
  let dialog = null;
  let timer = null;
  try {
    const data = await DialogV2.input({
      window: { title: loc("DSAUTO.Pick.Title", { label }), icon: "fa-solid fa-crosshairs" },
      content: typeSelect(damageTypes),
      ok: { label: "DSAUTO.Pick.Confirm", icon: "fa-solid fa-crosshairs" },
      rejectClose: false,
      render: (_event, app) => {
        dialog = app;
        timer = setTimeout(() => app.close(), timeoutMs);
      },
    });
    return damageTypes.includes(data?.damageType) ? data.damageType : null;
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timer);
    if (dialog?.rendered) await dialog.close();
  }
}

/**
 * The picker on this client: `{tokenUuids, damageType}`, or null when closed, empty, too many or timed out.
 * @param {{label: string, intro: string, count: number, candidates: object[], damageTypes: string[], timeoutMs?: number}} args
 */
export async function pickDialog({ label = "", intro = "", count = 1, candidates = [], damageTypes = [], timeoutMs = DIALOG_MS } = {}) {
  if (!candidates.length) {
    ui.notifications?.warn?.(loc("DSAUTO.Pick.None", { label }));
    return null;
  }
  const max = Math.max(1, Math.min(Number(count) || 1, MAX_PICK));
  // One creature, all on this canvas: Combat Tools' picker (it resolves on a click on a highlighted token).
  const api = dsctApi();
  const sceneId = globalThis.canvas?.scene?.id ?? null;
  const placeables = candidates.map(c => doc(c.tokenUuid)).map(d => (d && d.parent?.id === sceneId ? d.object : null));
  if (max === 1 && typeof api?.colorTokenPicker === "function" && placeables.every(Boolean)) {
    let picked = null;
    try {
      picked = await api.colorTokenPicker({ tokens: placeables, title: label, hint: loc("DSAUTO.Pick.Hint") });
    } catch (err) {
      error("pick.picker", err);
      picked = null;
    }
    const uuid = picked?.document?.uuid ?? null;
    if (!uuid || !candidates.some(c => c.tokenUuid === uuid)) return null;
    if (!damageTypes.length) return { tokenUuids: [uuid], damageType: null };
    const damageType = await askType(label, damageTypes, timeoutMs);
    return damageType ? { tokenUuids: [uuid], damageType } : null;
  }
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return null;
  const rows = candidates.map((c, i) => `<label class="checkbox"><input type="checkbox" name="t-${i}"> ${esc(c.name)}</label>`).join("");
  let dialog = null;
  let timer = null;
  let result = null;
  try {
    result = await DialogV2.wait({
      window: { title: loc("DSAUTO.Pick.Title", { label }), icon: "fa-solid fa-crosshairs" },
      content: `<p>${esc(intro)}</p><div class="ds-auto-pick-list">${rows}</div>${typeSelect(damageTypes)}`,
      buttons: [{
        action: "pick", label: "DSAUTO.Pick.Confirm", icon: "fa-solid fa-crosshairs", default: true,
        callback: (_e, button) => {
          const data = new foundry.applications.ux.FormDataExtended(button.form).object;
          const tokenUuids = candidates.filter((_c, i) => data[`t-${i}`]).map(c => c.tokenUuid);
          return { tokenUuids, damageType: data.damageType ?? null };
        },
      }],
      rejectClose: false,
      render: (_event, app) => {
        dialog = app;
        timer = setTimeout(() => app.close(), timeoutMs);
      },
    });
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timer);
    if (dialog?.rendered) await dialog.close();
  }
  if (!result?.tokenUuids?.length) return null;
  if (result.tokenUuids.length > max) {
    ui.notifications?.warn?.(loc("DSAUTO.Pick.TooMany", { count: max }));
    return null;
  }
  if (damageTypes.length && !damageTypes.includes(result.damageType)) return null;
  return { tokenUuids: result.tokenUuids, damageType: damageTypes.length ? result.damageType : null };
}

/** The row's Pick button (resolution-part `dsAutoPick`): the picker here, from this client's own candidates. */
export async function localPick(op, res) {
  const p = op?.pick ?? {};
  return pickDialog({
    label: op?.label ?? "", intro: introOf(op, res), count: p.count ?? 1, candidates: pickCandidates(op, res), damageTypes: p.damageTypes ?? [],
  });
}

/** The payload checks of `targetPick` (types and lengths; ownership is checked by the handler). */
export function validTargetPick(p) {
  return !!p && typeof p === "object" && p.type === "targetPick" && str(p.messageId, 64) && str(p.opId, 300) && optStr(p.label, 200)
    && Number.isInteger(p.count) && p.count >= 1 && p.count <= MAX_PICK
    && Array.isArray(p.candidates) && p.candidates.length >= 1 && p.candidates.length <= MAX_CANDIDATES
    && p.candidates.every(c => !!c && typeof c === "object" && str(c.tokenUuid, 299) && optStr(c.name, 100) && optStr(c.img, 500))
    && Array.isArray(p.damageTypes) && p.damageTypes.length <= 10 && p.damageTypes.every(t => typeof t === "string" && TYPE_RE.test(t));
}

/**
 * Owner side of `targetPick`: the active GM sends it; this user owns the ability's user. Answers `{tokenUuids,
 * damageType}` (empty `tokenUuids`: closed or timed out).
 */
export async function handleTargetPick(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  if (!validTargetPick(payload)) throw new Error("DSAUTO.Relay.BadRequest");
  const res = getResolution(game.messages.get(payload.messageId));
  const op = res?.ops?.[payload.opId];
  if (!op || op.kind !== "pick") throw new Error("DSAUTO.Relay.BadRequest");
  const source = doc(res.sourceActorUuid);
  if (!source?.isOwner) throw new Error("DSAUTO.Relay.Denied");
  const candidates = payload.candidates.filter(c => !!doc(c.tokenUuid)).map(c => ({ tokenUuid: c.tokenUuid, name: c.name ?? "", img: c.img ?? null }));
  const answer = await pickDialog({
    label: payload.label ?? "", intro: introOf(op, res), count: payload.count, candidates, damageTypes: payload.damageTypes,
  });
  return answer ?? { tokenUuids: [], damageType: null };
}

/** Who picks: an owner of the ability's user (the card's author first), else the active GM. */
function recipientFor(message, res) {
  const actor = doc(res?.sourceActorUuid);
  const author = message?.author ?? game.users.get(res?.authorUserId);
  const owners = actor?.type === "npc" ? [] : ownersOf(actor);
  return owners.find(u => u.id === author?.id) ?? owners[0] ?? game.users.activeGM;
}

/** Offer one pick row and record the answer (active GM; never throws). */
async function askTargetPick(message, op, res, { recordPick }) {
  const candidates = pickCandidates(op, res);
  if (!candidates.length) {
    log("pick.noCandidates", { messageId: message.id, opId: op.opId });
    return;
  }
  const recipient = recipientFor(message, res);
  if (!recipient) return;
  const payload = {
    type: "targetPick", messageId: message.id, opId: op.opId, label: String(op.label ?? "").slice(0, 200),
    count: Math.max(1, Math.min(Number(op.pick?.count) || 1, MAX_PICK)), candidates, damageTypes: [...(op.pick?.damageTypes ?? [])],
  };
  let answer = null;
  try {
    answer = recipient.isSelf
      ? await routePrompt(payload, { user: game.user })
      : await recipient.query(QUERY_PROMPT, payload, { timeout: PICK_ASK_MS });
  } catch (_err) {
    answer = null;   // timed out or offline: the row's Pick button stays
  }
  const tokenUuids = Array.isArray(answer?.tokenUuids) ? answer.tokenUuids.filter(u => typeof u === "string").slice(0, MAX_PICK + 1) : [];
  if (!tokenUuids.length) return;
  const damageType = typeof answer.damageType === "string" ? answer.damageType : null;
  try {
    await recordPick(game.messages.get(message.id) ?? message, op.opId, { tokenUuids, damageType }, { userId: recipient.id });
  } catch (err) {
    log("pick.refused", { messageId: message.id, opId: op.opId, why: String(err?.message ?? err) });
  }
}

/**
 * Offer every pending pick row of a card that was not offered yet (active GM; after the resolve write and after a
 * choice). Marks them first (engine.mjs notePicksAsked), then sends the prompts without waiting for the answers.
 * @param {ChatMessage} message
 * @param {{recordPick: Function, notePicksAsked: Function}} engine   engine.mjs's own functions
 */
export async function offerPicks(message, { recordPick, notePicksAsked } = {}) {
  try {
    if (!message || typeof recordPick !== "function" || typeof notePicksAsked !== "function") return;
    const res = getResolution(message);
    if (!res?.resolvedAt) return;
    const open = Object.values(res.ops ?? {}).filter(op => op.kind === "pick" && op.status === OP_STATUS.PENDING && !op.awaitingChoice
      && !res.pickAsked?.[op.opId]);
    if (!open.length) return;
    const ids = await notePicksAsked(message, open.map(op => op.opId));
    const current = getResolution(game.messages.get(message.id) ?? message) ?? res;
    for (const id of ids) {
      const op = current.ops?.[id];
      if (op) askTargetPick(message, op, current, { recordPick }).catch(err => error("pick.ask", err));
    }
  } catch (err) {
    error("pick.offer", err);
  }
}

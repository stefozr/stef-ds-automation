/**
 * Resource-scaled feature benefits (1.2.0, docs/AUTHORING.md "scaling"). Used by the Null's Metakinetic Mastery and any
 * class feature whose overlay carries `scaling`. Everything is computed when it is used (a roll, a forced move, an
 * ability use), never stored as an effect, so a benefit turns on and off as the hero's heroic resource changes.
 *
 * - Level: Draw Steel 1.2 tracks `system.hero.primary.tracking` (the highest value reached this turn; it is what class
 *   features such as Metakinetic Mastery read); 1.1.x has only `primary.value`. `resourceLevel` takes the tracking
 *   when the field is a number, else the value.
 * - Tiers: a list of `{minResource, abilities?, ...}`; the entry with the highest `minResource` reached (and whose
 *   `abilities` name the ability's dsid, when given) replaces the lesser ones. Benefits never stack across tiers.
 * - `rollEdges` {minResource, abilities?, edges}: edges added to the hero's own power rolls (getActorModifiers wrapper).
 * - `forcedBonus` {minResource, abilities?, bonus (formula)}: squares added to every forced movement the hero causes
 *   (engine/plan.mjs buildForcedOp, so Combat Tools delegated moves carry them).
 * - `useBenefits` {minResource, category?, temporaryStamina}: temporary Stamina when the hero uses an ability of that
 *   category (not stacked: the higher of the current pool and the amount).
 * - `offers` {after, ability, free}: after the hero uses ability `after`, a card offers `ability` as a free
 *   "triggered" | "maneuver" use (flag freeTriggered / freeManeuver on its card). The button runs `item.system.use()`.
 *
 * i18n keys: DSAUTO.Mastery.{OfferText, OfferUse, OfferUsed, OfferGone, OfferSpeaker}.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { findOverlay } from "../library/registry.mjs";
import { itemDsid, itemKey } from "../library/identity.mjs";
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";

const list = c => c?.contents ?? (Array.isArray(c) ? c : (c ? [...c] : []));
const esc = v => {
  const s = String(v ?? "");
  const fn = globalThis.foundry?.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};

/** The hero's heroic resource for thresholds: tracking (1.2) when it is a number, else the current value (1.1.x). */
export function resourceLevel(actor) {
  const p = actor?.system?.hero?.primary;
  const tracking = p?.tracking;
  if (typeof tracking === "number" && Number.isFinite(tracking)) return tracking;
  const value = Number(p?.value);
  return Number.isFinite(value) ? value : 0;
}

const active = () => setting("enabled") !== false && setting("libraryEnabled") !== false;

/** The `scaling` blocks of the class features a hero owns (disabled items and NPCs skipped). */
export function scalingOf(actor) {
  if (!actor || actor.type !== "hero" || !active()) return [];
  const out = [];
  const seen = new Set();
  for (const item of list(actor.items)) {
    if (item?.type !== "feature") continue;
    const key = itemKey(item);
    if (!key || seen.has(key) || item.flags?.[MODULE_ID]?.disabled) continue;
    const scaling = findOverlay(item, actor)?.scaling;
    if (!scaling) continue;
    seen.add(key);
    out.push(scaling);
  }
  return out;
}

/** The dsid of an ability data model or item. */
export function abilityDsid(ability) {
  const direct = ability?._dsid || ability?.system?._dsid;
  if (direct) return String(direct);
  // An ability data model's parent is its Item; an Item's parent is an Actor.
  return itemDsid(ability?.parent?.type === "ability" ? ability.parent : ability);
}

/** The tier that applies: highest `minResource` reached among the entries naming the ability (or none). */
export function pickTier(entries, level, dsid) {
  let best = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!(level >= Number(e?.minResource ?? 0))) continue;
    if (Array.isArray(e.abilities) && !e.abilities.includes(dsid)) continue;
    if (!best || Number(e.minResource ?? 0) >= Number(best.minResource ?? 0)) best = e;
  }
  return best;
}

/** Edges the hero's features add to a power roll of this ability. */
export function rollEdgesFor(actor, dsid) {
  let n = 0;
  const level = resourceLevel(actor);
  for (const s of scalingOf(actor)) n += Number(pickTier(s.rollEdges, level, dsid)?.edges ?? 0) || 0;
  return n;
}

/** Squares the hero's features add to a forced movement of this ability; `evaluate(formula)` -> number|null. */
export function forcedBonusFor(actor, dsid, evaluate) {
  let n = 0;
  const level = resourceLevel(actor);
  for (const s of scalingOf(actor)) {
    const tier = pickTier(s.forcedBonus, level, dsid);
    if (!tier) continue;
    const v = Number(evaluate(String(tier.bonus)));
    if (Number.isFinite(v)) n += Math.floor(v);
  }
  return Math.max(0, n);
}

/** Temporary Stamina the hero gains from using this ability (the best tier of each feature, highest wins). */
export function useBenefitFor(actor, ability) {
  const level = resourceLevel(actor);
  let temp = 0;
  for (const s of scalingOf(actor)) {
    let best = null;
    for (const e of Array.isArray(s.useBenefits) ? s.useBenefits : []) {
      if (!(level >= Number(e?.minResource ?? 0))) continue;
      if (e.category && e.category !== ability?.category) continue;
      if (!best || Number(e.minResource ?? 0) >= Number(best.minResource ?? 0)) best = e;
    }
    temp = Math.max(temp, Number(best?.temporaryStamina ?? 0) || 0);
  }
  return temp;
}

/** Grant the use benefits (temporary Stamina; not stacked). Never throws. */
export async function applyUseBenefits(ability, actor) {
  try {
    const temp = useBenefitFor(actor, ability);
    if (!(temp > 0) || !actor?.update) return 0;
    const current = Number(actor.system?.stamina?.temporary ?? 0) || 0;
    if (current >= temp) return 0;
    await actor.update({ "system.stamina.temporary": temp });
    log("mastery.tempStamina", { actor: actor.name, ability: abilityDsid(ability), temp });
    return temp;
  } catch (err) {
    error("mastery.tempStamina", err, { actor: actor?.name });
    return 0;
  }
}

/** The offers a hero's features make after it uses the ability with this dsid. */
export function offersAfter(actor, dsid) {
  const out = [];
  for (const s of scalingOf(actor)) for (const o of Array.isArray(s.offers) ? s.offers : []) if (o?.after === dsid) out.push(o);
  return out;
}

/** Items of an offer that the user is waiting to use for free (item uuid -> offer). */
const freeUses = new Map();
/** Is this ability use the one an offer card started? Consumed by the caller (featureAbilityUse). */
export function takeFreeUse(itemUuid) {
  const offer = freeUses.get(itemUuid);
  freeUses.delete(itemUuid);
  return offer ?? null;
}

/** Post the offer cards after `ability` was used. Never throws. */
export async function offerAfterUse(ability, actor) {
  try {
    const dsid = abilityDsid(ability);
    for (const o of offersAfter(actor, dsid)) {
      const item = list(actor.items).find(i => i.type === "ability" && itemDsid(i) === o.ability);
      if (!item) continue;
      const content = `<div class="ds-auto-offer"><p>${esc(loc("DSAUTO.Mastery.OfferText", { name: item.name, from: ability.parent?.name ?? dsid }))}</p>`
        + `<button type="button" class="ds-auto-offer-use" data-ds-auto-offer><i class="fa-solid fa-hand-fist" inert></i> ${esc(loc("DSAUTO.Mastery.OfferUse", { name: item.name }))}</button></div>`;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker?.({ actor }) ?? { alias: actor.name },
        content, whisper: [game.user.id],
        flags: { [MODULE_ID]: { featureOffer: { actorUuid: actor.uuid, itemUuid: item.uuid, free: o.free ?? "triggered", used: false } } },
      });
    }
  } catch (err) {
    error("mastery.offer", err, { actor: actor?.name });
  }
}

/** Wire the button of a rendered offer card: only the actor's owner may use it, once. */
export function decorateOffer(message, root) {
  const offer = message?.flags?.[MODULE_ID]?.featureOffer;
  if (!offer || !root?.querySelectorAll) return 0;
  let n = 0;
  for (const button of root.querySelectorAll("[data-ds-auto-offer]")) {
    const owner = fromUuidSync?.(offer.actorUuid ?? "");
    if (offer.used || !owner?.isOwner) {
      button.disabled = true;
      continue;
    }
    if (button.dataset.dsAutoWired) continue;
    button.dataset.dsAutoWired = "1";
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      await useOffer(message, offer, button);
    });
    n++;
  }
  return n;
}

/** Run the offered ability as a free use (the offer is spent once its card is posted). */
export async function useOffer(message, offer, button = null) {
  if (button) button.disabled = true;
  try {
    const item = await fromUuid(offer.itemUuid);
    const actor = item?.actor;
    if (!item || actor?.uuid !== offer.actorUuid || !actor.isOwner || typeof item.system?.use !== "function") {
      globalThis.ui?.notifications?.warn?.(loc("DSAUTO.Mastery.OfferGone"));
      return null;
    }
    freeUses.set(item.uuid, offer);
    let result = null;
    try { result = await item.system.use({}); } finally { freeUses.delete(item.uuid); }
    if (result) await message?.update?.({ [`flags.${MODULE_ID}.featureOffer.used`]: true });
    else if (button) button.disabled = false;
    return result;
  } catch (err) {
    error("mastery.offerUse", err, { item: offer?.itemUuid });
    if (button) button.disabled = false;
    return null;
  }
}

/** init: wire the offer cards on every client. */
export function registerMasteryUI() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      if (!message?.flags?.[MODULE_ID]?.featureOffer) return;
      const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
      decorateOffer(message, root);
    } catch (err) {
      error("mastery.offerRender", err, { messageId: message?.id ?? null });
    }
  });
}

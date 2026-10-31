/**
 * 0.13.0: Combat Tools' own "X teleported N squares" message (with its Undo Teleport button) for a teleport our card
 * drove is folded to one muted line (client setting `foldDetails`): the card's row already shows the teleport and
 * its Undo. The message is tagged on the client that created it (the one that ran our awaited `api.teleport`,
 * delegation/teleport.mjs expectations), flag `flags["stef-ds-automation"].foldedTeleport = {card, opId}`. Teleports
 * started from Combat Tools' own buttons carry no expectation and stay as they are.
 * Combat Tools' Undo Teleport stays in the DOM (its own panel row clicks it) and is one click away: our row's
 * Undo only puts the tokens back, Combat Tools' also reverses fall damage and statuses from its undo log.
 */
import { DSCT_ID, MODULE_ID, loc } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { matchTeleportExpectation } from "../delegation/teleport.mjs";

export const FOLDED_TELEPORT_FLAG = "foldedTeleport";
const CLASS = "ds-auto-folded-teleport";
const OPEN = "ds-auto-folded-teleport--open";
const openTeleports = new Set();

const rootOf = html => (html instanceof HTMLElement ? html : html?.[0]);

/** Our flag patch for a Combat Tools teleport message created on this client, or null. */
export function foldPatch(message, userId, myId = game.userId) {
  if (userId !== myId) return null;
  const hit = matchTeleportExpectation(message?.flags?.[DSCT_ID]);
  return hit ? { [`flags.${MODULE_ID}.${FOLDED_TELEPORT_FLAG}`]: hit } : null;
}

/** Idempotent: fold class, open state and the expand toggle on a rendered teleport message. */
export function applyTeleportFold(message, li) {
  if (!li?.classList) return false;
  const fold = !!message?.flags?.[MODULE_ID]?.[FOLDED_TELEPORT_FLAG] && setting("foldDetails") !== false;
  li.classList.toggle(CLASS, fold);
  li.classList.toggle(OPEN, fold && openTeleports.has(message.id));
  const existing = li.querySelector?.(".ds-auto-tp-toggle");
  if (!fold) {
    existing?.remove?.();
    return false;
  }
  if (!existing) {
    const doc = li.ownerDocument ?? globalThis.document;
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "ds-auto-tp-toggle";
    btn.dataset.tooltip = loc("DSAUTO.Card.TeleportNoteExpand");
    btn.setAttribute("aria-label", loc("DSAUTO.Card.TeleportNoteExpand"));
    const icon = doc.createElement("i");
    icon.className = "fa-solid fa-chevron-down";
    icon.inert = true;
    btn.append(icon);
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (openTeleports.has(message.id)) openTeleports.delete(message.id);
      else openTeleports.add(message.id);
      li.classList.toggle(OPEN, openTeleports.has(message.id));
    });
    li.prepend(btn);
  }
  return true;
}

export function registerTeleportMessageFold() {
  Hooks.on("preCreateChatMessage", (message, _data, _options, userId) => {
    try {
      const patch = foldPatch(message, userId);
      if (patch) message.updateSource(patch);
    } catch (err) {
      console.warn(`${MODULE_ID} | teleport message fold`, err);
    }
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message?.flags?.[MODULE_ID]?.[FOLDED_TELEPORT_FLAG]) return;
    applyTeleportFold(message, rootOf(html));
  });
}

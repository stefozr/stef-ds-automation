/**
 * 1.2.0: Draw Steel: Death Tracker posts its own chat card for every death. When the death belongs to one of our
 * cards (the card's id is the death message's `cause.messageId`, noted before every op that can deal damage:
 * compat/death-tracker.mjs `noteCardCause`) the Automation box shows a "Fallen" row under that target instead and
 * Death Tracker's card is hidden (class `ds-auto-death-folded`, styles/ds-auto-compact.css). The box's Undo revives
 * as before (engine/undo.mjs, delegation/forced-movement.mjs). Deaths with no link (a manual Stamina edit, other
 * sources) keep Death Tracker's card.
 */
import { DT_ID } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { setting } from "../settings.mjs";

export const DEATH_FOLD_CLASS = "ds-auto-death-folded";
const RECENT = 300;

const rootOf = html => (html instanceof HTMLElement ? html : html?.[0]);
const dtFlags = message => message?.flags?.[DT_ID] ?? null;
export const isDeathMessage = message => !!dtFlags(message)?.isDeathMessage;

/** Pure: the token id (last uuid segment) of a record's target. */
export const tokenIdOfUuid = uuid => (typeof uuid === "string" && uuid ? uuid.split(".").pop() : null);

/**
 * Pure: the "Fallen" decision for one target. `messages` are chat messages (any); `isDefeated(tokenId)` reads the
 * token's current status. Returns `{ object }` or null.
 */
export function fallenFor({ cardId, tokenId, messages, isDefeated }) {
  if (!cardId || !tokenId || !isDefeated?.(tokenId)) return null;
  for (const m of messages ?? []) {
    const f = dtFlags(m);
    if (!f?.isDeathMessage || f.cause?.messageId !== cardId) continue;
    const entry = (f.deaths ?? []).find(d => d?.tokenId === tokenId);
    if (entry || (f.deadTokenIds ?? []).includes(tokenId)) return { object: !!entry?.isObject };
  }
  return null;
}

/**
 * Pure: hide Death Tracker's card? Only for a death message linked to an existing card with our record while the
 * suite is on.
 */
export function shouldHideDeathMessage(message, { getMessage, enabled = true } = {}) {
  if (!enabled || !isDeathMessage(message)) return false;
  const id = dtFlags(message).cause?.messageId;
  if (!id) return false;
  return !!getResolution(getMessage?.(id));
}

const recentMessages = () => game.messages?.contents?.slice(-RECENT) ?? [];

/** The "Fallen" entry of a record target on this client now, or null (buildView). */
export function fallenForTarget(message, target) {
  const tokenId = tokenIdOfUuid(target?.tokenUuid);
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  return fallenFor({
    cardId: message?.id, tokenId, messages: recentMessages(),
    isDefeated: () => {
      try {
        return !!fromUuidSync(target.tokenUuid)?.actor?.statuses?.has?.(defeated);
      } catch (_err) {
        return false;
      }
    },
  });
}

/** Idempotent: tag (or untag) a rendered death message. */
export function applyDeathFold(message, li) {
  if (!li?.classList) return false;
  const hide = shouldHideDeathMessage(message, { getMessage: id => game.messages?.get(id), enabled: setting("enabled") !== false });
  li.classList.toggle(DEATH_FOLD_CLASS, hide);
  return hide;
}

const pending = new Set();
let timer = null;

/** Re-render the cards (debounced) the given ids name. */
function queueRerender(ids) {
  for (const id of ids) if (id) pending.add(id);
  if (!pending.size || timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pending];
    pending.clear();
    for (const id of batch) {
      const card = game.messages?.get(id);
      if (getResolution(card)) globalThis.ui?.chat?.updateMessage?.(card)?.catch?.(() => {});
    }
  }, 150);
}

const defeatedId = () => CONFIG.specialStatusEffects?.DEFEATED ?? "dead";

export function registerDeathFold() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (isDeathMessage(message)) applyDeathFold(message, rootOf(html));
  });
  const onDeathMessage = message => { if (isDeathMessage(message)) queueRerender([dtFlags(message).cause?.messageId]); };
  Hooks.on("createChatMessage", onDeathMessage);
  Hooks.on("updateChatMessage", onDeathMessage);
  Hooks.on("deleteChatMessage", onDeathMessage);
  // A token defeated or revived after its death message was posted (undo, revive on heal): the Fallen row follows.
  const onStatus = effect => {
    if (!effect?.statuses?.has?.(defeatedId())) return;
    const actor = effect.parent;
    const tokenIds = new Set(actor?.isToken ? [actor.token?.id] : (actor?.getActiveTokens?.() ?? []).map(t => t.id));
    queueRerender(recentMessages().filter(m => {
      const f = dtFlags(m);
      return f?.isDeathMessage && (f.deadTokenIds ?? []).some(id => tokenIds.has(id));
    }).map(m => dtFlags(m).cause?.messageId));
  };
  Hooks.on("createActiveEffect", onStatus);
  Hooks.on("deleteActiveEffect", onStatus);
}

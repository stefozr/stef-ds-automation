/**
 * 1.2.0: the Automation box is THE apply / undo surface of a card. On Draw Steel 1.2 every `targetResult` part has its
 * own one-click buttons (applyDamage, applyEffect, gainResource) and ctlib adds "Apply All Damage" on top. Each of
 * them calls `Hooks.call("ds.preApplyTargetResult", part, action, context)` first and stops on `false`
 * (draw-steel.mjs TargetResultPart), so this module vetoes the click when the card's record owns that row: its
 * matching op is applied or still pending (ui/part-lock.mjs `partOwnedBySuite`, the same test as the visual lock).
 * Rows applied elsewhere (status "external"), undone rows, other parts, cards without a trusted resolved record and
 * a disabled suite are never vetoed.
 *
 * A player's click that ctlib relays to the Director never reaches the system's hook on that client; ctlib calls
 * `ctlib.preApplyTargetResult` with `relay: true` there instead, with no roll or effect in the context (only the
 * part and the action), so a relayed click is vetoed when ANY row of that kind of the part is owned. Non-relay calls
 * of the ctlib hook already came through the ds hook and are ignored.
 *
 * While the suite is still resolving a 1.2 card (record without `resolvedAt`, younger than two minutes) every
 * per-target button is vetoed with DSAUTO.Lock.Resolving; after the resolve only owned rows are.
 *
 * i18n keys: DSAUTO.Lock.PartOwned, DSAUTO.Lock.Resolving.
 */
import { loc } from "../constants.mjs";
import { partOwnedBySuite } from "../ui/part-lock.mjs";
import { getResolution } from "../engine/record.mjs";
import { integrity } from "../engine/ledger.mjs";
import { isTargetResultCard } from "./dstd.mjs";
import { setting } from "../settings.mjs";
import { error } from "../log.mjs";

/** An unresolved record older than this is abandoned (the card was never resolved): its buttons are free. */
export const RESOLVING_MAX_MS = 120_000;

/**
 * Is the suite still resolving this card (a trusted, fresh record of a 1.2 card without `resolvedAt`, younger than
 * RESOLVING_MAX_MS, e.g. while a player answers the "Spend surges" dialog)? Its `ops` are empty then, so a per-target
 * button clicked now would land and our row would apply it again.
 */
export function isResolving(message, now = Date.now()) {
  const res = getResolution(message);
  if (!res || res.resolvedAt || setting("enabled") === false || integrity(message) !== "fresh") return false;
  if (!isTargetResultCard(message)) return false;
  const since = Number(res.createdAt ?? message?.timestamp);
  return Number.isFinite(since) && now - since < RESOLVING_MAX_MS;
}

/** The roll index of the clicked damage button, or null when the context carries no roll. */
function rollIndex(part, context) {
  if (!context?.roll) return null;
  return Array.from(part?.rolls ?? []).indexOf(context.roll);
}

/**
 * Does our record own the row a click on `part` / `action` would apply? Never throws (a failure vetoes nothing).
 * @param {object} part       The TargetResultPart (`id`, `message`, `rolls`).
 * @param {string} action     "applyDamage" | "applyEffect" | "gainResource".
 * @param {object} [context]  The hook's context ({roll}, {effect, effectId}, {effect}); empty for a relayed click.
 */
export function isOwnedByRecord(part, action, context = {}) {
  try {
    const message = part?.message;
    if (!message || !part?.id) return false;
    if (action === "applyDamage") {
      const index = rollIndex(part, context);
      if (index === -1) return false;
      return partOwnedBySuite(message, part.id, action, { index });
    }
    if (action === "applyEffect") {
      return partOwnedBySuite(message, part.id, action, { effectId: context?.effectId ?? null, uuid: context?.effect?.uuid ?? null });
    }
    if (action === "gainResource") return partOwnedBySuite(message, part.id, action, { uuid: context?.effect?.uuid ?? null });
    return false;
  } catch (err) {
    error("targetResultVeto", err);
    return false;
  }
}

function veto(part, action, context) {
  let resolving = false;
  try {
    resolving = !!part?.message && isResolving(part.message);
  } catch (err) {
    error("targetResultVeto", err);
  }
  if (!resolving && !isOwnedByRecord(part, action, context)) return true;
  ui.notifications?.warn?.(loc(resolving ? "DSAUTO.Lock.Resolving" : "DSAUTO.Lock.PartOwned"));
  return false;
}

/** init: the system's hook on every client, and ctlib's relayed-click hook. */
export function registerTargetResultVeto() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("ds.preApplyTargetResult", (part, action, context) => veto(part, action, context));
  // Registered whether or not ctlib is active: the hook never fires without it.
  Hooks.on("ctlib.preApplyTargetResult", (part, action, context) => (context?.relay === true ? veto(part, action, context) : true));
}

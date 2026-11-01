/**
 * Owner-side teleport and optional Hide. Queries never call Apply while its GM lock is held. Milestone 9 (D6): a
 * teleport with a `boost` first asks how many points the mover spends for extra squares (`{picked, boost}`).
 */
import { QUERY_PROMPT, loc } from "../constants.mjs";
import { dsctApi, dsctSetting } from "../compat/dsct.mjs";
import { getResolution } from "../engine/record.mjs";
import { dsctTeleport } from "../delegation/teleport.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { routePrompt } from "../relay/prompt-router.mjs";
import { boostLimit } from "../engine/forced.mjs";

const running = new Set();

/**
 * Who makes a card's move: the card's author when they own `actor`, else its first active owner, else the active GM.
 * A real card by a GM stays with the active GM. 1.1.1: a synthetic card (feature rules such as Null Field's Gravitic
 * Disruption) is always created by the active GM, so its record's `authorUserId` stands for the author, and a GM there
 * does not keep the move from the hero's player.
 */
export function stepRecipient(message, actor) {
  const res = getResolution(message);
  const author = res?.synthetic ? game.users.get(res.authorUserId) : (message.author ?? game.users.get(res?.authorUserId));
  if (author?.isGM && !res?.synthetic) return game.users.activeGM;
  const owners = ownersOf(actor);
  return owners.find(u => u.id === author?.id) ?? owners[0] ?? game.users.activeGM;
}

/** Query errors (timeout, disconnect) reach the caller; engine/forced.mjs then asks the active GM (`recipient`). */
export async function askTeleportStep(message, op, actor, step, { recipient = stepRecipient(message, actor) } = {}) {
  const payload = { type: "teleportStep", messageId: message.id, opId: op.opId, step };
  const answer = recipient?.isSelf
    ? await routePrompt(payload, { user: game.user })
    : await recipient?.query(QUERY_PROMPT, payload, { timeout: 300_000 });
  return { answer, userId: recipient?.id };
}

const BOOST_ASK_MS = 60_000;

/**
 * Milestone 9 (D6): how many points of the boost resource the mover spends for extra squares (0-boostLimit; closing or
 * a timeout is 0). Owner side; the active GM checks the answer again (engine/forced.mjs boostSpend).
 */
async function askBoost(op, actor) {
  const max = boostLimit(op, actor);
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!max || !DialogV2?.input) return 0;
  const esc = foundry.utils.escapeHTML ?? (v => String(v));
  const name = (op.boost.resource === "heroic" ? actor?.system?.hero?.primary?.label : null) || loc(`DSAUTO.Entry.Resource.${op.boost.resource}`);
  const per = Number(op.boost.per) || 1;
  const label = op.boost.label || loc("DSAUTO.Teleport.BoostDefault", { per, name });
  let dialog = null;
  let timer = null;
  try {
    const data = await DialogV2.input({
      window: { title: "DSAUTO.Teleport.BoostTitle", icon: "fa-solid fa-person-through-window" },
      content: `<p>${esc(loc("DSAUTO.Teleport.BoostIntro", { label, distance: op.distance, per, name, max }))}</p>
        <div class="form-group"><label>${esc(loc("DSAUTO.Teleport.BoostLabel", { name }))}</label>
        <div class="form-fields"><input type="number" name="boost" value="0" min="0" max="${max}" step="1" autofocus></div></div>`,
      ok: { label: "DSAUTO.Teleport.BoostSpend", icon: "fa-solid fa-person-through-window" },
      rejectClose: false,
      render: (_event, app) => {
        dialog = app;
        timer = setTimeout(() => app.close(), BOOST_ASK_MS);
      },
    });
    const n = Math.floor(Number(data?.boost));
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
  } catch (_err) {
    return 0;
  } finally {
    clearTimeout(timer);
    if (dialog?.rendered) await dialog.close();
  }
}

export async function handleTeleportStep(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  const message = game.messages.get(payload?.messageId);
  const res = getResolution(message);
  const op = res?.ops?.[payload?.opId];
  const doc = op ? fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.tokenUuid ?? "") : null;
  if (!op || !doc?.actor || !doc.actor.isOwner || !["teleport", "hide"].includes(payload.step)) throw new Error("DSAUTO.Relay.BadRequest");
  if (!doc.object || doc.parent?.id !== globalThis.canvas?.scene?.id) return { unavailable: true };
  if (running.has(doc.uuid)) throw new Error("DSAUTO.Relay.Busy");
  running.add(doc.uuid);
  try {
    const api = dsctApi();
    if (payload.step === "teleport") {
      // Any recipient the active GM asks (self-teleports, Flip the Script recipients); this client must own it.
      if (op.kind !== "teleport" || op.status === "applied") throw new Error("DSAUTO.Relay.BadRequest");
      if (typeof api?.teleport !== "function" || !(op.distance > 0)) return { unavailable: true, reason: "delegateUnavailable" };
      // Milestone 9 (D6): extra squares for a resource, asked first; the GM checks the number again (forced.mjs).
      const boost = op.boost ? await askBoost(op, doc.actor) : 0;
      const distance = op.distance + boost * (Number(op.boost?.per) || 1);
      await dsctTeleport(api, { tokenDoc: doc, distance, mode: op.teleportMode ?? "normal", animate: true, cardId: message.id, opId: op.opId });
      return op.boost ? { picked: true, boost } : { picked: true };
    }
    if (op.kind !== "hide" || op.status === "applied") throw new Error("DSAUTO.Relay.BadRequest");
    const stealth = api?.stealth;
    if (!dsctSetting("stealthSystemEnabled", true) || !stealth?.isActive?.() || typeof stealth.runHide !== "function") return { unavailable: true };
    const accepted = await foundry.applications.api.DialogV2.confirm({
      window: { title: loc("DSAUTO.Card.Hide") },
      content: `<p>${loc("DSAUTO.Card.HideAfterTeleport")}${op.whileObserved ? ` ${loc("DSAUTO.Card.HideWhileObserved")}` : ""}</p>`,
      rejectClose: false,
    });
    if (!accepted) return { declined: true };
    const ids = await stealth.runHide(doc.object, { whileObserved: !!op.whileObserved });
    return { ids: Array.isArray(ids) ? ids : [] };
  } finally {
    running.delete(doc.uuid);
  }
}

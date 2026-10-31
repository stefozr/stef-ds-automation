/**
 * Cleanse choices by the affected creature's owner (Milestone 9, docs/M9-DESIGN.md §A, D4).
 *
 * A library cleanse row that may end fewer effects than the creature has (`count`) needs a choice. Before Milestone 9
 * whoever pressed Apply chose (resolution-part askCleanse); now the active GM asks first, inside applyOpList right after
 * the surge choice (`prepareCleanseChoice`): every such row of the call is sent at once (parallel) to an owner of the
 * creature (the card's author when they own it, else the first active owner), an NPC or a creature without an active
 * owner to the Director's own dialog. A valid answer becomes the row's `override = {effects, by, at}` and the row
 * applies; no answer within 32 s (or a closed dialog) leaves the row pending ("chooseEffects") with its Apply, where the
 * clicker chooses as before.
 *
 * Prompt type `cleanseChoice` (registered in main.mjs), sent by the active GM only. Payload:
 *   {type, messageId, opId, actorUuid, name, count, candidateIds, label, statuses, ends}
 * The owner's client re-reads the candidates from its own copy of the creature (with the row's `statuses` / `ends`
 * from the payload: on a card's first resolve the GM asks before the record is written, so the owner's copy of the
 * card has no row yet) and offers only those the GM named; the GM keeps only ids it offered (the answer is the
 * owner's choice, nothing else).
 *
 * i18n keys: DSAUTO.Cleanse.{PromptTitle, PromptIntro, PromptApply}, DSAUTO.CleanseDialog.{Title, Intro, TooMany},
 * DSAUTO.EditDialog.Apply, DSAUTO.Relay.{Denied, BadRequest}.
 */
import { QUERY_PROMPT, OP_STATUS, loc } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { getResolution } from "../engine/record.mjs";
import { cleanseCandidates } from "../engine/library-plan.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { routePrompt } from "../relay/prompt-router.mjs";
import { log } from "../log.mjs";

/** How long the GM waits for an owner's answer; the owner's dialog closes a little earlier. */
export const CLEANSE_ASK_MS = 32_000;
const DIALOG_MS = 30_000;
const ID_RE = /^[A-Za-z0-9]{16}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_CANDIDATES = 20;

const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const optKeys = v => v == null || (Array.isArray(v) && v.length <= 20 && v.every(k => typeof k === "string" && KEY_RE.test(k)));

/**
 * The checkbox dialog: which of `candidates` ({id, name}) end, at most `count` (the first `count` pre-ticked).
 * Resolves with the ticked ids, or null when closed, emptied, too many or timed out (`timeoutMs` > 0).
 * @param {{name: string, count: number, candidates: {id: string, name: string}[], timeoutMs?: number,
 *          title?: string, intro?: string, applyLabel?: string}} args
 * @returns {Promise<string[]|null>}
 */
export async function cleanseDialog({ name = "", count = 1, candidates = [], timeoutMs = 0, title = null, intro = null, applyLabel = "DSAUTO.EditDialog.Apply" } = {}) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait || !candidates.length) return null;
  const esc = foundry.utils.escapeHTML ?? (v => String(v));
  const max = Math.max(1, Math.min(Number(count) || candidates.length, candidates.length));
  const rows = candidates.map((e, i) => `<label class="checkbox"><input type="checkbox" name="e-${esc(e.id)}"${i < max ? " checked" : ""}> ${esc(e.name)}</label>`).join("");
  let dialog = null;
  let timer = null;
  let result = null;
  try {
    result = await DialogV2.wait({
      window: { title: title ?? "DSAUTO.CleanseDialog.Title", icon: "fa-solid fa-hand-sparkles" },
      content: `<p>${esc(intro ?? loc("DSAUTO.CleanseDialog.Intro", { name, count: max }))}</p><div class="ds-auto-cleanse-list">${rows}</div>`,
      buttons: [{
        action: "apply", label: applyLabel, icon: "fa-solid fa-play", default: true,
        callback: (_e, button) => {
          const data = new foundry.applications.ux.FormDataExtended(button.form).object;
          return Object.entries(data).filter(([k, v]) => k.startsWith("e-") && v).map(([k]) => k.slice(2));
        },
      }],
      rejectClose: false,
      render: (_event, app) => {
        dialog = app;
        if (timeoutMs > 0) timer = setTimeout(() => app.close(), timeoutMs);
      },
    });
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timer);
    if (dialog?.rendered) await dialog.close();
  }
  // Only the effects the dialog offered (a form field of another name is ignored).
  const offered = new Set(candidates.map(c => c.id));
  if (Array.isArray(result)) result = result.filter(id => offered.has(id));
  if (!Array.isArray(result) || !result.length) return null;
  if (result.length > max) {
    ui.notifications?.warn?.(loc("DSAUTO.CleanseDialog.TooMany", { count: max }));
    return null;
  }
  return result;
}

/** The payload checks of `cleanseChoice` (types and lengths; ownership is checked by the handler). */
export function validCleanseChoice(p) {
  return !!p && typeof p === "object" && p.type === "cleanseChoice" && str(p.messageId, 64) && str(p.opId, 300) && str(p.actorUuid, 300)
    && optStr(p.name, 200) && optStr(p.label, 200) && Number.isInteger(p.count) && p.count >= 1 && p.count <= 10
    && Array.isArray(p.candidateIds) && p.candidateIds.length >= 1 && p.candidateIds.length <= MAX_CANDIDATES
    && p.candidateIds.every(id => typeof id === "string" && ID_RE.test(id)) && optKeys(p.statuses) && optKeys(p.ends);
}

/**
 * Owner side of `cleanseChoice`: the active GM sends it, this user owns the creature; the dialog offers the creature's
 * own effects that the GM named. Answers `{effects: [ids]}` (empty: closed or nothing left).
 */
export async function handleCleanseChoice(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  if (!validCleanseChoice(payload)) throw new Error("DSAUTO.Relay.BadRequest");
  let actor = null;
  try {
    actor = fromUuidSync(payload.actorUuid);
  } catch (_err) { /* invalid */ }
  if (!actor?.isOwner) throw new Error("DSAUTO.Relay.Denied");
  const res = getResolution(game.messages.get(payload.messageId));
  const op = res?.ops?.[payload.opId] ?? null;
  if (op && op.kind !== "cleanse") throw new Error("DSAUTO.Relay.BadRequest");
  // The row's filters from the payload (the record may not be written yet: first resolve), else from the record.
  const fromPayload = Array.isArray(payload.statuses) || Array.isArray(payload.ends);
  if (!fromPayload && !op) throw new Error("DSAUTO.Relay.BadRequest");
  const filters = fromPayload ? { statuses: payload.statuses ?? [], ends: payload.ends ?? [] } : { statuses: op.statuses, ends: op.ends };
  const offered = new Set(payload.candidateIds);
  const candidates = cleanseCandidates(actor, filters).filter(e => offered.has(e.id)).map(e => ({ id: e.id, name: e.name }));
  if (!candidates.length) return { effects: [] };
  const name = actor.name ?? payload.name ?? "";
  const ids = await cleanseDialog({
    name, count: payload.count, candidates, timeoutMs: DIALOG_MS, applyLabel: "DSAUTO.Cleanse.PromptApply",
    title: loc("DSAUTO.Cleanse.PromptTitle", { name }),
    intro: loc("DSAUTO.Cleanse.PromptIntro", { ability: payload.label || res?.abilityName || "", name, count: Math.min(payload.count, candidates.length) }),
  });
  return { effects: ids ?? [] };
}

/** Who chooses for this creature: an NPC or a creature without an active owner -> the active GM; else its owner. */
function recipientFor(message, res, actor) {
  const gm = game.users.activeGM;
  if (actor?.type === "npc") return gm;
  const author = message?.author ?? game.users.get(res?.authorUserId);
  const owners = ownersOf(actor);
  return owners.find(u => u.id === author?.id) ?? owners[0] ?? gm;
}

/** The row's creature and its candidates, when it needs a choice now (more candidates than it may end). */
function needsChoiceNow(res, op) {
  if (op?.kind !== "cleanse" || op.status !== OP_STATUS.PENDING || op.noApply || op.awaitingChoice || op.count == null) return null;
  if (op.override?.effects?.length || op.afterMoveEffect) return null;
  // Asked once per row: an unanswered prompt is not repeated on every Apply all or re-resolve (the row's own Apply
  // still lets the clicker choose, resolution-part.mjs askCleanse).
  if (op.cleanseAsked) return null;
  let actor = null;
  try {
    actor = fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
  } catch (_err) { /* gone */ }
  if (!actor) return null;
  const candidates = cleanseCandidates(actor, { statuses: op.statuses, ends: op.ends });
  return candidates.length > op.count ? { actor, candidates: candidates.slice(0, MAX_CANDIDATES) } : null;
}

/** Ask one recipient; null on a timeout, a refusal or an invalid answer. */
async function askOne(recipient, payload) {
  try {
    return recipient?.isSelf
      ? await routePrompt(payload, { user: game.user })
      : await recipient?.query(QUERY_PROMPT, payload, { timeout: CLEANSE_ASK_MS }) ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * Pre-pass of applyOpList (active GM, inside the card lock): ask the owners of the creatures of this call's cleanse
 * rows that need a choice, all at once, and put each valid answer on its op (`override = {effects, by, at}`; the
 * caller's `res.ops` copy too). Never throws; rows nobody answered stay as they are.
 * @param {ChatMessage} message
 * @param {object} res      The applier's record copy (resLive).
 * @param {object[]} ops    The call's ops (mutated).
 */
export async function prepareCleanseChoice(message, res, ops) {
  if (setting("enabled") === false || res?.synthetic) return;
  const asks = [];
  for (const op of ops ?? []) {
    const need = needsChoiceNow(res, op);
    if (!need) continue;
    const recipient = recipientFor(message, res, need.actor);
    if (!recipient) continue;
    const payload = {
      type: "cleanseChoice", messageId: message.id, opId: op.opId, actorUuid: need.actor.uuid, name: need.actor.name ?? "",
      count: op.count, candidateIds: need.candidates.map(e => e.id), label: String(op.label ?? res.abilityName ?? "").slice(0, 200),
      statuses: [...(op.statuses ?? [])].slice(0, 20), ends: [...(op.ends ?? [])].slice(0, 20),
    };
    op.cleanseAsked = Date.now();
    if (res.ops) res.ops[op.opId] = op;
    asks.push(askOne(recipient, payload).then(answer => {
      const offered = new Set(payload.candidateIds);
      const effects = Array.isArray(answer?.effects) ? [...new Set(answer.effects)] : [];
      const ok = effects.length >= 1 && effects.length <= op.count && effects.every(id => typeof id === "string" && offered.has(id));
      log("cleanse.choice", { messageId: message.id, opId: op.opId, by: recipient.id, chosen: ok ? effects.length : 0 });
      if (!ok) return;
      op.override = { ...(op.override ?? {}), effects, by: recipient.id, at: Date.now() };
      if (res.ops) res.ops[op.opId] = op;
    }));
  }
  if (asks.length) await Promise.all(asks);
}

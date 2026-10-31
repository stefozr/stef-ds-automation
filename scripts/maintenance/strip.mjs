/**
 * Uninstall preparation, chat cards (Milestone 8, docs/M8-DESIGN.md §6.1, D24). `api.stripParts` and the settings
 * window's "Prepare to uninstall" button. Calling GM, who must be the active GM (the engine's own writes must not race
 * the pass).
 *
 * A card with our `dsAutoResolution` part and another part (an ability card) loses our part (ForcedDeletion) and, with
 * `removeFlags`, our flag scope (the record and its undo data). A card that consists only of our part (a synthetic card:
 * api.applyDamage, ongoing ticks, zone hits, trigger, gain, Malice and summon cards) would become invisible once the
 * module is gone (the system's StandardModel shows a card only when one part is visible): `convert` turns it into a
 * plain system `content` part with a text summary, `delete` deletes it, `keep` leaves it. Messages that only carry our
 * flags (save cards, Malice reminders) lose them with `removeFlags`.
 * Selection reads `_source` (works for parts that are already invalid). Writes go in batches and carry the update option
 * `{"stef-ds-automation": {strip: true}}`; `stripInProgress()` is true for the whole pass (the engine skips its writes).
 * Errors are collected per message; the pass never throws halfway. Fires `dsAuto.stripped(report)`.
 *
 * i18n keys: DSAUTO.Strip.Progress, DSAUTO.Strip.Done, DSAUTO.Strip.Running (DSAUTO.Strip.DoneHint: the settings window).
 */
import { FLAG, HOOKS, MODULE_ID, OP_STATUS, PART_TYPE, loc } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { LEDGER_VERSION } from "../engine/ledger.mjs";
import { opLabel } from "../parts/view.mjs";

const SYNTHETIC = new Set(["convert", "delete", "keep"]);
const DAY_MS = 86_400_000;
/** Kinds whose label carries a number the card hides from players for NPC targets (hideNpcNumbersFromPlayers). */
const NUMBER_KINDS = new Set(["damage", "heal", "temp"]);

let running = false;

/** True while a stripParts pass writes (engine/engine.mjs skips its own writes then). */
export const stripInProgress = () => running;

/** The update / delete options our strip writes carry (a fresh object per call: core writes onto it). */
export const stripOptions = () => ({ [MODULE_ID]: { strip: true } });

const forcedDeletion = () => new foundry.data.operators.ForcedDeletion();
const esc = v => (typeof foundry?.utils?.escapeHTML === "function" ? foundry.utils.escapeHTML(String(v ?? "")) : String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

/** Calling user must be a GM and the active GM. */
export function requireActiveGM() {
  if (!game.user?.isGM || !game.users?.activeGM?.isSelf) throw new Error("DSAUTO.Relay.NotActiveGM");
}

/** Our part ids and the other part ids of a message, from its source. */
export function partsOf(message) {
  const parts = message?._source?.system?.parts ?? {};
  const ours = [];
  const others = [];
  for (const [id, p] of Object.entries(parts && typeof parts === "object" ? parts : {})) {
    if (p?.type === PART_TYPE) ours.push(id);
    else others.push(id);
  }
  return { ours, others };
}

/** Our flag scope on a message (source first). */
function ourFlags(message) {
  return message?._source?.flags?.[MODULE_ID] ?? message?.flags?.[MODULE_ID] ?? null;
}

/** The record of a message (source first; null when none). */
function recordOf(message) {
  return ourFlags(message)?.[FLAG] ?? null;
}

/** Whether a player could see this op's numbers on the card (parts/view.mjs canSeeNumbers, for players). */
function numbersPublic(res, op) {
  if (!setting("hideNpcNumbersFromPlayers")) return true;
  return (op.targetKeys ?? []).every(k => {
    try {
      return !!fromUuidSync(res.targets?.[k]?.actorUuid)?.hasPlayerOwner;
    } catch (_err) {
      return false;
    }
  });
}

function statusText(op) {
  if (op.status === OP_STATUS.PENDING) return loc(`DSAUTO.Status.pending.${["auto", "prompt", "manual"].includes(op.mode) ? op.mode : "manual"}`);
  return loc(`DSAUTO.Status.${op.status}`);
}

/**
 * Plain HTML of a synthetic card's record (title, one line per row: targets, what, status) for the `content` part that
 * replaces ours. No buttons; NPC numbers left out when the card hides them from players (the text is public).
 */
export function summaryHtml(message, res = recordOf(message)) {
  const title = res?.abilityName || message?.flavor || "";
  const ops = Object.values(res?.ops ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const lines = [];
  for (const op of ops) {
    let label;
    try {
      label = NUMBER_KINDS.has(op.kind) && !numbersPublic(res, op) ? loc(`DSAUTO.Card.Synthetic.${op.kind}`) : opLabel(res, op);
    } catch (_err) {
      label = op.kind ?? "";
    }
    const names = (op.targetKeys ?? []).map(k => res.targets?.[k]?.name).filter(Boolean).join(", ");
    const what = [names, label].filter(Boolean).join(": ");
    lines.push(`<li>${esc(what)} (${esc(statusText(op))})</li>`);
  }
  return `<p><strong>${esc(title)}</strong></p>${lines.length ? `<ul>${lines.join("")}</ul>` : ""}`;
}

/**
 * Plan of a pass (no writes): per message what happens.
 * @returns {{scanned, abilityCards, syntheticCards, partsRemoved, converted, deleted, flagsRemoved, updates, deletes, ids, recordIds}}
 */
function planStrip({ synthetic, removeFlags, olderThanDays }) {
  const cutoff = Number.isFinite(olderThanDays) && olderThanDays >= 0 ? Date.now() - olderThanDays * DAY_MS : null;
  const plan = {
    scanned: 0, abilityCards: 0, syntheticCards: 0, partsRemoved: 0, converted: 0, deleted: 0, flagsRemoved: 0,
    updates: [], deletes: [], ids: [], recordIds: [],
  };
  const messages = game.messages?.contents ?? [...(game.messages ?? [])];
  for (const m of messages) {
    if (cutoff != null && !((m.timestamp ?? 0) < cutoff)) continue;
    plan.scanned++;
    const { ours, others } = partsOf(m);
    const flags = ourFlags(m);
    if (!ours.length && !flags) continue;
    const update = { _id: m.id };
    let changed = false;
    let dropsRecord = false;
    if (ours.length && others.length) {
      plan.abilityCards++;
      for (const id of ours) update[`system.parts.${id}`] = forcedDeletion();
      plan.partsRemoved += ours.length;
      changed = true;
    } else if (ours.length) {
      plan.syntheticCards++;
      if (synthetic === "keep") {
        plan.ids.push({ id: m.id, kind: "synthetic", action: "keep" });
        continue;
      }
      if (synthetic === "delete") {
        plan.deletes.push(m.id);
        plan.deleted++;
        plan.recordIds.push(m.id);
        plan.ids.push({ id: m.id, kind: "synthetic", action: "delete" });
        continue;
      }
      for (const id of ours) update[`system.parts.${id}`] = forcedDeletion();
      plan.partsRemoved += ours.length;
      const partId = foundry.utils.randomID();
      update[`system.parts.${partId}`] = { _id: partId, type: "content", flavor: "", rolls: [] };
      update.content = summaryHtml(m);
      plan.converted++;
      changed = true;
    }
    if (removeFlags && flags) {
      update[`flags.${MODULE_ID}`] = forcedDeletion();
      plan.flagsRemoved++;
      changed = true;
      dropsRecord = true;
    }
    if (!changed) continue;
    plan.updates.push(update);
    if (dropsRecord) plan.recordIds.push(m.id);
    plan.ids.push({ id: m.id, kind: ours.length ? (others.length ? "ability" : "synthetic") : "flags", action: ours.length && !others.length ? "convert" : "strip" });
  }
  return plan;
}

/** Run one batch; on failure every id of the batch is reported (the next batches still run). */
async function runBatch(fn, chunk, ids, errors) {
  try {
    await fn(chunk);
    return true;
  } catch (err) {
    error("strip.batch", err, { ids });
    for (const id of ids) errors.push({ id, message: String(err?.message ?? err) });
    return false;
  }
}

/**
 * Remove our chat-card data (docs/M8-DESIGN.md §6.1).
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]           Count only (and log the first 50 ids).
 * @param {"convert"|"delete"|"keep"} [options.synthetic="convert"]
 * @param {boolean} [options.removeFlags=true]      Remove our flag scope (the record: undo is lost).
 * @param {number|null} [options.olderThanDays=null] Only messages older than this.
 * @param {number} [options.batchSize=100]
 * @returns {Promise<{dryRun, scanned, abilityCards, syntheticCards, partsRemoved, converted, deleted, flagsRemoved, ledgerPruned, errors}>}
 */
export async function stripParts({ dryRun = true, synthetic = "convert", removeFlags = true, olderThanDays = null, batchSize = 100 } = {}) {
  requireActiveGM();
  if (!SYNTHETIC.has(synthetic) || (olderThanDays != null && !(Number(olderThanDays) >= 0))) throw new Error("DSAUTO.Relay.BadRequest");
  if (running) throw new Error("DSAUTO.Strip.Running");
  const size = Math.max(1, Math.min(500, Math.floor(Number(batchSize)) || 100));
  const days = olderThanDays == null ? null : Number(olderThanDays);
  const plan = planStrip({ synthetic, removeFlags: !!removeFlags, olderThanDays: days });
  const report = {
    dryRun: !!dryRun, scanned: plan.scanned, abilityCards: plan.abilityCards, syntheticCards: plan.syntheticCards,
    partsRemoved: plan.partsRemoved, converted: plan.converted, deleted: plan.deleted, flagsRemoved: plan.flagsRemoved,
    ledgerPruned: 0, errors: [],
  };
  if (dryRun) {
    if (plan.ids.length) console.table(plan.ids.slice(0, 50));
    log("strip.dryRun", { ...report, errors: undefined });
    return report;
  }
  running = true;
  const failed = new Set();
  try {
    const cls = globalThis.ChatMessage?.implementation ?? globalThis.ChatMessage;
    const total = Math.ceil(plan.updates.length / size) + Math.ceil(plan.deletes.length / size);
    let done = 0;
    let bar = null;
    try {
      bar = total ? ui.notifications?.info?.(loc("DSAUTO.Strip.Progress"), { progress: true }) : null;
    } catch (_err) { /* no progress bar */ }
    const step = () => {
      done++;
      try {
        bar?.update?.({ pct: total ? done / total : 1, message: loc("DSAUTO.Strip.Progress") });
      } catch (_err) { /* ignore */ }
    };
    for (let i = 0; i < plan.updates.length; i += size) {
      const chunk = plan.updates.slice(i, i + size);
      const ids = chunk.map(u => u._id);
      const ok = await runBatch(c => cls.updateDocuments(c, stripOptions()), chunk, ids, report.errors);
      if (!ok) ids.forEach(id => failed.add(id));
      step();
    }
    for (let i = 0; i < plan.deletes.length; i += size) {
      const ids = plan.deletes.slice(i, i + size);
      const ok = await runBatch(c => cls.deleteDocuments(c, stripOptions()), ids, ids, report.errors);
      if (!ok) ids.forEach(id => failed.add(id));
      step();
    }
    if (failed.size) {
      // Counts of what really happened.
      report.converted -= plan.updates.filter(u => failed.has(u._id) && u.content !== undefined).length;
      report.deleted -= plan.deletes.filter(id => failed.has(id)).length;
    }
    report.ledgerPruned = await pruneLedger(plan.recordIds.filter(id => !failed.has(id)), {
      full: days == null && !!removeFlags && synthetic !== "keep" && !failed.size,
    });
  } finally {
    running = false;
  }
  log("strip.done", { ...report, errors: report.errors.length });
  try {
    ui.notifications?.info?.(loc("DSAUTO.Strip.Done", { count: report.abilityCards + report.syntheticCards }));
  } catch (_err) { /* ignore */ }
  Hooks.callAll(HOOKS.stripped ?? "dsAuto.stripped", report);
  return report;
}

/**
 * The record ledger (engine/ledger.mjs) after a pass: emptied after a full pass, else the stripped ids removed.
 * @returns {Promise<number>} entries removed
 */
async function pruneLedger(ids, { full = false } = {}) {
  let stored;
  try {
    stored = game.settings.get(MODULE_ID, "ledger");
  } catch (_err) {
    return 0;
  }
  const h = { ...(stored?.h ?? {}) };
  const before = Object.keys(h).length;
  if (full) {
    if (!before && stored?.v === LEDGER_VERSION) return 0;
    await game.settings.set(MODULE_ID, "ledger", { v: LEDGER_VERSION, h: {} });
    return before;
  }
  let removed = 0;
  for (const id of ids) {
    if (id in h) {
      delete h[id];
      removed++;
    }
  }
  if (removed) await game.settings.set(MODULE_ID, "ledger", { v: stored?.v ?? LEDGER_VERSION, h });
  return removed;
}

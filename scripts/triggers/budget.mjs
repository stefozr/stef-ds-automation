import { radicalAvailable, consumeRadical } from "../features/capabilities.mjs";
/**
 * Triggered-action budget (Milestone 5, docs/M5-DESIGN.md §1.9, §3.6). `triggered` abilities use one
 * triggered action per round, `freeTriggered` ones never. Ours lives on the Combat
 * (`flags["stef-ds-automation"].triggerBudget`, written only by the active GM on one promise chain); a use is
 * available only when DSCT's "Unspent Triggered Action" effect (when present and live) is enabled and we
 * have no entry or reservation for that round. Reservations and pending heroic-resource debits are
 * in-memory only. Every trigger card carries one op of kind "budget" (its undo anchor), applied by
 * `applyBudgetOp` and undone by `undoBudgetOp`.
 *
 * - A state whose `round` differs from `combat.round` counts as empty (lazy reset: no write on round
 *   change). Keys are `uuidKey(actorUuid)`: Foundry expands dotted keys in update data.
 * - Reservations `{combatId, round, actorUuid, decisionId, used, at}`: taken when a reactor accepts
 *   (engine.offer), kept across a round change once `used` until the trigger card's budget op applies or
 *   the decision is released (10 min cap). Unused ones go at round change and when the combat is deleted.
 * - Pending debits `{actorUuid, amount}`: heroic resource answered but not yet paid, counted by
 *   eligibility.canPay so queued prompts cannot overspend (review conc 17).
 * - DSCT's effect is stale outside combat (`duration.expired`, left over from the last fight, C8): only
 *   live effects count. `dsctMode` "ours" disables it when our reaction posts no ability card; "byCard"
 *   leaves it to DSCT, which disables it when the `use` card posts (C21).
 */
import { DSCT_ID, MODULE_ID, OP_STATUS } from "../constants.mjs";
import { annotateOps } from "../engine/engine.mjs";
import { getResolution } from "../engine/record.mjs";
import { debug, error, log } from "../log.mjs";
import { triggersActive } from "./engine.mjs";
import { BUDGET_FLAG } from "./taxonomy.mjs";

export const uuidKey = uuid => String(uuid ?? "").replace(/\./g, "__");

const KEEP_MS = 600_000; // used reservations and debits are dropped after 10 min whatever happens
const reservations = new Map(); // token -> {combatId, round, actorUuid, decisionId, ability, used, at}
const debits = new Map(); // token -> {actorUuid, amount, at}
let writeChain = Promise.resolve();

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const newId = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const ForcedDeletion = () => new foundry.data.operators.ForcedDeletion();
const budgetPath = () => `flags.${MODULE_ID}.${BUDGET_FLAG}`;

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The started combat an event belongs to: game.combat when started, else a started combat on that scene. */
export function combatFor(sceneId = null) {
  try {
    const sceneOf = c => c?.scene?.id ?? c?._source?.scene ?? null;
    const viewed = game.combat;
    if (viewed?.started && (!sceneId || !sceneOf(viewed) || sceneOf(viewed) === sceneId)) return viewed;
    const all = list(game.combats).filter(c => c?.started);
    return all.find(c => sceneId && sceneOf(c) === sceneId) ?? all.find(c => !sceneOf(c)) ?? (sceneId ? null : all[0] ?? null);
  } catch (_err) {
    return null;
  }
}

/** DSCT "Unspent Triggered Action" effects that are live (flag effectType "triggered-action", not duration.expired). */
export function dsctBudgetEffects(actor) {
  try {
    return list(actor?.effects).filter(e => (e?.flags?.[DSCT_ID]?.effectType ?? e?.getFlag?.(DSCT_ID, "effectType")) === "triggered-action"
      && !e.duration?.expired);
  } catch (_err) {
    return [];
  }
}

/** Our budget state of a combat for its current round (another round counts as empty). */
function state(combat) {
  const st = combat?.flags?.[MODULE_ID]?.[BUDGET_FLAG];
  if (!st || st.round !== combat?.round) return { round: combat?.round ?? null, used: {} };
  return { round: st.round, used: { ...(st.used ?? {}) } };
}

function prune() {
  const now = Date.now();
  for (const [token, r] of reservations) if (now - r.at > KEEP_MS) reservations.delete(token);
  for (const [token, d] of debits) if (now - d.at > KEEP_MS) debits.delete(token);
}

function reservedFor(combat, actorUuid) {
  prune();
  for (const r of reservations.values()) {
    if (r.combatId === combat.id && r.round === combat.round && r.actorUuid === actorUuid) return r;
  }
  return null;
}

/** Medkit / api: {tracked, available, source: "dsct"|"ours"|"none", usedAbility, round}. Any client (reads only). */
export function budgetInfo(actor, combat = combatFor()) {
  // Nothing records triggered actions while the engine is off or deferred (mirrorCard): not tracked then.
  if (!actor || !triggersActive() || !combat?.started) return { tracked: false, available: true, source: "none", usedAbility: null, round: null };
  const entry = state(combat).used[uuidKey(actor.uuid)] ?? null;
  const effs = dsctBudgetEffects(actor);
  return {
    tracked: true, available: available(actor, combat), source: entry ? "ours" : (effs.length ? "dsct" : "ours"),
    usedAbility: entry?.ability ?? null, round: combat.round ?? null,
  };
}

/** Eligibility (active GM): DSCT's effect (when present) enabled AND no entry / reservation of ours this round. */
export function available(actor, combat) {
  if (!combat?.started) return true;
  if (!actor) return false;
  if (reservedFor(combat, actor.uuid)) return false;
  // Our own entry always counts (review conc 5, integration 9).
  if (radicalAvailable(actor, combat)) return true;
  if (state(combat).used[uuidKey(actor.uuid)]) return false;
  const effs = dsctBudgetEffects(actor);
  return effs.length ? effs.some(e => !e.disabled) : true;
}

/** Reserve the round's budget in memory (sync). Token or null. Stores {combatId, round, actorUuid, decisionId}. */
export function reserve(actor, combat, { ability, decisionId } = {}) {
  if (!actor || !combat?.started || !available(actor, combat)) return null;
  const token = newId();
  reservations.set(token, {
    combatId: combat.id, round: combat.round, actorUuid: actor.uuid, decisionId: decisionId ?? null, ability: ability ?? null,
    radical: radicalAvailable(actor, combat), used: false, at: Date.now(),
  });
  debug("budget.reserve", { actor: actor.name, round: combat.round, ability });
  return token;
}

/** The decision was accepted: keep the reservation across a round change until its card posts (10 min cap). */
export function markUsed(token) {
  const r = token ? reservations.get(token) : null;
  if (r) r.used = true;
}

export function radicalReservation(token) { return !!reservations.get(token)?.radical; }

export function release(token) {
  if (token) reservations.delete(token);
}

/** Pending heroic-resource debits (answered, not yet paid; review conc 17). */
export function debit(actor, amount) {
  const n = Number(amount);
  if (!actor?.uuid || !Number.isFinite(n) || n <= 0) return null;
  const token = newId();
  debits.set(token, { actorUuid: actor.uuid, amount: n, at: Date.now() });
  return token;
}

export function pendingDebit(actor) {
  if (!actor?.uuid) return 0;
  prune();
  let sum = 0;
  for (const d of debits.values()) if (d.actorUuid === actor.uuid) sum += d.amount;
  return sum;
}

export function releaseDebit(token) {
  if (token) debits.delete(token);
}

/** Drop the reservations of a combat (unused ones only unless `all`): round change, deleted combat. */
function dropReservations(combatId, { all = false } = {}) {
  for (const [token, r] of reservations) if (r.combatId === combatId && (all || !r.used)) reservations.delete(token);
}

/**
 * Write one actor's entry on the combat (active GM). Serialized on one promise chain; a stale state of
 * an earlier round is deleted first (a merge update would keep its other entries).
 */
function writeEntry(combat, key, entry) {
  const run = writeChain.catch(() => {}).then(async () => {
    const live = game.combats?.get?.(combat.id) ?? combat;
    const st = live.flags?.[MODULE_ID]?.[BUDGET_FLAG];
    if (st && st.round === live.round) {
      await live.update({ [`${budgetPath()}.used.${key}`]: entry });
      return;
    }
    if (st) await live.update({ [budgetPath()]: ForcedDeletion() });
    await live.update({ [budgetPath()]: { round: live.round, used: { [key]: entry } } });
  });
  writeChain = run.catch(() => {});
  return run;
}

/** Applier for op kind "budget" (called by engine applyOpList). Always returns an applied patch. */
export async function applyBudgetOp(message, res, op) {
  const out = { status: OP_STATUS.APPLIED, charged: false, before: { used: null, dsct: [] }, after: { used: null, dsct: [] } };
  if (op.budgetType !== "triggered") return { ...out, why: "free" };
  const combat = game.combats?.get?.(op.combatId) ?? null;
  if (!combat?.started) return { ...out, why: "noCombat" };
  // The decision's round, not the posting round (review conc 16).
  if (combat.round !== op.round) return { ...out, why: "roundOver" };
  const actor = lookup(op.actorUuid);
  if (op.radical && actor && await consumeRadical(actor, combat)) {
    await actor.update({ [`flags.${MODULE_ID}.radicalCard`]: { itemUuid: op.itemUuid, messageId: message.id, round: combat.round, combatId: combat.id } });
    return { ...out, charged: true, radical: true, radicalMessageId: message.id };
  }
  const key = uuidKey(op.actorUuid);
  const st = state(combat);
  // A race with a triggered ability card used by hand this round.
  if (st.used[key] && st.used[key].messageId !== message?.id) return { ...out, why: "alreadyUsed" };
  out.before.used = st.used[key] ?? null;
  const entry = { ability: op.ability ?? "", itemUuid: op.itemUuid ?? null, at: Date.now(), messageId: message?.id ?? null, by: "trigger" };
  await writeEntry(combat, key, entry);
  // Our response posts no `triggered` ability card: spend DSCT's effect ourselves.
  if (op.dsctMode === "ours" && actor) {
    for (const e of dsctBudgetEffects(actor)) {
      if (e.disabled) continue;
      out.before.dsct.push({ id: e.id, disabled: false });
      await e.update({ disabled: true });
    }
  }
  for (const [token, r] of reservations) {
    if (r.combatId === combat.id && r.round === op.round && r.actorUuid === op.actorUuid) reservations.delete(token);
  }
  log("budget.charge", { actor: actor?.name ?? op.actorUuid, ability: op.ability, round: op.round, dsctMode: op.dsctMode });
  return { ...out, charged: true, after: { used: entry, dsct: out.before.dsct.map(d => ({ id: d.id, disabled: true })) } };
}

/** Undo for op kind "budget" (called by engine/undo.mjs). */
export async function undoBudgetOp(res, op) {
  if (!op.charged) return { status: OP_STATUS.UNDONE, undoMode: "absolute" };
  const combat = game.combats?.get?.(op.combatId) ?? null;
  if (!combat) return { status: OP_STATUS.UNDONE, undoMode: "delta" };
  const actor = lookup(op.actorUuid);
  if (op.radical && actor) {
    if (actor.flags?.[MODULE_ID]?.radicalUsed === `${combat.id}:${op.round}` && actor.flags?.[MODULE_ID]?.radicalCard?.messageId === op.radicalMessageId) await actor.update({ [`flags.${MODULE_ID}.radicalUsed`]: ForcedDeletion(), [`flags.${MODULE_ID}.radicalCard`]: ForcedDeletion() });
    return { status: OP_STATUS.UNDONE, undoMode: "absolute" };
  }
  const key = uuidKey(op.actorUuid);
  const st = state(combat);
  const absolute = st.round === op.round && !!st.used[key] && st.used[key].at === op.after?.used?.at;
  if (absolute) await combat.update({ [`${budgetPath()}.used.${key}`]: ForcedDeletion() });
  if (combat.round === op.round && actor) {
    for (const d of op.before?.dsct ?? []) {
      const e = actor.effects?.get?.(d.id);
      if (e?.disabled) await e.update({ disabled: false });
    }
    // DSCT disabled its effect when the ability card posted (review rules-ux 7b).
    if (op.dsctMode === "byCard" && absolute) {
      for (const e of dsctBudgetEffects(actor)) if (e.disabled) await e.update({ disabled: false });
    }
  }
  log("budget.refund", { actor: actor?.name ?? op.actorUuid, ability: op.ability, absolute });
  return { status: OP_STATUS.UNDONE, undoMode: absolute ? "absolute" : "delta" };
}

/** A kept byCard reaction whose ability card never came: disable DSCT's effect, re-tag the op "ours" (C21). */
export async function switchToOurs(triggerMessage) {
  const res = getResolution(triggerMessage);
  const op = Object.values(res?.ops ?? {}).find(o => o.kind === "budget");
  if (!op?.charged || op.dsctMode !== "byCard") return false;
  const combat = game.combats?.get?.(op.combatId) ?? null;
  if (!combat?.started || combat.round !== op.round) return false;
  const actor = lookup(op.actorUuid);
  const dsct = [];
  for (const e of dsctBudgetEffects(actor)) {
    if (e.disabled) continue;
    dsct.push({ id: e.id, disabled: false });
    await e.update({ disabled: true });
  }
  log("budget.switchToOurs", { messageId: triggerMessage?.id, actor: actor?.name, effects: dsct.length });
  return annotateOps(triggerMessage, {
    [op.opId]: {
      dsctMode: "ours",
      before: { ...(op.before ?? {}), dsct },
      after: { ...(op.after ?? {}), dsct: dsct.map(d => ({ id: d.id, disabled: true })) },
    },
  });
}

/** Mirror of DSCT's own spend rule (DSCT/triggered-actions.mjs:170-187): a triggered ability card spends the round. */
function mirrorCard(msg) {
  if (!isActiveGM() || !triggersActive()) return;
  const use = list(msg?.system?.parts).find(p => p?.type === "abilityUse");
  const item = lookup(use?.abilityUuid);
  if (item?.system?.type !== "triggered" || item.flags?.["draw-steel-triggers"]?.malice || item.system.category === "maliceAncestry") return;
  let actor = null;
  try {
    actor = ChatMessage.getSpeakerActor?.(msg.speaker) ?? null;
  } catch (_err) { /* no speaker */ }
  actor ??= item.actor;
  const combat = combatFor(msg.speaker?.scene ?? null);
  if (!actor || !combat?.started || (actor.flags?.[MODULE_ID]?.radicalCard?.itemUuid === item.uuid && !actor.flags[MODULE_ID].radicalCard.used)) return;
  const key = uuidKey(actor.uuid);
  if (state(combat).used[key]) return; // our trigger card already recorded it (dsctMode "byCard")
  writeEntry(combat, key, { ability: item.name, itemUuid: item.uuid, at: Date.now(), messageId: msg.id, by: "card" })
    .catch(err => error("budget.mirror", err));
}

/** Active GM hooks: createChatMessage mirror, updateCombat round change, deleteCombat (§3.6). */
export function registerBudget() {
  Hooks.on("createChatMessage", msg => {
    try {
      mirrorCard(msg);
    } catch (err) {
      error("budget.mirror", err);
    }
  });
  Hooks.on("updateCombat", (combat, changes) => {
    try {
      if (combat?.id && changes && "round" in changes) dropReservations(combat.id);
    } catch (err) {
      error("budget.round", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      if (combat?.id) dropReservations(combat.id);
    } catch (err) {
      error("budget.deleteCombat", err);
    }
  });
}

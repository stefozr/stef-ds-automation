import { radicalReservation } from "./budget.mjs";
/**
 * Trigger cards (Milestone 5, docs/M5-DESIGN.md §1.8, §3.7, §3.9). Every reaction whose effect landed
 * posts a GM-authored card (`shape: "trigger"`, through engine/synthetic.mjs postRecordCard) carrying a
 * resource op (cost and spend), the `budget` op (its undo anchor) and note rows, so the M1.5 undo works
 * for it. Undoing the anchor revokes that reaction's entry on its origin card. After-steps (`use`,
 * `freeStrike`) run on the clients planned once before the card posts.
 *
 * - The budget op is on every card and always applied (deviation 6): `charged` only for a `triggered` use
 *   in the decision's round. `dsctMode` "byCard" when Combat Tools will spend its own effect on the `use`
 *   card, "ours" when the reactor has a live DSCT effect and no such card follows, "none" otherwise.
 * - A bleeding (or dying) reactor whose response posts no ability card gets a manual row (C22).
 * - The decision's reservation and pending debit are released once the card's ops applied (or the card
 *   failed): from then on the combat flag and the actor's resource carry them.
 * - Revocation (`dsAuto.undoOp` on the anchor): the origin's damage ops get that entry `revoked`, their
 *   halving and potency are recomputed from the entries still live (review conc 8, rules-ux 8); rows that
 *   already landed are left to the Director. Runs with setTimeout(0), outside the trigger card's lock.
 * - A follow-up that never starts (cancelled ability dialog, skipped free strike) undoes the card when the
 *   reaction changed nothing by itself, else keeps it and re-tags the budget "ours" (C21). Reports are taken
 *   once per card, from the users this GM started a follow-up for, and never after a follow-up started.
 * - Milestone 9 (D5): a chosen spend of a reaction with a `use` step whose ability has its own spend effect
 *   (`candidate.spendByUse`) is not charged here: the `use` follow-up carries `spend` and the system's roll dialog
 *   opens pre-ticked, charges it and records it on the ability card (library `when.spend` rows).
 */
import { HOOKS, OP_STATUS, loc } from "../constants.mjs";
import { dsctActive } from "../compat/dsct.mjs";
import { annotateOps, undoOps } from "../engine/engine.mjs";
import { opId } from "../engine/keys.mjs";
import { getResolution } from "../engine/record.mjs";
import { itemDsid } from "../library/identity.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { error, log, warn } from "../log.mjs";
import { setting } from "../settings.mjs";
import { dsctBudgetEffects, release, releaseDebit, switchToOurs, uuidKey } from "./budget.mjs";
import { serverNow } from "./engine.mjs";
import { potencyFails, potencyStatus, summarize } from "./holds.mjs";
import { ownersOf, promptMs, runFollowUp } from "./prompt.mjs";
import { spendEffectDoc } from "./eligibility.mjs";

/** `followUps[].userId` of a free strike whose striker's players are offline with `triggerFallback` "skip". */
export const SKIP_USER = "skip";
/** Steps whose effect lands by itself (the card stays when a follow-up fails). */
const HOLD_STEPS = new Set(["halve", "potency", "edge", "takeTurnNext"]);
const REPORTS = new Set(["useStarted", "useCancelled", "followUpFailed"]);
const FREE_STRIKE_DSIDS = new Set(["melee-free-strike", "ranged-free-strike"]);
/** How long after its follow-ups started the GM accepts their reports (watch windows + slack). */
const FOLLOW_UP_GRACE_MS = 90_000;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const newId = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const signed = n => (Number(n) > 0 ? `+${Number(n)}` : String(Number(n) || 0));

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

function owns(user, doc) {
  try {
    return !!doc?.testUserPermission?.(user, "OWNER");
  } catch (_err) {
    return false;
  }
}

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

/* -------------------------------------------- */
/*  Origin index ("still spent", rules-ux 9)    */
/* -------------------------------------------- */

let index = null; // origin messageId -> [{messageId, entryId, abilityName, byName}]
/** Active GM: trigger card id -> {userIds, until, started, settled} of the follow-ups it started (handleTriggerReport). */
const followUps = new Map();
const MAX_FOLLOW_UPS = 200;

function indexEntry(message) {
  const res = getResolution(message);
  const t = res?.shape === "trigger" ? res.trigger : null;
  if (!t?.origin?.messageId) return null;
  const abilityName = t.abilityName ?? lookup(t.itemUuid)?.name ?? "";
  return { origin: t.origin.messageId, row: { messageId: message.id, entryId: t.origin.entryId ?? null, abilityName, byName: t.reactorName ?? "" } };
}

function addRow(origin, row) {
  if (!index || !origin || !row?.messageId) return;
  const rows = index.get(origin) ?? [];
  if (!rows.some(r => r.messageId === row.messageId)) rows.push(row);
  index.set(origin, rows);
}

function addToIndex(message) {
  const e = indexEntry(message);
  if (e) addRow(e.origin, e.row);
}

function ensureIndex() {
  if (index) return index;
  index = new Map();
  try {
    for (const m of list(game.messages)) addToIndex(m);
  } catch (_err) { /* no messages yet */ }
  return index;
}

/** Trigger cards of an origin card (GM index, for the "still spent" detail; rules-ux 9). */
export function triggerCardsFor(originMessageId) {
  if (!originMessageId) return [];
  return [...(ensureIndex().get(originMessageId) ?? [])];
}

/* -------------------------------------------- */
/*  The card                                    */
/* -------------------------------------------- */

/** §3.6: who spends DSCT's triggered-action effect for this reaction. */
function dsctModeOf(d, reactor) {
  if (d.candidate.budget !== "triggered") return "none";
  if (dsctActive() && (d.steps ?? []).some(s => s.type === "use") && d.candidate.item.type === "triggered") return "byCard";
  if (dsctBudgetEffects(reactor).length) return "ours";
  return "none";
}

/** Localized note texts for the card (one per effective step). */
export function stepSummary(decision, effects) {
  const c = decision?.candidate;
  if (!c) return [];
  const fx = effects ?? {};
  const subject = c.event?.subject?.name ?? "";
  const source = c.event?.source?.name || loc("DSAUTO.Trigger.Dialog.UnknownSource");
  const out = [];
  for (const s of decision.steps ?? []) {
    switch (s.type) {
      case "halve":
        // An instance someone else had already halved: this reaction did not halve it.
        if (Array.isArray(fx.halved) && !fx.halved.length) break;
        out.push(loc("DSAUTO.Trigger.Card.Halved", { target: fx.halved?.join(", ") || subject }));
        break;
      case "potency":
        for (const p of fx.potency ?? []) out.push(loc("DSAUTO.Trigger.Card.Potency", { delta: signed(p.delta), target: p.name }));
        break;
      case "edge":
        out.push(loc("DSAUTO.Trigger.Card.Edge", { count: fx.edges ?? s.amount ?? 1, target: subject }));
        break;
      case "use": {
        const target = s.targets === "source" ? source : (s.targets === "none" ? c.reactor.name : subject);
        out.push(loc("DSAUTO.Trigger.Card.Use", { ability: c.item.name, target }));
        break;
      }
      case "freeStrike":
        out.push(loc("DSAUTO.Trigger.Card.FreeStrike", { name: s.by === "reactor" ? c.reactor.name : subject, target: source }));
        break;
      case "takeTurnNext":
        out.push(loc("DSAUTO.Trigger.Card.TakeTurn"));
        break;
      case "note":
        if (s.text) out.push(String(s.text));
        break;
      default:
        break;
    }
  }
  return [...new Set(out)];
}

/**
 * Post the GM-authored trigger card of a used decision and apply its auto ops (§3.9).
 * @param {Decision} decision
 * @param {{origin?: {messageId, entryId, targetKey}, effects?: {halved?: string[], potency?: {name, delta}[],
 *          edges?: number, turn?: boolean}, warnings?: object[], followUps?: {kind, userId}[]}} info
 * @returns {Promise<string|null>} message id
 */
export async function postTriggerCard(decision, { origin = null, effects = {}, warnings = [], followUps = [] } = {}) {
  const d = decision;
  const c = d?.candidate;
  if (!c) return null;
  let r = null;
  try {
    if (!isActiveGM()) return null;
    const reactor = lookup(c.reactor.actorUuid);
    if (!reactor) return null;
    const tokenDoc = lookup(c.reactor.tokenUuid);
    const target = targetFromTokenDoc(tokenDoc)
      ?? { key: uuidKey(reactor.uuid), tokenUuid: null, actorUuid: reactor.uuid, name: reactor.name, img: reactor.img ?? null };
    const key = target.key;
    const ops = {};
    let order = 0;
    const add = (id, op) => {
      ops[id] = { opId: id, order: order++, targetKeys: [key], tier: null, ...op };
    };
    // Milestone 9 (D5): a spend with a use step is charged by the system's dialog of that use (runFollowUps pre-ticks it).
    const pay = (Number(c.cost) || 0) + (d.spend && !c.spendByUse ? Number(c.spendCost) || 0 : 0);
    // Milestone 7 (§3.8): an NPC reactor pays from the shared Malice pool (a world resource row).
    const resource = reactor.type === "npc" ? "malice" : "heroic";
    if (pay > 0) add(opId("trigger", "res", key), { kind: "resource", resource, amount: -pay, mode: "auto", status: OP_STATUS.PENDING, triggerSpend: true });
    add(opId("trigger", "budget", key), {
      kind: "budget", mode: "auto", status: OP_STATUS.PENDING, anchor: true, budgetType: c.budget, radical: radicalReservation(d.reservation),
      combatId: d.combatId ?? null, round: d.round ?? null, // the decision's round (review conc 16)
      actorUuid: reactor.uuid, ability: c.item.name, itemUuid: c.item.uuid, dsctMode: dsctModeOf(d, reactor),
    });
    if (c.bleeding) add(opId("trigger", "bleed", key), { kind: "note", mode: "manual", status: OP_STATUS.PENDING, noApply: true, text: loc("DSAUTO.Trigger.Card.Bleeding") });
    stepSummary(d, effects).forEach((text, i) => add(opId("trigger", "note", i, key), { kind: "note", mode: "manual", status: OP_STATUS.PENDING, noApply: true, text }));
    const ev = c.event ?? {};
    const meta = {
      trigger: {
        v: 1, eventKind: ev.kind ?? null, eventId: ev.id ?? null, reactorUuid: reactor.uuid, reactorName: reactor.name,
        itemUuid: c.item.uuid, itemKey: c.item.key ?? null, abilityName: c.item.name, triggerId: c.trigger?.id ?? null, budget: c.budget, cost: Number(c.cost) || 0,
        spendCost: d.spend ? Number(c.spendCost) || 0 : 0, spend: !!d.spend, steps: (d.steps ?? []).map(s => s.type),
        spendByUse: !!(d.spend && c.spendByUse),
        subject: { actorUuid: ev.subject?.actorUuid ?? null, tokenUuid: ev.subject?.tokenUuid ?? null, name: ev.subject?.name ?? "" },
        source: ev.source?.actorUuid || ev.source?.name ? { actorUuid: ev.source.actorUuid ?? null, name: ev.source.name ?? null } : null,
        origin: origin?.messageId && origin.entryId ? { messageId: origin.messageId, entryId: origin.entryId, targetKey: origin.targetKey ?? null } : null,
        answeredBy: d.by ?? null,
        followUps: (followUps ?? []).map(f => ({ kind: f.kind, userId: f.userId ?? null })),
      },
    };
    r = await postRecordCard({
      title: loc("DSAUTO.Trigger.Card.Title", { ability: c.item.name, name: reactor.name }), sourceActor: reactor,
      sourceTokenUuid: tokenDoc?.uuid ?? null, targets: { [key]: target }, ops, modes: { trigger: "auto" }, meta, shape: "trigger",
      warnings: (warnings ?? []).map(w => ({ ...w, targetKey: w.targetKey ?? key })), user: game.user,
    });
    log("trigger.card", { messageId: r?.messageId ?? null, reactor: reactor.name, ability: c.item.name, pay, budget: c.budget });
  } catch (err) {
    // Card creation vetoed or failed: the reaction's hold effect already landed (§6.12).
    warn("trigger.cardFailed", { reactor: c.reactor?.name, ability: c.item?.name, error: String(err?.message ?? err) });
    r = null;
  } finally {
    // applyBudgetOp / applyResource persisted them (or the card failed).
    release(d.reservation);
    releaseDebit(d.debit);
    d.reservation = null;
    d.debit = null;
  }
  if (r?.messageId && origin?.messageId) {
    addRow(origin.messageId, { messageId: r.messageId, entryId: origin.entryId ?? null, abilityName: c.item.name, byName: c.reactor.name });
  }
  return r?.messageId ?? null;
}

/* -------------------------------------------- */
/*  Follow-ups                                  */
/* -------------------------------------------- */

/** Who runs each after-step, decided once before the card posts (stored in meta.trigger.followUps; review conc 27). */
export function followUpPlan(decision) {
  const out = [];
  const c = decision?.candidate;
  if (!c) return out;
  const reactor = lookup(c.reactor.actorUuid);
  for (const s of decision.steps ?? []) {
    if (s.type === "use") {
      const by = decision.by ? game.users?.get?.(decision.by) ?? null : null;
      const user = by && by.active && !by.isGM && owns(by, reactor) ? by : (ownersOf(reactor)[0] ?? null);
      out.push({ kind: "use", userId: user?.id ?? null, step: s });
    } else if (s.type === "freeStrike") {
      const striker = s.by === "reactor" ? reactor : lookup(c.event?.subject?.actorUuid);
      // An NPC without a free strike ability strikes through the system's free strike, which writes the
      // damage itself: the active GM runs it (ui/trigger-dialog.mjs runFreeStrike).
      const systemStrike = striker?.type === "npc"
        && !list(striker.items).some(i => i?.type === "ability" && FREE_STRIKE_DSIDS.has(itemDsid(i)));
      const owner = striker && !systemStrike ? (ownersOf(striker)[0] ?? null) : null;
      // null = the active GM runs it locally.
      const userId = owner?.id ?? (!systemStrike && striker?.hasPlayerOwner && setting("triggerFallback") === "skip" ? SKIP_USER : null);
      out.push({ kind: "freeStrike", userId, step: s });
    }
  }
  return out;
}

/**
 * Milestone 9 (D5): the roll dialog's `context.spend` for a use step: `{<spend effect id>: n}` (a multiple spend: the
 * trigger's spend cost in points; a single one: the effect's own value), or null without a spend effect.
 */
function spendSeed(item, c) {
  const e = spendEffectDoc(item);
  if (!e?.id) return null;
  const cost = Math.max(1, Math.floor(Number(c.spendCost) || 1));
  return { [e.id]: e.resource?.multiple ? cost : (Math.floor(Number(e.resource?.value)) || cost) };
}

/** Run the decision's after-steps (use, freeStrike) on the planned clients (§3.7). */
export async function runFollowUps(decision, { triggerMessageId, plan } = {}) {
  const c = decision?.candidate;
  if (!c || !triggerMessageId) return;
  const T = promptMs();
  const steps = plan ?? followUpPlan(decision);
  followUps.set(triggerMessageId, {
    userIds: new Set(steps.map(p => p.userId).filter(u => u && u !== SKIP_USER)),
    until: serverNow() + 2 * T + FOLLOW_UP_GRACE_MS, started: false, settled: false,
  });
  while (followUps.size > MAX_FOLLOW_UPS) followUps.delete(followUps.keys().next().value);
  const failed = () => handleTriggerReport({ sub: "followUpFailed", triggerMessageId }, game.user)
    .catch(err => error("triggers.followUp", err));
  for (const p of steps) {
    try {
      if (p.userId === SKIP_USER) {
        await failed();
        continue;
      }
      const user = p.userId ? (game.users?.get?.(p.userId) ?? null) : null;
      let r = null;
      if (p.kind === "use") {
        const item = lookup(c.item.uuid);
        const t = p.step?.targets ?? "subject";
        const targets = (t === "subject" ? [c.event?.subject?.tokenUuid] : (t === "source" ? [c.event?.source?.tokenUuid] : [])).filter(Boolean);
        // In All This Confusion: a self ability with no preset target uses the reactor's own token (review integration 3).
        const selfTarget = t === "none" && item?.system?.target?.type === "self";
        // Milestone 9 (D5): the spend the reactor chose, pre-ticked in the system's dialog (which charges it).
        const spend = decision.spend && c.spendByUse ? spendSeed(item, c) : null;
        r = await runFollowUp(user, {
          kind: "use", runId: newId(), triggerMessageId, itemUuid: c.item.uuid, targetTokenUuids: targets, selfTarget, watchMs: T + 30_000,
          ...(spend ? { spend } : {}),
        });
      } else if (p.kind === "freeStrike") {
        const strikerUuid = p.step?.by === "reactor" ? c.reactor.actorUuid : c.event?.subject?.actorUuid;
        const striker = lookup(strikerUuid);
        r = await runFollowUp(user, {
          kind: "freeStrike", runId: newId(), triggerMessageId, actorUuid: strikerUuid ?? null, againstTokenUuid: c.event?.source?.tokenUuid ?? null,
          title: loc("DSAUTO.Trigger.Dialog.FreeStrikeTitle"),
          intro: loc("DSAUTO.Trigger.Dialog.FreeStrikeIntro", {
            reactor: c.reactor.name, ability: c.item.name, striker: striker?.name ?? c.event?.subject?.name ?? "", target: c.event?.source?.name ?? "",
          }),
          timeoutMs: T, deadline: serverNow() + T,
        });
      } else continue;
      if (r && !r.started) await failed();
    } catch (err) {
      error("triggers.followUp", err);
    }
  }
}

/** GM side of relay action "trigger" (useStarted / useCancelled / followUpFailed). */
export async function handleTriggerReport(req, user) {
  const r = req?.trigger && typeof req.trigger === "object" ? req.trigger : (req ?? {});
  if (!REPORTS.has(r.sub) || typeof r.triggerMessageId !== "string") throw new Error("DSAUTO.Relay.BadRequest");
  const card = game.messages?.get?.(r.triggerMessageId) ?? null;
  const res = getResolution(card);
  if (!card || res?.shape !== "trigger") throw new Error("DSAUTO.Relay.BadRequest");
  if (!user?.isGM && !(res.trigger?.followUps ?? []).some(f => f.userId && f.userId === user?.id)) throw new Error("DSAUTO.Relay.Denied");
  // Each card's follow-ups report once (review): a player's report needs the live run this GM started for
  // that user; after a follow-up started, or once one report settled the card, later reports change nothing.
  const st = followUps.get(card.id) ?? null;
  const live = !!st && serverNow() <= st.until;
  if (!user?.isGM && !(live && st.userIds.has(user?.id))) {
    log("trigger.report", { messageId: card.id, sub: r.sub, user: user?.name, ignored: "noRun" });
    return { ok: true, ignored: true };
  }
  if (st?.started || (st?.settled && r.sub !== "useStarted")) {
    log("trigger.report", { messageId: card.id, sub: r.sub, user: user?.name, ignored: st.started ? "started" : "settled" });
    return { ok: true, ignored: true };
  }
  log("trigger.report", { messageId: card.id, sub: r.sub, user: user?.name });
  if (st) st.settled = true;
  if (r.sub === "useStarted") {
    if (st) st.started = true;
    return { ok: true };
  }
  if (!(res.trigger?.steps ?? []).some(t => HOLD_STEPS.has(t))) {
    // The reaction did not happen: cost and budget come back.
    await undoOps(card, null, { userId: game.userId });
  } else {
    // Its hold effect landed: the cost stays spent, and the round's triggered action must not stay open on DSCT's side (C21).
    await switchToOurs(card);
  }
  return { ok: true };
}

/* -------------------------------------------- */
/*  Revocation                                  */
/* -------------------------------------------- */

/** An undone trigger card revokes its entry on the origin card (review conc 8, rules-ux 8, integration 17). */
async function revokeEntry({ messageId, entryId, targetKey = null }) {
  const origin = game.messages?.get?.(messageId);
  if (!origin) return false;
  return annotateOps(origin, originRes => {
    const patches = {};
    const ops = Object.values(originRes?.ops ?? {});
    for (const op of ops) {
      if (op?.kind !== "damage" || (targetKey && op.targetKeys?.[0] !== targetKey)) continue;
      if (!(op.trigger?.entries ?? []).some(e => e.id === entryId)) continue;
      const entries = op.trigger.entries.map(e => (e.id === entryId ? { ...e, revoked: true } : e));
      const trigger = summarize(entries); // halved / potencyDelta from the entries still live
      const p = { trigger };
      if (op.status !== OP_STATUS.APPLIED && op.trigger.halved && !trigger.halved) p.half = false; // the halving was the trigger's
      patches[op.opId] = p;
    }
    for (const s of ops) {
      const all = s?.potency?.triggerDeltas;
      if (!Array.isArray(all) || !all.some(x => x.entryId === entryId)) continue;
      if (s.status === OP_STATUS.APPLIED) continue; // landed: the Director adjusts by hand (as triggerPotencyLate)
      const deltas = all.filter(x => x.entryId !== entryId);
      const base = Number(s.potency.baseValue ?? s.potency.value) || 0;
      let value = base + deltas.reduce((sum, x) => sum + (Number(x.delta) || 0), 0);
      const actor = lookup(originRes.targets?.[s.targetKeys?.[0]]?.actorUuid);
      let f = potencyFails(actor, s, value);
      const potency = { ...s.potency, triggerDeltas: deltas };
      const extra = {};
      // A potency surge bought on this row and not paid yet (its +1 is not in baseValue): without the revoked
      // reaction the row lands on its own, so the surge is dropped and never paid; else its +1 stays.
      if (s.surge?.kind === "potency") {
        if (f) {
          potency.surged = false;
          extra.surge = null;
        } else {
          value += 1;
          f = potencyFails(actor, s, value);
        }
      }
      patches[s.opId] = { ...(patches[s.opId] ?? {}), potency: { ...potency, value, fails: f }, ...extra, ...potencyStatus(s, f) };
    }
    return patches;
  });
}

/** dsAuto.undoOp listener: an undone anchor revokes that card's entry on its origin (§3.9). */
export function registerTriggerCards() {
  Hooks.on(HOOKS.undoOp, (message, op, patch) => {
    try {
      if (!isActiveGM()) return;
      const res = getResolution(message);
      if (res?.shape !== "trigger" || !op?.anchor || patch?.status !== OP_STATUS.UNDONE) return;
      const o = res.trigger?.origin;
      // damage.after / external / pre-roll / turn cards: nothing to revoke.
      if (!o?.messageId || !o.entryId) return;
      setTimeout(() => revokeEntry(o).catch(err => error("triggers.revoke", err)), 0);
    } catch (err) {
      error("triggers.undoHook", err);
    }
  });
  Hooks.on("createChatMessage", message => {
    try {
      addToIndex(message);
    } catch (err) {
      error("triggers.index", err);
    }
  });
  Hooks.on("deleteChatMessage", message => {
    try {
      if (!index || !message?.id) return;
      index.delete(message.id);
      for (const [k, rows] of index) {
        const left = rows.filter(r => r.messageId !== message.id);
        if (left.length !== rows.length) left.length ? index.set(k, left) : index.delete(k);
      }
    } catch (err) {
      error("triggers.index", err);
    }
  });
}

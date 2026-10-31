import { featuresWantAfter } from "../features/engine.mjs";
/**
 * Holds (Milestone 5, docs/M5-DESIGN.md §3.1, §3.2). Our damage is held by a pre-pass at the top of
 * engine applyOpList, inside the card's lock and before anything is written; reactions whose damage
 * landed get their trigger card after the record write (`settlePrePass`, `finishPrePass`). External
 * damage (system Apply, Target Damage rows, Combat Tools) is held through the relay action `hold` with a
 * two-phase commit (`externalHold` answers `{holdId, amount}`, `externalDone` commits or releases).
 *
 * Pre-pass (one card, one apply list):
 *   0. `dsAuto.preApplyOp` is asked first for the damage ops (a vetoed op never prompts); damage.after
 *      reactions are measured from where everyone stood before the batch (`positions`).
 *   1. One instance per (card, target); squad ops are not subjects in M5. A USED, unrevoked reaction
 *      already recorded on that target's damage ops is reused without a prompt (C17).
 *   2. `engine.offer` prompts; the card's hold marker is written once, right before the first prompt.
 *   3. Answers apply in order (player side first): a halving halves every damage op of the instance once
 *      (never stacks, C16), a potency step changes the instance's potency ops (`applyPotencyDelta`).
 *   4. `op.trigger` (entries per reaction, C2) goes into each op's patch through `listed`.
 * Settling (end of applyOpList): an instance whose damage did not land releases its reactions (no card, no
 * cost, entries `moot` with why "notApplied") and reverts its halving and potency changes (review conc 2).
 * Nothing here writes a document: the engine merges `skip` / `listed` / `extra` into its one record write.
 */
import { HOOKS, OP_STATUS } from "../constants.mjs";
import { causeNoteCount, noteDamageCause } from "../compat/death-tracker.mjs";
import { effectiveAmount, immunityWeakness, opSource } from "../engine/damage.mjs";
import { damageInFlight } from "../engine/engine.mjs";
import { potencyApplies } from "../engine/plan.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { combatFor } from "./budget.mjs";
import { tokenOnScene } from "./eligibility.mjs";
import {
  heldSubjects, holdSubjects, kindsInUse, offer, releaseDecisions, reportDecisions, runAfter, sceneIdOf, serverNow, triggersActive,
} from "./engine.mjs";
import { EXTERNAL_SLACK_MS, clock, externalPromptMs, promptMs } from "./prompt.mjs";
import { STEP_PHASE, effectNote } from "./taxonomy.mjs";
import { observeExternalReport } from "../resources/gain-card.mjs";
import { gainsWant } from "../resources/rules.mjs";
import { requestOp } from "../relay/queries.mjs";

export const EMPTY_PREPASS = Object.freeze({
  held: false, gone: false, skip: new Map(), listed: new Map(), extra: {},
  decisions: [], landed: [], effects: new Map(), instances: new Map(), positions: null, asked: new Set(),
});

/** Persisted trigger halving that is still valid (re-apply keeps it). */
export const triggerHalved = op => !!op?.trigger?.halved && !op.trigger.revoked;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const newId = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const clone = v => (globalThis.foundry?.utils?.deepClone ?? structuredClone)(v);
const POTENCY_KINDS = new Set(["condition", "forced", "damage", "teleport"]);
const EXTERNAL_KEEP_MS = 60_000;
/** Below Death Tracker's 8 s cause TTL (DT/death-tracker.mjs:12). */
const CAUSE_REFRESH_MS = 5_000;
const pending = new Map(); // holdId -> PendingCommit (external damage)

/** Is this external hold pending on this client? (its commit is taken here even after the active GM changed) */
export const hasExternalPending = holdId => typeof holdId === "string" && pending.has(holdId);

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

const anyStartedCombat = () => list(game.combats).some(c => c?.started);
const afterStep = s => STEP_PHASE[s.type] === "after" && s.type !== "note";
/** The trigger's own steps for the decision's spend choice (before eligibility left moot ones out). */
const stepsOf = d => (d?.candidate?.trigger?.steps ?? []).filter(s => s.when?.spend === undefined || s.when.spend === !!d.spend);

/* -------------------------------------------- */
/*  Entries and potency (shared with card.mjs)  */
/* -------------------------------------------- */

/** One entry's potency delta (the sum of its steps, read from its first op). */
function entryDelta(e) {
  const first = e?.potency?.[0]?.opId;
  return (e?.potency ?? []).filter(p => p.opId === first).reduce((s, p) => s + (Number(p.delta) || 0), 0);
}

/** The persisted `op.trigger` of a list of entries (§1.8). */
export function summarize(entries) {
  const used = entries.filter(e => e.outcome === "used");
  const live = used.filter(e => !e.revoked);
  return {
    outcome: used.length ? "used" : (entries[0]?.outcome ?? "moot"),
    // A live reaction whose halving was moot only because another reaction halved first still halves the hit
    // once that one is revoked (as the reuse path reads it; "Apply half" has no `halve` entry, third review).
    halved: live.some(e => e.halve) || (used.some(e => e.halve) && live.some(e => e.couldHalve)),
    potencyDelta: live.reduce((s, e) => s + entryDelta(e), 0),
    revoked: used.length > 0 && !live.length,
    at: serverNow(),
    entries,
  };
}

/** Does the target fail the potency check at `value`? (actor.checkPotency, else value > resist) */
export function potencyFails(actor, op, value) {
  try {
    const out = actor?.checkPotency?.(value, op.potency.characteristic);
    if (typeof out === "boolean") return out;
  } catch (_err) { /* fall back to the stored resist value */ }
  return value > Number(op.potency?.resist ?? 0);
}

/**
 * Status change of a potency op whose check result changed (review rules-ux 17, integration 11): the op's
 * own potency condition decides, as the plan does. {} when nothing changes.
 */
export function potencyStatus(op, fails) {
  const open = op.status === OP_STATUS.PENDING
    || (op.status === OP_STATUS.SKIPPED && (op.reason === "resisted" || op.reason === "triggerResisted"));
  if (!open) return {};
  const { applies } = potencyApplies({ condition: op.condition ?? "failure" }, { gated: true, fails });
  if (applies && op.status === OP_STATUS.SKIPPED) return { status: OP_STATUS.PENDING, reason: null };
  if (!applies && op.status === OP_STATUS.PENDING) return { status: OP_STATUS.SKIPPED, reason: "triggerResisted" };
  return {};
}

const conditionName = op => op?.display?.name || op?.label || op?.effectId || op?.movement || op?.kind || "";

/** Ops of the instance's target whose potency a trigger may change. */
function potencyOps(resLive, targetKey) {
  return Object.values(resLive.ops ?? {})
    .filter(o => o?.targetKeys?.[0] === targetKey && !o.surge && o.potency?.characteristic && POTENCY_KINDS.has(o.kind))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

const POTENCY_PROBE = [-3, -2, -1, 1, 2, 3];

/**
 * Can a potency step change anything on this target? A row still to apply (steps of several reactors add
 * up), one that landed already (the Director adjusts it, triggerPotencyLate), or a resisted row a few steps
 * flip (a "success" condition). A resisted row that stays resisted, an undone or a failed row gains nothing,
 * so a spend that only lowers potency is not offered for it (third review).
 */
function potencyMayChange(resLive, targetKey) {
  const rows = potencyOps(resLive, targetKey);
  if (!rows.length) return false;
  const actor = lookup(resLive.targets?.[targetKey]?.actorUuid);
  return rows.some(o => o.status === OP_STATUS.PENDING || o.status === OP_STATUS.APPLIED || POTENCY_PROBE.some(delta =>
    Object.keys(potencyStatus(o, potencyFails(actor, o, (Number(o.potency.value) || 0) + delta))).length > 0));
}

/** §3.1.1: apply one potency step of a decision to the instance's potency ops. */
function applyPotencyDelta(inst, delta, scope, d, entry, resLive, ops, pre, fx) {
  const cands = potencyOps(resLive, inst.targetKey);
  if (!cands.length) return false;
  const actor = lookup(resLive.targets?.[inst.targetKey]?.actorUuid);
  const fails = (c, value) => potencyFails(actor, c, value);
  let chosen = cands;
  if (scope === "one") {
    const flips = cands.find(c => Object.keys(potencyStatus(c, fails(c, Number(c.potency.value) + delta))).length);
    chosen = [flips ?? cands[0]];
  }
  const by = `${d.candidate.item.name} (${d.candidate.reactor.name})`;
  let changed = false;
  for (const c of chosen) {
    if (c.status === OP_STATUS.APPLIED) {
      fx.late.push(conditionName(c)); // -> warning triggerPotencyLate on the trigger card
      continue;
    }
    if (!pre.origPotency.has(c.opId)) pre.origPotency.set(c.opId, { potency: c.potency, status: c.status, reason: c.reason ?? null });
    const value = Number(c.potency.value) + delta;
    const f = fails(c, value);
    const potency = {
      ...c.potency, value, fails: f, baseValue: c.potency.baseValue ?? c.potency.value,
      triggerDeltas: [...(c.potency.triggerDeltas ?? []), { entryId: entry.id, by, delta }],
    };
    const status = potencyStatus(c, f);
    // An effect only on a row still to apply (steps add up) or one whose result flipped (a resisted, undone or
    // failed row that stays so is recorded, not counted: third review).
    if (c.status === OP_STATUS.PENDING || Object.keys(status).length) changed = true;
    const listOp = ops.find(o => o.opId === c.opId);
    if (listOp) {
      listOp.potency = potency;
      // `listed` is merged over every patch of the op (skip included): it must carry the latest potency too.
      pre.listed.set(c.opId, { ...(pre.listed.get(c.opId) ?? {}), potency });
      // The skip changes only when the status really flips: a second step on a row an earlier one made
      // resisted returns {} and keeps it skipped; a skip the trigger did not set (hookVetoed) is never lifted.
      const cur = pre.skip.get(c.opId);
      if (status.status === OP_STATUS.SKIPPED) pre.skip.set(c.opId, { status: OP_STATUS.SKIPPED, reason: "triggerResisted", potency });
      else if (status.status === OP_STATUS.PENDING && cur?.reason === "triggerResisted") pre.skip.delete(c.opId);
      else if (cur) pre.skip.set(c.opId, { ...cur, potency });
    } else pre.extra[c.opId] = { ...(pre.extra[c.opId] ?? {}), potency, ...status };
    resLive.ops[c.opId] = { ...c, potency, ...status };
    entry.potency.push({ opId: c.opId, delta });
    inst.siblings.add(c.opId);
    fx.potency.push({ name: conditionName(c), delta });
  }
  return changed;
}

/* -------------------------------------------- */
/*  Events of a card                            */
/* -------------------------------------------- */

function sceneOfRes(resLive) {
  for (const t of Object.values(resLive?.targets ?? {})) {
    const id = sceneIdOf(t?.tokenUuid);
    if (id) return id;
  }
  return null;
}

/** {tokenUuid: {x, y, width, height, elevation}} of a scene (damage.after measures from it, review rules-ux 15). */
function snapshotPositions(sceneId) {
  const scene = sceneId ? game.scenes?.get?.(sceneId) : null;
  if (!scene) return null;
  const out = {};
  for (const t of list(scene.tokens)) {
    if (t?.uuid) out[t.uuid] = { x: t.x, y: t.y, width: t.width, height: t.height, elevation: t.elevation };
  }
  return out;
}

function subjectOf(resLive, targetKey) {
  const t = resLive.targets?.[targetKey] ?? {};
  const actor = lookup(t.actorUuid);
  return { actorUuid: t.actorUuid ?? null, tokenUuid: t.tokenUuid ?? null, name: t.name ?? actor?.name ?? "", isHero: actor?.type === "hero" };
}

function sourceOf(resLive) {
  const item = lookup(resLive.abilityUuid);
  const actor = lookup(resLive.sourceActorUuid);
  const token = lookup(resLive.sourceTokenUuid);
  let keywords = [];
  try {
    keywords = [...(item?.system?.keywords ?? [])].map(k => String(k).toLowerCase());
  } catch (_err) { /* no keywords */ }
  return {
    actorUuid: resLive.sourceActorUuid ?? null, tokenUuid: resLive.sourceTokenUuid ?? null, itemUuid: resLive.abilityUuid ?? null,
    name: token?.name ?? actor?.name ?? null, keywords, featureChain: resLive.featureChain ?? [], fromAbility: !resLive.synthetic && !!resLive.abilityUuid, known: true,
  };
}

/**
 * Does this instance deal any damage after the subject's immunity and weakness? A hit immunity reduces to 0
 * is not taken ("you take damage"), so nothing is offered for it. Unknown (roll or actor missing): yes.
 * Surge rows of a base op count with it (applySurgeOp: immunity applies once to base + surges): those applied
 * in this call (`ops`, they follow their base) and those applied earlier.
 */
function instanceDealsDamage(message, resLive, inst, ops = []) {
  const actor = lookup(resLive.targets?.[inst.targetKey]?.actorUuid);
  if (!actor) return true;
  for (const op of inst.ops) {
    let src = null;
    try {
      src = opSource(message, op);
    } catch (_err) { /* roll gone */ }
    if (!src || src.isHeal) return true;
    const { immunity, weakness } = immunityWeakness(actor, src);
    const surges = surgeTotal(resLive, ops, op);
    const hit = surges && triggerHalved(op) ? Math.floor(((Number(src.total) || 0) + surges) / 2) : effectiveAmount(src, op) + surges;
    if (Math.max(0, hit + weakness - immunity) > 0) return true;
  }
  return false;
}

/** Surge damage on a base op: its surge rows in this apply list plus those already applied. */
function surgeTotal(resLive, ops, base) {
  const rows = new Map();
  for (const o of ops ?? []) {
    if (o?.kind === "damage" && o.surge?.baseOpId === base.opId && o.status !== OP_STATUS.UNDONE) rows.set(o.opId, o);
  }
  for (const o of Object.values(resLive.ops ?? {})) {
    if (o?.kind === "damage" && o.surge?.baseOpId === base.opId && o.status === OP_STATUS.APPLIED && !rows.has(o.opId)) rows.set(o.opId, o);
  }
  return [...rows.values()].reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
}

function buildDamageEvent(message, resLive, inst) {
  const op0 = inst.ops[0];
  let src = null;
  try {
    src = opSource(message, op0);
  } catch (_err) { /* roll gone */ }
  const subject = subjectOf(resLive, inst.targetKey);
  return {
    id: newId(), kind: "damage.before", sceneId: sceneIdOf(subject.tokenUuid), subject, source: sourceOf(resLive),
    damage: {
      instanceKey: inst.key, amount: Number(src?.total ?? op0.amount ?? 0) || 0, type: src?.type ?? op0.type ?? "", halved: inst.halved,
      hasPotency: potencyMayChange(resLive, inst.targetKey), messageId: message.id,
      targetKey: inst.targetKey, external: false,
    },
    at: serverNow(),
  };
}

/* -------------------------------------------- */
/*  Pre-pass                                    */
/* -------------------------------------------- */

/**
 * The pre-pass of applyOpList (§3.1). Mutates `ops` (the call's in-memory copies) and `resLive.ops`.
 * @param {ChatMessage} message
 * @param {object} resLive                  {...res, ops: {...res.ops}} built by the engine
 * @param {object[]} ops                    the apply call's op list
 * @param {{userId: string, markHold: (info: object) => Promise<void>, covered: (op) => boolean}} ctx
 * @returns {Promise<PrePass>}  skip: Map<opId, patch> (terminal), listed: Map<opId, patch> (merged in every runOne branch),
 *                              extra: {[opId]: patch} (ops not in the list), held, gone (card deleted while held)
 */
export async function prePass(message, resLive, ops, ctx = {}) {
  if (!message || !resLive || !Array.isArray(ops) || (!triggersActive() && !featuresWantAfter(sceneOfRes(resLive))) || !isActiveGM()) return EMPTY_PREPASS;
  const kinds = kindsInUse();
  if (!kinds.has("damage.before") && !kinds.has("damage.after")) return EMPTY_PREPASS;
  // Zero cost without a started combat (harness1-7 have no game.combats).
  if (!setting("triggersOutsideCombat") && !anyStartedCombat() && !featuresWantAfter(sceneOfRes(resLive))) return EMPTY_PREPASS;
  resLive.ops ??= {};
  const pre = {
    held: false, gone: false, skip: new Map(), listed: new Map(), extra: {}, decisions: [], landed: [], effects: new Map(),
    instances: new Map(), positions: null, origPotency: new Map(), asked: new Set(), resLive, messageId: message.id,
  };
  const covered = typeof ctx.covered === "function" ? ctx.covered : () => false;

  // 0. Hook veto first (review integration 19): a vetoed damage op never prompts or reserves anything.
  for (const op of ops) {
    if (op?.kind !== "damage" || op.surge) continue;
    pre.asked.add(op.opId);
    let vetoed = false;
    try {
      vetoed = Hooks.call(HOOKS.preApplyOp, message, op) === false;
    } catch (err) {
      error("triggers.preApplyOp", err);
    }
    if (vetoed) pre.skip.set(op.opId, { status: OP_STATUS.SKIPPED, reason: "hookVetoed" });
  }
  // 0b. damage.after reactions are judged where everyone stood when the hit happened (review rules-ux 15).
  if (kinds.has("damage.after")) pre.positions = snapshotPositions(sceneOfRes(resLive));
  if (!kinds.has("damage.before")) return pre;

  // 1. Damage instances of this call: card x target (squad ops are not subjects in M5).
  for (const op of ops) {
    if (op?.kind !== "damage" || op.surge || op.group || pre.skip.has(op.opId) || !op.targetKeys?.[0]) continue;
    let isCovered = false;
    try {
      isCovered = !!covered(op);
    } catch (_err) { /* treated as not covered */ }
    if (isCovered) continue;
    const key = `${message.id}:${op.targetKeys[0]}`;
    const inst = pre.instances.get(key) ?? {
      key, targetKey: op.targetKeys[0], ops: [], origHalf: new Map(), halved: false, entries: [], decisions: [],
      siblings: new Set(), potencyDelta: 0, done: false,
    };
    inst.ops.push(op);
    inst.origHalf.set(op.opId, !!op.half);
    pre.instances.set(key, inst);
  }
  const events = [];
  for (const inst of pre.instances.values()) {
    inst.halved = inst.ops.every(o => o.half); // "Apply half" / synthetic half (C16)
    // A USED, unrevoked reaction recorded on this target's damage ops is reused without a prompt (C17).
    const prior = Object.values(resLive.ops).find(o => o?.kind === "damage" && o.targetKeys?.[0] === inst.targetKey
      && (o.trigger?.entries ?? []).some(e => e.outcome === "used" && !e.revoked));
    if (prior) {
      // A reaction whose halving was moot only because the earlier apply was halved halves this one.
      const couldHalve = (prior.trigger?.entries ?? []).some(e => e.outcome === "used" && !e.revoked && (e.halve || e.couldHalve));
      for (const op of inst.ops) {
        op.trigger = clone(prior.trigger);
        if (couldHalve && !op.trigger.revoked) op.trigger.halved = true;
        op.half = !!op.half || triggerHalved(prior) || triggerHalved(op);
        pre.listed.set(op.opId, { ...(pre.listed.get(op.opId) ?? {}), trigger: op.trigger, half: !!op.half });
        resLive.ops[op.opId] = op;
      }
      inst.done = true;
      debug("trigger.reuse", { messageId: message.id, targetKey: inst.targetKey });
      continue;
    }
    if (!instanceDealsDamage(message, resLive, inst, ops)) {
      debug("trigger.noDamage", { messageId: message.id, targetKey: inst.targetKey, why: "immunity" });
      continue;
    }
    events.push(buildDamageEvent(message, resLive, inst));
  }
  if (!events.length) return pre;

  // 2. Ask (one prompt per reactor). markHold runs once, right before the first prompt is SENT (review conc 4).
  const instanceOf = e => pre.instances.get(e.damage.instanceKey);
  const unhold = holdSubjects(events.map(e => e.subject.actorUuid)); // external holds on them pass through (§3.2)
  let decisions = [];
  try {
    const T = promptMs();
    decisions = await offer(events, {
      phase: "hold", deadline: serverNow() + 2 * T + 6_000,
      markHold: async (names, until) => {
        if (typeof ctx.markHold !== "function") return;
        await ctx.markHold({
          at: serverNow(), until, by: game.userId, names,
          opIds: events.flatMap(e => instanceOf(e).ops.map(o => o.opId)), targetKeys: events.map(e => e.damage.targetKey),
        });
        pre.held = true;
      },
    });
  } finally {
    unhold();
  }
  pre.decisions = decisions; // already ordered: player side, then Director side

  // 2b. The card may have been deleted while the prompts were open (review conc 26).
  if (game.messages && !game.messages.get?.(message.id)) {
    releaseDecisions(decisions);
    pre.gone = true;
    return pre;
  }

  // 3. Apply in that order.
  for (const d of decisions) {
    const inst = pre.instances.get(d.candidate?.event?.damage?.instanceKey);
    if (!inst) {
      releaseDecisions([d]);
      continue;
    }
    const entry = {
      id: d.id, key: d.candidate.item.key, triggerId: d.candidate.trigger.id, by: d.candidate.reactor.actorUuid,
      byName: d.candidate.reactor.name, abilityName: d.candidate.item.name, playerSide: !!d.playerSide,
      response: [], halve: false, potency: [], spend: !!d.spend, outcome: d.outcome, why: d.why ?? null, revoked: false, at: d.at,
    };
    if (d.outcome === "used") {
      const fx = { halved: [], potency: [], late: [] };
      if (d.steps.some(s => s.type === "halve") && !inst.halved) {
        inst.halved = true;
        for (const op of inst.ops) op.half = true;
        entry.halve = true;
        entry.response.push("halve");
        fx.halved.push(resLive.targets?.[inst.targetKey]?.name ?? d.candidate.event.subject?.name ?? "");
      } else if (inst.halved && stepsOf(d).some(s => s.type === "halve")) {
        // Its halving was moot only because the hit was already halved ("Apply half", another reactor): a
        // later plain re-apply that reuses this reaction must halve (C16, C17).
        entry.couldHalve = true;
      }
      for (const s of d.steps.filter(x => x.type === "potency")) {
        const delta = Number(s.delta) || 0;
        if (!delta) continue;
        const changed = applyPotencyDelta(inst, delta, s.scope ?? "all", d, entry, resLive, ops, pre, fx);
        if (changed) {
          if (!entry.response.includes("potency")) entry.response.push("potency");
          inst.potencyDelta += delta;
        }
      }
      if (!entry.response.length && !d.steps.some(afterStep) && !d.steps.some(effectNote)) {
        // e.g. a second halving of the same instance (review conc 13)
        d.outcome = entry.outcome = "moot";
        d.why = entry.why = "noEffect";
        releaseDecisions([d]);
      } else {
        inst.decisions.push(d);
        pre.effects.set(d.id, { ...fx, origin: { messageId: message.id, entryId: d.id, targetKey: inst.targetKey } });
      }
    }
    if (d.outcome === "cancelled") entry.outcome = "moot";
    if (d.outcome === "error") entry.outcome = "noAnswer";
    inst.entries.push(entry);
  }

  // 4. Persist on every op of each prompted instance (merged into each op's patch by runOne; no extra write).
  for (const inst of pre.instances.values()) {
    if (!inst.entries.length) continue;
    inst.trigger = summarize(inst.entries);
    for (const op of inst.ops) {
      op.trigger = inst.trigger;
      pre.listed.set(op.opId, { ...(pre.listed.get(op.opId) ?? {}), trigger: inst.trigger, half: !!op.half });
      resLive.ops[op.opId] = op;
    }
  }
  log("trigger.prePass", {
    messageId: message.id, instances: pre.instances.size, held: pre.held,
    decisions: decisions.map(d => `${d.candidate?.item?.name}:${d.outcome}`),
  });
  return pre;
}

/** End of applyOpList, before the caller's write (sync): which instances landed; revert and release the rest (§3.1.2). */
export function settlePrePass(pre, patches, resLive) {
  if (!pre || pre === EMPTY_PREPASS || !pre.instances || !patches) return;
  try {
    for (const inst of pre.instances.values()) {
      if (!inst.decisions?.length) continue;
      const landed = inst.ops.some(o => patches[o.opId]?.status === OP_STATUS.APPLIED)
        || [...inst.siblings].some(id => patches[id]?.status === OP_STATUS.APPLIED);
      if (landed) {
        pre.landed.push(...inst.decisions);
        continue;
      }
      // The held damage never landed (Target Damage applied it during the hold, the applier failed, the
      // target vanished ...): the reaction did not happen (review conc 2, integration 4).
      releaseDecisions(inst.decisions);
      for (const d of inst.decisions) {
        d.outcome = "moot";
        d.why = "notApplied";
        pre.effects.delete(d.id);
      }
      for (const e of inst.entries) {
        if (e.outcome !== "used") continue;
        Object.assign(e, { outcome: "moot", why: "notApplied", halve: false, potency: [], response: [] });
      }
      const trigger = summarize(inst.entries);
      for (const op of inst.ops) {
        const p = patches[op.opId] ?? (patches[op.opId] = {});
        p.trigger = trigger;
        p.half = !!inst.origHalf.get(op.opId);
      }
      for (const id of inst.siblings) {
        if (patches[id]?.status === OP_STATUS.APPLIED) continue;
        const o = pre.origPotency.get(id);
        if (!o) continue;
        // Exactly as it was: an undone or failed row stays so (never revived as pending, third review).
        patches[id] = { ...(patches[id] ?? {}), potency: o.potency, status: o.status, reason: o.reason };
        if (resLive?.ops?.[id]) resLive.ops[id] = { ...resLive.ops[id], ...patches[id] };
      }
      log("trigger.notLanded", { instance: inst.key, released: inst.decisions.length });
    }
  } catch (err) {
    error("triggers.settle", err);
  }
  reportDecisions(pre.decisions); // dsAuto.trigger with the final outcomes
}

/** Caller, after its record write (sync): schedules engine.runAfter with setTimeout(0); never awaited. */
export function finishPrePass(message, pre, patches) {
  if (!pre || pre === EMPTY_PREPASS || !message) return;
  try {
    const resLive = pre.resLive ?? { ops: {}, targets: {} };
    const afterEvents = [];
    if (kindsInUse().has("damage.after")) {
      const dealt = new Map();
      for (const [id, p] of Object.entries(patches ?? {})) {
        const op = resLive.ops?.[id];
        if (op?.kind !== "damage" || op.group || p?.status !== OP_STATUS.APPLIED) continue;
        const key = op.targetKeys?.[0];
        if (key) dealt.set(key, (dealt.get(key) ?? 0) + (Number(p.finalAmount) || 0));
      }
      for (const [key, sum] of dealt) {
        if (sum <= 0) continue;
        const subject = subjectOf(resLive, key);
        const op0 = Object.values(resLive.ops ?? {}).find(o => o?.kind === "damage" && o.targetKeys?.[0] === key);
        afterEvents.push({
          id: newId(), kind: "damage.after", sceneId: sceneIdOf(subject.tokenUuid), subject, source: sourceOf(resLive),
          damage: {
            instanceKey: `${message.id}:${key}`, amount: sum, type: op0?.type ?? "", halved: !!op0?.half, hasPotency: false,
            finalAmount: sum, messageId: message.id, targetKey: key, external: false,
          },
          positions: pre.positions ?? null, at: serverNow(),
        });
      }
    }
    if (!afterEvents.length && !pre.landed.length) return;
    const effectsByDecision = pre.effects;
    const holdDecisions = [...pre.landed];
    setTimeout(() => runAfter({ afterEvents, holdDecisions, origin: { messageId: message.id }, effectsByDecision })
      .catch(err => error("triggers.after", err)), 0);
  } catch (err) {
    error("triggers.finish", err);
    releaseDecisions(pre.landed);
  }
}

/* -------------------------------------------- */
/*  External damage (two-phase commit)          */
/* -------------------------------------------- */

const total = s => (Number(s?.value) || 0) + (Number(s?.temporary) || 0);

function expire(holdId) {
  const p = pending.get(holdId);
  if (!p) return;
  pending.delete(holdId);
  releaseDecisions(p.decisions);
  log("trigger.holdExpired", { holdId, decisions: p.decisions.length });
}

/** GM side of the relay action "hold" (external damage, §3.2). Never throws. */
export async function externalHold(req, user, { local = false } = {}) {
  const h = req?.hold && typeof req.hold === "object" ? req.hold : (req ?? {});
  const requested = Math.max(0, Math.floor(Number(h.amount) || 0));
  const passThrough = { holdId: null, amount: requested, halved: !!h.halved, entries: [] };
  let decisions = [];
  try {
    const actor = lookup(h.actorUuid);
    // Held by our own pre-pass: no second prompt (review integration 5).
    if (!actor || !isActiveGM() || !triggersActive() || heldSubjects().has(actor.uuid)) return passThrough;
    // A hit immunity reduces to 0 is not taken (the system returns early, DSM:1667-1673): nothing to offer.
    const { immunity, weakness } = immunityWeakness(actor, { type: String(h.type ?? ""), ignoredImmunities: [...(h.ignoredImmunities ?? [])] });
    if (Math.max(0, requested + weakness - immunity) <= 0) return passThrough;
    const token = lookup(h.tokenUuid) ?? tokenOnScene(actor, combatFor()?.scene?.id ?? globalThis.canvas?.scene?.id ?? null);
    const P = externalPromptMs();
    const source = h.source ?? {};
    // Death Tracker's cause memory (review conc 18, integration 10): a cause is kept only while it is fresh
    // (DT/death-tracker.mjs:12, 20-36, 8 s), and a prompt may take up to P + 3 s. Refreshed every 5 s while the
    // prompts are open (null keeps what Combat Tools' socket or Target Damage noted), so it never goes stale;
    // nothing is written when the offer settles within 5 s. Death Tracker has ONE slot (a stated note
    // overwrites its user and source): never while other damage may be settling (an engine apply list, a
    // Combat Tools batch), and the refresh stops for good once another application noted its own cause here.
    const otherDamage = () => damageInFlight() || (Number(globalThis.window?._dsctDamageBatchDepth) || 0) > 0;
    let causeSeq = causeNoteCount();
    const noteCause = ({ own = true } = {}) => {
      if (otherDamage() || (own && causeNoteCount() !== causeSeq)) return;
      noteDamageCause({ userId: local ? null : (user?.id ?? null), sourceActorUuid: source.actorUuid ?? null, messageId: null });
      causeSeq = causeNoteCount();
    };
    let causeTimer = null;
    const keepCause = () => {
      causeTimer = clock.setTimeout(() => {
        noteCause();
        keepCause();
      }, CAUSE_REFRESH_MS);
    };
    keepCause();
    const event = {
      id: newId(), kind: "damage.before", sceneId: token?.parent?.id ?? null,
      subject: { actorUuid: actor.uuid, tokenUuid: token?.uuid ?? null, name: token?.name ?? actor.name, isHero: actor.type === "hero" },
      source: {
        actorUuid: source.actorUuid ?? null, tokenUuid: source.tokenUuid ?? null, itemUuid: null,
        name: lookup(source.tokenUuid)?.name ?? lookup(source.actorUuid)?.name ?? null, keywords: [], fromAbility: false,
        known: !!(source.actorUuid || source.tokenUuid),
      },
      damage: {
        instanceKey: `ext:${newId()}`, amount: requested, type: String(h.type ?? ""), halved: !!h.halved, hasPotency: false,
        messageId: null, targetKey: null, external: true,
      },
      at: serverNow(),
    };
    try {
      decisions = await offer([event], { phase: "hold", promptMs: P, deadline: serverNow() + P + EXTERNAL_SLACK_MS }); // no markHold: no card; ends below DSTD's 15 s (C19)
    } finally {
      clock.clearTimeout(causeTimer);
    }
    let amount = requested;
    let halved = !!h.halved;
    const entries = [];
    const kept = [];
    const effects = new Map();
    for (const d of decisions) {
      if (d.outcome !== "used") continue;
      let changed = false;
      // Halving comes before weakness and immunity (DSM:1667-1669).
      if (d.steps.some(s => s.type === "halve") && !halved) {
        halved = true;
        amount = Math.floor(amount / 2);
        changed = true;
      }
      // Potency steps never apply to external damage (no card, no ops).
      if (!changed && !d.steps.some(afterStep) && !d.steps.some(effectNote)) {
        d.outcome = "moot";
        d.why = "noEffect";
        releaseDecisions([d]);
        continue;
      }
      kept.push(d);
      entries.push({ abilityName: d.candidate.item.name, byName: d.candidate.reactor.name });
      effects.set(d.id, { halved: changed ? [event.subject.name] : [] });
    }
    reportDecisions(decisions);
    // Once more right before the write when somebody was asked (the cause noted before the prompt is still
    // fresh); not while another application's damage is settling (it would take that kill, §6.3).
    if (decisions.some(d => d.prompted)) noteCause({ own: false });
    if (!kept.length) return { holdId: null, amount, halved, entries: [] };
    const holdId = newId();
    pending.set(holdId, {
      holdId, kind: "external", userId: user?.id ?? null, decisions: kept, effects, amount, actorUuid: actor.uuid,
      source: event.source, expires: serverNow() + EXTERNAL_KEEP_MS, timer: clock.setTimeout(() => expire(holdId), EXTERNAL_KEEP_MS),
    });
    log("trigger.hold", { holdId, actor: actor.name, requested, amount, reactions: entries.map(e => e.abilityName) });
    return { holdId, amount, halved, entries };
  } catch (err) {
    error("triggers.externalHold", err);
    releaseDecisions(decisions);
    return passThrough;
  }
}

/** GM side of "holdDone": commit or release the hold; damage.after for external damage. */
export async function externalDone(req, user) {
  const r = req?.holdDone && typeof req.holdDone === "object" ? req.holdDone : (req ?? {});
  const p = r.holdId ? pending.get(r.holdId) : null;
  if (r.holdId && !p) return; // expired or unknown: nothing to commit
  // A hold is committed only by its requester (§6.13).
  if (p && p.userId !== (user?.id ?? null)) throw new Error("DSAUTO.Relay.Denied");
  try {
    if (p) {
      pending.delete(p.holdId);
      clock.clearTimeout(p.timer);
      if (r.applied) {
        setTimeout(() => runAfter({ holdDecisions: p.decisions, origin: null, effectsByDecision: p.effects })
          .catch(err => error("triggers.after", err)), 0);
      } else releaseDecisions(p.decisions); // the damage never landed: no card, no cost
      log("trigger.holdDone", { holdId: p.holdId, applied: !!r.applied });
    }
    // Milestone 7 (§3.4, C23): the report adds type and source to a Stamina change the active GM saw land (resource
    // gains). A non-active GM (the hold's GM) forwards it to the active one instead of observing it.
    if (r.applied && r.after) {
      if (isActiveGM()) observeExternalReport(r, user);
      else if (!r.reportOnly) {
        const sceneId = lookup(r.tokenUuid)?.parent?.id ?? null;
        if (gainsWant("damage", sceneId) || gainsWant("winded", sceneId)) {
          // The reporter travels with the forward: the active GM matches the change to the user who wrote it (C23).
          requestOp({ action: "holdDone", holdDone: { ...r, holdId: null, reportOnly: true, reporter: user?.id ?? null } })
            .catch(err => debug("gains.reportForward", { why: String(err?.message ?? err) }));
        }
      }
    }
    // Built here even when the active GM changed meanwhile: runAfter forwards it to the new one (third review).
    if (!r.applied || !r.before || (!triggersActive() && !featuresWantAfter(lookup(r.tokenUuid)?.parent?.id)) || !kindsInUse().has("damage.after")) return;
    const actor = lookup(r.actorUuid);
    if (!actor) return;
    if (total(r.after) !== total(actor.system?.stamina)) {
      log("trigger.holdDone.stale", { actor: actor.name }); // another write meanwhile
      return;
    }
    const dealt = Math.min(p?.amount ?? Infinity, total(r.before) - total(r.after));
    if (!(dealt > 0)) return;
    const token = lookup(r.tokenUuid) ?? tokenOnScene(actor, null);
    const event = {
      id: newId(), kind: "damage.after", sceneId: token?.parent?.id ?? null,
      subject: { actorUuid: actor.uuid, tokenUuid: token?.uuid ?? null, name: token?.name ?? actor.name, isHero: actor.type === "hero" },
      source: p?.source ?? { actorUuid: null, tokenUuid: null, itemUuid: null, name: null, keywords: [], fromAbility: false, known: false },
      damage: {
        instanceKey: `ext:${newId()}`, amount: dealt, type: "", halved: false, hasPotency: false, finalAmount: dealt,
        messageId: null, targetKey: null, external: true,
      },
      at: serverNow(),
    };
    setTimeout(() => runAfter({ afterEvents: [event] }).catch(err => error("triggers.after", err)), 0);
  } catch (err) {
    error("triggers.externalDone", err);
  }
}

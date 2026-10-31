import { runFeatureEvents, featuresWantAfter } from "../features/engine.mjs";
/**
 * Trigger engine (Milestone 5, docs/M5-DESIGN.md §0.1, §3.3, §3.7, §3.13). One engine on the active GM:
 * a trigger event (damage about to land or landed, a damage-dealing roll about to be made, a turn ended, a
 * move about to happen) is matched against reactors on the event's scene whose ability declares a
 * `triggers` entry for it (library overlay or detach stamp). Every eligible reactor gets one prompt listing
 * all its options, all in parallel, within a server-time deadline. Zero cost when unused: no overlay for
 * the event kind, or no started combat, means no relay, no prompt, no write.
 *
 * - `offer` resolves recipients before anything is written (review conc 4): a reactor nobody can answer
 *   for gives `noAnswer` decisions without a prompt, and the caller's `markHold` write runs once, right
 *   before the first prompt is actually sent.
 * - One prompt chain per reactor (prompt.mjs withReactorQueue): a queued prompt re-checks eligibility
 *   (budget, dazed, range) and gets only the time left before the offer's deadline, or no prompt at all
 *   (`timedOut`, why "deadline"; review conc 3).
 * - Accepting reserves the round's budget and the heroic resource in memory (budget.mjs); nothing is
 *   charged until the trigger card's ops apply. A player-side halving of an instance cancels the other
 *   player prompts that could only halve it (review conc 13); Director-side prompts are never cut short.
 * - Decisions come back player side first (by answer time), then Director side. Callers adjust the
 *   outcomes and fire `dsAuto.trigger` through `reportDecisions` (review conc 14).
 * Every function returns "nothing" quietly when the Foundry globals it reads are missing (harness mocks).
 *
 * i18n keys used by WP-A (engine, holds, card, budget, eligibility):
 *   DSAUTO.Reason.triggerResisted, DSAUTO.Warning.triggerPotencyLate, DSAUTO.Relay.BadRequest, DSAUTO.Relay.Denied,
 *   DSAUTO.Trigger.Card.{Title, Bleeding, Halved, Potency, Edge, Use, FreeStrike, TakeTurn},
 *   DSAUTO.Trigger.Dialog.{Title, UnknownSource, Spend, FreeStrikeTitle, FreeStrikeIntro},
 *   DSAUTO.Trigger.Dialog.Event.<eventKey> (dynamic, §5.6), DSAUTO.Trigger.Step.{halve, potency, edge1, edge2, use,
 *   freeStrike, takeTurnNext}.
 */
import { HOOKS, MODULE_ID, TRIGGERS_ID, loc } from "../constants.mjs";
import { allOverlays, onRegistryChange } from "../library/registry.mjs";
import { resolveAbility } from "../library/resolve.mjs";
import { requestOp } from "../relay/queries.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { combatFor, debit, markUsed, release, releaseDebit, reserve } from "./budget.mjs";
import { followUpPlan, postTriggerCard, runFollowUps } from "./card.mjs";
import { canPay, evaluate, resourceName, resourceValue } from "./eligibility.mjs";
import { cancelPrompt, clock, promptMs, promptReactor, recipientFor, withReactorQueue } from "./prompt.mjs";
import { effectNote, eventKey, realStep } from "./taxonomy.mjs";
import { MALICE_DEBIT_KEY } from "../resources/world-resources.mjs";

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const newId = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);

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

/* -------------------------------------------- */
/*  Gates                                       */
/* -------------------------------------------- */

/** Settings on and not deferred to draw-steel-triggers (§3.13). Any client. */
export function triggersActive() {
  return !!setting("enabled") && !!setting("triggersEnabled") && !triggersDeferred();
}

export function triggersDeferred() {
  try {
    return !!setting("deferToTriggersModule") && !!game.modules?.get?.(TRIGGERS_ID)?.active;
  } catch (_err) {
    return false;
  }
}

export const serverNow = () => game.time?.serverTime ?? Date.now();

/* -------------------------------------------- */
/*  Reactor discovery (cached per generation)   */
/* -------------------------------------------- */

let generation = 0;
const itemCache = new WeakMap(); // item -> {gen, value}
let kindsCache = null; // {gen, kinds}
const stampKinds = new Set(); // event kinds seen in detach stamps (flags["stef-ds-automation"].overlay.triggers)
let stampsScanned = false;

const bump = () => {
  generation++;
  kindsCache = null;
};

/** §1.4 defaults, applied again to stamps written by older code (cheap, idempotent). */
function normalizeTrigger(t) {
  return {
    subject: "self", range: "ability", loe: true, require: {},
    ...(String(t?.event ?? "").startsWith("damage.") ? { attacker: "any" } : {}),
    ...t,
    steps: (t?.steps ?? []).map(s => ({
      ...s,
      ...(s.type === "potency" ? { scope: s.scope ?? "all" } : {}),
      ...(s.type === "use" ? { targets: s.targets ?? "subject" } : {}),
      ...(s.type === "freeStrike" ? { by: s.by ?? "subject" } : {}),
    })),
  };
}

function stampTriggerKinds(item) {
  const stamp = item?.flags?.[MODULE_ID]?.overlay;
  for (const t of Array.isArray(stamp?.triggers) ? stamp.triggers : []) if (t?.event) stampKinds.add(t.event);
}

/** {triggers, trackers} of an ability item from resolveAbility (cached per item and cache generation). */
export function itemTriggers(item) {
  const empty = { triggers: [], trackers: [] };
  if (!item || item.type !== "ability") return empty;
  const hit = itemCache.get(item);
  if (hit && hit.gen === generation) return hit.value;
  let value = empty;
  try {
    const r = resolveAbility(item);
    value = {
      triggers: (Array.isArray(r?.triggers) ? r.triggers : []).map(normalizeTrigger),
      trackers: (Array.isArray(r?.trackers) ? r.trackers : []).map(k => ({ endPrevious: true, endOnSourceDying: false, ...k })),
    };
    if (r?.layer === "detached") for (const t of value.triggers) stampKinds.add(t.event);
  } catch (err) {
    debug("trigger.itemTriggers", { item: item?.name, error: String(err?.message ?? err) });
  }
  itemCache.set(item, { gen: generation, value });
  return value;
}

/** Event kinds any registered overlay declares (cached per generation). */
export function kindsInUse() {
  if (kindsCache?.gen === generation) return kindsCache.kinds;
  const kinds = new Set(["damage.after"]);
  try {
    for (const o of allOverlays()) for (const t of Array.isArray(o?.triggers) ? o.triggers : []) if (t?.event) kinds.add(t.event);
    if (!stampsScanned && game.actors) {
      stampsScanned = true;
      for (const actor of list(game.actors)) for (const item of list(actor?.items)) stampTriggerKinds(item);
      // Items detached on an unlinked token live in its ActorDelta, not in game.actors.
      for (const scene of list(game.scenes)) {
        for (const token of list(scene?.tokens)) {
          if (token?.actorLink) continue;
          for (const item of list(token?.actor?.items)) stampTriggerKinds(item);
        }
      }
    }
  } catch (err) {
    debug("trigger.kinds", { error: String(err?.message ?? err) });
  }
  for (const k of stampKinds) kinds.add(k);
  kindsCache = { gen: generation, kinds };
  return kinds;
}

function sceneById(sceneId) {
  try {
    if (sceneId) return game.scenes?.get?.(sceneId) ?? null;
    return globalThis.canvas?.scene ?? null;
  } catch (_err) {
    return null;
  }
}

/** Reactors of a scene, plus the tokens whose actor this client cannot read (possible reactors). */
function scanScene(sceneId, kind) {
  const reactors = [];
  let unknown = 0;
  const scene = sceneById(sceneId);
  if (!scene || !kindsInUse().has(kind)) return { reactors, unknown };
  for (const token of list(scene.tokens)) {
    const actor = token?.actor ?? null;
    if (!actor) {
      if (token?.actorId) unknown++;
      continue;
    }
    for (const item of list(actor.items)) {
      if (item?.type !== "ability") continue;
      for (const trigger of itemTriggers(item).triggers) if (trigger.event === kind) reactors.push({ token, actor, item, trigger });
    }
  }
  return { reactors, unknown };
}

/** Reactors on a scene for an event kind: [{token, actor, item, trigger}]. */
export function sceneReactors(sceneId, kind) {
  try {
    return scanScene(sceneId, kind).reactors;
  } catch (err) {
    debug("trigger.sceneReactors", { error: String(err?.message ?? err) });
    return [];
  }
}

/** Cheap local gate for wrappers and the roll lock (any client): could anything on that scene react? */
export function mayHold(kind, sceneId) {
  try {
    if (kind === "damage.after" && featuresWantAfter(sceneId)) return true;
    if (!triggersActive() || !kindsInUse().has(kind)) return false;
    if (!setting("triggersOutsideCombat") && !combatFor(sceneId)?.started) return false;
    const { reactors, unknown } = scanScene(sceneId, kind);
    return reactors.length > 0 || (unknown > 0 && !game.user?.isGM);
  } catch (_err) {
    return false;
  }
}

/** Scene id of a token uuid ("Scene.<id>.Token.<id>"). */
export const sceneIdOf = tokenUuid => /^Scene\.([A-Za-z0-9]{16})\./.exec(String(tokenUuid ?? ""))?.[1] ?? null;

export function mayHoldDamage(tokenUuids) {
  return (tokenUuids ?? []).some(u => mayHold("damage.before", sceneIdOf(u)));
}

/** Eligible candidates of one event (calls dsAuto.preTrigger; drops muted ones). Active GM. */
export function candidatesFor(event) {
  if (!isActiveGM() || !triggersActive() || !event?.kind) return [];
  const combat = combatFor(event.sceneId ?? null);
  const out = [];
  for (const r of sceneReactors(event.sceneId ?? null, event.kind)) {
    const c = evaluate({ event, reactorActor: r.actor, reactorToken: r.token, item: r.item, trigger: r.trigger, combat });
    if (!c) continue;
    try {
      if (Hooks.call(HOOKS.preTrigger, event, c) === false) {
        debug("trigger.vetoed", { reactor: c.reactor.name, item: c.item.name, event: event.kind });
        continue;
      }
    } catch (err) {
      error("triggers.preTrigger", err);
    }
    out.push(c);
  }
  return out;
}

/* -------------------------------------------- */
/*  "Not this round"                            */
/* -------------------------------------------- */

const mutes = new Set(); // `${reactorUuid}|${itemUuid}|${combatId}|${round}`
const muteKey = (reactorUuid, itemUuid, combat) => `${reactorUuid}|${itemUuid}|${combat?.id}|${combat?.round}`;

/** "Not this round" (review rules-ux 10): in-memory, keyed (reactorUuid, itemUuid, combatId, round); cleared on round change. */
export function mute(reactorUuid, itemUuid, combat) {
  if (!combat?.id || !reactorUuid || !itemUuid) return;
  mutes.add(muteKey(reactorUuid, itemUuid, combat));
}

export function isMuted(reactorUuid, itemUuid, combat) {
  return !!combat?.id && mutes.has(muteKey(reactorUuid, itemUuid, combat));
}

function clearMutes(combatId) {
  for (const k of mutes) if (k.split("|")[2] === combatId) mutes.delete(k);
}

/* -------------------------------------------- */
/*  Held subjects                               */
/* -------------------------------------------- */

const held = new Map(); // actorUuid -> count of instances held right now

/** GM: subjects of instances held right now (external holds on them pass through, review integration 5). */
export function heldSubjects() {
  return new Set(held.keys());
}

/** Mark subjects held while our pre-pass prompts; returns the release function (counted per instance). */
export function holdSubjects(actorUuids) {
  const ids = [...(actorUuids ?? [])].filter(Boolean);
  for (const id of ids) held.set(id, (held.get(id) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const id of ids) {
      const n = (held.get(id) ?? 1) - 1;
      if (n > 0) held.set(id, n);
      else held.delete(id);
    }
  };
}

/* -------------------------------------------- */
/*  Offer                                       */
/* -------------------------------------------- */

const signed = n => (Number(n) > 0 ? `+${Number(n)}` : String(Number(n) || 0));

function stepText(s, c) {
  switch (s.type) {
    case "halve": return loc("DSAUTO.Trigger.Step.halve");
    case "potency": return loc("DSAUTO.Trigger.Step.potency", { delta: signed(s.delta) });
    case "edge": return Number(s.amount) >= 2 ? loc("DSAUTO.Trigger.Step.edge2") : loc("DSAUTO.Trigger.Step.edge1");
    case "use": return loc("DSAUTO.Trigger.Step.use", { ability: c.item.name });
    case "freeStrike": return loc("DSAUTO.Trigger.Step.freeStrike");
    case "takeTurnNext": return loc("DSAUTO.Trigger.Step.takeTurnNext");
    case "note": return String(s.text ?? "");
    default: return "";
  }
}

/** What an option does, in our words: the base steps, and what the spend adds. */
function stepsText(c, resource) {
  const text = steps => steps.map(s => stepText(s, c)).filter(Boolean).join(", ");
  const base = text(c.steps.base);
  if (c.spendMode === "none" || !c.steps.spend.length) return base;
  const spend = text(c.steps.spend);
  if (!base) return spend;
  return `${base} (${loc("DSAUTO.Trigger.Dialog.Spend", { cost: c.spendCost, resource })}: ${spend})`;
}

/** The event in one sentence (prompt intro). */
export function eventText(ev) {
  const source = ev?.source?.name || loc("DSAUTO.Trigger.Dialog.UnknownSource");
  const amount = ev?.damage ? (ev.damage.finalAmount ?? ev.damage.amount ?? 0) : 0;
  const ability = ev?.roll ? (lookup(ev.roll.abilityUuid)?.name ?? "") : "";
  return loc(`DSAUTO.Trigger.Dialog.Event.${eventKey(ev?.kind ?? "")}`, { subject: ev?.subject?.name ?? "", amount, source, ability });
}

/** One candidate per instance (or event): the entry an unanswered prompt leaves on the card. */
function uniqueByInstance(cands) {
  const seen = new Set();
  return cands.filter(c => {
    const k = c.event.damage?.instanceKey ?? c.event.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const optionId = c => `${c.event.id}|${String(c.item.uuid).split(".").pop()}|${c.trigger.id}`;

function decision(c, outcome, answer = null, extra = {}) {
  return {
    id: newId(), candidate: c, outcome, why: answer?.why ?? null, spend: false, steps: [],
    by: answer?.by ?? null, at: answer?.at ?? serverNow(), playerSide: !!c.reactor.playerSide, prompted: false,
    reservation: null, debit: null, combatId: null, round: null,
    ...extra,
  };
}

/** A halving of an instance another reactor already halved is moot now (review conc 13). */
function withoutMootHalve(c, shared) {
  const K = c.event.damage?.instanceKey;
  if (!K || !shared.halvedBy.has(K)) return c;
  const strip = steps => steps.filter(s => s.type !== "halve");
  const steps = { base: strip(c.steps.base), spend: strip(c.steps.spend) };
  if (!steps.base.some(realStep) && !steps.spend.some(realStep)) return null;
  // The spend is now the option's only effect: pre-ticked and charged (as evaluate does, third review).
  if (c.spendMode === "optional" && !steps.base.some(realStep)) return { ...c, steps: { base: [], spend: steps.spend }, spendMode: "required" };
  return { ...c, steps };
}

const onlyHalves = c => [...c.steps.base, ...c.steps.spend].every(s => s.type === "halve" || (s.type === "note" && !effectNote(s)));

async function askReactor(g, shared) {
  // Given up while it waited in the reactor's queue (offer's deadline race): never prompts or reserves.
  if (g.abandoned) return [];
  g.started = true;
  if (shared.signal?.aborted) return uniqueByInstance(g.list).map(c => decision(c, "cancelled", null, { why: "aborted" }));
  const remaining = shared.deadline - serverNow();
  if (remaining < 3_000) return uniqueByInstance(g.list).map(c => decision(c, "timedOut", null, { why: "deadline" }));
  const actor = lookup(g.uuid);
  if (!actor) return [];
  // Re-check after the queue wait: budget, dazed, range may have changed.
  let live = g.list.map(c => evaluate({
    event: c.event, reactorActor: actor, reactorToken: lookup(c.reactor.tokenUuid), item: lookup(c.item.uuid), trigger: c.trigger,
    combat: combatFor(c.event.sceneId ?? null),
  })).filter(Boolean);
  live = live.map(c => withoutMootHalve(c, shared)).filter(Boolean);
  if (!live.length) return [];
  const resource = resourceName(actor);
  const have = resourceValue(actor);
  const intros = [...new Set(live.map(c => c.event.id))].map(id => eventText(live.find(c => c.event.id === id).event));
  const request = {
    type: "trigger", promptId: newId(), title: loc("DSAUTO.Trigger.Dialog.Title", { name: actor.name }), intro: intros.join(" "),
    reactor: { actorUuid: actor.uuid, name: actor.name, img: actor.img ?? null }, canMute: !!combatFor(live[0].event.sceneId ?? null),
    options: live.map(c => ({
      id: optionId(c), abilityName: c.item.name, subjectName: c.event.subject?.name ?? "", eventKind: c.event.kind,
      label: c.trigger.label ?? null,   // the overlay's prompt subtitle (our words, schema rule 10)
      stepsText: stepsText(c, resource), cost: c.cost, resourceName: resource, have, budget: c.budget,
      spend: c.spendMode === "none" ? null : { cost: c.spendCost, label: c.trigger.spend?.label ?? null, required: c.spendMode === "required" },
      bleeding: !!c.bleeding,
    })),
  };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (shared.signal?.aborted) controller.abort();
  else shared.signal?.addEventListener?.("abort", onAbort, { once: true });
  shared.pending.set(request.promptId, { playerSide: !!live[0].reactor.playerSide, live, controller });
  let answer;
  try {
    answer = await promptReactor(actor, request, {
      signal: controller.signal, recipient: g.rcpt, timeoutMs: Math.min(shared.promptMs, remaining - 3_000),
      onFirstPrompt: shared.firstPrompt,
    });
  } finally {
    shared.pending.delete(request.promptId);
    shared.signal?.removeEventListener?.("abort", onAbort);
  }
  answer ??= { outcome: "noAnswer", by: null, at: serverNow() };
  if (answer.mute) for (const c of live) mute(c.reactor.actorUuid, c.item.uuid, combatFor(c.event.sceneId ?? null));
  if (answer.outcome !== "used") return uniqueByInstance(live).map(c => decision(c, answer.outcome, answer, { prompted: true }));
  const c = live.find(o => optionId(o) === answer.optionId);
  if (!c) return [decision(live[0], "error", answer, { prompted: true, why: "badOption" })];
  const spend = c.spendMode === "required" || (c.spendMode === "optional" && !!answer.spend);
  const total = c.cost + (spend ? c.spendCost : 0);
  // canPay counts pending debits of other answered prompts (review conc 17).
  if (!canPay(actor, total)) return [decision(c, "moot", answer, { prompted: true, why: "cost" })];
  const combat = combatFor(c.event.sceneId ?? null);
  const id = newId();
  let reservation = null;
  if (c.budget === "triggered" && combat) {
    reservation = reserve(actor, combat, { ability: c.item.name, decisionId: id });
    if (!reservation) return [decision(c, "moot", answer, { prompted: true, why: "budget" })];
  }
  // Milestone 7 (§3.8): NPC reactors pay from the shared Malice pool, so their pending debits share one key.
  const debitToken = total > 0 ? debit(actor?.type === "npc" ? { uuid: MALICE_DEBIT_KEY } : actor, total) : null;
  const d = decision(c, "used", answer, {
    id, spend, steps: spend ? c.steps.spend : c.steps.base, reservation, debit: debitToken,
    combatId: combat?.id ?? null, round: combat?.round ?? null, prompted: true,
  });
  markUsed(reservation);
  // A player-side halving of instance K makes other player prompts that only halve K pointless.
  const K = c.event.damage?.instanceKey;
  if (K && c.reactor.playerSide && d.steps.some(s => s.type === "halve") && !shared.halvedBy.has(K)) {
    shared.halvedBy.set(K, d.id);
    for (const [pid, p] of shared.pending) {
      if (p.playerSide && p.live.every(o => o.event.damage?.instanceKey === K && onlyHalves(o))) cancelPrompt(pid, "moot");
    }
  }
  return [d];
}

/**
 * askReactor through the reactor's prompt chain, the wait in that chain bounded by the offer's deadline
 * (§6.2: every GM-side wait ends by deadline - 3 s): a job still queued then gives `timedOut` (why "deadline")
 * and is abandoned (it never prompts or reserves); a prompt already started is never dropped.
 */
function queuedAsk(g, shared, end) {
  let timer = null;
  const give = new Promise(resolve => {
    timer = clock.setTimeout(() => {
      if (g.started) return;
      g.abandoned = true;
      resolve(uniqueByInstance(g.list).map(c => decision(c, "timedOut", null, { why: "deadline" })));
    }, Math.max(0, end - 3_000 - serverNow()));
  });
  const run = withReactorQueue(g.uuid, () => askReactor(g, shared))
    .catch(err => {
      error("triggers.ask", err);
      return uniqueByInstance(g.list).map(c => decision(c, "error", null, { why: "error" }));
    })
    .finally(() => clock.clearTimeout(timer));
  return Promise.race([run, give]);
}

/**
 * Prompt every eligible reactor of these events (one prompt per reactor, all in parallel), collect the
 * answers, reserve budgets and debits, cancel prompts that became moot. Never throws; never writes documents
 * itself (markHold is the caller's write, called at most once, right before the first prompt is sent).
 * @param {TriggerEvent[]} events
 * @param {{phase: "hold"|"after"|"preRoll"|"turn"|"gate", deadline: number (server ms), promptMs?: number,
 *          markHold?: (names: {text, playerSide}[], until: number) => Promise<void>, signal?: AbortSignal}} options
 * @returns {Promise<Decision[]>}   player-side decisions first (by answer time), then Director-side
 */
export async function offer(events, { phase = "hold", deadline = null, promptMs: P = null, markHold = null, signal = null } = {}) {
  const decisions = [];
  try {
    if (!events?.length || !triggersActive() || !isActiveGM() || signal?.aborted) return [];
    const T = Number(P) > 0 ? Number(P) : promptMs();
    const end = Number.isFinite(deadline) ? deadline : serverNow() + 2 * T + 6_000;
    const cands = events.flatMap(e => candidatesFor(e));
    if (!cands.length) return [];
    const groups = new Map();
    for (const c of cands) {
      const g = groups.get(c.reactor.actorUuid) ?? { uuid: c.reactor.actorUuid, name: c.reactor.name, playerSide: !!c.reactor.playerSide, list: [] };
      g.list.push(c);
      groups.set(g.uuid, g);
    }
    // Recipients first, before any write (review conc 4).
    for (const g of groups.values()) {
      try {
        g.rcpt = recipientFor(lookup(g.uuid)) ?? { none: true, why: "noRecipient" };
      } catch (err) {
        error("triggers.recipient", err);
        g.rcpt = { none: true, why: "error" };
      }
    }
    const live = [...groups.values()].filter(g => !g.rcpt.none);
    const abilityNames = g => [...new Set(g.list.map(c => c.item.name))].join(", ");
    let first = null;
    const shared = {
      halvedBy: new Map(), pending: new Map(), deadline: end, promptMs: T, signal,
      firstPrompt: () => (first ??= (async () => {
        if (!markHold) return;
        try {
          await markHold(live.map(g => ({ text: `${g.name} (${abilityNames(g)})`, playerSide: g.playerSide })), end + 3_000);
        } catch (err) {
          error("triggers.markHold", err);
        }
      })()),
    };
    log("trigger.offer", { phase, events: events.map(e => e.kind), reactors: [...groups.values()].map(g => g.name), asked: live.length });
    const lists = await Promise.all([...groups.values()].map(g => (g.rcpt.none
      ? Promise.resolve(uniqueByInstance(g.list).map(c => decision(c, "noAnswer", null, { why: g.rcpt.why ?? null })))
      : queuedAsk(g, shared, end))));
    for (const l of lists) decisions.push(...(l ?? []));
    decisions.sort((a, b) => (Number(b.playerSide) - Number(a.playerSide)) || ((a.at ?? 0) - (b.at ?? 0)));
    return decisions;
  } catch (err) {
    error("triggers.offer", err);
    releaseDecisions(decisions);
    return [];
  }
}

/** Fire dsAuto.trigger for final decisions (callers, §1.11). */
export function reportDecisions(decisions) {
  for (const d of decisions ?? []) {
    log("trigger.decision", {
      reactor: d.candidate?.reactor?.name, ability: d.candidate?.item?.name, event: d.candidate?.event?.kind,
      outcome: d.outcome, why: d.why ?? undefined, spend: d.spend || undefined, by: d.by ?? undefined,
    });
    try {
      Hooks.callAll(HOOKS.trigger, d.candidate?.event ?? null, d);
    } catch (err) {
      error("triggers.report", err);
    }
  }
}

/** Release every reservation and debit of these decisions (dropped, moot, not landed, not committed). */
export function releaseDecisions(decisions) {
  for (const d of decisions ?? []) {
    if (!d) continue;
    release(d.reservation);
    releaseDebit(d.debit);
    d.reservation = null;
    d.debit = null;
  }
}

/* -------------------------------------------- */
/*  After the batch                             */
/* -------------------------------------------- */

/** Post one used decision's trigger card and run its follow-ups. */
async function commit(d, { origin = null, effects = {} } = {}) {
  const plan = followUpPlan(d);
  const id = await postTriggerCard(d, {
    origin: effects.origin ?? origin, effects, followUps: plan.map(p => ({ kind: p.kind, userId: p.userId })),
    warnings: effects.late?.length ? [{ code: "triggerPotencyLate" }] : [],
  });
  if (id && plan.length) await runFollowUps(d, { triggerMessageId: id, plan });
}

const plain = v => JSON.parse(JSON.stringify(v ?? null));
const MAX_FORWARD = 20;

/**
 * The active GM changed after these reactions were decided here (an Assistant answered, a Gamemaster logged
 * in): their effect landed, so the new active GM posts their cards (relay action `triggerCommit`). The
 * in-memory reservation and debit stay here and are released; the card's own ops charge budget and cost.
 * The damage.after events of a hit that landed here go along: the new active GM offers them (third review).
 */
async function forwardCommit(decisions, origin, effectsByDecision, afterEvents = []) {
  const used = (decisions ?? []).filter(d => d?.outcome === "used" && d.candidate).slice(0, MAX_FORWARD);
  const events = (afterEvents ?? []).filter(e => e?.kind === "damage.after").slice(0, MAX_FORWARD);
  if ((!used.length && !events.length) || !game.users?.activeGM || game.users.activeGM.isSelf) return false;
  const payload = {
    origin: origin ? plain(origin) : null,
    decisions: used.map(d => {
      const { reservation: _r, debit: _d, ...rest } = d;
      return { decision: plain(rest), effects: plain(effectsByDecision?.get?.(d.id) ?? {}) };
    }),
    afterEvents: events.map(plain),
  };
  try {
    await requestOp({ action: "triggerCommit", triggerCommit: payload });
    log("triggers.after", { why: "forwarded", to: game.users.activeGM?.name, decisions: used.length, events: events.length });
    return true;
  } catch (err) {
    log("triggers.after", { why: "forwardFailed", error: String(err?.message ?? err) });
    return false;
  }
}

/** A forwarded damage.after event (another GM's landed hit), re-stamped here; null when malformed. */
function forwardedEvent(e) {
  if (!e || typeof e !== "object" || e.kind !== "damage.after" || typeof e.subject?.actorUuid !== "string") return null;
  const amount = Number(e.damage?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !lookup(e.subject.actorUuid)) return null;
  return { ...e, id: typeof e.id === "string" ? e.id : newId(), at: serverNow() };
}

/** Active GM side of relay action `triggerCommit` (another GM's decided reactions and landed hits, see forwardCommit). */
export async function handleTriggerCommit(req, user) {
  const r = req?.triggerCommit ?? req;
  if (!user?.isGM) throw new Error("DSAUTO.Relay.Denied");
  if (!isActiveGM()) return { ok: true, count: 0 };
  const holdDecisions = [];
  const effectsByDecision = new Map();
  for (const x of (r?.decisions ?? []).slice(0, MAX_FORWARD)) {
    const d = x?.decision;
    if (!d || typeof d !== "object" || typeof d.id !== "string" || d.outcome !== "used" || !d.candidate?.reactor?.actorUuid || !d.candidate?.item) continue;
    holdDecisions.push({ ...d, steps: Array.isArray(d.steps) ? d.steps : [], reservation: null, debit: null });
    effectsByDecision.set(d.id, x.effects && typeof x.effects === "object" ? x.effects : {});
  }
  const afterEvents = (Array.isArray(r?.afterEvents) ? r.afterEvents : []).slice(0, MAX_FORWARD).map(forwardedEvent).filter(Boolean);
  if (holdDecisions.length || afterEvents.length) {
    setTimeout(() => runAfter({ afterEvents, holdDecisions, origin: r?.origin ?? null, effectsByDecision })
      .catch(err => error("triggers.after", err)), 0);
  }
  log("triggers.commitForwarded", { from: user?.name, decisions: holdDecisions.length, events: afterEvents.length });
  return { ok: true, count: holdDecisions.length + afterEvents.length };
}

/** After an apply batch (async, outside every lock, active GM only): damage.after offers, after-steps, trigger cards. */
export async function runAfter({ afterEvents = [], holdDecisions = [], origin = null, effectsByDecision = new Map() } = {}) {
  if (!isActiveGM()) {
    log("triggers.after", { why: "notActiveGM" });
    await forwardCommit(holdDecisions, origin, effectsByDecision, afterEvents);
    releaseDecisions(holdDecisions);
    return;
  }
  // Decided inside the hold, landed (§3.1.2) or committed (§3.2, §3.11).
  for (const d of holdDecisions ?? []) {
    try {
      await commit(d, { origin, effects: effectsByDecision?.get?.(d.id) ?? {} });
    } catch (err) {
      error("triggers.card", err);
      releaseDecisions([d]);
    }
  }
  if (!afterEvents?.length) return;
  await runFeatureEvents(afterEvents);
  const T = promptMs();
  const decisions = await offer(afterEvents, { phase: "after", deadline: serverNow() + 2 * T + 6_000 });
  reportDecisions(decisions);
  for (const d of decisions) {
    if (d.outcome !== "used") {
      releaseDecisions([d]);
      continue;
    }
    try {
      await commit(d, { origin: null, effects: {} });
    } catch (err) {
      error("triggers.card", err);
      releaseDecisions([d]);
    }
  }
}

/* -------------------------------------------- */
/*  Listings and registration                   */
/* -------------------------------------------- */

/** Listing for api.triggers.reactors and the medkit. */
export function listTriggers(actor) {
  const out = [];
  for (const item of list(actor?.items)) {
    if (item?.type !== "ability") continue;
    const { triggers, trackers } = itemTriggers(item);
    if (triggers.length || trackers.length) out.push({ itemUuid: item.uuid, name: item.name, triggers, trackers });
  }
  return out;
}

const CACHE_SETTINGS = new Set([`${MODULE_ID}.libraryEnabled`, `${MODULE_ID}.libraryDefersToCombatTools`]);

/**
 * Does an actor update change what library/identity.mjs monsterKeys reads (name, `flags.stef-ds-automation.monsterKey`
 * set or unset, compendium source)? Covers unsetFlag's `-=monsterKey` key and a ForcedDeletion value.
 */
export function monsterKeyChanged(changes) {
  if (!changes || typeof changes !== "object") return false;
  if ("name" in changes) return true;
  const flags = changes.flags;
  if (flags && typeof flags === "object" && (MODULE_ID in flags || `-=${MODULE_ID}` in flags)) {
    const f = flags[MODULE_ID];
    if (!f || typeof f !== "object") return true;
    if (Object.keys(f).some(k => k === "monsterKey" || k === "-=monsterKey")) return true;
  }
  if (changes._stats && typeof changes._stats === "object" && "compendiumSource" in changes._stats) return true;
  return Object.keys(changes).some(k => k.includes("monsterKey") || k === "name");
}

/** Cache invalidation: registry changes, item create/update/delete, libraryEnabled; DSCT setting snapshot at ready. */
export function registerTriggerEngine() {
  onRegistryChange(bump);
  const onItem = item => {
    try {
      stampTriggerKinds(item);
      bump();
    } catch (err) {
      error("triggers.cache", err);
    }
  };
  Hooks.on("createItem", onItem);
  Hooks.on("updateItem", onItem);
  Hooks.on("deleteItem", onItem);
  // Monster-specific overlays follow the actor's monster key (pinned flag, compendium source, name slug).
  Hooks.on("updateActor", (_actor, changes) => {
    try {
      if (monsterKeyChanged(changes)) bump();
    } catch (err) {
      error("triggers.cache", err);
    }
  });
  const onSetting = s => {
    try {
      if (CACHE_SETTINGS.has(s?.key)) bump();
    } catch (err) {
      error("triggers.cache", err);
    }
  };
  Hooks.on("createSetting", onSetting);
  Hooks.on("updateSetting", onSetting);
  Hooks.on("updateCombat", (combat, changes) => {
    try {
      if (combat?.id && changes && "round" in changes) clearMutes(combat.id);
    } catch (err) {
      error("triggers.mutes", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      if (combat?.id) clearMutes(combat.id);
    } catch (err) {
      error("triggers.mutes", err);
    }
  });
}

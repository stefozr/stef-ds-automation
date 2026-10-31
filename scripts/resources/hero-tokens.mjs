/**
 * Hero-token regain on a lethal hit (Milestone 7, docs/M7-DESIGN.md §1.5, §1.8, §3.7, CH3, D2, Q5, §6.1, §6.2). Active GM.
 *
 * - `heroTokenPrePass` is the engine step right after the M5 pre-pass in applyOpList: when our damage would leave a hero
 *   at 0 Stamina or less (after halving, immunity, weakness, temporary Stamina) and the party has 2+ hero tokens, the
 *   hero's online non-GM owner is asked (prompt type `heroTokenRegain`); a hero without any non-GM owner is asked on the
 *   active GM itself (the same dialog, through the local prompt router); an owner who is offline is not replaced.
 * - One spend of ours per hero per turn (combat round + turn), reserved synchronously while planning (C6), bound to the
 *   heal op on "Spend", freed on decline / timeout / not lethal any more / undo / `damageNotApplied` (R6). Out of combat
 *   there is no turn: no reservation.
 * - Asks run through the hero's reactor queue (one prompt per hero, triggers and hero tokens); an ask that cannot START
 *   within 5 s is skipped ("busy"), so a busy hero never stretches the card's hold (§6.1). The card's waiting banner is a
 *   new hold marker written when the first ask starts (C13). Each ask re-projects from live Stamina when it starts.
 * - "Spend" builds a heal op with `heroToken.damageOpId`, inserted by the engine before its damage op: it pays 2 tokens
 *   on the world chain (never the system's `spendToken`) and heals the recovery value before the damage lands, so Death
 *   Tracker never sees the hero at 0 on the way. Undo: Stamina (absolute / delta), tokens back (`dsblQuiet`), spend freed.
 * - Spends through the system's own hero-token buttons are not seen (the dialog reminds the player, §8).
 * i18n keys: DSAUTO.Reason.noHeroTokens (and existing DSAUTO.Reason.targetMissing).
 */
import * as C from "../constants.mjs";
import { OP_STATUS, QUERY_PROMPT } from "../constants.mjs";
import { effectiveAmount, immunityWeakness, opSource, snapStamina } from "../engine/damage.mjs";
import { opId } from "../engine/keys.mjs";
import { debug, error, log } from "../log.mjs";
import { routePrompt } from "../relay/prompt-router.mjs";
import { setting } from "../settings.mjs";
import { combatFor } from "../triggers/budget.mjs";
import { triggerHalved } from "../triggers/holds.mjs";
import { clock, ownersOf, promptMs, withReactorQueue } from "../triggers/prompt.mjs";
import { sceneIdOf } from "./facts.mjs";
import { setWorldValue, withResourceChain, worldValue } from "./world-resources.mjs";

export const EMPTY_HERO_PASS = Object.freeze({ ops: Object.freeze([]), gone: false, held: false });

const COST = 2;
const START_MS = 5_000;          // an ask that cannot start within 5 s is skipped
const GM_SLACK_MS = 3_000;       // the GM gives up at timeoutMs + 3 s
const QUERY_SLACK_MS = 10_000;   // the query socket at timeoutMs + 10 s
const SHORT_QUERY_MS = 10_000;
const OWNER_OUTCOMES = new Set(["spend", "decline", "timedOut", "closed", "cancelled"]);
const HOOK_HERO_TOKEN = () => C.HOOKS?.heroToken ?? "dsAuto.heroToken";

const spends = new Map();   // hero actor uuid -> {turnKey, combatId, round, messageId, opId}
const open = new Map();     // promptId -> {resolve, user, local, heroName, heroUuid, deadline}

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const serverNow = () => game.time?.serverTime ?? Date.now();
const randomID = () => globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2, 18);
const defeatedId = () => globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
const promptOn = () => setting("heroTokenPrompt") ?? true;

function lookup(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------- */
/*  Turn spends                                 */
/* -------------------------------------------- */

/** The turn key of a hero's combat (`${combat.id}:${round}:${turn}`), null out of combat. */
function turnKeyFor(sceneId) {
  const combat = combatFor(sceneId ?? null);
  if (!combat?.started) return { turnKey: null, combat: null };
  return { turnKey: `${combat.id}:${combat.round}:${combat.turn}`, combat };
}

/** Reserve the hero's spend of this turn (sync). False when this turn's spend is taken. */
function reserveSpend(heroUuid, turnKey, combat, messageId) {
  if (!turnKey) return true;
  const cur = spends.get(heroUuid);
  if (cur && cur.turnKey === turnKey) return false;
  spends.set(heroUuid, { turnKey, combatId: combat?.id ?? null, round: combat?.round ?? null, messageId, opId: null });
  return true;
}

/** Free the spend when it is still the one of this message (planning) or of this op (the heal). */
function releaseSpend(heroUuid, by) {
  const cur = spends.get(heroUuid);
  if (cur && by && (cur.messageId === by || cur.opId === by)) spends.delete(heroUuid);
}

function bindSpend(heroUuid, id) {
  const cur = spends.get(heroUuid);
  if (cur) cur.opId = id;
}

/** Has the hero spent (or reserved) this turn? */
function spentThisTurn(heroUuid, sceneId) {
  const { turnKey } = turnKeyFor(sceneId);
  return !!turnKey && spends.get(heroUuid)?.turnKey === turnKey;
}

/* -------------------------------------------- */
/*  Who is asked                                */
/* -------------------------------------------- */

/** Has the actor any non-GM owner (online or not)? */
function hasPlayerOwner(actor) {
  try {
    if (typeof actor?.hasPlayerOwner === "boolean") return actor.hasPlayerOwner;
    return !!game.users?.some?.(u => !u.isGM && actor?.testUserPermission?.(u, "OWNER"));
  } catch (_err) {
    return false;
  }
}

/** The hero's online non-GM owner; no non-GM owner at all → the active GM (local); an offline owner → null (Q5). */
function askerFor(hero) {
  const owner = ownersOf(hero)[0] ?? null;
  if (owner) return { user: owner, local: false, name: owner.name, isGM: false };
  if (hasPlayerOwner(hero)) return null;
  return { user: game.user, local: true, name: game.user?.name ?? "", isGM: true };
}

/* -------------------------------------------- */
/*  Projection                                  */
/* -------------------------------------------- */

/**
 * What the listed damage ops of one hero would leave (§3.7 project): {value, temporary, max, after, withHeal, rv}.
 * A halved base (M5 Parry) halves base + surges together, as damage.mjs applySurgeOp.
 */
export function project(message, resLive, hero, list) {
  const rv = Number(hero?.system?.recoveries?.recoveryValue) || 0;
  const st = hero?.system?.stamina ?? {};
  const value = Number(st.value) || 0;
  const temporary = Number(st.temporary) || 0;
  const max = Number.isFinite(Number(st.max)) ? Number(st.max) : value + rv;
  const bases = new Map();   // base opId -> {base, surges}
  for (const op of list) {
    const baseId = op.surge?.baseOpId ?? op.opId;
    const base = op.surge ? (resLive?.ops?.[baseId] ?? null) : op;
    if (!base) continue;
    const entry = bases.get(baseId) ?? { base, inList: false, surges: 0 };
    if (op.surge) entry.surges += Number(op.amount) || 0;
    else entry.inList = true;
    bases.set(baseId, entry);
  }
  let projected = 0;
  for (const { base, inList, surges } of bases.values()) {
    let src = null;
    try {
      src = opSource(message, base);
    } catch (_err) { /* roll gone */ }
    if (!src || src.isHeal) continue;
    const { immunity, weakness } = immunityWeakness(hero, src);
    const raw = Number(src.total) || 0;
    const B = effectiveAmount(src, base);
    const halved = triggerHalved(base);
    const hit = x => (halved ? Math.floor((raw + x) / 2) : B + x);
    const f = x => Math.max(0, x + weakness - immunity);
    if (inList) projected += f(hit(surges));
    else {
      // Surges on an applied base: the difference they make on top of the surges applied earlier.
      const earlier = Object.values(resLive?.ops ?? {})
        .filter(o => o?.surge?.baseOpId === base.opId && o.status === OP_STATUS.APPLIED)
        .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
      projected += Math.max(0, f(hit(earlier + surges)) - f(hit(earlier)));
    }
  }
  const loss = Math.max(0, projected - temporary);
  return { value, temporary, max, rv, projected, after: value - loss, withHeal: Math.min(max, value + rv) - loss };
}

/* -------------------------------------------- */
/*  The ask                                     */
/* -------------------------------------------- */

/** Run `fn` on the hero's reactor queue unless it cannot start within `ms` ({outcome: "busy"} then). */
function withReactorQueueStart(uuid, ms, fn) {
  const queuedAt = clock.now();
  return withReactorQueue(uuid, async () => {
    if (clock.now() - queuedAt > ms) return { outcome: "busy" };
    return fn();
  });
}

/** Ask one hero's owner (or the active GM). Resolves {outcome, by}, never rejects. */
async function ask(a, live) {
  const t = promptMs();
  const request = {
    type: "heroTokenRegain", promptId: randomID(), heroName: a.hero.name ?? "", heroUuid: a.hero.uuid, cost: COST,
    tokens: worldValue("heroToken"), amount: live.rv, staminaNow: live.value, staminaAfter: live.after,
    staminaWith: live.withHeal, deadline: clock.now() + t, timeoutMs: t,
  };
  const { user, local } = a.asker;
  const slot = { resolve: null, user, local, heroName: request.heroName, heroUuid: a.hero.uuid, deadline: request.deadline };
  const cancelP = new Promise(resolve => { slot.resolve = resolve; });
  open.set(request.promptId, slot);
  let timer = null;
  try {
    log("heroToken.prompt", { promptId: request.promptId, hero: request.heroName, to: local ? "director" : user?.name, ms: t, after: live.after });
    const asked = local
      ? routePrompt(request, { user: game.user })
      : user.query(QUERY_PROMPT, request, { timeout: t + QUERY_SLACK_MS });
    const answerP = Promise.resolve(asked)
      .then(x => ({ ...(x ?? { outcome: "closed" }), fromOwner: true }))
      .catch(err => ({ outcome: "noAnswer", why: String(err?.message ?? err) }));
    const timerP = new Promise(resolve => {
      timer = clock.setTimeout(() => resolve({ outcome: "timedOut", why: "gmDeadline" }), Math.max(0, request.deadline - clock.now()) + GM_SLACK_MS);
    });
    const raw = await Promise.race([answerP, timerP, cancelP]);
    // Every outcome the asker did not give closes the asker's dialog.
    if (!raw.fromOwner) {
      const cancel = { type: "heroTokenRegainCancel", promptId: request.promptId };
      Promise.resolve()
        .then(() => (local ? routePrompt(cancel, { user: game.user }) : (user.active !== false ? user.query(QUERY_PROMPT, cancel, { timeout: SHORT_QUERY_MS }) : null)))
        .catch(err => debug("heroToken.cancelFailed", { promptId: request.promptId, why: String(err?.message ?? err) }));
    }
    const outcome = raw.fromOwner && !OWNER_OUTCOMES.has(raw.outcome) ? "decline" : raw.outcome;
    log("heroToken.answer", { promptId: request.promptId, outcome, why: raw.why ?? null });
    return { outcome, promptId: request.promptId, by: local ? game.userId : (user?.id ?? null) };
  } catch (err) {
    error("heroToken.ask", err, { promptId: request.promptId });
    return { outcome: "noAnswer", promptId: request.promptId, by: null };
  } finally {
    clock.clearTimeout(timer);
    open.delete(request.promptId);
  }
}

/**
 * The hero-token step of applyOpList (§3.7), after the M5 pre-pass. Never throws.
 * @param {ChatMessage} message
 * @param {object} resLive
 * @param {object[]} ops                 the call's op list (after the M5 pre-pass mutated it)
 * @param {{userId, markHold: (info) => Promise<void>, skip: Map, covered: (op) => boolean}} ctx
 * @returns {Promise<{ops: object[], before: Map<opId, damageOpId>, gone: boolean, held: boolean}>}
 */
export async function heroTokenPrePass(message, resLive, ops, ctx = {}) {
  const asks = [];
  try {
    if (!isActiveGM() || !promptOn() || !message || !resLive || !Array.isArray(ops)) return EMPTY_HERO_PASS;
    if (worldValue("heroToken") < COST) return EMPTY_HERO_PASS;
    const skip = ctx.skip instanceof Map ? ctx.skip : new Map();
    const covered = typeof ctx.covered === "function" ? ctx.covered : () => false;
    const byTarget = new Map();
    for (const op of ops) {
      if (op?.kind !== "damage" || op.group || op.heroToken) continue;
      if (op.status === OP_STATUS.APPLIED || op.status === OP_STATUS.EXTERNAL) continue;
      if (skip.has(op.opId) || covered(op)) continue;
      const key = op.targetKeys?.[0];
      if (!key) continue;
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push(op);
    }
    for (const [key, list] of byTarget) {
      const rec = resLive.targets?.[key];
      const hero = lookup(rec?.actorUuid);
      if (hero?.type !== "hero" || hero.statuses?.has?.(defeatedId())) continue;
      if (project(message, resLive, hero, list).after > 0) continue;   // cheap first test, re-done when the ask starts
      const sceneId = sceneIdOf(rec?.tokenUuid) ?? hero.token?.parent?.id ?? null;
      const { turnKey, combat } = turnKeyFor(sceneId);
      if (!reserveSpend(hero.uuid, turnKey, combat, message.id)) continue;   // SYNC, before any await (C6)
      const asker = askerFor(hero);
      if (!asker) {
        releaseSpend(hero.uuid, message.id);   // an owner who is offline is not replaced (Q5)
        continue;
      }
      asks.push({ key, hero, asker, list, turnKey });
    }
    if (!asks.length) return EMPTY_HERO_PASS;

    let marked = false;
    const answers = await Promise.all(asks.map(a => withReactorQueueStart(a.hero.uuid, START_MS, async () => {
      const live = project(message, resLive, a.hero, a.list);   // another card may have hit or healed meanwhile
      if (live.after > 0) return { outcome: "notLethal" };
      if (worldValue("heroToken") < COST) return { outcome: "noTokens" };
      if (!marked) {
        marked = true;
        try {
          await ctx.markHold?.({
            at: serverNow(), until: serverNow() + START_MS + promptMs() + GM_SLACK_MS, by: game.userId, kind: "heroToken",
            names: asks.map(x => ({ text: x.asker.name, playerSide: !x.asker.isGM })),
            opIds: asks.flatMap(x => x.list.map(o => o.opId)), targetKeys: asks.map(x => x.key),
          });
        } catch (err) {
          error("heroToken.markHold", err);
        }
      }
      return ask(a, live);
    }).catch(err => {
      error("heroToken.queue", err);
      return { outcome: "noAnswer" };
    })));

    if (game.messages && !game.messages.get(message.id)) {
      for (const a of asks) releaseSpend(a.hero.uuid, message.id);
      return { ...EMPTY_HERO_PASS, gone: true, held: marked };
    }
    const out = [];
    const before = new Map();
    const declined = [];
    asks.forEach((a, i) => {
      const answer = answers[i] ?? { outcome: "noAnswer" };
      const first = [...a.list].sort((x, y) => (Number(x.order) || 0) - (Number(y.order) || 0))[0];
      if (answer.outcome !== "spend") {
        releaseSpend(a.hero.uuid, message.id);
        debug("heroToken.noSpend", { hero: a.hero.name, outcome: answer.outcome });
        // 0.9.1 (TESTING.md §14 T103): the row of an earlier, undone spend for this hit would stay pending with an
        // Apply button that spends outside the prompt: it is skipped now.
        const stale = resLive.ops?.[opId("htoken", a.key, first.opId)];
        if (stale?.heroToken && (stale.status === OP_STATUS.PENDING || stale.status === OP_STATUS.UNDONE)) declined.push(stale.opId);
        return;
      }
      const rv = Number(a.hero.system?.recoveries?.recoveryValue) || 0;
      const op = {
        opId: opId("htoken", a.key, first.opId), order: (Number(first.order) || 0) - 0.5, kind: "heal",
        heroToken: { cost: COST, promptId: answer.promptId ?? null, answeredBy: answer.by ?? null, damageOpId: first.opId, turnKey: a.turnKey },
        mode: "auto", status: OP_STATUS.PENDING, tier: first.tier ?? null, targetKeys: [a.key], amount: rv,
      };
      bindSpend(a.hero.uuid, op.opId);
      out.push(op);
      before.set(op.opId, first.opId);
    });
    return { ops: out, before, gone: false, held: marked, declined };
  } catch (err) {
    error("heroToken.prePass", err);
    for (const a of asks) releaseSpend(a.hero.uuid, message?.id);
    return EMPTY_HERO_PASS;
  }
}

/* -------------------------------------------- */
/*  Apply / undo                                */
/* -------------------------------------------- */

const heroOf = (res, op) => lookup(res?.targets?.[op?.targetKeys?.[0]]?.actorUuid);

/** Tokens first (world chain), then the heal (§3.7). In the damage batch, before its damage op. */
export async function applyHeroTokenOp(message, res, op) {
  const hero = heroOf(res, op);
  if (!hero) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const cost = Number(op.heroToken?.cost) || COST;
  const paid = await withResourceChain("world:heroTokens", async () => {
    const tokens = worldValue("heroToken");
    if (tokens < cost) return null;
    await setWorldValue("heroToken", tokens - cost);
    return { before: tokens, after: tokens - cost };
  });
  if (!paid) {
    releaseSpend(hero.uuid, op.opId);
    return { status: OP_STATUS.FAILED, reason: "noHeroTokens" };
  }
  const before = snapStamina(hero);
  try {
    if (Number(op.amount) > 0) await hero.modifyTokenAttribute("stamina", Number(op.amount), true, true);
  } catch (err) {
    // The heal did not land: the tokens go back.
    await withResourceChain("world:heroTokens", async () => {
      const now = worldValue("heroToken");
      await setWorldValue("heroToken", now === paid.after ? paid.before : now + cost, { quiet: true });
    }).catch(e => error("heroToken.refund", e));
    releaseSpend(hero.uuid, op.opId);
    throw err;
  }
  const after = snapStamina(hero);
  const patch = {
    status: OP_STATUS.APPLIED, amount: Number(op.amount) || 0, finalAmount: after.value - before.value, before, after, tokens: paid,
  };
  log("heroToken.spend", { hero: hero.name, tokens: paid, healed: patch.finalAmount, messageId: message?.id ?? null });
  try {
    globalThis.Hooks?.callAll?.(HOOK_HERO_TOKEN(), message, { ...op, ...patch }, { hero, tokensBefore: paid.before, tokensAfter: paid.after });
  } catch (err) {
    error("heroToken.hook", err);
  }
  return patch;
}

/** Heal back (Stamina absolute / delta), tokens back (quiet), turn spend freed. */
export async function undoHeroTokenOp(res, op) {
  const hero = heroOf(res, op);
  if (!hero) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const current = snapStamina(hero);
  const b = op.before ?? current;
  const a = op.after ?? current;
  let undoMode = "absolute";
  let next;
  if (current.value === a.value && current.temporary === a.temporary) next = { ...b };
  else {
    undoMode = "delta";
    next = {
      value: current.value - ((Number(a.value) || 0) - (Number(b.value) || 0)),
      temporary: Math.max(0, current.temporary - ((Number(a.temporary) || 0) - (Number(b.temporary) || 0))),
    };
  }
  const { min, max } = hero.system?.stamina ?? {};
  if (Number.isFinite(max)) next.value = Math.min(max, next.value);
  if (Number.isFinite(min)) next.value = Math.max(min, next.value);
  await hero.update({ "system.stamina.value": next.value, "system.stamina.temporary": next.temporary }, { dsblQuiet: true });
  const cost = Number(op.heroToken?.cost) || COST;
  if (op.tokens) {
    await withResourceChain("world:heroTokens", async () => {
      const now = worldValue("heroToken");
      await setWorldValue("heroToken", now === op.tokens.after ? op.tokens.before : now + cost, { quiet: true });
    });
  }
  releaseSpend(hero.uuid, op.opId);
  log("heroToken.undo", { hero: hero.name, undoMode, tokensBack: !!op.tokens });
  return { status: OP_STATUS.UNDONE, undoMode };
}

/** Could our damage on these tokens open a hero-token prompt? (sync; ongoing and zone ticks detach when true) */
export function mayHoldHeroToken(tokenUuids) {
  try {
    if (!isActiveGM() || !promptOn() || worldValue("heroToken") < COST) return false;
    for (const uuid of tokenUuids ?? []) {
      const hero = lookup(uuid)?.actor ?? null;
      if (hero?.type !== "hero" || hero.statuses?.has?.(defeatedId())) continue;
      if (!askerFor(hero)) continue;
      if (spentThisTurn(hero.uuid, sceneIdOf(uuid))) continue;
      return true;
    }
    return false;
  } catch (_err) {
    return false;
  }
}

/** Prompts open now (selfCheck, harness). */
export function openHeroTokenPrompts() {
  return [...open.entries()].map(([promptId, e]) => ({
    promptId, heroName: e.heroName, heroUuid: e.heroUuid, userId: e.local ? game.userId : (e.user?.id ?? null), deadline: e.deadline,
  }));
}

/** Turn spends held now (selfCheck, harness). */
export const heroTokenSpends = () => [...spends.entries()].map(([heroUuid, s]) => ({ heroUuid, ...s }));

/** init: userConnected (a recipient who leaves answers at once), round change and deleteCombat clear spends. */
export function registerHeroTokens() {
  Hooks.on("userConnected", (user, connected) => {
    try {
      if (connected || !isActiveGM()) return;
      for (const [promptId, entry] of open) {
        if (entry.local || entry.user?.id !== user?.id) continue;
        entry.resolve?.({ outcome: "noAnswer", why: "userLeft" });
        log("heroToken.userLeft", { promptId, user: user?.name });
      }
    } catch (err) {
      error("heroToken.userConnected", err);
    }
  });
  Hooks.on("updateCombat", (combat, changed) => {
    try {
      if (!combat?.id || !changed || !("round" in changed)) return;
      for (const [uuid, s] of spends) if (s.combatId === combat.id && s.round !== combat.round) spends.delete(uuid);
    } catch (err) {
      error("heroToken.round", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      for (const [uuid, s] of spends) if (s.combatId === combat?.id) spends.delete(uuid);
    } catch (err) {
      error("heroToken.deleteCombat", err);
    }
  });
}

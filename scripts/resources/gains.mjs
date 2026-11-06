/**
 * Event gains (Milestone 7, docs/M7-DESIGN.md §1.5, §1.6, §3.1-§3.3, §6.2, §6.5). Active GM.
 *
 * - `planGains(facts, ctx)` matches facts (resources/facts.mjs) against the gain rules of the heroes in the started
 *   combat (resources/rules.mjs) and builds ops of kind `gain`. It is synchronous: an **auto** row claims
 *   `(combat, round|encounter, gainer, rule)` in memory before anything awaits (the budget.mjs pattern), so two cards
 *   applied in the same tick make one row (H8). A **waiting** row (mode prompt/manual, a `confirm` rule, a fact only a
 *   player vouches for) claims nothing (D13): the ledger decides when it is applied, the first one applied wins.
 * - The ledger lives on the Combat: `eventGains` (one round, lazy reset as budget.mjs:81-86) and `eventGainsEncounter`
 *   (the whole combat; `once: "each"` rules with a `dedupeKey`, a hero's death, write `<ruleKey>@<dedupeKey>` there).
 *   Both are written on one promise chain (`gainChain`) that waits for nothing but its own Combat write.
 * - `applyGainOp` rolls dice on every apply (the roll lives in the patch, `amount` stays null, C28), re-checks the
 *   ledger, writes it, then the resource on the gainer's resource chain (no `dsblQuiet`: Battle Log logs a real gain).
 *   `undoGainOp` gives the resource back (absolute / delta, `dsblQuiet`) and releases the ledger entry when it is still
 *   this op's. `cascadeGainIds` lists the gains (and hero-token heals) an undo of their cause ops takes along.
 * - Claims go when the op's ledger entry is written, when the op ends skipped/failed/vetoed (`releaseGainClaims`,
 *   C22), on undo, on round change for round scopes and on deleteCombat.
 * i18n keys: DSAUTO.Reason.alreadyGained (plus existing targetMissing, noResource, nothingGained).
 */
import * as C from "../constants.mjs";
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { resourcePath } from "../engine/library-plan.mjs";
import { opId } from "../engine/keys.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { itemDsid } from "../library/identity.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { stricterMode, typeOverride } from "../engine/actor-category.mjs";
import { combatFor, uuidKey } from "../triggers/budget.mjs";
import { distanceSquares, lineOfEffect, relation, tokenOnScene } from "../triggers/eligibility.mjs";
import { gainCandidates, gainsActive, liveAmount } from "./rules.mjs";
import { resourceLevel } from "../features/mastery.mjs";
import { auraActive } from "../features/auras.mjs";
import { withResourceChain } from "./world-resources.mjs";

const GAIN_FLAG = () => C.GAIN_FLAG ?? "eventGains";
const GAIN_ENC_FLAG = () => C.GAIN_ENC_FLAG ?? "eventGainsEncounter";
const HOOK_PRE_GAIN = () => C.HOOKS?.preGain ?? "dsAuto.preGain";
const HOOK_GAIN = () => C.HOOKS?.gain ?? "dsAuto.gain";
const KEEP_MS = 600_000;   // reservations are dropped after 10 min whatever happens
const EMPTY = Object.freeze({ ops: Object.freeze([]), targets: Object.freeze({}) });

const reservations = new Map();   // token -> {combatId, scopeKey, gainerUuid, ledgerKey, opId, at}
const claims = new Map();         // opId -> reservation token
const turnHeroes = new Map();     // turnKey -> Set(hero actor uuid) (heroesInTurn, fed by use facts)
let gainChain = Promise.resolve();

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const newId = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const ForcedDeletion = () => new foundry.data.operators.ForcedDeletion();
const flagPath = flag => `flags.${MODULE_ID}.${flag}`;
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });
const getPath = (obj, path) => String(path ?? "").split(".").reduce((o, k) => o?.[k], obj);

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------- */
/*  Ledger state                                */
/* -------------------------------------------- */

/** The ledger state of a flag: `eventGains` of another round counts as empty (lazy reset). */
function gainState(combat, flag) {
  const st = combat?.flags?.[MODULE_ID]?.[flag];
  if (flag === GAIN_FLAG()) {
    if (!st || st.round !== combat?.round) return { round: combat?.round ?? null, used: {} };
    return { round: st.round, used: { ...(st.used ?? {}) } };
  }
  return { used: { ...(st?.used ?? {}) } };
}

/** Scope of a rule: the flag and the scope key of its claim. */
function scopeOf(once, combat, hasDedupe) {
  if (once === "round") return { flag: GAIN_FLAG(), scopeKey: `r${combat?.round ?? 0}` };
  if (once === "encounter" || (once === "each" && hasDedupe)) return { flag: GAIN_ENC_FLAG(), scopeKey: "enc" };
  return null;
}

const ledgerKeyOf = (ruleKey, once, dedupeKey) => (once === "each" ? (dedupeKey ? `${ruleKey}@${dedupeKey}` : null) : ruleKey);

function prune() {
  const now = Date.now();
  for (const [token, r] of reservations) {
    if (now - r.at <= KEEP_MS) continue;
    reservations.delete(token);
    if (claims.get(r.opId) === token) claims.delete(r.opId);
  }
}

function reservedBy(combatId, scopeKey, gainerUuid, ledgerKey) {
  prune();
  for (const r of reservations.values()) {
    if (r.combatId === combatId && r.scopeKey === scopeKey && r.gainerUuid === gainerUuid && r.ledgerKey === ledgerKey) return r;
  }
  return null;
}

/** Does the ledger (flag or an in-memory claim) already hold this rule for the gainer in that scope? */
function ledgerHas(combat, scope, gainerUuid, ledgerKey) {
  if (!scope || !ledgerKey) return false;
  if (gainState(combat, scope.flag).used[uuidKey(gainerUuid)]?.[ledgerKey]) return true;
  return !!reservedBy(combat.id, scope.scopeKey, gainerUuid, ledgerKey);
}

/** Reserve synchronously (auto rows only). Token or null. `messageId`: the card the row is on (null: a gain card not posted yet). */
function reserveGain(combat, gainerUuid, ledgerKey, scope, id, messageId = null) {
  if (ledgerHas(combat, scope, gainerUuid, ledgerKey)) return null;
  const token = newId();
  reservations.set(token, { combatId: combat.id, scopeKey: scope.scopeKey, gainerUuid, ledgerKey, opId: id, messageId, at: Date.now() });
  return token;
}

/**
 * Is a ledger entry or claim this very row? Op ids are deterministic per (rule, gainer, scope), so two cards' rows of
 * one rule in one round share an id: the card tells them apart (a claim made before its gain card existed has none).
 */
const sameRow = (e, op, message) => !!e && e.opId === op.opId && (!e.messageId || !message?.id || e.messageId === message.id);

/** Release the in-memory claims of these ops (or op ids); a no-op for ops that hold none. */
export function releaseGainClaims(opsOrIds) {
  const items = opsOrIds == null ? [] : (Array.isArray(opsOrIds) || opsOrIds instanceof Set ? [...opsOrIds] : [opsOrIds]);
  for (const x of items) {
    const id = typeof x === "string" ? x : x?.opId;
    if (!id) continue;
    const token = claims.get(id);
    if (token) reservations.delete(token);
    claims.delete(id);
  }
}

/** Write one ledger entry (gain chain). A stale `eventGains` of an earlier round is deleted first. */
function writeGainEntry(combat, flag, key, ledgerKey, entry) {
  const run = gainChain.catch(() => {}).then(async () => {
    const live = game.combats?.get?.(combat.id) ?? combat;
    const path = flagPath(flag);
    if (flag === GAIN_FLAG()) {
      const st = live.flags?.[MODULE_ID]?.[flag];
      if (!st || st.round !== live.round) {
        if (st) await live.update({ [path]: ForcedDeletion() }, INTERNAL());
        await live.update({ [path]: { round: live.round, used: { [key]: { [ledgerKey]: entry } } } }, INTERNAL());
        return;
      }
    }
    await live.update({ [`${path}.used.${key}.${ledgerKey}`]: entry }, INTERNAL());
  });
  gainChain = run.catch(() => {});
  return run;
}

/** Delete one ledger entry (gain chain) when it is still the one written at `at`. True when deleted. */
function deleteGainEntry(combat, flag, key, ledgerKey, at = null) {
  const run = gainChain.catch(() => {}).then(async () => {
    const live = game.combats?.get?.(combat.id) ?? combat;
    if (!live) return false;
    const entry = gainState(live, flag).used[key]?.[ledgerKey];
    if (!entry || (at != null && entry.at !== at)) return false;
    await live.update({ [`${flagPath(flag)}.used.${key}.${ledgerKey}`]: ForcedDeletion() }, INTERNAL());
    return true;
  });
  gainChain = run.catch(() => {});
  return run;
}

/* -------------------------------------------- */
/*  Matching (§3.2)                             */
/* -------------------------------------------- */

/** Token of a party {actorUuid, tokenUuid} on the fact's scene. */
function tokenOf(p, sceneId) {
  const doc = lookup(p?.tokenUuid);
  if (doc) return doc;
  return tokenOnScene(lookup(p?.actorUuid), sceneId ?? null);
}

/** The relation of a party to the gainer: self | ally | enemy | object | other. */
function relOf(cand, p, sceneId) {
  if (!p?.actorUuid && !p?.tokenUuid) return "other";
  if (p.actorUuid && p.actorUuid === cand.actor.uuid) return "self";
  if (p.tokenUuid && cand.tokenDoc?.uuid && p.tokenUuid === cand.tokenDoc.uuid) return "self";
  return relation(cand.tokenDoc, tokenOf(p, sceneId));
}

const actorOfParty = p => lookup(p?.actorUuid) ?? lookup(p?.tokenUuid)?.actor ?? null;

/** Taker / mover specs (§1.1 GAIN_TAKERS). */
function partyMatches(spec, cand, p, sceneId) {
  const rel = relOf(cand, p, sceneId);
  switch (spec ?? "self") {
    case "self": return rel === "self";
    case "ally": return rel === "ally";
    case "selfOrAlly": return rel === "self" || rel === "ally";
    case "enemy": return rel === "enemy";
    case "creature": return rel !== "self" && rel !== "object";
    case "selfOrCreature": return rel !== "object";
    case "hero": return actorOfParty(p)?.type === "hero";
    default: return false;
  }
}

/** Dealer specs (§1.1 GAIN_DEALERS). An unknown dealer passes only `any`. */
function dealerMatches(spec, cand, dealer, sceneId) {
  const s = spec ?? "any";
  if (s === "any") return true;
  if (s === "director") return !!dealer?.director;
  if (!dealer?.actorUuid && !dealer?.tokenUuid) return false;
  const rel = relOf(cand, dealer, sceneId);
  switch (s) {
    case "self": return rel === "self";
    case "ally": return rel === "ally";
    case "selfOrAlly": return rel === "self" || rel === "ally";
    case "enemy": return rel === "enemy";
    default: return false;
  }
}

/** User / roller specs (§1.1 GAIN_USERS). */
function userMatches(spec, cand, user, sceneId) {
  const s = spec ?? "any";
  if (s === "any") return true;
  if (s === "hero") return user?.isHero ?? actorOfParty(user)?.type === "hero";
  if (s === "director") return user?.isNpc ?? actorOfParty(user)?.type === "npc";
  const rel = relOf(cand, user, sceneId);
  if (s === "self") return rel === "self";
  if (s === "ally") return rel === "ally";
  if (s === "enemy") return rel === "enemy";
  return false;
}

/** Within n squares of the gainer's token (the gainer itself always). */
function withinOf(n, cand, p, sceneId) {
  if (n == null) return true;
  if (relOf(cand, p, sceneId) === "self") return true;
  const other = tokenOf(p, sceneId);
  if (!cand.tokenDoc || !other) return false;
  return distanceSquares(cand.tokenDoc, other) <= Number(n);
}

/**
 * Does `actor` carry an enabled effect from the gainer's ability (CH8): its origin resolves to an item of the gainer
 * (or starts with the gainer's uuid) and its id is the effect id, or the origin item's dsid is the ability.
 */
export function carriesEffectOf(actor, gainer, spec) {
  if (!actor || !gainer?.uuid || !spec?.ability) return false;
  let effects = [];
  try {
    effects = list(actor.appliedEffects ?? actor.effects);
  } catch (_err) {
    return false;
  }
  for (const e of effects) {
    if (!e || e.disabled) continue;
    const origin = typeof e.origin === "string" ? e.origin : null;
    if (!origin) continue;
    const doc = lookup(origin);
    const owner = doc?.actor ?? (doc?.documentName === "Actor" ? doc : doc?.parent) ?? null;
    const ours = (owner?.uuid && owner.uuid === gainer.uuid) || origin.startsWith(`${gainer.uuid}.`);
    if (!ours) continue;
    if (spec.effect && e.id === spec.effect) return true;
    if (doc && itemDsid(doc) === spec.ability) return true;
  }
  return false;
}

/**
 * Abilities whose aura only exists while the hero keeps it up (an activation recorded by features/auras.mjs on the
 * item's `flags.<module>.aura`). `withinAbility` of one of these counts only while that aura is ACTIVE.
 */
const SUSTAINED_AURAS = Object.freeze(new Set(["null-field"]));

/**
 * Radius of the gainer's ability with that dsid (`system.distance.primary`), null when it has none. A sustained aura
 * (Null Field) that is not up has no radius: null, so no gain (when the state cannot be told, nothing is gained).
 */
function abilityRadius(actor, dsid) {
  const item = list(actor?.items).find(i => itemDsid(i) === dsid);
  if (!item) return null;
  if (SUSTAINED_AURAS.has(dsid) && !auraActive(item)) return null;
  const v = item.system?.distance?.primary;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return evaluateInt(v, item, {}, { min: 0, max: 100 });
}

/** Does a rule match a fact for one candidate gainer? (§3.2) */
export function matches(rule, fact, cand, _combat = null) {
  const sceneId = fact.sceneId ?? null;
  switch (fact.kind) {
    case "damage": {
      if ((rule.notTypes ?? []).includes(fact.type ?? "")) return false;
      if ((Number(fact.surges) || 0) < (Number(rule.minSurges) || 0)) return false;
      if (!dealerMatches(rule.dealer, cand, fact.dealer, sceneId)) return false;
      if (rule.dealerEffect && !carriesEffectOf(actorOfParty(fact.dealer), cand.actor, rule.dealerEffect)) return false;
      return (fact.takers ?? []).some(t => partyMatches(rule.taker ?? "self", cand, t, sceneId)
        && withinOf(rule.within, cand, t, sceneId)
        && (!rule.takerEffect || carriesEffectOf(actorOfParty(t), cand.actor, rule.takerEffect)));
    }
    case "forcedMove":
      if (fact.resisted && !rule.includeResisted) return false;
      return partyMatches(rule.taker ?? "selfOrCreature", cand, fact.mover, sceneId) && withinOf(rule.within, cand, fact.mover, sceneId);
    case "abilityUse": {
      if (!userMatches(rule.user, cand, fact.user, sceneId)) return false;
      if (rule.category && fact.category !== rule.category) return false;
      if (rule.actionType && fact.actionType !== rule.actionType) return false;
      if (rule.costsMalice && !fact.costsMalice) return false;
      if (!withinOf(rule.within, cand, fact.user, sceneId)) return false;
      if (rule.withinAbility) {
        const r = abilityRadius(cand.actor, rule.withinAbility);
        if (r == null || !withinOf(r, cand, fact.user, sceneId)) return false;
      }
      if (rule.heroesInTurn) {
        const set = fact.turnKey ? turnHeroes.get(fact.turnKey) : null;
        if ((set?.size ?? 0) < Number(rule.heroesInTurn)) return false;
      }
      return true;
    }
    case "naturalRoll": {
      if (!(rule.natural ?? []).includes(fact.natural)) return false;
      if (!userMatches(rule.user, cand, fact.roller, sceneId)) return false;
      const self = relOf(cand, fact.roller, sceneId) === "self";
      if (rule.loe && !self) {
        const other = tokenOf(fact.roller, sceneId);
        if (!cand.tokenDoc || !other || !lineOfEffect(cand.tokenDoc, other)) return false;
      }
      return withinOf(rule.within, cand, fact.roller, sceneId);
    }
    case "winded":
      return partyMatches(rule.taker ?? "self", cand, fact.taker, sceneId)
        && (rule.states ?? ["winded"]).some(s => (fact.states ?? []).includes(s))
        && withinOf(rule.within, cand, fact.taker, sceneId);
    case "heroDeath":
      return partyMatches(rule.taker ?? "self", cand, fact.taker, sceneId);
    default:
      return false;
  }
}

/**
 * Mode of a gain row (§3.2 gainMode). Milestone 8 (§4.3): the gainer's creature-type mode (`modeByActorType`, gains
 * are hero-only) can only make it stricter.
 */
export function gainMode(rule, fact, gainer = null) {
  return stricterMode(baseGainMode(rule, fact), gainer ? typeOverride(gainer.actor ?? null, gainer.tokenDoc?.uuid ?? null) : "inherit");
}

function baseGainMode(rule, fact) {
  const s = setting("resourceGains") ?? "auto";
  if (s === "prompt" || s === "manual") return s;
  const needsVouch = (rule?.dealer && rule.dealer !== "any") || !!rule?.dealerEffect || (rule?.notTypes?.length > 0)
    || !!rule?.minSurges;
  if (fact?.vouched === "player" && needsVouch) return "prompt";
  return "auto";
}

/** The gainer's record on the card: any existing one (dropped included, reused unchanged), else a gainOnly one. */
function gainerRecord(resLive, planned, cand) {
  const uuid = cand.actor.uuid;
  for (const src of [resLive?.targets ?? {}, planned]) {
    for (const [key, t] of Object.entries(src)) if (t?.actorUuid === uuid) return { key, record: t, isNew: false };
  }
  const built = cand.tokenDoc ? targetFromTokenDoc(cand.tokenDoc, { gainOnly: true }) : null;
  const record = built ?? { key: uuidKey(uuid), tokenUuid: null, actorUuid: uuid, name: cand.actor.name, img: cand.actor.img ?? null, gainOnly: true };
  // A key that exists is never overwritten (C26).
  if (resLive?.targets?.[record.key]) return { key: record.key, record: resLive.targets[record.key], isNew: false };
  return { key: record.key, record, isNew: true };
}

/**
 * Match facts against the candidates' rules and build gain ops. Never throws; empty when gains are off, outside a
 * started combat, or nobody's rules match.
 * @param {object[]} facts
 * @param {object} ctx   {message?, resLive?, origin: "card"|"gainCard"}
 * @returns {{ops: object[], targets: Record<string, object>}}
 */
export function planGains(facts, ctx = {}) {
  const made = [];
  try {
    if (!Array.isArray(facts) || !facts.length || !gainsActive()) return EMPTY;
    const combat = combatFor(facts[0]?.sceneId ?? null);
    if (!combat?.started) return EMPTY;   // Q2
    const cands = gainCandidates(combat);
    if (!cands.length) return EMPTY;
    // heroesInTurn: every hero use of this turn counts before matching.
    for (const f of facts) {
      if (f?.kind !== "abilityUse" || !f.turnKey || !f.user?.isHero || !f.user.actorUuid) continue;
      if (!turnHeroes.has(f.turnKey)) turnHeroes.set(f.turnKey, new Set());
      turnHeroes.get(f.turnKey).add(f.user.actorUuid);
    }
    const resLive = ctx.resLive ?? null;
    const targets = {};
    const seen = new Set();
    const maxOrder = Math.max(0, ...Object.values(resLive?.ops ?? {}).map(o => Number(o?.order) || 0));
    for (const fact of facts) {
      if (!fact?.kind) continue;
      for (const cand of cands) {
        for (const v of cand.rules) {
          const rule = v.rule;
          if (rule.event !== fact.kind) continue;
          // 1.2.0: `minResource` gates the rule on the gainer's heroic resource now (tracking-aware, features/mastery.mjs).
          if (rule.minResource != null && resourceLevel(cand.actor) < rule.minResource) continue;
          const ledgerRule = v.ledgerRuleKey ?? v.ruleKey;   // `onceWith`: rules sharing one slot
          const seenKey = `${cand.actor.uuid}|${ledgerRule}|${rule.once === "each" ? fact.id : ""}`;
          if (seen.has(seenKey)) continue;
          if (!matches(rule, fact, cand, combat)) continue;
          if (globalThis.Hooks?.call?.(HOOK_PRE_GAIN(), cand.actor, rule, fact) === false) continue;
          const now = liveAmount(v, cand.actor);   // `amountBy` entries with `minResource` follow the live resource
          const mode = gainMode(rule, fact, cand);
          const dedupeKey = fact.dedupeKey ?? null;
          const ledgerKey = ledgerKeyOf(ledgerRule, rule.once, dedupeKey);
          const scope = ledgerKey ? scopeOf(rule.once, combat, !!dedupeKey) : null;
          if (scope && ledgerHas(combat, scope, cand.actor.uuid, ledgerKey)) {   // already this round / encounter
            // 0.16.0 diagnostic (Tactician Focus seen more than once a round).
            log("gain.ledger", { ruleKey: v.ruleKey, gainer: cand.actor.name, combatId: combat.id, round: combat.round ?? null, scopeKey: scope.scopeKey, ledgerKey, claimed: false, reason: "alreadyGained" });
            continue;
          }
          const scopeKey = rule.once === "round" ? `r${combat.round}` : (rule.once === "encounter" ? "enc" : fact.id);
          const { key, record, isNew } = gainerRecord(resLive, targets, cand);
          const id = opId("gain", v.ruleKey, key, scopeKey);
          let claim = null;
          if (mode === "auto" && scope) {
            claim = reserveGain(combat, cand.actor.uuid, ledgerKey, scope, id, ctx.message?.id ?? null);   // SYNC, before any await
            if (!claim) continue;
          }
          seen.add(seenKey);
          if (isNew) targets[key] = record;
          if (claim) claims.set(id, claim);
          log("gain.ledger", { ruleKey: v.ruleKey, gainer: cand.actor.name, combatId: combat.id, round: combat.round ?? null, scopeKey: scope?.scopeKey ?? null, ledgerKey, claimed: !!claim, mode, fact: fact.id ?? null });
          made.push({
            opId: id, order: maxOrder + 1 + made.length / 100, kind: "gain", mode, status: OP_STATUS.PENDING, tier: null,
            targetKeys: [key], resource: rule.resource ?? "heroic", amount: now.amount ?? null, formula: now.formula ?? null,
            gain: {
              v: 1, featureKey: v.featureKey, ruleId: rule.id, ruleKey: v.ruleKey, label: rule.label ?? "", event: rule.event,
              ...(v.ledgerRuleKey ? { ledgerRuleKey: v.ledgerRuleKey } : {}),
              once: rule.once, confirm: false, combatId: combat.id, round: combat.round ?? null,
              gainerActorUuid: cand.actor.uuid, causeOpIds: [...(fact.opIds ?? [])], causeKey: fact.id ?? null, dedupeKey,
              vouched: fact.vouched === "player" ? "player" : "gm",
            },
          });
          debug("gains.plan", { gainer: cand.actor.name, rule: v.ruleKey, mode, fact: fact.id, origin: ctx.origin ?? null });
        }
      }
    }
    if (!made.length) return EMPTY;
    log("gains.planned", { ops: made.map(o => `${o.gain.ruleKey}:${o.mode}`), origin: ctx.origin ?? null, messageId: ctx.message?.id ?? null });
    return { ops: made, targets };
  } catch (err) {
    error("gains.plan", err);
    releaseGainClaims(made);
    return EMPTY;
  }
}

/* -------------------------------------------- */
/*  Apply / undo (§3.3)                         */
/* -------------------------------------------- */

async function rollAmount(formula) {
  const Roll = globalThis.foundry?.dice?.Roll ?? globalThis.Roll;
  const roll = new Roll(String(formula));
  await roll.evaluate();
  return Math.max(0, Math.floor(Number(roll.total) || 0));
}

/** Applier of op kind "gain" (engine applyOpList). Rolls dice, re-checks the ledger, writes it, then the resource. */
export async function applyGainOp(message, res, op) {
  const g = op?.gain ?? {};
  const gainer = lookup(g.gainerActorUuid);
  if (!gainer) {
    releaseGainClaims(op);
    return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  }
  const path = resourcePath(gainer, op.resource);
  if (!path) {
    releaseGainClaims(op);
    return { status: OP_STATUS.SKIPPED, reason: "noResource" };
  }
  try {
    let amount = Number.isInteger(op.amount) ? op.amount : null;
    let rolled = null;
    if (amount == null && op.formula) {
      amount = await rollAmount(op.formula);
      rolled = { formula: op.formula, total: amount };
    }
    amount = Math.max(0, Number(amount) || 0);
    if (!amount) {
      releaseGainClaims(op);
      return { status: OP_STATUS.SKIPPED, reason: "nothingGained", rolled };
    }
    const combat = g.combatId ? (game.combats?.get?.(g.combatId) ?? null) : null;
    const ledgerKey = ledgerKeyOf(g.ledgerRuleKey ?? g.ruleKey, g.once, g.dedupeKey);
    let ledger = null;
    if (ledgerKey && combat?.started && (g.once !== "round" || combat.round === g.round)) {
      const flag = g.once === "round" ? GAIN_FLAG() : GAIN_ENC_FLAG();
      const key = uuidKey(gainer.uuid);
      const entry = gainState(combat, flag).used[key]?.[ledgerKey];
      const scope = scopeOf(g.once, combat, !!g.dedupeKey);
      const other = scope ? reservedBy(combat.id, scope.scopeKey, gainer.uuid, ledgerKey) : null;
      if ((entry && !sameRow(entry, op, message)) || (other && !sameRow(other, op, message))) {
        releaseGainClaims(op);
        return { status: OP_STATUS.SKIPPED, reason: "alreadyGained" };
      }
      const at = Date.now();
      await writeGainEntry(combat, flag, key, ledgerKey, {
        at, messageId: message?.id ?? null, opId: op.opId, amount, by: res?.gain ? "gainCard" : "card",
      });
      ledger = { at, flag, key: ledgerKey };
    }
    // An applied row of an older round (prompt mode, applied late) applies without a ledger write.
    const { before, after } = await withResourceChain(gainer.uuid, async () => {
      const b = Number(getPath(gainer, path)) || 0;
      await gainer.update({ [path]: b + amount });
      return { before: b, after: b + amount };
    });
    releaseGainClaims(op);
    const patch = { status: OP_STATUS.APPLIED, before: { value: before }, after: { value: after }, finalAmount: amount, rolled, ledger };
    log("gains.apply", { gainer: gainer.name, rule: g.ruleKey, amount, before, after, ledger: !!ledger, messageId: message?.id ?? null });
    try {
      globalThis.Hooks?.callAll?.(HOOK_GAIN(), message, { ...op, ...patch }, { gainer, rule: g });
    } catch (err) {
      error("gains.hook", err);
    }
    return patch;
  } catch (err) {
    releaseGainClaims(op);
    throw err;
  }
}

/** Undo of op kind "gain": resource back (absolute/delta), ledger entry deleted when still this op's. */
export async function undoGainOp(res, op) {
  const g = op?.gain ?? {};
  const gainer = lookup(g.gainerActorUuid);
  if (!gainer) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const path = resourcePath(gainer, op.resource);
  if (!path) return { status: OP_STATUS.FAILED, reason: "noResource" };
  const undoMode = await withResourceChain(gainer.uuid, async () => {
    const current = Number(getPath(gainer, path)) || 0;
    const b = Number(op.before?.value) || 0;
    const a = Number(op.after?.value) || 0;
    const absolute = current === a;
    const next = absolute ? b : current - (a - b);
    await gainer.update({ [path]: op.resource === "heroic" ? next : Math.max(0, next) }, { dsblQuiet: true });
    return absolute ? "absolute" : "delta";
  });
  let released = false;
  const combat = g.combatId ? (game.combats?.get?.(g.combatId) ?? null) : null;
  // 0.16.0: setting `gainUndoKeepsSlot`: the undone gain still counts for its round (or encounter).
  if (op.ledger && combat && setting("gainUndoKeepsSlot")) {
    releaseGainClaims(op);
    log("gains.undo", { gainer: gainer.name, rule: g.ruleKey, undoMode, released: false, kept: true });
    return { status: OP_STATUS.UNDONE, undoMode, ledgerReleased: false, ledgerKept: true };
  }
  if (op.ledger && combat) {
    try {
      released = await deleteGainEntry(combat, op.ledger.flag, uuidKey(gainer.uuid), op.ledger.key, op.ledger.at);
    } catch (err) {
      error("gains.ledgerRelease", err, { opId: op.opId });
    }
  }
  releaseGainClaims(op);
  log("gains.undo", { gainer: gainer.name, rule: g.ruleKey, undoMode, released });
  return { status: OP_STATUS.UNDONE, undoMode, ledgerReleased: released };
}

/**
 * Ids of applied gain ops whose cause ops are each in `undoneIds` or already undone, and of applied hero-token heals
 * whose damage op is in `undoneIds` (§3.3 cascade). Ids already in `undoneIds` are not repeated.
 */
export function cascadeGainIds(res, undoneIds) {
  const ids = undoneIds instanceof Set ? undoneIds : new Set(undoneIds ?? []);
  const out = [];
  for (const op of Object.values(res?.ops ?? {})) {
    if (!op?.opId || ids.has(op.opId) || op.status !== OP_STATUS.APPLIED) continue;
    if (op.kind === "gain") {
      const causes = op.gain?.causeOpIds ?? [];
      if (causes.length && causes.some(id => ids.has(id))
        && causes.every(id => ids.has(id) || res.ops?.[id]?.status === OP_STATUS.UNDONE)) out.push(op.opId);
    } else if (op.heroToken && ids.has(op.heroToken.damageOpId)) out.push(op.opId);
  }
  return out;
}

/** A record write failed after gains applied: undo their resource and ledger writes (fire-and-forget). */
export function cleanupGains(patches, createdOps) {
  try {
    const entries = createdOps instanceof Map ? [...createdOps.entries()] : Object.entries(createdOps ?? {});
    for (const [id, op] of entries) {
      const p = patches?.[id];
      if (op?.kind !== "gain") continue;
      releaseGainClaims(id);
      if (p?.status !== OP_STATUS.APPLIED) continue;
      undoGainOp(null, { ...op, ...p }).catch(err => error("gains.cleanup", err, { opId: id }));
    }
  } catch (err) {
    error("gains.cleanup", err);
  }
}

/* -------------------------------------------- */
/*  Readers and Director tools                  */
/* -------------------------------------------- */

const actorFrom = a => (typeof a === "string" ? (lookup(a)?.actor ?? lookup(a)) : (a?.actor ?? a));

/** The hero's ledger entries: {round: {<ruleKey>: entry}, encounter: {...}}. Any client (reads the Combat). */
export function gainLedger(combat, actor) {
  const a = actorFrom(actor);
  const c = combat ?? combatFor(a?.token?.parent?.id ?? null);
  if (!a?.uuid || !c) return { round: {}, encounter: {} };
  const key = uuidKey(a.uuid);
  return {
    round: { ...(gainState(c, GAIN_FLAG()).used[key] ?? {}) },
    encounter: { ...(gainState(c, GAIN_ENC_FLAG()).used[key] ?? {}) },
  };
}

/** Active GM: release one ledger entry (the Director re-grants by hand). True when an entry was deleted. */
export async function releaseLedgerEntry(combat, actor, ruleKey, { encounter = false } = {}) {
  if (!isActiveGM() || typeof ruleKey !== "string" || !ruleKey || /\./.test(ruleKey)) return false;
  const a = actorFrom(actor);
  const c = combat ?? combatFor(a?.token?.parent?.id ?? null);
  if (!a?.uuid || !c) return false;
  const flag = encounter ? GAIN_ENC_FLAG() : GAIN_FLAG();
  for (const [token, r] of reservations) {
    if (r.combatId === c.id && r.gainerUuid === a.uuid && r.ledgerKey === ruleKey) {
      reservations.delete(token);
      if (claims.get(r.opId) === token) claims.delete(r.opId);
    }
  }
  const done = await deleteGainEntry(c, flag, uuidKey(a.uuid), ruleKey, null);
  log("gains.release", { actor: a.name, ruleKey, encounter, done });
  return done;
}

/** Claims held now (selfCheck, harness). */
export const gainClaims = () => [...reservations.values()].map(r => ({ ...r }));

function dropCombat(combatId, { roundsOnly = false, round = null } = {}) {
  for (const [token, r] of reservations) {
    if (r.combatId !== combatId) continue;
    if (roundsOnly && (!r.scopeKey.startsWith("r") || r.scopeKey === `r${round}`)) continue;
    reservations.delete(token);
    if (claims.get(r.opId) === token) claims.delete(r.opId);
  }
  for (const k of turnHeroes.keys()) if (k.startsWith(`${combatId}:`)) turnHeroes.delete(k);
}

/** init: updateCombat (round) and deleteCombat drop claims (budget.mjs:291-313 pattern). */
export function registerGains() {
  Hooks.on("updateCombat", (combat, changes) => {
    try {
      if (combat?.id && changes && ("round" in changes || "turn" in changes)) {
        // A turn change only ends the turn's hero set; a round change also ends the round's claims.
        if ("round" in changes) dropCombat(combat.id, { roundsOnly: true, round: combat.round });
        else for (const k of turnHeroes.keys()) if (k.startsWith(`${combat.id}:`) && !k.startsWith(`${combat.id}:${combat.round}:${combat.turn}:`)) turnHeroes.delete(k);
      }
    } catch (err) {
      error("gains.round", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      if (combat?.id) dropCombat(combat.id);
    } catch (err) {
      error("gains.deleteCombat", err);
    }
  });
}

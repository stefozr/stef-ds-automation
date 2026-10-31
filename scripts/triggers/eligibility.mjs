/**
 * Trigger eligibility (Milestone 5, docs/M5-DESIGN.md §3.5). Reads only: combat, restrictions, budget,
 * relation, range, line of effect, requirements and cost of one trigger of one reactor item against one
 * event. Runs on the active GM; the cheap gates (relation, range) also on any client.
 *
 * - Relations follow token dispositions as AbilityModel#validTarget does (DSM:6679-6695): same actor is
 *   "self", same disposition "ally", a friendly or hostile token against another disposition "enemy".
 * - One distance rule everywhere (review integration 14): footprint-to-footprint Chebyshev gap in grid
 *   squares from the token documents, + 1 (adjacent = 1, overlapping = 0); elevation is ignored, as in
 *   ctlib. `damage.after` events measure from where everyone stood before the batch (`event.positions`).
 * - Restrictions read `actor.system.restrictions` (type and dsid, DSM:1406-1412, 6564-6572); Surprised
 *   restricts only in round 1 (C10, the system never removes it).
 * - The heroic resource may go below 0 when paid (library-apply.mjs:139-142), so `canPay` is the only
 *   guard; it counts the pending debits of answered prompts (review conc 17).
 * A trigger with a `use` step costs nothing here: the ability's own use pays it (review integration 18).
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { MALICE_DEBIT_KEY, worldValue } from "../resources/world-resources.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { itemKey } from "../library/identity.mjs";
import { ctlib } from "../compat/ctlib.mjs";
import { debug } from "../log.mjs";
import { setting } from "../settings.mjs";
import { available, pendingDebit } from "./budget.mjs";
import { isMuted } from "./engine.mjs";
import { realStep } from "./taxonomy.mjs";

const FRIENDLY = () => globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
const HOSTILE = () => globalThis.CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;

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

function has(set, v) {
  if (v == null || !set) return false;
  if (typeof set.has === "function") return set.has(v);
  return Array.isArray(set) && set.includes(v);
}
const sameActor = (a, b) => !!a && !!b && (a === b || (!!a.uuid && a.uuid === b.uuid));

export function tokenOnScene(actor, sceneId) {
  if (!actor) return null;
  try {
    if (actor.isToken && actor.token) return !sceneId || actor.token.parent?.id === sceneId ? actor.token : null;
    const scene = sceneId ? game.scenes?.get?.(sceneId) : (globalThis.canvas?.scene ?? null);
    if (scene) return list(scene.tokens).find(t => sameActor(t?.actor, actor) || (t?.actorLink && t.actorId === actor.id)) ?? null;
    if (sceneId) return null;
    return actor.getActiveTokens?.(false, true)?.[0] ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * Not a creature: an object actor (ObjectModel, DSM:14020, 14087: `isObject`, no `isCreature`). Unknown actors
 * count as creatures.
 */
export function notCreature(actor) {
  const sys = actor?.system;
  return !!sys && (sys.isObject === true || sys.isCreature === false);
}

/**
 * "self" | "ally" | "enemy" | "object" | "other" by token disposition, as AbilityModel#validTarget
 * (DSM:6679-6695): only creatures are allies or enemies; an object token is "object" whatever its disposition.
 */
export function relation(reactorToken, subjectToken) {
  if (!reactorToken || !subjectToken) return "other";
  if (reactorToken === subjectToken || sameActor(reactorToken.actor, subjectToken.actor)) return "self";
  if (notCreature(subjectToken.actor)) return "object";
  const a = reactorToken.disposition;
  const b = subjectToken.disposition;
  if (a === b) return "ally";
  if (a === FRIENDLY() || a === HOSTILE()) return "enemy";
  return "other";
}

export function subjectMatches(spec, rel) {
  switch (spec ?? "self") {
    case "self": return rel === "self";
    case "ally": return rel === "ally";
    case "selfOrAlly": return rel === "self" || rel === "ally";
    case "enemy": return rel === "enemy";
    case "creature": return rel !== "self" && rel !== "object";
    case "selfOrCreature": return rel !== "object";
    default: return false;
  }
}

/** The event source's token: its uuid, else the source actor's token on the event's scene. */
function sourceToken(event) {
  return lookup(event?.source?.tokenUuid) ?? tokenOnScene(lookup(event?.source?.actorUuid), event?.sceneId ?? null);
}

export function attackerMatches(spec, reactorToken, event) {
  switch (spec ?? "any") {
    case "any": return true;
    // The system Apply button and Target Damage rows pass no source; they always come from a creature's card (review rules-ux 13).
    // An object's damage (a trap, dynamic terrain) is not "a creature deals damage".
    case "creature": return event?.source?.actorUuid
      ? !notCreature(lookup(event.source.actorUuid))
      : (!!event?.damage?.external && !event?.source?.known);
    case "enemy": {
      const src = sourceToken(event);
      return !!src && relation(reactorToken, src) === "enemy";
    }
    default: return false;
  }
}

function gridSize(doc) {
  const g = doc?.parent?.grid;
  const size = typeof g === "number" ? g : g?.size;
  return Number(size) || Number(globalThis.canvas?.grid?.size) || 100;
}

/**
 * Vertical gap in squares between two token columns (ctlib 1.5.0 `tokenColumn`: bottom = elevation / grid distance,
 * height = max(1, size, depth)); 0 when the columns touch or overlap, or ctlib's `range3d` is switched off.
 */
function verticalGap(a, b, positions = null) {
  if (ctlib()?.config?.get?.("range3d") === false) return 0;
  const column = doc => {
    const unit = Number(doc?.parent?.grid?.distance) || 1;
    const elevation = Number(positions?.[doc.uuid]?.elevation ?? doc.elevation) || 0;
    const size = Number(doc.actor?.system?.combat?.size?.value) || 0;
    const depth = Number(doc.depth) > 1 ? Number(doc.depth) : 1;
    return { z: elevation / unit, d: Math.max(1, size, depth) };
  };
  const A = column(a);
  const B = column(b);
  const gap = Math.max(0, B.z - (A.z + A.d), A.z - (B.z + B.d));
  return Number.isFinite(gap) ? gap : 0;
}

/**
 * Squares between two tokens, always the same rule (review integration 14): footprint-to-footprint Chebyshev
 * gap from the token documents (x, y, width, height, the scene's grid size) + 1 (adjacent = 1, overlapping = 0).
 * `positions` (event snapshot) overrides x/y (and elevation). Since ctlib 1.5.0 range is 3D: the larger of that and
 * the vertical gap + 1, the same as ctlib's `tokFootprintDist(a, b) < range * gridDistance` (helpers.mjs:1313-1323).
 */
export function distanceSquares(a, b, positions = null) {
  if (!a || !b) return Infinity;
  const g = gridSize(a);
  const box = doc => {
    const p = positions?.[doc.uuid] ?? doc;
    const x = Number(p.x) / g;
    const y = Number(p.y) / g;
    const w = Number(p.width ?? doc.width ?? 1) || 1;
    const h = Number(p.height ?? doc.height ?? 1) || 1;
    return { x, y, w, h };
  };
  const A = box(a);
  const B = box(b);
  if (![A.x, A.y, B.x, B.y].every(Number.isFinite)) return Infinity;
  const gapX = Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w);
  const gapY = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
  // Off-grid tokens: a part of a square counts as a square.
  const squares = gap => Math.ceil(gap - 1e-6) + 1;
  const vertical = verticalGap(a, b, positions);
  if (gapX < 0 && gapY < 0) return vertical > 0 ? squares(vertical) : 0; // the footprints overlap
  return Math.max(squares(Math.max(0, gapX, gapY)), vertical > 0 ? squares(vertical) : 0);
}

/** A distance value: a prepared number, else a formula evaluated with the item's roll data. */
function distanceValue(v, item) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  try {
    const out = Number(ds.utils.evaluateFormula(String(v), item?.getRollData?.() ?? {}, { contextName: item?.uuid ?? MODULE_ID }));
    return Number.isFinite(out) ? out : null;
  } catch (_err) {
    return null;
  }
}

/** The ability's own distance in squares, or null (unlimited). `melee` reads the melee value of meleeRanged. */
export function abilityRange(item, { melee = false } = {}) {
  const d = item?.system?.distance;
  if (!d) return null;
  switch (d.type) {
    case "melee":
    case "ranged":
      return distanceValue(d.primary, item);
    case "meleeRanged": {
      const p = distanceValue(d.primary, item);
      if (melee) return p;
      const s = distanceValue(d.secondary, item);
      if (p == null || s == null) return p ?? s;
      return Math.max(p, s);
    }
    case "self":
      return 0;
    default:
      return null;
  }
}

/**
 * The distance bonus the system added to the ability's own melee / ranged distance (a kit's melee or ranged
 * distance bonus, `_applyAbilityBonuses` DSM:6040-6052): its prepared distance less its source one. 0 unknown.
 */
function abilityDistanceBonus(item) {
  const d = item?.system?.distance;
  if (!d || (d.type !== "melee" && d.type !== "ranged")) return 0;
  const prepared = distanceValue(d.primary, item);
  const raw = distanceValue(item?._source?.system?.distance?.primary, item);
  return prepared != null && raw != null ? Math.max(0, prepared - raw) : 0;
}

/**
 * Range of a trigger; `spend` uses `trigger.spend.range` when given. null = unlimited. A spend range replaces
 * the ability's distance ("Melee 1 + your Reason score"): the ability keeps its keywords, so the kit bonus the
 * system added to its own distance applies to it as well (third review).
 */
export function rangeOf(trigger, item, { spend = false } = {}) {
  const spendRange = spend && trigger?.spend?.range != null;
  const r = spendRange ? trigger.spend.range : (trigger?.range ?? "ability");
  if (r === "unlimited") return null;
  if (r === "ability") return abilityRange(item);
  const bonus = spendRange ? abilityDistanceBonus(item) : 0;
  if (typeof r === "number") return Number.isFinite(r) ? Math.max(0, r) + bonus : null;
  // `@R` is the actor's Reason (DSM:2410-2416); an invalid formula falls back to the ability's distance.
  const v = evaluateInt(r, item, {}, { min: 0, max: 100 });
  return v == null ? abilityRange(item) : v + bonus;
}

/** true when it cannot be checked (scene not viewed, placeables missing). */
export function lineOfEffect(a, b) {
  try {
    const pa = a?.object;
    const pb = b?.object;
    if (!pa || !pb || typeof pa.hasLineOfEffect !== "function") return true;
    const out = pa.hasLineOfEffect(pb);
    return typeof out === "boolean" ? out : true;
  } catch (_err) {
    return true;
  }
}

/** Does a restriction hit this use (type, the item's own type, or its dsid)? */
function restrictionHits(r, item, type) {
  const dsid = item?.system?._dsid || item?.dsid || null;
  return has(r?.type, type) || has(r?.type, item?.system?.type) || has(r?.dsid, dsid);
}

/**
 * Is this use restricted? `restrictions.type` has `type` ("triggered"/"freeTriggered") or the item's own type,
 * or `restrictions.dsid` has the item's dsid (as item.system.restricted, DSM:6564-6572; review integration 13).
 * From round 2 on, a restriction whose only status source is Surprised is ignored (C10).
 */
export function restricted(actor, item, type, combat = null) {
  try {
    const r = actor?.system?.restrictions;
    if (!r || !restrictionHits(r, item, type)) return false;
    // Surprised lasts until the end of the first round (R§rules §1.4); the system never removes it.
    if (combat?.started && combat.round > 1 && has(actor.statuses, "surprised")) {
      const others = list(CONFIG.statusEffects).filter(s => s?.id && s.id !== "surprised" && has(actor.statuses, s.id)
        && restrictionHits(s.restrictions, item, type));
      // Only Surprised restricts (an effect-only restriction is not seen: documented).
      if (!others.length) return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * A hero or retainer dies at the negative of its winded value (stamina.min, DSM:3364, 14317). The system never
 * marks it with a status (staminaEffects: dying and winded only, DSM:526-538) and Death Tracker skips both types
 * (death-tracker.mjs:1454). Unknown minimum: not dead.
 */
function deadByStamina(actor) {
  if (actor?.type !== "hero" && actor?.type !== "retainer") return false;
  const st = actor.system?.stamina;
  const value = Number(st?.value);
  if (st?.value == null || !Number.isFinite(value)) return false;
  let min = st?.min == null ? NaN : Number(st.min);
  if (!Number.isFinite(min)) {
    const winded = Number(st?.winded);
    if (!(winded > 0)) return false;
    min = -winded;
  }
  return value <= min;
}

/**
 * A non-minion NPC dies at 0 Stamina; the system only gives it `dying` (staminaEffects, DSM:526-538,
 * 1545-1552) and only Death Tracker (optional, seconds later) adds `dead` (third review). Minions are left
 * out: their own Stamina is not written (squad pool), they die through Death Tracker's `dead` status.
 */
function npcDown(actor) {
  if (actor?.type !== "npc" || actor.system?.isMinion || actor.isMinion) return false;
  if (has(actor.statuses, "dying")) return true;
  const st = actor.system?.stamina;
  const value = Number(st?.value);
  return st?.value != null && Number.isFinite(value) && value <= 0;
}

export function incapacitated(actor, combat) {
  if (!actor) return null;
  const dead = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  if (has(actor.statuses, dead)) return "dead";
  if (deadByStamina(actor) || npcDown(actor)) return "dead";
  try {
    if (combat?.getCombatantsByActor?.(actor)?.[0]?.isDefeated) return "defeated";
  } catch (_err) { /* no combatants */ }
  if (has(actor.statuses, "sleep")) return "unconscious";
  return null;
}

const getPath = (obj, path) => String(path ?? "").split(".").reduce((o, k) => o?.[k], obj);

/** The hero's heroic resource {name, target, path, minimum} (DSM:3557-3568); null for NPCs (Malice). */
function heroicResource(actor) {
  if (!actor || actor.type === "npc") return null;
  try {
    const cr = actor.system?.coreResource;
    return cr?.path ? cr : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Heroic resource payable: current - pendingDebit - minimum >= n (coreResource, DSM:3557-3568). NPCs (Milestone 7,
 * §3.8): the shared Malice pool minus the pending debits of every NPC reactor (`MALICE_DEBIT_KEY`).
 */
export function canPay(actor, n) {
  const need = Number(n) || 0;
  if (need <= 0) return true;
  if (actor?.type === "npc") return worldValue("malice") - pendingDebit({ uuid: MALICE_DEBIT_KEY }) >= need;
  const cr = heroicResource(actor);
  if (!cr) return false;
  const current = Number(getPath(cr.target ?? actor, cr.path));
  if (!Number.isFinite(current)) return false;
  return current - pendingDebit(actor) - (Number(cr.minimum) || 0) >= need;
}

export function resourceName(actor) {
  if (actor?.type === "npc") return loc("DSAUTO.Entry.Resource.malice");
  const name = heroicResource(actor)?.name;
  return typeof name === "string" ? name : "";
}

export function resourceValue(actor) {
  if (actor?.type === "npc") return worldValue("malice");
  const cr = heroicResource(actor);
  if (!cr) return null;
  const v = Number(getPath(cr.target ?? actor, cr.path));
  return Number.isFinite(v) ? v : null;
}

export function requirementsMet(trigger, event, { subjectToken, combat, reactorActor } = {}) {
  const req = trigger?.require ?? {};
  const keywords = (event?.source?.keywords ?? []).map(k => String(k).toLowerCase());
  if (req.keywords?.length && !req.keywords.every(k => keywords.includes(String(k).toLowerCase()))) return false;
  if (req.fromAbility && !event?.source?.fromAbility) return false;
  if (req.damaging && !event?.roll?.damaging) return false;
  if (req.subjectType) {
    const subject = lookup(event?.subject?.actorUuid);
    const isHero = subject ? subject.type === "hero" : !!event?.subject?.isHero;
    if ((req.subjectType === "hero") !== isHero) return false;
  }
  if (req.notStartedByThis) {
    // Hesitation is Weakness writes `hiwStart` when it starts a turn (turn-order.mjs).
    const hs = combat?.flags?.[MODULE_ID]?.hiwStart;
    const round = event?.turn?.round ?? combat?.round;
    const subjectCombatant = event?.turn?.combatantId
      ?? combat?.getCombatantsByActor?.(lookup(event?.subject?.actorUuid))?.[0]?.id ?? null;
    if (hs && hs.round === round && subjectCombatant && hs.combatantId === subjectCombatant) return false;
  }
  if (req.meleeReach && keywords.includes("ranged")) {
    // A melee+ranged strike used at range is a ranged strike (review rules-ux 14).
    const srcItem = lookup(event?.source?.itemUuid);
    const src = sourceToken(event);
    const reach = srcItem ? abilityRange(srcItem, { melee: true }) : null;
    if (reach != null && src && subjectToken && distanceSquares(src, subjectToken, event?.positions) > reach) return false;
  }
  if (req.recoveries && !((Number(reactorActor?.system?.recoveries?.value) || 0) >= req.recoveries)) return false;
  if ((trigger?.steps ?? []).some(s => s.type === "takeTurnNext")) {
    const c = combat?.getCombatantsByActor?.(reactorActor)?.[0] ?? null;
    if (!c || c.isDefeated || !((c.initiative ?? 0) > 0)) return false;
    if (c.id === event?.turn?.combatantId || reactorActor?.uuid === event?.subject?.actorUuid) return false;
  }
  return true;
}

/** Milestone 9 (D5): the id of the item's own `spend` special effect (the roll dialog's spend box), or null. */
export function spendEffectOf(item) {
  const e = spendEffectDoc(item);
  return typeof e?.id === "string" && e.id ? e.id : null;
}

/** The item's own `spend` special effect (system 1.1.2: `effects.documentsByType.spend`, DSM:4502), or null. */
export function spendEffectDoc(item) {
  const effects = item?.system?.effects;
  const byType = effects?.documentsByType?.spend;
  const all = Array.isArray(byType) ? byType : (effects?.contents ?? (typeof effects?.values === "function" ? [...effects.values()] : []));
  return all.find(x => x?.type === "spend" || Array.isArray(byType)) ?? null;
}

/** A step without `when`, or with the matching `when.spend`. */
const stepsFor = (trigger, spend) => (trigger?.steps ?? []).filter(s => s.when?.spend === undefined || s.when.spend === spend);

/** Comparable form of a step list (fields only, `when` left out). */
function stepsSignature(steps) {
  return JSON.stringify(steps.map(({ when: _w, ...rest }) => Object.keys(rest).sort().map(k => [k, rest[k]])));
}

/** One trigger of one reactor item against one event. Null when not eligible (debug log with `why`). */
export function evaluate({ event, reactorActor: A, reactorToken: RT, item, trigger, combat } = {}) {
  const no = why => {
    debug("trigger.ineligible", { why, reactor: A?.name, item: item?.name, event: event?.kind });
    return null;
  };
  try {
    if (!event || !A || !item || !trigger) return no("missing");
    if (trigger.event !== event.kind) return no("event");
    if (!RT) return no("noToken");
    if (!combat && !setting("triggersOutsideCombat")) return no("notInCombat");
    const down = incapacitated(A, combat);
    if (down) return no(down);
    if (isMuted(A.uuid, item.uuid, combat)) return no("muted");
    const free = trigger.free === true || item.system?.type === "freeTriggered";
    if (restricted(A, item, free ? "freeTriggered" : "triggered", combat)) return no("restricted");
    const budgetType = free ? "free" : "triggered";
    if (budgetType === "triggered" && combat && !available(A, combat)) return no("budget");
    const ST = lookup(event.subject?.tokenUuid) ?? tokenOnScene(lookup(event.subject?.actorUuid), event.sceneId ?? null);
    const rel = A.uuid === event.subject?.actorUuid ? "self" : relation(RT, ST);
    if (!subjectMatches(trigger.subject ?? "self", rel)) return no("subject");
    if (String(event.kind).startsWith("damage") && !attackerMatches(trigger.attacker ?? "any", RT, event)) return no("attacker");
    if (!requirementsMet(trigger, event, { subjectToken: ST, combat, reactorActor: A })) return no("require");
    let spendMode = "none";
    if (rel !== "self" && trigger.range !== "unlimited") {
      const base = rangeOf(trigger, item);
      const withSpend = trigger.spend?.range != null ? rangeOf(trigger, item, { spend: true }) : base;
      const d = distanceSquares(RT, ST, event.positions);
      const baseOk = base == null || d <= base;
      const spendOk = withSpend == null || d <= withSpend;
      if (!baseOk && !spendOk) return no("range");
      if (!baseOk) spendMode = "required";
    }
    if (rel !== "self" && trigger.loe !== false && !lineOfEffect(RT, ST)) return no("loe");
    const hasUse = (trigger.steps ?? []).some(s => s.type === "use");
    const cost = hasUse ? 0 : (Number.isInteger(trigger.cost) ? trigger.cost : (Number(item.system?.resource) || 0));
    let spendCost = Number(trigger.spend?.cost) || 0;
    if (spendCost && spendMode === "none") spendMode = "optional";
    if (!spendCost && spendMode === "required") return no("range");
    if (!canPay(A, cost)) return no("cost");
    if (spendMode === "required" && !canPay(A, cost + spendCost)) return no("spendCost");
    if (spendMode === "optional" && !canPay(A, cost + spendCost)) spendMode = "none";
    // A dead subject (the hit that just killed it, damage.after) is neither healed nor makes a free strike.
    const SA = lookup(event.subject?.actorUuid) ?? ST?.actor ?? null;
    const subjectDead = !!SA && incapacitated(SA, combat) === "dead";
    const moot = s => (s.type === "halve" && !!event.damage?.halved) || (s.type === "potency" && !event.damage?.hasPotency)
      || (s.type === "use" && s.targets === "source" && !event.source?.tokenUuid)
      || (s.type === "use" && s.targets === "subject" && subjectDead)
      || (s.type === "freeStrike" && (!event.source?.tokenUuid || (s.by === "subject" && subjectDead)));
    let base = spendMode === "required" ? [] : stepsFor(trigger, false).filter(s => !moot(s));
    let spend = spendMode === "none" ? [] : stepsFor(trigger, true).filter(s => !moot(s));
    // A spend that adds nothing is not offered (Parry within its base reach).
    if (spendMode === "optional" && stepsSignature(spend) === stepsSignature(base)) {
      spendMode = "none";
      spend = [];
    }
    // A spend that is the option's only effect (Inertial Shield on a hit already halved: only its potency step is
    // left) is pre-ticked and charged, never an unticked box whose Use does nothing (third review). Affordable:
    // an optional spend the reactor cannot pay was dropped above.
    if (spendMode === "optional" && !base.some(realStep) && spend.some(realStep)) {
      spendMode = "required";
      base = [];
    }
    // A note marked `effect` (a shift done by hand) is worth the triggered action by itself (halving never stacks).
    if (!base.some(realStep) && !spend.some(realStep)) return no("moot");
    if (spendMode === "none") spendCost = 0;
    // Milestone 9 (D5): a use step of an ability with its own spend effect: the system's dialog (pre-ticked) charges
    // the spend, the trigger card does not (triggers/card.mjs).
    const spendEffectId = hasUse && spendCost > 0 ? spendEffectOf(item) : null;
    return {
      event,
      reactor: { actorUuid: A.uuid, tokenUuid: RT.uuid ?? null, name: A.name, img: A.img ?? null, playerSide: !!A.hasPlayerOwner },
      item: { uuid: item.uuid, name: item.name, key: itemKey(item), type: item.system?.type ?? null },
      trigger, budget: budgetType, cost, spendCost, spendMode, steps: { base, spend }, spendByUse: !!spendEffectId, spendEffectId,
      bleeding: !hasUse && (has(A.statuses, "bleeding") || has(A.statuses, "dying")), // C22
    };
  } catch (err) {
    debug("trigger.ineligible", { why: "error", reactor: A?.name, item: item?.name, error: String(err?.message ?? err) });
    return null;
  }
}

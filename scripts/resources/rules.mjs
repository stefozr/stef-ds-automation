/**
 * Gain rules (Milestone 7, docs/M7-DESIGN.md §1.1, §2.1 WP-A, §3.2). Any client: pure reads of actors, items and the
 * overlay registry.
 *
 * - A gain rule lives on a class feature's overlay (`feature:<dsid>`, `gains: [...]`, D12). A hero's rules are found by
 *   scanning its feature items: `findOverlay(item, actor)` (the NPC guard keeps them off monsters), skipping items the
 *   medkit disabled (`itemFlags(item).disabled`, the layer-2 rule of resolveAbility, I26).
 * - Upgrades replace the amount (`amountBy`, RES:139-140): the highest `amountBy` entry whose feature the hero owns wins;
 *   upgrades never add a second gain. A dice amount ("1d3") is kept as a formula (`amount: null`).
 * - The rules of an actor are cached by uuid; any item create/update/delete and any registry change drops the cache.
 * - Gains stand down when the setting `resourceGains` is off, or a module that owns resource gains is active
 *   (Draw Steel: Resources UI, Draw Steel: Triggers; RES:630-631).
 * i18n keys: none (see resources/world-resources.mjs for the WP-A list).
 */
import * as C from "../constants.mjs";
import { findOverlay, onRegistryChange } from "../library/registry.mjs";
import { itemDsid, itemKey } from "../library/identity.mjs";
import { itemFlags } from "../library/resolve.mjs";
import { error } from "../log.mjs";
import { setting } from "../settings.mjs";
import { combatFor } from "../triggers/budget.mjs";
import { tokenDocForActorUuid } from "../engine/targets.mjs";
import { resourceLevel } from "../features/mastery.mjs";

const RESOURCES_UI_ID = () => C.RESOURCES_UI_ID ?? "draw-steel-resources-ui";
const TRIGGERS_ID = () => C.TRIGGERS_ID ?? "draw-steel-triggers";
const GAIN_DICE_RE = /^\s*\d{1,2}d\d{1,2}(\s*\+\s*\d{1,2})?\s*$/;

/** Default taker per event (§1.1 table; WP-D's normalizeOverlay fills the same, this is a guard for raw rules). */
const TAKER_DEFAULT = Object.freeze({ damage: "self", forcedMove: "selfOrCreature", winded: "self", heroDeath: "self" });

const cache = new Map();   // actor uuid -> GainRuleView[]

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function moduleActive(id) {
  try {
    return !!game.modules?.get?.(id)?.active;
  } catch (_err) {
    return false;
  }
}

/** Gains are off when the setting is off or a module that owns resource gains is active (RES:630-631). */
export function gainsActive() {
  if (setting("enabled") === false) return false;
  const mode = setting("resourceGains") ?? "auto";
  if (mode === "off") return false;
  return !moduleActive(RESOURCES_UI_ID()) && !moduleActive(TRIGGERS_ID());
}

/** A rule with its defaults (deep copy). WP-D's normalizeOverlay sets them; raw rules (tests, world sources) may not. */
export function normalizeRule(raw) {
  const r = JSON.parse(JSON.stringify(raw ?? {}));
  r.once ??= "round";
  r.resource ??= "heroic";
  r.amount ??= 1;
  r.amountBy = Array.isArray(r.amountBy) ? r.amountBy : [];
  if (r.event in TAKER_DEFAULT) r.taker ??= TAKER_DEFAULT[r.event];
  if (r.event === "damage") r.dealer ??= "any";
  if (r.event === "abilityUse" || r.event === "naturalRoll") r.user ??= "any";
  if (r.event === "damage") r.notTypes = Array.isArray(r.notTypes) ? r.notTypes : [];
  if (r.event === "winded") r.states = Array.isArray(r.states) && r.states.length ? r.states : ["winded"];
  r.confirm = false;   // deprecated: accepted and ignored (a gain waits only for a real decision)
  r.loe = !!r.loe;
  return r;
}

/** Integer 1-20 or a dice string -> {amount, formula}; anything else -> null. */
function amountOf(a) {
  if (Number.isInteger(a) && a > 0) return { amount: a, formula: null };
  if (typeof a === "string" && /^\s*\d+\s*$/.test(a)) return { amount: Number(a), formula: null };
  if (typeof a === "string" && GAIN_DICE_RE.test(a)) return { amount: null, formula: a.trim().replace(/\s+/g, " ") };
  return null;
}

/** The amount of a rule for a hero owning the item dsids `owned` (§1.1 replace semantics: the highest present wins). */
export function ruleAmount(rule, owned, level = null) {
  let best = amountOf(rule?.amount) ?? { amount: 1, formula: null };
  let bestN = best.amount ?? 0;
  for (const by of rule?.amountBy ?? []) {
    // 1.2.0: `{minResource, amount}` entries count once the hero's heroic resource (tracking-aware) reaches the number;
    // they are only seen when a `level` is given (features/mastery.mjs resourceLevel), never from the cached view.
    if (by?.minResource != null) {
      if (level == null || level < by.minResource) continue;
    } else if (!by?.feature || !owned.has(by.feature)) continue;
    const a = amountOf(by.amount);
    if (!a) continue;
    // Integers compare by value; a dice entry counts as its own (normalizeOverlay sorts integers first, so the planner
    // takes the last present one: a later entry replaces an earlier one of the same value).
    const n = a.amount ?? Infinity;
    if (n >= bestN) {
      best = a;
      bestN = n;
    }
  }
  return best;
}

/**
 * 1.2.0: the amount of a gain rule for this hero right now: the cached view's amount, or (a rule with `minResource`
 * amounts) recomputed from the hero's current heroic resource, so the thresholds follow the live value.
 */
export function liveAmount(view, actor) {
  const rule = view?.rule;
  if (!rule?.amountBy?.some(by => by?.minResource != null)) return { amount: view?.amount ?? null, formula: view?.formula ?? null };
  const owned = new Set(list(actor?.items).map(i => itemDsid(i)).filter(Boolean));
  return ruleAmount(rule, owned, resourceLevel(actor));
}

/**
 * The gain rules of a hero: one entry per rule of every feature overlay it owns, with the upgrade amount applied.
 * Cached per actor uuid; the cache drops on createItem / updateItem / deleteItem and on registry change.
 * @returns {GainRuleView[]}  {featureKey, featureDsid, ruleKey, rule (normalized), amount: int|null, formula: string|null}
 */
export function gainRulesOf(actor) {
  if (!actor || actor.type !== "hero") return [];
  const uuid = actor.uuid ?? null;
  if (uuid && cache.has(uuid)) return cache.get(uuid);
  const out = [];
  try {
    const items = list(actor.items);
    const owned = new Set(items.map(i => itemDsid(i)).filter(Boolean));
    const features = new Set();
    for (const item of items) {
      if (item?.type !== "feature") continue;
      const key = itemKey(item);
      if (!key || features.has(key)) continue;
      if (itemFlags(item).disabled) continue;
      const overlay = findOverlay(item, actor);
      if (!overlay?.gains?.length) continue;
      features.add(key);
      const featureDsid = String(overlay.key ?? key).replace(/^feature:/, "");
      for (const raw of overlay.gains) {
        if (!raw?.id || !raw?.event) continue;
        const rule = normalizeRule(raw);
        const { amount, formula } = ruleAmount(rule, owned);
        out.push({ featureKey: overlay.key ?? key, featureDsid, ruleKey: `${featureDsid}:${rule.id}`, rule, amount, formula,
          ...(rule.onceWith ? { ledgerRuleKey: `${featureDsid}:${rule.onceWith}` } : {}) });
      }
    }
  } catch (err) {
    error("gains.rules", err, { actor: actor?.name });
  }
  if (uuid) cache.set(uuid, out);
  return out;
}

/** The token document of a combatant (its own, else the actor's token). */
function combatantToken(c) {
  try {
    return c?.token ?? (c?.actor?.uuid ? tokenDocForActorUuid(c.actor.uuid) : null) ?? null;
  } catch (_err) {
    return null;
  }
}

/** Heroes (type "hero", not retainers) among the started combat's combatants, each with its rules (rules non-empty). */
export function gainCandidates(combat) {
  if (!combat?.started) return [];
  const out = [];
  const seen = new Set();
  for (const c of list(combat.combatants)) {
    const actor = c?.actor;
    if (actor?.type !== "hero" || !actor.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    const rules = gainRulesOf(actor);
    if (!rules.length) continue;
    out.push({ actor, tokenDoc: combatantToken(c), rules });
  }
  return out;
}

/** Is any candidate of the started combat on this scene interested in `event`? (external report gate, observers) */
export function gainsWant(event, sceneId = null) {
  try {
    if (!gainsActive()) return false;
    const combat = combatFor(sceneId ?? null);
    if (!combat?.started) return false;
    return gainCandidates(combat).some(c => c.rules.some(v => v.rule.event === event));
  } catch (_err) {
    return false;
  }
}

/** Drop the rule cache (all actors). */
export function clearRuleCache() {
  cache.clear();
}

/** init: the item hooks and onRegistryChange that clear the cache. */
export function registerRuleCache() {
  // Any item change clears every actor's rules: a base actor's item reaches its unlinked tokens too, and the cache is
  // small (heroes of the combat).
  const drop = () => cache.clear();
  for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, drop);
  // A medkit change of a feature's automation (layer 2) is an item flag update: covered by updateItem.
  onRegistryChange(() => cache.clear());
}

/** Selfcheck / harness. */
export const ruleCacheSize = () => cache.size;

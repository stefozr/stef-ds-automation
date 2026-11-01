import { modifierKeyOk, validateAutomation } from "./custom.mjs";
/**
 * Overlay schema of the ability library (Milestone 4). Pure JavaScript without Foundry globals, so the
 * build tools of the library (node) validate content with the same rules the runtime applies.
 *
 * An overlay describes what an ability does in structured data, keyed by the ability's identity
 * (`ability:<dsid>`). It never carries rules text: `name` is the ability's own title (a label) and
 * `notes` / note effects are short reminders in our own words.
 *
 *   {
 *     key: "ability:catch-breath",          // `${item.type}:${dsid}`
 *     monster?: ["<monster key>", ...],      // monster-specific overlay (NPC abilities)
 *     version: "1.0.0",                      // semver, bumped on any change of behaviour
 *     name: "Catch Breath",
 *     notes?: "what stays manual",
 *     requires?: { modules?: ["module-id"] }, // skipped (medkit: unavailable) when a module is inactive
 *     native?: {
 *       suppress?: ["<power roll effect id>"],  // native effects the overlay replaces
 *       filter?: "allies" | "enemies",          // native rows (damage, conditions, forced) only for that side
 *     },
 *     config?: [{ key, type: "checkbox"|"number"|"select", label, hint?, default, options? }],
 *     choices?: [{ id, label?, options: [{ id, label, dsctOption? }] }],  // "choose one" groups shown on the card;
 *                                     dsctOption (0.17.0): the Combat Tools choose choice that picks this option
 *     effects: [Effect, ...],                // may be empty when `triggers` or `trackers` is not
 *     triggers?: [Trigger, ...],             // Milestone 5: triggered actions (at most 4)
 *     trackers?: [Tracker, ...]              // Milestone 5: re-target at 0 Stamina (at most 2)
 *   }
 *
 * Trigger (vocabulary in triggers/taxonomy.mjs; defaults filled in by normalizeOverlay):
 *   id, event ("damage.before" | "damage.after" | "roll.before" | "turn.start" | "turn.end" | "forced.before" | "move.before"),
 *   subject? ("self" default | "ally" | "selfOrAlly" | "enemy" | "creature" | "selfOrCreature"),
 *   attacker? ("any" default | "creature" | "enemy"; damage.* events only),
 *   free? (true: never uses the round's triggered action; default: the item's type decides),
 *   range? ("ability" default | "unlimited" | formula), loe? (default true),
 *   cost? (0-10 heroic resource; default the item's own cost),
 *   spend? {cost (1-5), range? (formula), label?}       an optional extra the owner may pay
 *   require? {keywords?, fromAbility?, damaging?, subjectType?, notStartedByThis?, meleeReach?, recoveries?}
 *   label? (the prompt's subtitle), steps: [Step, ...] (1-6, at least one that is not a plain note: a note
 *   with `effect: true` counts, as the engine's realStep)
 * Step: type ("halve" | "potency" | "edge" | "use" | "freeStrike" | "takeTurnNext" | "note", as the event
 *   allows), when? {spend}, and per type: potency delta (-3..3) + scope? ("all" | "one"); edge amount (1 | 2);
 *   use targets? ("subject" | "source" | "none"); freeStrike by? ("subject" | "reactor"); note text.
 * Tracker: id, effect (the ability's own effect id, applied by a condition effect of the overlay),
 *   onZero ("retarget"), endPrevious? (default true), endOnSourceDying? (default false), label?
 *
 * Effect (flat; `byTier` overrides fields per tier of success):
 *   common  id, type, name? (Combat Tools "choose" name), label?, targets ("targets" | "self" | "pick" | "area"),
 *           filter? ("allies" | "enemies": only targets of that side), tiers? [1,2,3],
 *           when? {spend?, strained?, config?}, choice? {group, option},
 *           potency? {characteristic, value}, manual?, byTier? {"1": {...}, ...},
 *           pick? {count (1-MAX_PICK), within (formula, squares), of ("self" | "target"), filter?, damageTypes?}
 *           (Milestone 9, with `targets: "pick"`: the user's owner picks the creature(s) at resolve time; "area"
 *           = every creature inside the area the use placed, `filter` as for targets)
 *   damage    value (formula), damageType?, ignoredImmunities?
 *   heal      value (formula) | recoveries (n) and spender? ("self": the user pays, the target heals
 *             the user's recovery value), temporary?
 *   condition status | effect (the ability's own effect id) | uuid (compendium effect), end?, stacking?,
 *             until? ("yourNextTurnStart" | "yourNextTurnEnd": the user's next turn, in combat)
 *   cleanse   statuses? [...], ends? ["save", "turn", ...], count? (null = all)
 *   resource  resource ("surge" | "heroic" | "epic" | "recovery"), value (formula)
 *   forced    movement ("push" | "pull" | "slide" | [several]), distance (formula), vertical?, ignoresStability?,
 *             properties? (Combat Tools: "no-collision-damage", "no-mover-collision-damage", "no-obstacle-collision-damage")
 *   teleport  distance (formula), mode? ("normal"), autoStart?, hideAfter?, hideWhileObserved?, hideSurge? (0-3);
 *             opt-in picker and optional Hide after a self teleport; resource reward only on confirmed success;
 *             boost? {resource ("heroic" | "surge" | "epic"), per (squares per point, default 1), max?, label?}
 *             (Milestone 9, self teleports only: the mover may spend the resource for extra squares)
 *   modifier  key (an actor property of custom.mjs modifierKeyOk: damage weaknesses / immunities, speed, ...),
 *             value (formula), mode? ("add" | "override"), end? (MODIFIER_ENDS: when the effect ends; absent = stays)
 *             (Milestone 9: an ActiveEffect on the creature, as a feature rule's modifier)
 *   note      text
 *   summon    actors [{uuid, label?}], quantity, distance?, origin, side, turn, actsThisRound, squad, lasts, upkeep?, carryStamina, lockOnZero
 *             (Milestone 6: always on the user's own row, `targets: "self"`; defaults in SUMMON_DEFAULTS; only
 *             quantity, distance and label vary by tier)
 *   zone      value (formula, per hit or per square), damageType?, ignoredImmunities?, zoneEvents, once, onceShared,
 *             perSquare, affects, exceptKeywords, exceptMonsters, shape, size?, width?, range?, lasts, upkeep?,
 *             forcedCounts (Milestone 7: a lasting area; always on the user's own row, `targets: "self"`; defaults
 *             in ZONE_DEFAULTS; only value, size and label vary by tier; no `filter`, no `potency`),
 *             terrain? ("difficult": Milestone 9, the area is difficult terrain for the creatures `affects` names;
 *             a zone needs `value` or `terrain`, a terrain-only zone deals no damage)
 *
 * Milestone 7 overlay-level fields:
 *   npc?: true                              a generic overlay that also applies to NPCs (registry findOverlay: NPCs
 *                                           get monster-specific overlays only, unless the generic one opts in);
 *                                           never together with `monster`
 *   gains?: [Gain, ...]                     only on a class feature's overlay (`feature:<dsid>`, `effects: []`),
 *                                           at most MAX_GAINS
 * Milestone 9 overlay-level field (docs/M9-DESIGN.md §C):
 *   persistent?: {cost?, keep, targets?, note?}  a Persistent ability (heroes only): at the user's turn start the owner
 *                                           keeps the use for `cost` (1-10, default the item's persistent effect
 *                                           `essence`) or lets it go. keep: "reroll" (the power roll again, free) |
 *                                           "extend" (conditions with `until` / the aura last to the next decision) |
 *                                           "manual" (a reminder; needs `note`) or a list of 1-2 of them (manual
 *                                           alone); targets ("recorded" default | "area", reroll only). Never with
 *                                           a summon or zone effect (they keep themselves with `upkeep`).
 * Gain (defaults filled in by normalizeOverlay; fields per event in GAIN_FIELDS):
 *   id, event ("damage" | "forcedMove" | "abilityUse" | "naturalRoll" | "winded" | "heroDeath"), once ("round" default |
 *   "encounter" | "each"), resource ("heroic" default | "surge" | "epic"), amount (1-20 or "1d3"), amountBy?
 *   [{feature, amount}] (upgrades replace the amount, the highest present wins), taker?, dealer?, user?,
 *   takerEffect? / dealerEffect? {ability, effect?}, within?, withinAbility?, notTypes?, minSurges?, category?,
 *   actionType?, costsMalice?, heroesInTurn?, natural?, loe?, states?, confirm?, label (required, our own words)
 */
import {
  ATTACKERS, EVENT_STEPS, FREE_STRIKE_BY, LIMITS, POTENCY_SCOPES, RANGE_WORDS, REQUIRE_KEYS, STEP_TYPES, SUBJECTS,
  SUBJECT_TYPES, TRACKER_ON_ZERO, TRIGGER_EVENTS, USE_TARGETS, realStep,
} from "../triggers/taxonomy.mjs";

export const SCHEMA_VERSION = 1;

export const EFFECT_TYPES = Object.freeze(["damage", "heal", "condition", "cleanse", "resource", "forced", "teleport", "note", "summon", "zone", "modifier"]);
export const TARGETS = Object.freeze(["targets", "self", "pick", "area"]);
export const FILTERS = Object.freeze(["allies", "enemies"]);
export const TIERS = Object.freeze([1, 2, 3]);
export const CHARACTERISTICS = Object.freeze(["might", "agility", "reason", "intuition", "presence"]);
export const MOVEMENTS = Object.freeze(["push", "pull", "slide"]);
export const RESOURCES = Object.freeze(["surge", "heroic", "epic", "recovery"]);
export const TELEPORT_MODES = Object.freeze(["normal"]);
export const UNTILS = Object.freeze(["yourNextTurnStart", "yourNextTurnEnd"]);
export const FORCED_PROPERTIES = Object.freeze(["no-collision-damage", "no-mover-collision-damage", "no-obstacle-collision-damage"]);
export const SPENDERS = Object.freeze(["target", "self"]);
/* Milestone 9: target picks, area allies, modifiers and teleport boosts (docs/M9-DESIGN.md §A). */
/** Who a `pick` is measured from: the ability's user, or the card's first real target. */
export const PICK_OF = Object.freeze(["self", "target"]);
export const MAX_PICK = 5;
/** Ends of a `modifier` effect: custom.mjs RULE_ENDS without "" (stays), "passive" and "aura" (feature rules only). */
export const MODIFIER_ENDS = Object.freeze(["turnEnd", "nextTurnEnd", "nextTurnStart", "sourceNextTurnStart", "sourceNextTurnEnd", "roundEnd", "encounterEnd"]);
export const MODIFIER_MODES = Object.freeze(["add", "override"]);
/** Resources a self teleport's `boost` may spend (one point per `per` extra squares). */
export const BOOST_RESOURCES = Object.freeze(["heroic", "surge", "epic"]);
const PICK_FIELDS = Object.freeze(["count", "within", "of", "filter", "damageTypes", "flanking"]);
const BOOST_FIELDS = Object.freeze(["resource", "per", "max", "label"]);
/** Effect types a pick cannot target (they go on the user's own row, or apply nothing). */
const NO_PICK_TYPES = Object.freeze(["summon", "zone", "note"]);
/** Effect types `targets: "area"` may carry (allies in the placed area). */
const AREA_EFFECT_TYPES = Object.freeze(["damage", "heal", "condition", "cleanse", "resource", "note", "modifier"]);
/** Effect ends of Draw Steel 1.1.2 (ds.CONFIG.effectEnds) plus "" (no end). */
export const ENDS = Object.freeze(["", "turn", "save", "encounter", "respite"]);
/** Status ids of Draw Steel 1.1.2 (CONFIG.statusEffects after the system's setup). */
export const STATUSES = Object.freeze([
  "bleeding", "dazed", "frightened", "grabbed", "prone", "restrained", "slowed", "surprised", "taunted",
  "weakened", "dying", "winded", "dead", "sleep", "fly", "burrow", "blind", "deaf", "invisible",
]);
/** Names the system and Combat Tools reserve for their own types: never used by us. */
export const RESERVED_NAMES = Object.freeze(["summon", "portfolioSummon", "targetResult", "fall"]);
/* Milestone 9 (docs/M9-DESIGN.md §C): Persistent upkeep of an ability use (overlay-level `persistent`). */
/** What keeping the use at the user's turn start does: roll again for free, hold the effects, or a reminder only. */
export const PERSISTENT_KEEPS = Object.freeze(["reroll", "extend", "manual"]);
/** Who a re-roll targets: the use's own targets (default), or every enemy in the area again. */
export const PERSISTENT_TARGETS = Object.freeze(["recorded", "area"]);
export const PERSISTENT_FIELDS = Object.freeze(["cost", "keep", "targets", "note"]);

/* Milestone 6: summon effects (docs/M6-DESIGN.md §1.1). */
export const SUMMON_ORIGINS = Object.freeze(["self", "target"]);
export const SUMMON_SIDES = Object.freeze(["summoner", "hostile"]);
export const SUMMON_TURNS = Object.freeze(["after", "own", "with", "none"]);
export const SUMMON_SQUADS = Object.freeze(["join", "new", "none"]);
export const SUMMON_LASTS = Object.freeze(["summonerTurnStart", "summonerTurnEnd", "encounterEnd", "summonerDying", "zeroStamina", "manual"]);
export const SUMMON_PACK = "draw-steel.monsters";
export const MAX_SUMMON_ACTORS = 6;
export const MAX_SUMMON_QUANTITY = 10;
/** Defaults filled in by normalizeOverlay (and read by the plan for detached entries). */
export const SUMMON_DEFAULTS = Object.freeze({
  quantity: "1", origin: "self", side: "summoner", turn: "own", actsThisRound: true, squad: "join",
  lasts: Object.freeze(["encounterEnd"]), upkeep: null, carryStamina: false, lockOnZero: false,
});

/* Milestone 7: event gains of class features (docs/M7-DESIGN.md §1.1). */
export const GAIN_EVENTS = Object.freeze(["damage", "forcedMove", "abilityUse", "naturalRoll", "winded", "heroDeath"]);
export const GAIN_ONCE = Object.freeze(["round", "encounter", "each"]);
export const GAIN_RESOURCES = Object.freeze(["heroic", "surge", "epic"]);
/** Who took the damage / was moved / became winded / died, relative to the gainer. */
export const GAIN_TAKERS = Object.freeze(["self", "ally", "selfOrAlly", "enemy", "creature", "selfOrCreature", "hero"]);
/** Who dealt the damage. "director": an NPC dealer, or a card authored by a GM with no source actor. */
export const GAIN_DEALERS = Object.freeze(["any", "self", "ally", "selfOrAlly", "enemy", "director"]);
/** Who used the ability / rolled. */
export const GAIN_USERS = Object.freeze(["any", "self", "ally", "enemy", "hero", "director"]);
/** `system.category` values a rule may test (no shipped rule needs `maliceAncestry` or the empty category). */
export const GAIN_CATEGORIES = Object.freeze(["heroic", "signature", "villain"]);
/** `system.type` of the ability used (Draw Steel 1.1.2 ability types, all seen in the packs). */
export const GAIN_ACTIONS = Object.freeze(["main", "maneuver", "freeManeuver", "triggered", "freeTriggered", "move", "none", "villain"]);
export const GAIN_STATES = Object.freeze(["winded", "dying"]);
export const MAX_GAINS = 6;
/** "1d3", "1d3 + 1": the only dice a gain amount may roll (rolled on the GM when the row applies). */
export const GAIN_DICE_RE = /^\s*\d{1,2}d\d{1,2}(\s*\+\s*\d{1,2})?\s*$/;
/** Fields a gain may carry besides the common ones, per event ("does not go with <event>" otherwise). */
export const GAIN_FIELDS = Object.freeze({
  damage: Object.freeze(["taker", "dealer", "takerEffect", "dealerEffect", "within", "notTypes", "minSurges"]),
  forcedMove: Object.freeze(["taker", "within"]),
  abilityUse: Object.freeze(["user", "within", "withinAbility", "category", "actionType", "costsMalice", "heroesInTurn"]),
  naturalRoll: Object.freeze(["user", "within", "natural", "loe"]),
  winded: Object.freeze(["taker", "within", "states"]),
  heroDeath: Object.freeze(["taker"]),
});
const GAIN_COMMON = Object.freeze(["id", "event", "once", "resource", "amount", "amountBy", "confirm", "label"]);
/** Default `taker` per event (forced movement: the gainer can be force moved too). */
const GAIN_TAKER_DEFAULT = Object.freeze({ damage: "self", forcedMove: "selfOrCreature", winded: "self", heroDeath: "self" });

/* Milestone 7: lasting areas (docs/M7-DESIGN.md §1.2). */
export const ZONE_EVENTS = Object.freeze(["enter", "move", "turnStart", "turnEnd"]);
export const ZONE_ONCE = Object.freeze(["round", "none"]);
export const ZONE_AFFECTS = Object.freeze(["enemies", "allies", "all"]);
export const ZONE_SHAPES = Object.freeze(["ability", "wall", "cube", "line", "burst", "aura"]);
/** Milestone 9 (docs/M9-DESIGN.md §B): what the area does to movement; "difficult" doubles the cost of ground moves. */
export const ZONE_TERRAINS = Object.freeze(["difficult"]);
/** Defaults filled in by normalizeOverlay (and read by the plan for detached entries, which bypass it). */
export const ZONE_DEFAULTS = Object.freeze({
  zoneEvents: Object.freeze(["enter", "turnStart"]), once: "round", onceShared: false, perSquare: false,
  affects: "enemies", exceptKeywords: Object.freeze([]), exceptMonsters: Object.freeze([]), shape: "ability",
  lasts: Object.freeze(["summonerTurnStart"]), upkeep: null, forcedCounts: true, terrain: null,
});
export const MAX_ZONE_SQUARES = 30;
/** The RegionBehavior type (module.json documentTypes.RegionBehavior.zone). */
export const ZONE_TYPE = "stef-ds-automation.zone";
const SUMMON_COMPENDIUM_RE = /^Compendium\.[\w-]+\.[\w-]+\.Actor\.[A-Za-z0-9]{16}$/;
const SUMMON_WORLD_RE = /^Actor\.[A-Za-z0-9]{16}$/;

/**
 * A summon stat block reference as the runtime uses it, or null when it is not one:
 *   "Compendium.<pkg>.<pack>.Actor.<16 id>" -> unchanged
 *   "Actor.<16 id>" (world-relative link in pack text) -> "Compendium.draw-steel.monsters.Actor.<16 id>"
 */
export function summonActorUuid(uuid) {
  if (typeof uuid !== "string") return null;
  const s = uuid.trim();
  if (SUMMON_COMPENDIUM_RE.test(s)) return s;
  if (SUMMON_WORLD_RE.test(s)) return `Compendium.${SUMMON_PACK}.${s}`;
  return null;
}

/** Throws when `name` is one of RESERVED_NAMES (the system's / Combat Tools' own type names). */
export function assertNotReserved(name) {
  if (RESERVED_NAMES.includes(name)) throw new Error(`stef-ds-automation | "${name}" is reserved by Draw Steel or Combat Tools and cannot name one of our types`);
}

const KEY_RE = /^[a-zA-Z]+:[a-z0-9][a-z0-9-]*$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MAX_TEXT = 200;

/** Fields an effect type may carry (besides the common ones). */
export const TYPE_FIELDS = Object.freeze({
  damage: ["value", "damageType", "ignoredImmunities"],
  heal: ["value", "recoveries", "spender", "temporary"],
  condition: ["status", "effect", "uuid", "end", "stacking", "until", "temporaryStamina"],
  cleanse: ["statuses", "ends", "count", "afterMove"],
  resource: ["resource", "value"],
  forced: ["movement", "distance", "vertical", "ignoresStability", "properties"],
  teleport: ["distance", "mode", "autoStart", "hideAfter", "hideWhileObserved", "hideSurge", "boost"],
  note: ["text"],
  summon: ["actors", "quantity", "distance", "origin", "side", "turn", "actsThisRound", "squad", "lasts", "upkeep", "carryStamina", "lockOnZero"],
  zone: ["value", "damageType", "ignoredImmunities", "zoneEvents", "once", "onceShared", "perSquare", "affects", "exceptKeywords",
    "exceptMonsters", "shape", "size", "width", "range", "lasts", "upkeep", "forcedCounts", "terrain"],
  modifier: ["key", "value", "mode", "end"],
});
const COMMON_FIELDS = ["id", "type", "name", "label", "targets", "filter", "tiers", "when", "choice", "potency", "manual", "byTier", "pick"];
const TIERABLE = new Set(["value", "recoveries", "temporary", "status", "effect", "uuid", "end", "until", "distance", "movement", "potency", "count", "text", "label", "quantity", "size"]);

/* -------------------------------------------- */
/*  Formulas (syntax check only)                */
/* -------------------------------------------- */

/**
 * Check a deterministic formula without evaluating it: numbers, `@paths`, + - * /, parentheses and
 * the functions floor / ceil / max / min / abs. Returns null when it parses, else the problem.
 */
export function formulaProblem(formula) {
  const src = String(formula ?? "").trim();
  if (!src) return "empty";
  const tokens = src.match(/\s+|\d+(?:\.\d+)?|@[A-Za-z_][A-Za-z0-9_.]*|[A-Za-z_]+|[-+*/(),]|./g) ?? [];
  const seq = tokens.filter(t => !/^\s+$/.test(t));
  let depth = 0;
  let expectOperand = true;
  for (let i = 0; i < seq.length; i++) {
    const t = seq[i];
    if (/^\d/.test(t) || t.startsWith("@")) {
      if (!expectOperand) return `unexpected "${t}"`;
      expectOperand = false;
    } else if (/^[A-Za-z_]+$/.test(t)) {
      if (!["floor", "ceil", "max", "min", "abs", "round"].includes(t)) return `unknown name "${t}"`;
      if (seq[i + 1] !== "(") return `"${t}" needs parentheses`;
      if (!expectOperand) return `unexpected "${t}"`;
    } else if (t === "(") {
      if (!expectOperand) return "unexpected (";
      depth++;
    } else if (t === ")") {
      if (expectOperand) return "unexpected )";
      if (--depth < 0) return "unbalanced )";
    } else if (t === ",") {
      if (expectOperand || depth === 0) return "unexpected ,";
      expectOperand = true;
    } else if ("+-*/".includes(t)) {
      if (expectOperand && t !== "-" && t !== "+") return `unexpected "${t}"`;
      expectOperand = true;
    } else return `unexpected "${t}"`;
  }
  if (depth !== 0) return "unbalanced (";
  if (expectOperand) return "ends with an operator";
  return null;
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = v => typeof v === "string";
const isFormula = v => (typeof v === "number" && Number.isFinite(v)) || (isStr(v) && !formulaProblem(v));
const shortText = v => isStr(v) && v.length > 0 && v.length <= MAX_TEXT && !/[<>]/.test(v);

/** Problems of one effect's type-specific fields (`e` already merged with a tier's overrides). */
function typeProblems(e, where, ctx) {
  const out = [];
  const bad = msg => out.push(`${where}: ${msg}`);
  switch (e.type) {
    case "damage":
      if (!isFormula(e.value)) bad("damage needs a formula `value`");
      if (e.damageType != null && !isStr(e.damageType)) bad("damageType must be a string");
      if (e.ignoredImmunities != null && !(Array.isArray(e.ignoredImmunities) && e.ignoredImmunities.every(isStr))) bad("ignoredImmunities must be strings");
      break;
    case "heal": {
      const hasValue = e.value != null;
      const hasRec = e.recoveries != null;
      if (hasValue === hasRec) bad("heal needs exactly one of `value` and `recoveries`");
      if (hasValue && !isFormula(e.value)) bad("heal `value` must be a formula");
      if (hasRec && !(Number.isInteger(e.recoveries) && e.recoveries >= 1 && e.recoveries <= 5)) bad("`recoveries` must be 1-5");
      if (hasRec && e.temporary) bad("recoveries heal Stamina, not temporary Stamina");
      if (e.spender != null && (!hasRec || !SPENDERS.includes(e.spender))) bad("`spender` (target | self) only goes with `recoveries`");
      if (e.spender === "self" && e.targets === "self") bad("`spender: self` is for healing a target with the user's Recovery");
      break;
    }
    case "condition": {
      const sources = ["status", "effect", "uuid"].filter(k => e[k] != null);
      if (sources.length !== 1) bad("condition needs exactly one of `status`, `effect`, `uuid`");
      if (e.status != null && !STATUSES.includes(e.status)) bad(`unknown status "${e.status}"`);
      if (e.effect != null && !(isStr(e.effect) && e.effect.length)) bad("`effect` must be the ability's effect id");
      if (e.effect != null && ctx.effectIds && !ctx.effectIds.has(e.effect)) bad(`the ability has no effect "${e.effect}"`);
      if (e.uuid != null && !(isStr(e.uuid) && /^Compendium\.[\w-]+\.[\w-]+\.ActiveEffect\.[A-Za-z0-9]{16}$/.test(e.uuid))) bad("`uuid` must be a compendium ActiveEffect uuid");
      if (e.uuid != null && ctx.effectUuids && !ctx.effectUuids.has(e.uuid)) bad(`unknown effect uuid ${e.uuid}`);
      if (e.end != null && !ENDS.includes(e.end)) bad(`unknown end "${e.end}"`);
      if (e.until != null && !UNTILS.includes(e.until)) bad(`unknown until "${e.until}" (yourNextTurnStart | yourNextTurnEnd)`);
      break;
    }
    case "cleanse":
      if (e.statuses != null && !(Array.isArray(e.statuses) && e.statuses.every(s => STATUSES.includes(s)))) bad("`statuses` must be status ids");
      if (e.ends != null && !(Array.isArray(e.ends) && e.ends.every(s => ENDS.includes(s) && s))) bad("`ends` must be effect ends");
      if (e.statuses == null && e.ends == null) bad("cleanse needs `statuses` or `ends`");
      if (e.count != null && !(Number.isInteger(e.count) && e.count >= 1 && e.count <= 10)) bad("`count` must be 1-10 or null");
      break;
    case "resource":
      if (!RESOURCES.includes(e.resource)) bad(`unknown resource "${e.resource}"`);
      if (!isFormula(e.value)) bad("resource needs a formula `value`");
      break;
    case "forced": {
      const list = Array.isArray(e.movement) ? e.movement : [e.movement];
      if (!list.length || !list.every(m => MOVEMENTS.includes(m))) bad("`movement` must be push, pull or slide (or a list)");
      if (!isFormula(e.distance)) bad("forced needs a formula `distance`");
      if (e.targets === "self" && !list.includes("slide")) bad("a creature cannot push or pull itself");
      if (e.properties != null && !(Array.isArray(e.properties) && e.properties.every(p => FORCED_PROPERTIES.includes(p)))) bad("`properties` must be Combat Tools' no-collision flags");
      break;
    }
    case "teleport":
      if (!isFormula(e.distance)) bad("teleport needs a formula `distance`");
      if (e.mode != null && !TELEPORT_MODES.includes(e.mode)) bad(`unknown teleport mode "${e.mode}"`);
      for (const k of ["autoStart", "hideAfter", "hideWhileObserved"]) if (e[k] != null && typeof e[k] !== "boolean") bad(`\`${k}\` must be true or false`);
      if (e.hideSurge != null && !intIn(e.hideSurge, 0, 3)) bad("`hideSurge` must be an integer 0-3");
      if ((e.autoStart || e.hideAfter) && e.targets !== "self") bad("automatic teleport and Hide require targets: self");
      if ((e.hideWhileObserved || e.hideSurge) && !e.hideAfter) bad("Hide options require hideAfter");
      if (e.boost != null) boostProblems(e).forEach(bad);
      break;
    case "note":
      if (!shortText(e.text)) bad(`note needs a short \`text\` (1-${MAX_TEXT} characters, no markup)`);
      break;
    case "summon": summonProblems(e, ctx).forEach(bad); break;
    case "zone": zoneProblems(e).forEach(bad); break;
    case "modifier":
      // The same keys a feature rule's modifier may change (custom.mjs MODIFIER_KEYS and the typed damage keys).
      if (!modifierKeyOk(e.key)) bad(`unsupported modifier \`key\` "${e.key}"`);
      if (!isFormula(e.value)) bad("modifier needs a formula `value`");
      if (e.mode != null && !MODIFIER_MODES.includes(e.mode)) bad(`unknown mode "${e.mode}" (${MODIFIER_MODES.join(" | ")})`);
      if (e.end != null && !MODIFIER_ENDS.includes(e.end)) bad(`unknown end "${e.end}" (${MODIFIER_ENDS.join(" | ")})`);
      break;
  }
  return out;
}

/** Problems of a self teleport's `boost` (Milestone 9): the resource spent for extra squares. */
function boostProblems(e) {
  const b = e.boost;
  if (!isObj(b)) return ["`boost` must be an object ({resource, per, max, label})"];
  const out = [];
  for (const k of Object.keys(b)) if (!BOOST_FIELDS.includes(k)) out.push(`unknown field "boost.${k}"`);
  if (!BOOST_RESOURCES.includes(b.resource)) out.push(`\`boost.resource\` must be ${BOOST_RESOURCES.join(" | ")}`);
  if (b.per != null && !intIn(b.per, 1, 10)) out.push("`boost.per` must be 1-10 (squares per point)");
  if (b.max != null && !intIn(b.max, 1, 20)) out.push("`boost.max` must be 1-20");
  if (b.label != null && !shortText(b.label)) out.push("`boost.label` must be short text");
  if (e.targets !== "self") out.push("a teleport `boost` needs targets: \"self\" (the mover spends the resource)");
  return out;
}

/**
 * Problems of an effect's `pick` (Milestone 9): `targets: "pick"` and the `pick` object go together; `within` is a
 * formula in squares, `damageTypes` (a damage effect only) replaces `damageType` with the picker's choice.
 */
function pickProblems(e, where) {
  const out = [];
  const bad = msg => out.push(`${where}: ${msg}`);
  const p = e.pick;
  if (e.targets === "pick" && NO_PICK_TYPES.includes(e.type)) bad(`a ${e.type} effect cannot pick its targets`);
  if (e.targets === "pick" && p == null) {
    bad("targets \"pick\" needs a `pick` object ({count, within, of, filter, damageTypes})");
    return out;
  }
  if (p == null) return out;
  if (!isObj(p)) {
    bad("`pick` must be an object");
    return out;
  }
  if (e.targets !== "pick") bad("`pick` needs targets: \"pick\"");
  for (const k of Object.keys(p)) if (!PICK_FIELDS.includes(k)) bad(`unknown field "pick.${k}"`);
  if (p.count != null && !intIn(p.count, 1, MAX_PICK)) bad(`\`pick.count\` must be 1-${MAX_PICK}`);
  if (!isFormula(p.within)) bad("`pick.within` must be a formula (squares)");
  else if (literalNumber(p.within) !== null && literalNumber(p.within) < 0) bad("`pick.within` must be 0 or more");
  if (p.of != null && !PICK_OF.includes(p.of)) bad(`unknown pick.of "${p.of}" (${PICK_OF.join(" | ")})`);
  if (p.filter != null && !FILTERS.includes(p.filter)) bad("`pick.filter` must be \"allies\" or \"enemies\"");
  // 1.1.1: allies flanking the card's target together with the user (engine/proximity.mjs flankingAllies).
  if (p.flanking != null && typeof p.flanking !== "boolean") bad("`pick.flanking` must be true or false");
  if (p.flanking === true && (p.of !== "target" || p.filter !== "allies")) bad("`pick.flanking` needs `of: \"target\"` and `filter: \"allies\"`");
  if (p.damageTypes != null) {
    if (e.type !== "damage") bad("`pick.damageTypes` only goes with a damage effect");
    const ok = Array.isArray(p.damageTypes) && p.damageTypes.length >= 1 && p.damageTypes.length <= 10
      && p.damageTypes.every(t => isStr(t) && /^[a-z]+$/.test(t)) && new Set(p.damageTypes).size === p.damageTypes.length;
    if (!ok) bad("`pick.damageTypes` must list 1-10 distinct damage types");
    if (e.damageType != null) bad("`pick.damageTypes` replaces `damageType` (the picker chooses)");
  }
  return out;
}

/** A literal number (a number, or a string of digits) of a formula field, else null (a formula: no range check). */
const literalNumber = v => (typeof v === "number" ? v : isStr(v) && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : null);

/** `lasts` and `upkeep` as summons (M6) and zones (M7) use them; `defaultLasts` when `lasts` is absent. */
function lastsProblems(e, defaultLasts) {
  const out = [];
  if (e.lasts != null) {
    const list = Array.isArray(e.lasts) ? e.lasts : null;
    if (!list || !list.length || !list.every(v => SUMMON_LASTS.includes(v)) || new Set(list).size !== list.length) {
      out.push(`\`lasts\` must list ends of ${SUMMON_LASTS.join(", ")} (no duplicates)`);
    } else if (list.includes("manual") && list.length > 1) out.push("`lasts`: `manual` cannot be combined");
  }
  if (e.upkeep != null) {
    if (!intIn(e.upkeep, 1, 10)) out.push("`upkeep` must be 1-10");
    else if (!(Array.isArray(e.lasts) ? e.lasts : defaultLasts).includes("summonerTurnStart")) out.push("`upkeep` needs `lasts` to include summonerTurnStart");
  }
  return out;
}

/**
 * Problems of a zone effect's own fields (docs/M7-DESIGN.md §1.2), `e` merged with a tier's overrides.
 * Absent fields take ZONE_DEFAULTS (so `move` with the default `once: "round"` is refused).
 */
function zoneProblems(e) {
  const out = [];
  const bad = msg => out.push(msg);
  const lit = (v, lo, hi, name) => {
    const n = literalNumber(v);
    if (n !== null && !(Number.isInteger(n) && n >= lo && n <= hi)) bad(`\`${name}\`: a literal number must be an integer ${lo}-${hi}`);
  };
  // Milestone 9: a terrain-only zone (Unquiet Ground) has no damage value.
  if (e.terrain != null && !ZONE_TERRAINS.includes(e.terrain)) bad(`unknown terrain "${e.terrain}" (${ZONE_TERRAINS.join(" | ")})`);
  if (e.value == null) {
    if (e.terrain == null) bad("zone needs a formula `value` or a `terrain`");
  } else if (!isFormula(e.value)) bad("zone needs a formula `value`");
  else lit(e.value, 0, 200, "value");
  if (e.damageType != null && !isStr(e.damageType)) bad("damageType must be a string");
  if (e.ignoredImmunities != null && !(Array.isArray(e.ignoredImmunities) && e.ignoredImmunities.every(isStr))) bad("ignoredImmunities must be strings");
  const events = e.zoneEvents ?? ZONE_DEFAULTS.zoneEvents;
  if (e.zoneEvents != null) {
    if (!Array.isArray(e.zoneEvents) || !e.zoneEvents.length || !e.zoneEvents.every(v => ZONE_EVENTS.includes(v)) || new Set(e.zoneEvents).size !== e.zoneEvents.length) {
      bad(`\`zoneEvents\` must list ${ZONE_EVENTS.join(" / ")}`);
    } else if (e.zoneEvents.includes("enter") && e.zoneEvents.includes("move")) bad("`zoneEvents`: enter and move cannot be combined");
  }
  if (e.once != null && !ZONE_ONCE.includes(e.once)) bad(`unknown once "${e.once}" (${ZONE_ONCE.join(" | ")})`);
  else if (Array.isArray(events) && events.includes("move") && (e.once ?? ZONE_DEFAULTS.once) !== "none") bad("`zoneEvents` move needs `once: \"none\"`");
  for (const k of ["onceShared", "perSquare", "forcedCounts"]) if (e[k] != null && typeof e[k] !== "boolean") bad(`\`${k}\` must be true or false`);
  if (e.affects != null && !ZONE_AFFECTS.includes(e.affects)) bad(`unknown affects "${e.affects}" (${ZONE_AFFECTS.join(" | ")})`);
  if (e.exceptKeywords != null && !(Array.isArray(e.exceptKeywords) && e.exceptKeywords.length <= 4
    && e.exceptKeywords.every(w => isStr(w) && w.length > 0 && w.length <= 30 && w === w.toLowerCase()))) {
    bad("`exceptKeywords` must be up to 4 lowercase keywords");
  }
  if (e.exceptMonsters != null && !(Array.isArray(e.exceptMonsters) && e.exceptMonsters.length <= 20 && e.exceptMonsters.every(m => isStr(m) && m.length))) {
    bad("`exceptMonsters` must be up to 20 monster keys");
  }
  if (e.shape != null && !ZONE_SHAPES.includes(e.shape)) bad(`unknown shape "${e.shape}" (${ZONE_SHAPES.join(" | ")})`);
  if (e.size != null) {
    if (!isFormula(e.size)) bad("`size` must be a formula");
    else lit(e.size, 1, MAX_ZONE_SQUARES, "size");
  }
  if (e.width != null) {
    if (!isFormula(e.width)) bad("`width` must be a formula");
    else lit(e.width, 1, 10, "width");
  }
  if (e.range != null) {
    if (!isFormula(e.range)) bad("`range` must be a formula");
    else lit(e.range, 0, 100, "range");
  }
  out.push(...lastsProblems(e, ZONE_DEFAULTS.lasts));
  return out;
}

/** A literal quantity (a number, or a string of digits): it must be an integer 1-MAX_SUMMON_QUANTITY. */
const literalQuantity = v => (typeof v === "number" ? v : isStr(v) && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : null);

/** Problems of a summon effect's own fields (§1.1 of docs/M6-DESIGN.md); `ctx.actorUuids` from the build index. */
function summonProblems(e, ctx) {
  const out = [];
  const bad = msg => out.push(msg);
  if (!Array.isArray(e.actors) || !e.actors.length || e.actors.length > MAX_SUMMON_ACTORS) {
    bad(`summon needs \`actors\`: 1-${MAX_SUMMON_ACTORS} {uuid}`);
  }
  const mapped = new Set();
  for (const [k, a] of (Array.isArray(e.actors) ? e.actors : []).entries()) {
    if (!isObj(a)) { bad(`actors[${k}]: must be {uuid, label?}`); continue; }
    for (const f of Object.keys(a)) if (!["uuid", "label"].includes(f)) bad(`actors[${k}]: unknown field "${f}"`);
    if (a.label != null && !shortText(a.label)) bad(`actors[${k}]: \`label\` must be short text`);
    const uuid = summonActorUuid(a.uuid);
    if (!uuid) { bad(`actors[${k}]: not an Actor uuid`); continue; }
    if (mapped.has(uuid)) bad(`actors[${k}]: duplicate`);
    mapped.add(uuid);
    if (ctx?.actorUuids && !ctx.actorUuids.has(uuid)) bad(`actors[${k}]: no actor ${uuid} in the monsters pack`);
  }
  if (e.quantity != null) {
    if (!isFormula(e.quantity)) bad("`quantity` must be a formula");
    else {
      const n = literalQuantity(e.quantity);
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= MAX_SUMMON_QUANTITY)) bad(`\`quantity\`: a literal number must be an integer 1-${MAX_SUMMON_QUANTITY}`);
    }
  }
  if (e.distance != null && !isFormula(e.distance)) bad("`distance` must be a formula");
  if (e.origin != null && !SUMMON_ORIGINS.includes(e.origin)) bad(`unknown origin "${e.origin}" (${SUMMON_ORIGINS.join(" | ")})`);
  if (e.side != null && !SUMMON_SIDES.includes(e.side)) bad(`unknown side "${e.side}" (${SUMMON_SIDES.join(" | ")})`);
  if (e.turn != null && !SUMMON_TURNS.includes(e.turn)) bad(`unknown turn "${e.turn}" (${SUMMON_TURNS.join(" | ")})`);
  if (e.squad != null && !SUMMON_SQUADS.includes(e.squad)) bad(`unknown squad "${e.squad}" (${SUMMON_SQUADS.join(" | ")})`);
  for (const k of ["actsThisRound", "carryStamina", "lockOnZero"]) if (e[k] != null && typeof e[k] !== "boolean") bad(`\`${k}\` must be true or false`);
  lastsProblems(e, SUMMON_DEFAULTS.lasts).forEach(bad);
  return out;
}

/**
 * Validate one overlay.
 * @param {object} overlay
 * @param {object} [ctx]
 * @param {Set<string>} [ctx.effectIds]   Ids of the ability's own ActiveEffects (build index).
 * @param {Set<string>} [ctx.effectUuids] Known compendium effect uuids (build index).
 * @param {Set<string>} [ctx.preIds]      Ids of the ability's power roll effects (build index).
 * @param {Set<string>} [ctx.actorUuids]  Compendium uuids of the monsters pack's actors (build index; summons).
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateOverlay(overlay, ctx = {}) {
  const errors = [];
  const bad = msg => errors.push(msg);
  if (!isObj(overlay)) return { ok: false, errors: ["overlay must be an object"] };
  const o = overlay;
  const known = ["key", "monster", "version", "name", "notes", "requires", "native", "config", "choices", "effects", "triggers", "trackers", "gains", "npc", "source", "automation", "persistent"];
  for (const k of Object.keys(o)) if (!known.includes(k)) bad(`unknown field "${k}"`);
  if (!isStr(o.key) || !KEY_RE.test(o.key)) bad("`key` must look like \"ability:<dsid>\"");
  if (!isStr(o.version) || !SEMVER_RE.test(o.version)) bad("`version` must be semver (1.0.0)");
  if (!isStr(o.name) || !o.name.trim() || o.name.length > 80) bad("`name` must be the ability's name");
  if (o.notes != null && !shortText(o.notes)) bad(`\`notes\` must be 1-${MAX_TEXT} characters without markup`);
  if (o.monster != null && !(Array.isArray(o.monster) && o.monster.length && o.monster.every(m => isStr(m) && m.length))) bad("`monster` must be a list of monster keys");
  // Milestone 7: a generic overlay reaches NPCs only when it opts in (registry findOverlay, NPC guard).
  if (o.npc != null) {
    if (o.npc !== true) bad("`npc` must be true (or absent)");
    if (o.monster != null) bad("`npc` is for generic overlays: a monster-specific overlay already applies to its monsters");
  }
  if (o.requires != null) {
    if (!isObj(o.requires) || (o.requires.modules != null && !(Array.isArray(o.requires.modules) && o.requires.modules.every(isStr)))) bad("`requires.modules` must be module ids");
  }
  if (o.native != null) {
    if (!isObj(o.native) || (o.native.suppress != null && !(Array.isArray(o.native.suppress) && o.native.suppress.every(isStr)))) bad("`native.suppress` must be power roll effect ids");
    for (const id of o.native?.suppress ?? []) if (ctx.preIds && !ctx.preIds.has(id)) bad(`native.suppress: the ability has no power roll effect "${id}"`);
    if (isObj(o.native)) {
      for (const k of Object.keys(o.native)) if (!["suppress", "filter"].includes(k)) bad(`unknown field "native.${k}"`);
      if (o.native.filter != null && !FILTERS.includes(o.native.filter)) bad("`native.filter` must be \"allies\" or \"enemies\"");
    }
  }
  const configKeys = new Set();
  if (o.config != null) {
    if (!Array.isArray(o.config)) bad("`config` must be a list");
    for (const c of o.config ?? []) {
      if (!isObj(c) || !ID_RE.test(c.key ?? "") || !["checkbox", "number", "select"].includes(c.type) || !shortText(c.label)) {
        bad(`config entry ${JSON.stringify(c?.key)} needs key, type (checkbox|number|select) and label`);
        continue;
      }
      if (configKeys.has(c.key)) bad(`duplicate config key "${c.key}"`);
      configKeys.add(c.key);
      if (c.type === "checkbox" && typeof c.default !== "boolean") bad(`config "${c.key}": checkbox default must be true or false`);
      if (c.type === "number" && !Number.isFinite(c.default)) bad(`config "${c.key}": number default must be a number`);
      if (c.type === "select" && !(Array.isArray(c.options) && c.options.length && c.options.some(op => op?.value === c.default))) bad(`config "${c.key}": select needs options containing the default`);
    }
  }
  const choiceOptions = new Map();
  if (o.choices != null) {
    if (!Array.isArray(o.choices)) bad("`choices` must be a list");
    for (const g of o.choices ?? []) {
      if (!isObj(g) || !ID_RE.test(g.id ?? "") || !Array.isArray(g.options) || g.options.length < 2) {
        bad(`choice group ${JSON.stringify(g?.id)} needs an id and at least two options`);
        continue;
      }
      if (choiceOptions.has(g.id)) bad(`duplicate choice group "${g.id}"`);
      if (g.label != null && !shortText(g.label)) bad(`choice group "${g.id}": label too long`);
      const ids = new Set();
      for (const op of g.options) {
        if (!isObj(op) || !ID_RE.test(op.id ?? "") || !shortText(op.label)) bad(`choice group "${g.id}": options need an id and a short label`);
        else if (op.dsctOption !== undefined && !shortText(op.dsctOption)) bad(`choice group "${g.id}": option "${op.id}" dsctOption must be a short name`);
        else if (ids.has(op.id)) bad(`choice group "${g.id}": duplicate option "${op.id}"`);
        else ids.add(op.id);
      }
      choiceOptions.set(g.id, ids);
    }
  }
  // A trigger-, tracker- or gain-only overlay has nothing to apply from the card itself: `effects: []`.
  if (o.automation != null) for (const msg of validateAutomation(o.automation).errors) bad(`automation: ${msg}`);
  const reacts = !!o.automation?.rules?.length || (Array.isArray(o.triggers) && o.triggers.length > 0) || (Array.isArray(o.trackers) && o.trackers.length > 0)
    || (Array.isArray(o.gains) && o.gains.length > 0) || persistentAutomates(o.persistent);
  if (!Array.isArray(o.effects)) bad("`effects` must be a list");
  else if (!o.effects.length && !reacts) bad("`effects` must be a non-empty list (it may be empty only with `triggers`, `trackers` or `gains`)");
  const ids = new Set();
  const usedOptions = new Map([...choiceOptions.keys()].map(g => [g, new Set()]));
  for (const [i, e] of (o.effects ?? []).entries()) {
    const where = `effects[${i}]${isStr(e?.id) ? ` (${e.id})` : ""}`;
    if (!isObj(e)) { bad(`${where}: must be an object`); continue; }
    if (!ID_RE.test(e.id ?? "")) bad(`${where}: \`id\` must be 1-24 lowercase letters, digits or dashes`);
    else if (ids.has(e.id)) bad(`${where}: duplicate id`);
    ids.add(e.id);
    if (!EFFECT_TYPES.includes(e.type)) { bad(`${where}: unknown type "${e.type}"`); continue; }
    const allowed = new Set([...COMMON_FIELDS, ...TYPE_FIELDS[e.type]]);
    for (const k of Object.keys(e)) if (!allowed.has(k)) bad(`${where}: field "${k}" does not belong to a ${e.type} effect`);
    if (e.name != null && !(isStr(e.name) && e.name.length <= 80)) bad(`${where}: \`name\` too long`);
    if (e.label != null && !shortText(e.label)) bad(`${where}: \`label\` must be short text`);
    if (e.targets != null && !TARGETS.includes(e.targets)) bad(`${where}: targets must be ${TARGETS.map(t => `"${t}"`).join(", ")}`);
    if (e.filter != null && !FILTERS.includes(e.filter)) bad(`${where}: filter must be "allies" or "enemies"`);
    if (e.filter != null && e.targets === "self") bad(`${where}: a filter only applies to targets`);
    // A pick's side goes in `pick.filter` (the candidates offered); an effect-level filter would drop the pick afterwards.
    if (e.filter != null && e.targets === "pick") bad(`${where}: a pick takes its side from \`pick.filter\`, not \`filter\``);
    // Milestone 9: picks and area allies.
    errors.push(...pickProblems(e, where));
    if (e.targets === "area" && !AREA_EFFECT_TYPES.includes(e.type)) bad(`${where}: a ${e.type} effect cannot target the area (${AREA_EFFECT_TYPES.join(", ")})`);
    // Milestone 6: a summon always goes on the user's own row (the rule above needs an explicit "self").
    if (e.type === "summon" && e.targets != null && e.targets !== "self") bad(`${where}: a summon effect goes on the user's own row (\`targets: "self"\`)`);
    if (e.type === "summon" && e.filter != null && e.targets !== "self") bad(`${where}: a filter only applies to targets`);
    // Milestone 7: a zone too (its own `affects` picks who the area hits; potency is refused below).
    if (e.type === "zone" && e.targets != null && e.targets !== "self") bad(`${where}: a zone effect goes on the user's own row (\`targets: "self"\`)`);
    if (e.type === "zone" && e.filter != null && e.targets !== "self") bad(`${where}: a zone has no filter: \`affects\` picks who the area hits`);
    if (e.tiers != null && !(Array.isArray(e.tiers) && e.tiers.length && e.tiers.every(t => TIERS.includes(t)))) bad(`${where}: tiers must be a list of 1, 2, 3`);
    if (e.manual != null && typeof e.manual !== "boolean") bad(`${where}: manual must be true or false`);
    if (e.temporaryStamina != null && (e.type !== "condition" || !ID_RE.test(e.temporaryStamina))) bad(`${where}: temporaryStamina must identify a temporary healing effect`);
    if (e.afterMove != null && (e.type !== "cleanse" || !ID_RE.test(e.afterMove))) bad(`${where}: afterMove must identify a movement effect`);
    if (e.when != null) {
      if (!isObj(e.when)) bad(`${where}: when must be an object`);
      else {
        for (const k of Object.keys(e.when)) if (!["spend", "strained", "config", "alliesNearTarget"].includes(k)) bad(`${where}: unknown when.${k}`);
        if (e.when.spend != null && typeof e.when.spend !== "boolean") bad(`${where}: when.spend must be true or false`);
        if (e.when.strained != null && typeof e.when.strained !== "boolean") bad(`${where}: when.strained must be true or false`);
        if (e.when.config != null && !configKeys.has(e.when.config)) bad(`${where}: when.config names no config entry`);
        // 1.1.1: squares from the card's first target (engine/proximity.mjs alliesNear).
        if (e.when.alliesNearTarget != null && (!isFormula(e.when.alliesNearTarget) || (literalNumber(e.when.alliesNearTarget) !== null && literalNumber(e.when.alliesNearTarget) < 0))) bad(`${where}: when.alliesNearTarget must be a formula (squares, 0 or more)`);
      }
    }
    if (e.choice != null) {
      const opts = choiceOptions.get(e.choice?.group);
      if (!opts || !opts.has(e.choice?.option)) bad(`${where}: choice must name a group and one of its options`);
      else usedOptions.get(e.choice.group).add(e.choice.option);
    }
    const potencyProblem = p => {
      if (!isObj(p) || !CHARACTERISTICS.includes(p.characteristic) || !isFormula(p.value)) return "potency needs a characteristic and a formula value";
      return null;
    };
    if (e.potency != null && potencyProblem(e.potency)) bad(`${where}: ${potencyProblem(e.potency)}`);
    if (e.potency != null && !["condition", "forced", "damage", "teleport", "modifier"].includes(e.type)) bad(`${where}: potency only gates conditions, forced movement, damage, teleports and modifiers`);
    if (e.byTier != null) {
      if (!isObj(e.byTier) || !Object.keys(e.byTier).every(k => ["1", "2", "3"].includes(k))) bad(`${where}: byTier keys must be "1", "2", "3"`);
      for (const [t, over] of Object.entries(e.byTier ?? {})) {
        if (!isObj(over)) { bad(`${where}: byTier.${t} must be an object`); continue; }
        for (const k of Object.keys(over)) if (!TIERABLE.has(k) || !allowed.has(k)) bad(`${where}: byTier.${t}.${k} cannot vary by tier`);
        if (over.potency != null && potencyProblem(over.potency)) bad(`${where}: byTier.${t}: ${potencyProblem(over.potency)}`);
      }
    }
    // Type fields for every tier the effect can apply on.
    const tiers = e.tiers ?? (e.byTier ? TIERS : [null]);
    const seen = new Set();
    for (const t of tiers) {
      for (const p of typeProblems(effectForTier(e, t), t ? `${where} tier ${t}` : where, ctx)) {
        if (!seen.has(p)) errors.push(p);
        seen.add(p);
      }
    }
  }
  for (const [g, opts] of choiceOptions) {
    for (const op of opts) if (!usedOptions.get(g)?.has(op)) bad(`choice group "${g}": option "${op}" has no effects`);
  }
  errors.push(...triggerProblems(o, ctx), ...trackerProblems(o, ctx), ...gainProblems(o, ctx), ...persistentProblems(o, ctx));
  return { ok: !errors.length, errors };
}

/* -------------------------------------------- */
/*  Event gains (Milestone 7)                   */
/* -------------------------------------------- */

const DSID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** A gain amount: an integer 1-20 or a dice formula like 1d3. */
const gainAmountOk = v => intIn(v, 1, 20) || (isStr(v) && GAIN_DICE_RE.test(v));

/**
 * Problems of an overlay's `gains` (docs/M7-DESIGN.md §1.1). Messages are prefixed `gains[i] (<id>)`.
 * Overlay-level rules: only on `feature:<dsid>` keys, at most MAX_GAINS.
 * @param {object} o      The overlay.
 * @param {object} [_ctx] Build index context (unused: the library's content lint checks feature and ability keys).
 * @returns {string[]}
 */
export function gainProblems(o, _ctx = {}) {
  const out = [];
  if (o?.gains == null) return out;
  if (!Array.isArray(o.gains)) return ["`gains` must be a list"];
  if (!(isStr(o.key) && o.key.startsWith("feature:"))) out.push("`gains` belong to a class feature's overlay (feature:<dsid>)");
  if (o.gains.length > MAX_GAINS) out.push(`\`gains\`: at most ${MAX_GAINS}`);
  const ids = new Set();
  for (const [i, g] of o.gains.entries()) {
    const where = `gains[${i}]${isStr(g?.id) ? ` (${g.id})` : ""}`;
    const bad = msg => out.push(`${where}: ${msg}`);
    if (!isObj(g)) { bad("must be an object"); continue; }
    if (!ID_RE.test(g.id ?? "")) bad("`id` must be 1-24 lowercase letters, digits or dashes");
    else if (ids.has(g.id)) bad("duplicate id");
    ids.add(g.id);
    const eventOk = GAIN_EVENTS.includes(g.event);
    if (!eventOk) bad(`unknown event "${g.event}" (${GAIN_EVENTS.join(" | ")})`);
    const allFields = new Set([...GAIN_COMMON, ...Object.values(GAIN_FIELDS).flat()]);
    for (const k of Object.keys(g)) {
      if (!allFields.has(k)) bad(`unknown field "${k}"`);
      else if (eventOk && !GAIN_COMMON.includes(k) && !GAIN_FIELDS[g.event].includes(k)) bad(`field "${k}" does not go with ${g.event}`);
    }
    if (g.once != null && !GAIN_ONCE.includes(g.once)) bad(`unknown once "${g.once}" (${GAIN_ONCE.join(" | ")})`);
    if (g.resource != null && !GAIN_RESOURCES.includes(g.resource)) bad(`unknown resource "${g.resource}" (${GAIN_RESOURCES.join(" | ")})`);
    if (g.amount != null && !gainAmountOk(g.amount)) bad("`amount` must be 1-20 or a dice formula like 1d3");
    if (g.amountBy != null) {
      if (!Array.isArray(g.amountBy) || g.amountBy.length > 4) bad("`amountBy` must be a list of up to 4 {feature, amount}");
      else {
        const features = new Set();
        for (const [k, a] of g.amountBy.entries()) {
          if (!isObj(a) || !isStr(a.feature) || !DSID_RE.test(a.feature) || !gainAmountOk(a.amount) || Object.keys(a).some(f => !["feature", "amount"].includes(f))) {
            bad(`\`amountBy[${k}]\` needs a feature dsid and an amount`);
            continue;
          }
          if (features.has(a.feature)) bad(`\`amountBy[${k}]\`: duplicate feature "${a.feature}"`);
          features.add(a.feature);
        }
      }
    }
    if (g.taker != null) {
      if (!GAIN_TAKERS.includes(g.taker)) bad(`unknown taker "${g.taker}" (${GAIN_TAKERS.join(" | ")})`);
      else if (g.event === "heroDeath" && !["self", "hero", "ally", "selfOrAlly"].includes(g.taker)) bad("heroDeath `taker` must be self, hero, ally or selfOrAlly");
    }
    if (g.dealer != null && !GAIN_DEALERS.includes(g.dealer)) bad(`unknown dealer "${g.dealer}" (${GAIN_DEALERS.join(" | ")})`);
    if (g.user != null && !GAIN_USERS.includes(g.user)) bad(`unknown user "${g.user}" (${GAIN_USERS.join(" | ")})`);
    for (const k of ["takerEffect", "dealerEffect"]) {
      const v = g[k];
      if (v == null) continue;
      if (!isObj(v) || !isStr(v.ability) || !DSID_RE.test(v.ability) || Object.keys(v).some(f => !["ability", "effect"].includes(f))) bad(`\`${k}\` needs an ability dsid`);
      else if (v.effect != null && !(isStr(v.effect) && EFFECT_ID_RE.test(v.effect))) bad(`\`${k}.effect\` must be the ability's effect id (16 letters and digits)`);
    }
    if (g.within != null && !intIn(g.within, 1, 100)) bad("`within` must be 1-100");
    if (g.withinAbility != null) {
      if (!isStr(g.withinAbility) || !DSID_RE.test(g.withinAbility)) bad("`withinAbility` must be an ability dsid");
      if (g.within != null) bad("`within` and `withinAbility` cannot be combined");
    }
    if (g.notTypes != null && !(Array.isArray(g.notTypes) && g.notTypes.every(t => isStr(t) && t.length <= 20))) bad("`notTypes` must be damage types (\"\" = untyped)");
    if (g.minSurges != null && !intIn(g.minSurges, 1, 3)) bad("`minSurges` must be 1-3");
    if (g.category != null && !GAIN_CATEGORIES.includes(g.category)) bad(`unknown category "${g.category}" (${GAIN_CATEGORIES.join(" | ")})`);
    if (g.actionType != null && !GAIN_ACTIONS.includes(g.actionType)) bad(`unknown actionType "${g.actionType}" (${GAIN_ACTIONS.join(" | ")})`);
    if (g.costsMalice != null && g.costsMalice !== true) bad("`costsMalice` can only be true");
    if (g.heroesInTurn != null) {
      if (!intIn(g.heroesInTurn, 2, 6)) bad("`heroesInTurn` must be 2-6");
      if (g.user !== "hero") bad("`heroesInTurn` needs `user: \"hero\"`");
    }
    if (g.event === "naturalRoll" && g.natural == null) bad("`natural` must list 2-20");
    if (g.natural != null && !(Array.isArray(g.natural) && g.natural.length && g.natural.every(n => intIn(n, 2, 20)))) bad("`natural` must list 2-20");
    if (g.states != null && !(Array.isArray(g.states) && g.states.length && g.states.every(s => GAIN_STATES.includes(s)) && new Set(g.states).size === g.states.length)) {
      bad(`\`states\` must list ${GAIN_STATES.join(" / ")}`);
    }
    for (const k of ["confirm", "loe"]) if (g[k] != null && typeof g[k] !== "boolean") bad(`\`${k}\` must be true or false`);
    if (!shortText(g.label)) bad(`\`label\` must be 1-${MAX_TEXT} characters without markup`);
  }
  return out;
}

/** A gain with the defaults of §1.1 filled in (already a deep copy); `amountBy` sorted, integers first, ascending. */
function normalizeGain(g) {
  const out = { once: "round", resource: "heroic", amount: 1, confirm: false, ...g };
  const fields = GAIN_FIELDS[g?.event] ?? [];
  if (fields.includes("taker")) out.taker ??= GAIN_TAKER_DEFAULT[g.event];
  if (fields.includes("dealer")) out.dealer ??= "any";
  if (fields.includes("user")) out.user ??= "any";
  if (fields.includes("notTypes")) out.notTypes ??= [];
  if (fields.includes("loe")) out.loe ??= false;
  if (fields.includes("states")) out.states ??= ["winded"];
  const rank = a => (Number.isInteger(a?.amount) ? [0, a.amount] : [1, String(a?.amount ?? "")]);
  out.amountBy = [...(Array.isArray(g?.amountBy) ? g.amountBy : [])].sort((a, b) => {
    const [ka, va] = rank(a);
    const [kb, vb] = rank(b);
    if (ka !== kb) return ka - kb;
    return ka === 0 ? va - vb : String(va).localeCompare(String(vb));
  });
  return out;
}

/* -------------------------------------------- */
/*  Triggers and trackers (Milestone 5)         */
/* -------------------------------------------- */

const TRIGGER_FIELDS = ["id", "event", "subject", "attacker", "free", "range", "loe", "cost", "spend", "require", "label", "steps"];
/** Fields a step type may carry besides `type` and `when`. */
const STEP_FIELDS = Object.freeze({
  halve: [], potency: ["delta", "scope"], edge: ["amount"], use: ["targets"], freeStrike: ["by"], takeTurnNext: [], note: ["text", "effect"],
});
const TRACKER_FIELDS = ["id", "effect", "onZero", "endPrevious", "endOnSourceDying", "label"];
const EFFECT_ID_RE = /^[A-Za-z0-9]{16}$/;
/** A range: a word, a number of squares (>= 0) or a formula. */
const rangeOk = v => RANGE_WORDS.includes(v) || (typeof v === "number" && Number.isFinite(v) && v >= 0) || (isStr(v) && !formulaProblem(v));
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Problems of an overlay's `triggers` (M5-DESIGN §1.2, rules 1-10). Messages are prefixed
 * `triggers[i] (<id>)`, steps `triggers[i] (<id>) steps[j]`.
 * @param {object} o      The overlay.
 * @param {object} [_ctx] Build index context (unused: triggers reference nothing in the ability).
 * @returns {string[]}
 */
export function triggerProblems(o, _ctx = {}) {
  const out = [];
  if (o?.triggers == null) return out;
  if (!Array.isArray(o.triggers)) return ["`triggers` must be a list"];
  if (o.triggers.length > LIMITS.triggers) out.push(`\`triggers\`: at most ${LIMITS.triggers}`);
  const ids = new Set();
  for (const [i, t] of o.triggers.entries()) {
    const where = `triggers[${i}]${isStr(t?.id) ? ` (${t.id})` : ""}`;
    const bad = msg => out.push(`${where}: ${msg}`);
    if (!isObj(t)) { bad("must be an object"); continue; }
    for (const k of Object.keys(t)) if (!TRIGGER_FIELDS.includes(k)) bad(`unknown field "${k}"`);
    // 2. id
    if (!ID_RE.test(t.id ?? "")) bad("`id` must be 1-24 lowercase letters, digits or dashes");
    else if (ids.has(t.id)) bad("duplicate id");
    ids.add(t.id);
    // 3. event, subject, attacker
    const eventOk = TRIGGER_EVENTS.includes(t.event);
    if (!eventOk) bad(`unknown event "${t.event}" (${TRIGGER_EVENTS.join(" | ")})`);
    const onDamage = isStr(t.event) && t.event.startsWith("damage.");
    if (t.subject != null && !SUBJECTS.includes(t.subject)) bad(`unknown subject "${t.subject}"`);
    if (t.attacker != null) {
      if (!ATTACKERS.includes(t.attacker)) bad(`unknown attacker "${t.attacker}"`);
      else if (eventOk && !onDamage) bad("`attacker` only goes with damage.* events");
    }
    if (t.free != null && typeof t.free !== "boolean") bad("`free` must be true or false");
    if (t.loe != null && typeof t.loe !== "boolean") bad("`loe` must be true or false");
    // 4. range
    if (t.range != null && !rangeOk(t.range)) bad("`range` must be \"ability\", \"unlimited\", a number of squares or a formula");
    // 5. cost, spend
    if (t.cost != null && !intIn(t.cost, 0, LIMITS.cost)) bad(`\`cost\` must be an integer 0-${LIMITS.cost}`);
    const hasSpend = t.spend != null;
    if (hasSpend) {
      if (!isObj(t.spend)) bad("`spend` must be an object");
      else {
        for (const k of Object.keys(t.spend)) if (!["cost", "range", "label"].includes(k)) bad(`unknown field "spend.${k}"`);
        if (!intIn(t.spend.cost, 1, LIMITS.spendCost)) bad(`\`spend.cost\` must be an integer 1-${LIMITS.spendCost}`);
        if (t.spend.range != null && !((typeof t.spend.range === "number" && Number.isFinite(t.spend.range) && t.spend.range >= 0) || (isStr(t.spend.range) && !formulaProblem(t.spend.range)))) {
          bad("`spend.range` must be a number of squares or a formula");
        }
        if (t.spend.label != null && !shortText(t.spend.label)) bad(`\`spend.label\` must be 1-${MAX_TEXT} characters without markup`);
      }
    }
    // 6. require
    if (t.require != null) {
      if (!isObj(t.require)) bad("`require` must be an object");
      else {
        for (const [k, v] of Object.entries(t.require)) {
          if (!(k in REQUIRE_KEYS)) { bad(`unknown field "require.${k}"`); continue; }
          if (eventOk && !REQUIRE_KEYS[k].includes(t.event)) bad(`\`require.${k}\` does not go with ${t.event}`);
          if (k === "keywords") {
            if (!(Array.isArray(v) && v.length >= 1 && v.length <= LIMITS.keywords && v.every(w => isStr(w) && w.length > 0 && w.length <= 30 && w === w.toLowerCase()))) {
              bad(`\`require.keywords\` must be 1-${LIMITS.keywords} lowercase keywords`);
            }
          } else if (k === "subjectType") {
            if (!SUBJECT_TYPES.includes(v)) bad(`\`require.subjectType\` must be ${SUBJECT_TYPES.join(" or ")}`);
          } else if (k === "recoveries") {
            if (!intIn(v, 1, 3)) bad("`require.recoveries` must be an integer 1-3");
          } else if (v !== true) bad(`\`require.${k}\` can only be true`);
        }
      }
    }
    // 10. label
    if (t.label != null && !shortText(t.label)) bad(`\`label\` must be 1-${MAX_TEXT} characters without markup`);
    // 7-9. steps
    if (!Array.isArray(t.steps) || !t.steps.length) { bad(`\`steps\` must be a list of 1-${LIMITS.steps}`); continue; }
    if (t.steps.length > LIMITS.steps) bad(`\`steps\`: at most ${LIMITS.steps}`);
    const allowed = eventOk ? EVENT_STEPS[t.event] : STEP_TYPES;
    const counts = new Map();
    const spendGroups = new Set();
    for (const [j, s] of t.steps.entries()) {
      const at = msg => bad(`steps[${j}]: ${msg}`);
      if (!isObj(s)) { at("must be an object"); continue; }
      if (!STEP_TYPES.includes(s.type)) { at(`unknown type "${s.type}"`); continue; }
      if (!allowed.includes(s.type)) at(`a ${s.type} step does not go with ${t.event} (${allowed.join(", ")})`);
      for (const k of Object.keys(s)) if (!["type", "when", ...STEP_FIELDS[s.type]].includes(k)) at(`field "${k}" does not belong to a ${s.type} step`);
      if (s.when != null) {
        if (!isObj(s.when) || Object.keys(s.when).some(k => k !== "spend") || typeof s.when.spend !== "boolean") at("`when` must be {spend: true|false}");
        else if (!hasSpend) at("`when.spend` needs the trigger's `spend`");
      }
      switch (s.type) {
        case "potency":
          if (!(intIn(s.delta, -3, 3) && s.delta !== 0)) at("potency needs a `delta` of -3 to 3, not 0");
          if (s.scope != null && !POTENCY_SCOPES.includes(s.scope)) at(`\`scope\` must be ${POTENCY_SCOPES.join(" or ")}`);
          break;
        case "edge":
          if (s.amount !== 1 && s.amount !== 2) at("edge needs an `amount` of 1 or 2");
          break;
        case "use":
          if (s.targets != null && !USE_TARGETS.includes(s.targets)) at(`\`targets\` must be ${USE_TARGETS.join(", ")}`);
          break;
        case "freeStrike":
          if (s.by != null && !FREE_STRIKE_BY.includes(s.by)) at(`\`by\` must be ${FREE_STRIKE_BY.join(" or ")}`);
          break;
        case "note":
          if (!shortText(s.text)) at(`note needs a short \`text\` (1-${MAX_TEXT} characters, no markup)`);
          // `effect: true`: the note is a real effect done by hand (a shift), worth the triggered action by itself.
          if (s.effect != null && typeof s.effect !== "boolean") at("`effect` must be true or false");
          break;
      }
      // 8. One step of a type per spend group (with the spend / without it).
      const group = `${s.type}|${s.when?.spend === true}`;
      counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
      if (spendGroups.has(group)) at(`duplicate ${s.type} step (steps of one type must differ in when.spend)`);
      spendGroups.add(group);
    }
    for (const once of ["halve", "takeTurnNext"]) if ((counts.get(once) ?? 0) > 1) bad(`at most one ${once} step`);
    // 9. Worth the triggered action by itself, as the engine judges it (taxonomy realStep): `forced.before`
    // allows only notes, so its reaction is an `effect: true` note.
    if (!t.steps.some(s => isObj(s) && realStep(s))) bad("needs a step that is not a plain note (a note with effect: true counts)");
    // turn.end is produced only between heroes' turns, for Hesitation is Weakness (turn-order.mjs runHiw).
    if (t.event === "turn.end") {
      if (!t.steps.some(s => isObj(s) && s.type === "takeTurnNext")) bad("a turn.end trigger needs a takeTurnNext step");
      if (isObj(t.require) && t.require.subjectType != null && t.require.subjectType !== "hero") bad("turn.end is offered only for heroes' turns (`require.subjectType` hero)");
    }
  }
  return out;
}

/**
 * Problems of an overlay's `trackers` (M5-DESIGN §1.3). A tracker follows the ability's own effect, so
 * that effect must be applied by a condition effect of the same overlay (and exist on the ability when
 * the build index is known).
 * @param {object} o
 * @param {object} [ctx]
 * @param {Set<string>} [ctx.effectIds]
 * @returns {string[]}
 */
export function trackerProblems(o, ctx = {}) {
  const out = [];
  if (o?.trackers == null) return out;
  if (!Array.isArray(o.trackers)) return ["`trackers` must be a list"];
  if (o.trackers.length > LIMITS.trackers) out.push(`\`trackers\`: at most ${LIMITS.trackers}`);
  const applied = new Set();
  // A stacking condition is created with a new id (library-apply.mjs keepId = !stacking): a tracker, which
  // matches the effect by id (triggers/trackers.mjs trackerFor), can never find it.
  const stacking = new Set();
  for (const e of Array.isArray(o.effects) ? o.effects : []) {
    if (e?.type !== "condition") continue;
    const variants = [e, ...Object.values(isObj(e.byTier) ? e.byTier : {}).filter(isObj).map(over => ({ ...e, ...over }))];
    for (const v of variants) if (isStr(v.effect)) (v.stacking === true ? stacking : applied).add(v.effect);
  }
  const ids = new Set();
  for (const [i, k] of o.trackers.entries()) {
    const where = `trackers[${i}]${isStr(k?.id) ? ` (${k.id})` : ""}`;
    const bad = msg => out.push(`${where}: ${msg}`);
    if (!isObj(k)) { bad("must be an object"); continue; }
    for (const f of Object.keys(k)) if (!TRACKER_FIELDS.includes(f)) bad(`unknown field "${f}"`);
    if (!ID_RE.test(k.id ?? "")) bad("`id` must be 1-24 lowercase letters, digits or dashes");
    else if (ids.has(k.id)) bad("duplicate id");
    ids.add(k.id);
    if (!isStr(k.effect) || !EFFECT_ID_RE.test(k.effect)) bad("`effect` must be the ability's effect id (16 letters and digits)");
    else {
      if (!applied.has(k.effect)) {
        bad(stacking.has(k.effect)
          ? `the condition that applies "${k.effect}" stacks (each copy gets a new id), so it cannot be tracked`
          : `no condition effect of this overlay applies "${k.effect}"`);
      }
      if (ctx.effectIds && !ctx.effectIds.has(k.effect)) bad(`the ability has no effect "${k.effect}"`);
    }
    if (!TRACKER_ON_ZERO.includes(k.onZero)) bad(`\`onZero\` must be ${TRACKER_ON_ZERO.join(" | ")}`);
    if (k.endPrevious != null && typeof k.endPrevious !== "boolean") bad("`endPrevious` must be true or false");
    if (k.endOnSourceDying != null && typeof k.endOnSourceDying !== "boolean") bad("`endOnSourceDying` must be true or false");
    if (k.label != null && !shortText(k.label)) bad(`\`label\` must be 1-${MAX_TEXT} characters without markup`);
  }
  return out;
}

/* -------------------------------------------- */
/*  Persistent (Milestone 9)                    */
/* -------------------------------------------- */

/** The keep list of a `persistent` value as written (a single keep or a list). */
const keepList = p => (Array.isArray(p?.keep) ? p.keep : [p?.keep]);

/** Does a `persistent` value automate something (rule 4): a re-roll or a hold does, a reminder does not. */
export function persistentAutomates(p) {
  return isObj(p) && keepList(p).some(k => k === "reroll" || k === "extend");
}

/** A condition effect (or one of its tiers) that ends with the user's turn (`until`): what `extend` holds. */
function holdsUntil(e) {
  if (e?.type !== "condition") return false;
  return e.until != null || Object.values(isObj(e.byTier) ? e.byTier : {}).some(t => isObj(t) && t.until != null);
}

/**
 * Problems of an overlay's `persistent` (docs/M9-DESIGN.md §C). Messages are prefixed `persistent:`. A hero rule
 * (`ability:` keys, no `monster` / `npc`); never with a summon or zone effect (they keep themselves with `upkeep`, a
 * second prompt would ask twice); `extend` needs a condition with `until` or an aura to hold; `targets` goes with
 * `reroll`; `manual` stands alone and needs a `note`.
 * @param {object} o      The overlay.
 * @param {object} [_ctx] Build index context (unused: the library's content lint checks the ability).
 * @returns {string[]}
 */
export function persistentProblems(o, _ctx = {}) {
  const out = [];
  const p = o?.persistent;
  if (p == null) return out;
  if (!isObj(p)) return ["`persistent` must be an object"];
  const bad = msg => out.push(`persistent: ${msg}`);
  for (const k of Object.keys(p)) if (!PERSISTENT_FIELDS.includes(k)) bad(`unknown field "${k}"`);
  if (p.cost != null && !intIn(p.cost, 1, 10)) bad("`cost` must be an integer 1-10 (absent: the ability's own Persistent cost)");
  const keeps = keepList(p);
  if (!keeps.length || keeps.length > 2 || !keeps.every(k => PERSISTENT_KEEPS.includes(k))) {
    bad(`\`keep\` must be ${PERSISTENT_KEEPS.map(k => `"${k}"`).join(" | ")} or a list of one or two of them`);
  } else if (new Set(keeps).size !== keeps.length) bad("`keep` names a value twice");
  else if (keeps.includes("manual") && keeps.length > 1) bad("`keep: \"manual\"` stands alone");
  if (p.targets != null) {
    if (!PERSISTENT_TARGETS.includes(p.targets)) bad(`\`targets\` must be ${PERSISTENT_TARGETS.map(t => `"${t}"`).join(" | ")}`);
    else if (!keeps.includes("reroll")) bad("`targets` goes with `keep: \"reroll\"`");
  }
  if (p.note != null && !shortText(p.note)) bad(`\`note\` must be 1-${MAX_TEXT} characters without markup`);
  if (keeps.includes("manual") && p.note == null) bad("`keep: \"manual\"` needs a `note` (what the table does)");
  if (o.monster != null || o.npc != null) bad("Persistent is a hero rule: not with `monster` or `npc`");
  if (!(isStr(o.key) && o.key.startsWith("ability:"))) bad("belongs to an ability's overlay (ability:<dsid>)");
  const effects = Array.isArray(o.effects) ? o.effects : [];
  if (effects.some(e => e?.type === "summon" || e?.type === "zone")) bad("a summon or zone keeps itself with its own `upkeep`, not with `persistent`");
  if (keeps.includes("extend") && !effects.some(holdsUntil) && !isObj(o.automation?.aura)) {
    bad("`extend` needs a condition effect with `until` or an aura to hold");
  }
  return out;
}

/** `persistent` with its defaults: `keep` always a list, `targets` "recorded" for a re-roll (else null). */
function normalizePersistent(p) {
  const keep = [...new Set(keepList(p).filter(k => PERSISTENT_KEEPS.includes(k)))];
  return { cost: p.cost ?? null, keep, targets: keep.includes("reroll") ? (p.targets ?? "recorded") : null, note: p.note ?? null };
}

/** An effect with the overrides of one tier merged in (no tier: the effect as written). */
export function effectForTier(effect, tier) {
  if (!tier || !effect?.byTier?.[String(tier)]) return effect;
  const { byTier, ...rest } = effect;
  return { ...rest, ...byTier[String(tier)] };
}

/**
 * Defaults filled in (targets, tiers, when; trigger subject, range, line of effect, attacker on damage
 * events, step scope / targets / by; tracker ends; summon fields), deep-copied: what the runtime works
 * with. A trigger's `free` and `cost` stay absent when not given (the item decides at run time). A summon
 * always targets "self" and its actor uuids are mapped to compendium uuids (summonActorUuid).
 * Milestone 7: a zone always targets "self" with ZONE_DEFAULTS filled in; `gains` (always a list) get the
 * defaults of §1.1 (once, resource, amount, confirm; taker / dealer / user / notTypes / loe / states for the
 * events they go with) and `amountBy` sorted by amount, integers first (the planner takes the last present one).
 */
export function normalizeOverlay(overlay, source = null) {
  const o = JSON.parse(JSON.stringify(overlay));
  if (source) o.source = source;
  o.effects = (o.effects ?? []).map(normalizeEffect);
  // Milestone 7: event gains of a class feature's overlay.
  o.gains = (Array.isArray(o.gains) ? o.gains : []).map(normalizeGain);
  o.config ??= [];
  o.choices ??= [];
  o.triggers = (o.triggers ?? []).map(t => ({
    subject: "self", range: "ability", loe: true, require: {},
    // `attacker` is valid on damage.* events only (rule 3), so only they get the default.
    ...(t.event?.startsWith("damage.") ? { attacker: "any" } : {}),
    ...t,
    steps: (t.steps ?? []).map(s => ({
      ...s,
      ...(s.type === "potency" ? { scope: s.scope ?? "all" } : {}),
      ...(s.type === "use" ? { targets: s.targets ?? "subject" } : {}),
      ...(s.type === "freeStrike" ? { by: s.by ?? "subject" } : {}),
    })),
  }));
  o.trackers = (o.trackers ?? []).map(k => ({ endPrevious: true, endOnSourceDying: false, ...k }));
  // Milestone 9: Persistent upkeep (keep always a list).
  if (isObj(o.persistent)) o.persistent = normalizePersistent(o.persistent);
  return o;
}

/**
 * One effect with its defaults: summons and zones as below; `targets: "targets"`; Milestone 9: `pick.count` 1 and
 * `pick.of` "self", a teleport `boost.per` 1, a modifier `mode` "add".
 */
function normalizeEffect(e) {
  if (e?.type === "summon") return normalizeSummon(e);
  if (e?.type === "zone") return normalizeZone(e);
  const out = { targets: "targets", ...e };
  if (isObj(out.pick)) out.pick = { count: 1, of: "self", ...out.pick };
  if (out.type === "teleport" && isObj(out.boost)) out.boost = { per: 1, ...out.boost };
  if (out.type === "modifier") out.mode ??= "add";
  return out;
}

/** A summon effect with SUMMON_DEFAULTS filled in, `targets: "self"` and compendium actor uuids. */
function normalizeSummon(e) {
  const out = { ...SUMMON_DEFAULTS, lasts: [...SUMMON_DEFAULTS.lasts], ...e, targets: "self" };
  if (Array.isArray(out.actors)) out.actors = out.actors.map(a => (isObj(a) ? { ...a, uuid: summonActorUuid(a.uuid) ?? a.uuid } : a));
  return out;
}

/** A zone effect with ZONE_DEFAULTS filled in (arrays copied) and `targets: "self"` (Milestone 7). */
function normalizeZone(e) {
  return {
    ...ZONE_DEFAULTS,
    zoneEvents: [...ZONE_DEFAULTS.zoneEvents], exceptKeywords: [...ZONE_DEFAULTS.exceptKeywords],
    exceptMonsters: [...ZONE_DEFAULTS.exceptMonsters], lasts: [...ZONE_DEFAULTS.lasts],
    ...e, targets: "self",
  };
}

/** djb2 hash of an overlay's content (dev drift and detached-entry stamps). */
export function overlayHash(overlay) {
  const { source, ...rest } = overlay ?? {};
  const text = JSON.stringify(rest);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Compare two semver strings: >0 when a is newer. */
export function compareVersions(a, b) {
  const pa = String(a ?? "0.0.0").split(".").map(Number);
  const pb = String(b ?? "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

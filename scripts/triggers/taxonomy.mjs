/**
 * Trigger vocabulary (Milestone 5, docs/M5-DESIGN.md §1.1). Pure data: no imports, no Foundry globals,
 * so library/schema.mjs and the library's node tooling can import it by path.
 */
export const TRIGGER_EVENTS = Object.freeze([
  "damage.before",   // A1: the subject is about to take damage (hold before the write)
  "damage.after",    // A2: the subject took damage (> 0 after immunity)
  "roll.before",     // D:  the subject is about to make an ability roll for a damage-dealing ability
  "turn.start",      // H:  the subject's turn starts (turn-order.mjs; no wave-2 content)
  "turn.end",        // H:  the subject's turn ended
  "forced.before",   // G:  the subject is about to be force-moved (DSCT gate; no wave-2 content)
  "move.before",     // F:  the subject's token is about to move (core movement; no wave-2 content)
]);
/** When the engine evaluates an event kind. */
export const EVENT_PHASE = Object.freeze({
  "damage.before": "hold", "damage.after": "after", "roll.before": "preRoll",
  "turn.start": "turn", "turn.end": "turn", "forced.before": "gate", "move.before": "gate",
});
/** Who the event's subject must be, seen from the reactor (token dispositions, DSM:6679-6695). */
export const SUBJECTS = Object.freeze(["self", "ally", "selfOrAlly", "enemy", "creature", "selfOrCreature"]);
/** Who the event's source must be, seen from the reactor ("any": no check; "creature": a source actor exists). */
export const ATTACKERS = Object.freeze(["any", "creature", "enemy"]);
export const SUBJECT_TYPES = Object.freeze(["hero", "npc"]);
export const STEP_TYPES = Object.freeze(["halve", "potency", "edge", "use", "freeStrike", "takeTurnNext", "note"]);
/** When a step takes effect. "hold"/"preRoll" steps change the pending event; the others run afterwards. */
export const STEP_PHASE = Object.freeze({
  halve: "hold", potency: "hold", edge: "preRoll", use: "after", freeStrike: "after", takeTurnNext: "turn", note: "after",
});
/** Step types an event kind may carry. */
export const EVENT_STEPS = Object.freeze({
  "damage.before": ["halve", "potency", "use", "freeStrike", "note"],
  "damage.after": ["use", "freeStrike", "note"],
  "roll.before": ["edge", "note"],
  "turn.start": ["use", "note"],
  // Hesitation is Weakness only (turn-order.mjs runHiw): a turn.end trigger takes the next turn (schema).
  "turn.end": ["takeTurnNext", "note"],
  "forced.before": ["note"],
  "move.before": ["use", "note"],
});
/** "none": no preset target; for an item whose own target type is "self", the reactor's own token (§3.7). */
export const USE_TARGETS = Object.freeze(["subject", "source", "none"]);
export const FREE_STRIKE_BY = Object.freeze(["subject", "reactor"]);
export const POTENCY_SCOPES = Object.freeze(["all", "one"]);
export const RANGE_WORDS = Object.freeze(["ability", "unlimited"]);
export const TRACKER_ON_ZERO = Object.freeze(["retarget"]);
/** `require` keys and the events they may be used on. */
export const REQUIRE_KEYS = Object.freeze({
  keywords: ["damage.before", "damage.after"],          // source ability has all of these keywords
  fromAbility: ["damage.before", "damage.after"],       // the damage comes from an ability card (not external, not synthetic)
  damaging: ["roll.before"],                            // the rolled ability has a damage power roll effect
  subjectType: TRIGGER_EVENTS,                          // "hero" | "npc"
  notStartedByThis: ["turn.end"],                       // the subject did not start that turn through this ability
  meleeReach: ["damage.before", "damage.after"],        // a source ability that also has the "ranged" keyword counts only
                                                        // when source-to-subject distance <= its melee distance (review rules-ux 14)
  recoveries: TRIGGER_EVENTS,                           // the reactor has at least this many Recoveries (integer 1..3)
});
export const OUTCOMES = Object.freeze(["used", "declined", "timedOut", "noAnswer", "cancelled", "closed", "moot", "error"]);
export const LIMITS = Object.freeze({ triggers: 4, trackers: 2, steps: 6, keywords: 8, spendCost: 5, cost: 10 });
export const BUDGET_FLAG = "triggerBudget";
/**
 * A note step that stands for a real effect done by hand (`effect: true`, e.g. Unearthly Reflexes' shift): it
 * keeps a reaction worth offering when its halving is moot (halving never stacks, C16).
 */
export const effectNote = s => s?.type === "note" && s.effect === true;
/** A step that makes a reaction worth offering by itself (any step but a plain note). */
export const realStep = s => s?.type !== "note" || effectNote(s);
/** i18n key suffix of an event kind ("damage.before" -> "damageBefore"). */
export const eventKey = kind => kind.replace(/\.(\w)/, (_m, c) => c.toUpperCase());

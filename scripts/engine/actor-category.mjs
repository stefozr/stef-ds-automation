/**
 * Modes by creature type (Milestone 8, docs/M8-DESIGN.md §4.2-§4.3). The world setting `modeByActorType` (WP-D) holds
 * one mode per TARGET category (`inherit` | `auto` | `prompt` | `manual`); a value other than `inherit` replaces the
 * feature mode for rows on such a target (as `heroOverride` did for heroes), `off` stays a feature-level switch.
 *
 * The category of a target, first match: a summon of ours (token flag `stef-ds-automation.summon`), a minion, a retainer,
 * a hero, an NPC, an object; else null (no override). `heroOverride` stays readable as the heroes' fallback while
 * `modeByActorType.hero` is `inherit` (D22, until 0.11.0).
 *
 * Pure on its arguments apart from the setting and uuid reads; no Foundry access at import (settings.mjs imports
 * ACTOR_CATEGORIES), and no import of settings.mjs (that would be a cycle).
 * i18n keys: none (the menu's DSAUTO.Menu.ActorType.* labels belong to WP-D).
 */
import { MODULE_ID } from "../constants.mjs";

export const ACTOR_CATEGORIES = Object.freeze(["hero", "retainer", "npc", "minion", "summon", "object"]);

const OVERRIDES = new Set(["auto", "prompt", "manual"]);
const MODE_RANK = { auto: 0, prompt: 1, manual: 2 };

/** The setting key of an op kind's feature mode (plan.mjs featureMode, api.modeFor). */
export function featureSettingKey(kind) {
  if (kind === "damage") return "damageMode";
  if (kind === "heal" || kind === "temp" || kind === "healing") return "healingMode";
  if (kind === "forced" || kind === "teleport") return "forcedMovementMode";
  if (kind === "resource") return "resourceMode";
  if (kind === "summon") return "summonMode";
  if (kind === "zone") return "zoneMode";
  if (kind === "ongoing") return "ongoingDamage";
  if (kind === "zoneDamage") return "zoneDamage";
  if (kind === "gain") return "resourceGains";
  return "conditionsMode";
}

/** A world setting of ours, undefined when it is not registered (yet). */
function readSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (_err) {
    return undefined;
  }
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/**
 * The category of a target actor (its token when known: summons are marked on the token).
 * @param {Actor|null} actor
 * @param {string|null} [tokenUuid]
 * @returns {"hero"|"retainer"|"npc"|"minion"|"summon"|"object"|null}
 */
export function actorCategory(actor, tokenUuid = null) {
  const token = lookup(tokenUuid) ?? actor?.token ?? null;
  actor ??= token?.actor ?? null;
  if (!actor) return null;
  if (token?.flags?.[MODULE_ID]?.summon) return "summon";
  try {
    if (actor.isMinion) return "minion";
  } catch (_err) { /* actors without the getter */ }
  if (actor.type === "retainer") return "retainer";
  if (actor.type === "hero") return "hero";
  if (actor.type === "npc") return "npc";
  if (actor.type === "object") return "object";
  return null;
}

/**
 * The per-type override for an actor, or "inherit". Falls back to `heroOverride` for heroes while
 * `modeByActorType.hero` is "inherit".
 */
export function typeOverride(actor, tokenUuid = null, map = readSetting("modeByActorType"), legacyHero = readSetting("heroOverride")) {
  const category = actorCategory(actor, tokenUuid);
  if (!category) return "inherit";
  const own = map?.[category];
  if (OVERRIDES.has(own)) return own;
  if (category === "hero" && OVERRIDES.has(legacyHero)) return legacyHero;
  return "inherit";
}

/** A feature mode with a type override applied: `off` stays off, an override replaces auto / prompt / manual. */
export function withTypeOverride(mode, override) {
  if (mode === "off" || !OVERRIDES.has(override)) return mode;
  return override;
}

/** The more restrictive of two modes (auto < prompt < manual); `inherit` / unknown values never loosen. */
export function stricterMode(a, b) {
  if (!(b in MODE_RANK)) return a;
  if (!(a in MODE_RANK)) return b;
  return MODE_RANK[b] > MODE_RANK[a] ? b : a;
}

/**
 * `api.modeFor(actorOrToken, kind)` (WP-D wires it): the category of a creature and the mode its rows of that kind get
 * from the world settings (feature mode, then the type override). Read-only, any client; the player-card cap and
 * per-card downgrades (private card, ambiguous tier) are not included.
 * @returns {{category: string|null, mode: string}}
 */
export function modeFor(actorOrToken, kind = "damage") {
  let doc = actorOrToken;
  if (typeof doc === "string") doc = lookup(doc);
  const isToken = doc?.documentName === "Token" || (!!doc?.actor && doc?.documentName !== "Actor" && !doc?.system?.stamina);
  const actor = isToken ? doc.actor : doc;
  const tokenUuid = isToken ? doc.uuid : null;
  const base = readSetting(featureSettingKey(kind)) ?? "auto";
  const override = typeOverride(actor, tokenUuid);
  return { category: actorCategory(actor, tokenUuid), mode: withTypeOverride(base, override) };
}

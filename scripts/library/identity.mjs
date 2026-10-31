/**
 * Identity keys of the ability library (Milestone 4).
 *   itemKey    `${item.type}:${dsid}` (Combat Tools' enhanced packs use the same key)
 *   monsterKey the actor's pinned key (flag), its compendium source, or a slug of its name without " (N)";
 *              NPC actors carry no `_dsid` of their own and monster ability dsids repeat across monsters
 *   fullKey    `${itemKey}@${monsterKey}` for NPC abilities, else the item key
 */
import { MODULE_ID } from "../constants.mjs";

/** The item's dsid: `system._dsid`, else the system's slug of its name (DrawSteelItem#dsid). */
export function itemDsid(item) {
  const dsid = item?.system?._dsid || item?.dsid || null;
  if (dsid) return String(dsid);
  return item?.name ? slug(item.name) : null;
}

export function itemKey(item) {
  const dsid = itemDsid(item);
  return item?.type && dsid ? `${item.type}:${dsid}` : null;
}

/** Same rule as the system's generateDSID: lowercase words joined by dashes. */
export function slug(name) {
  const cls = globalThis.CONFIG?.Item?.documentClass;
  if (typeof cls?.generateDSID === "function") {
    try {
      return cls.generateDSID(String(name));
    } catch (_err) { /* fall through */ }
  }
  return String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The world actor behind an unlinked token's synthetic actor, or null. Foundry v14 has `TokenDocument#baseActor`
 * but no `Actor#baseActor` (M6 live run 2026-10-07): read it through the token, else by id (a synthetic actor keeps
 * its base actor's id).
 */
export function baseActorOf(actor) {
  if (!actor?.isToken) return null;
  try {
    return actor.token?.baseActor ?? game.actors?.get?.(actor.id) ?? null;
  } catch (_err) {
    return null;
  }
}

export function monsterKey(actor) {
  if (!actor || actor.type !== "npc") return null;
  const pinned = actor.getFlag?.(MODULE_ID, "monsterKey") ?? actor.flags?.[MODULE_ID]?.monsterKey;
  if (pinned) return String(pinned);
  const source = actor._stats?.compendiumSource ?? baseActorOf(actor)?._stats?.compendiumSource ?? null;
  if (source) return source;
  return actor.name ? slug(String(actor.name).replace(/\s\(\d+\)$/, "")) : null;
}

/** Every key a monster may be known by (overlays list one or more of them). */
export function monsterKeys(actor) {
  if (!actor || actor.type !== "npc") return [];
  const keys = new Set();
  // A pinned key (medkit) replaces the automatic ones: it is set when they match the wrong monster.
  const pinned = actor.getFlag?.(MODULE_ID, "monsterKey") ?? actor.flags?.[MODULE_ID]?.monsterKey;
  if (pinned) return [String(pinned)];
  const source = actor._stats?.compendiumSource ?? baseActorOf(actor)?._stats?.compendiumSource ?? null;
  if (source) keys.add(source);
  if (actor.name) keys.add(slug(String(actor.name).replace(/\s\(\d+\)$/, "")));
  return [...keys];
}

export function fullKey(item, actor = item?.actor) {
  const key = itemKey(item);
  if (!key) return null;
  const mk = monsterKey(actor);
  return mk ? `${key}@${mk}` : key;
}

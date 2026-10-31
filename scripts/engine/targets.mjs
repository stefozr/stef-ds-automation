/** Target records: `{key, tokenUuid, actorUuid, name, img}` keyed by target key. */
import { targetKey } from "./keys.mjs";

/** Portrait for a token: Tokenizer stores the art as the dynamic-ring subject texture. */
function tokenImage(doc) {
  const ring = doc?.ring;
  const subject = ring?.enabled ? ring?.subject?.texture : null;
  return subject || doc?.texture?.src || doc?.actor?.img || null;
}

/** Build a target record from a TokenDocument. */
export function targetFromTokenDoc(doc, extra = {}) {
  if (!doc?.actor) return null;
  return {
    key: targetKey(doc.uuid),
    tokenUuid: doc.uuid,
    actorUuid: doc.actor.uuid,
    name: doc.name ?? doc.actor.name,
    img: tokenImage(doc),
    ...extra,
  };
}

/** Build target records from token uuids (unknown or actorless tokens are dropped). */
export function targetsFromTokenUuids(uuids, extra = {}) {
  const out = {};
  for (const uuid of uuids ?? []) {
    let doc = null;
    try {
      doc = fromUuidSync(uuid);
    } catch (_err) { /* compendium or invalid */ }
    const t = targetFromTokenDoc(doc, extra);
    if (t) out[t.key] = t;
  }
  return out;
}

/** A token document for an actor uuid: the synthetic actor's own token, else its first active token. */
export function tokenDocForActorUuid(actorUuid) {
  let actor = null;
  try {
    actor = fromUuidSync(actorUuid);
  } catch (_err) {
    return null;
  }
  if (!actor) return null;
  if (actor.token) return actor.token;
  const tokens = actor.getActiveTokens?.(true, true) ?? [];
  return tokens[0] ?? null;
}

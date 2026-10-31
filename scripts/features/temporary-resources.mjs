/** Temporary heroic-resource credits are consumed before permanent points. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { withResourceChain } from "../resources/world-resources.mjs";
const path = `flags.${MODULE_ID}.temporaryResources`;
const clone = v => JSON.parse(JSON.stringify(v ?? {}));
export async function trackTemporaryResource(actor, message, op, amount) {
  const credits = clone(actor.flags?.[MODULE_ID]?.temporaryResources);
  const id = `${message.id}-${op.opId}`;
  credits[id] = { remaining: Math.max(0, amount), combatId: game.combat?.id, end: op.featureEnd };
  await actor.update({ [path]: credits }, { [MODULE_ID]: { internal: true } });
  return id;
}
export async function removeTemporaryResources(actor, ids = null) {
  if (!actor?.system?.hero?.primary || (ids && !ids.length)) return { status: OP_STATUS.UNDONE, finalAmount: 0 };
  return withResourceChain(actor.uuid, async () => {
    const credits = clone(actor.flags?.[MODULE_ID]?.temporaryResources);
    let remaining = 0;
    for (const [id, c] of Object.entries(credits)) {
      if (ids && !ids.includes(id)) continue;
      remaining += Math.max(0, c.remaining); delete credits[id];
    }
    if (!remaining && !ids) return;
    await actor.update({ "system.hero.primary.value": Number(actor.system.hero.primary.value) - remaining, [path]: credits }, { [MODULE_ID]: { internal: true } });
    return { status: OP_STATUS.UNDONE, finalAmount: remaining };
  });
}
export function registerTemporaryResources() {
  Hooks.on("preUpdateActor", (actor, changes, options) => {
    if (options?.[MODULE_ID]?.internal) return;
    const current = Number(actor.system?.hero?.primary?.value);
    const raw = changes["system.hero.primary.value"] ?? changes.system?.hero?.primary?.value;
    if (raw == null || !Number.isFinite(current) || Number(raw) >= current) return;
    let spend = current - Number(raw);
    const credits = clone(actor.flags?.[MODULE_ID]?.temporaryResources);
    if (!Object.keys(credits).length) return;
    for (const c of Object.values(credits)) {
      const used = Math.min(spend, Math.max(0, Number(c.remaining) || 0));
      c.remaining -= used; spend -= used;
    }
    changes[path] = credits;
  });
}

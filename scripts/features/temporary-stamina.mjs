/** Dependent effects follow their accepted temporary-Stamina pool, including replacement. */
import { MODULE_ID } from "../constants.mjs";
import { applyingMessageFor, isActiveGM } from "../engine/engine.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { distanceSquares, relation, tokenOnScene } from "../triggers/eligibility.mjs";
import { error } from "../log.mjs";
const list = c => c?.contents ?? [...(c ?? [])];
const chains = new Map();
export function temporarySnapshot(actor) {
  return { value: Number(actor?.system?.stamina?.temporary ?? 0), effects: list(actor?.effects).filter(e => e.flags?.[MODULE_ID]?.temporaryStamina).map(e => e.toObject()) };
}
export async function reconcileTemporaryStamina(actor, before) {
  if (!actor || !before?.effects?.length) return [];
  const after = Number(actor.system?.stamina?.temporary ?? 0);
  if (after === before.value) return [];
  const expired = [];
  for (const snapshot of before.effects) {
    const current = actor.effects.get(snapshot._id);
    if (!current || current.flags?.[MODULE_ID]?.messageId !== snapshot.flags?.[MODULE_ID]?.messageId) continue;
    if (after <= 0 || after > before.value) expired.push(snapshot);
    else await current.update({ [`flags.${MODULE_ID}.temporaryStamina.remaining`]: after });
  }
  if (expired.length) await actor.deleteEmbeddedDocuments("ActiveEffect", expired.map(e => e._id), { [MODULE_ID]: { temporaryExpiry: true } });
  return expired;
}
export async function restoreTemporaryEffects(actor, op) {
  if (!actor || !op.temporaryBefore || actor.system.stamina.temporary !== op.temporaryBefore.value) return;
  const restore = (op.temporaryExpired ?? []).filter(e => !actor.effects.has(e._id));
  if (restore.length) await actor.createEmbeddedDocuments("ActiveEffect", restore, { keepId: true });
  for (const snapshot of op.temporaryBefore.effects ?? []) {
    const current = actor.effects.get(snapshot._id);
    if (current?.flags?.[MODULE_ID]?.messageId === snapshot.flags?.[MODULE_ID]?.messageId) await current.update({ [`flags.${MODULE_ID}.temporaryStamina`]: snapshot.flags[MODULE_ID].temporaryStamina });
  }
}
export function temporaryExplosionOps(actor, expired, causeOpId) {
  const token = tokenOnScene(actor, actor.token?.parent?.id ?? globalThis.canvas?.scene?.id);
  const targets = {}, ops = {};
  if (!token) return { targets, ops };
  for (const [n, effect] of (expired ?? []).entries()) {
    const item = fromUuidSync(effect.origin ?? "");
    if (item?.system?._dsid !== "the-green-defends-its-servants") continue;
    for (const enemy of [...(token.parent.tokens ?? [])]) {
      if (!enemy.actor || relation(token, enemy) !== "enemy" || distanceSquares(token, enemy) > 5) continue;
      const target = targetFromTokenDoc(enemy); targets[target.key] = target;
      const id = `temporary-burst-${causeOpId}-${n}-${enemy.id}`;
      ops[id] = { opId: id, kind: "damage", lib: true, amount: 10, type: "", ignoredImmunities: [], aoe: true, mode: "auto", status: "pending", order: 999, targetKeys: [target.key], temporaryCauseOpId: causeOpId, label: item.name };
    }
  }
  return { targets, ops };
}
export function registerTemporaryStamina() {
  const deadline = (effect, options, snapshot = effect.toObject()) => {
    if (!isActiveGM() || !effect.flags?.[MODULE_ID]?.temporaryStamina || options?.[MODULE_ID]?.temporaryExpiry) return;
    const actor = effect.parent, item = fromUuidSync(effect.origin ?? "");
    if (item?.system?._dsid !== "the-green-defends-its-servants" || !(actor.system.stamina.temporary > 0)) return;
    const run = (chains.get(actor.uuid) ?? Promise.resolve()).then(async () => {
      const before = { value: actor.system.stamina.temporary, effects: [snapshot] };
      await actor.update({ "system.stamina.temporary": 0 });
      await postExpiry(actor, before, before.effects);
    });
    chains.set(actor.uuid, run.catch(e => error("temporaryStamina.deadline", e)));
  };
  Hooks.on("deleteActiveEffect", (effect, options) => deadline(effect, options));
  Hooks.on("preUpdateActiveEffect", (effect, changes, options) => {
    if (effect.flags?.[MODULE_ID]?.temporaryStamina && (changes.disabled === true || changes["duration.expired"] === true || changes.duration?.expired === true)) {
      options[MODULE_ID] ??= {}; options[MODULE_ID].temporaryEffectBefore = effect.toObject();
    }
  });
  Hooks.on("updateActiveEffect", (effect, _changes, options) => {
    const before = options?.[MODULE_ID]?.temporaryEffectBefore; if (before) deadline(effect, options, before);
  });
  Hooks.on("preUpdateActor", (actor, _changes, options) => {
    if (!isActiveGM()) return;
    options[MODULE_ID] ??= {};
    options[MODULE_ID].temporaryBefore = temporarySnapshot(actor);
  });
  Hooks.on("updateActor", (actor, _changes, options) => {
    if (!isActiveGM() || applyingMessageFor(actor.uuid)) return;
    const before = options?.[MODULE_ID]?.temporaryBefore;
    if (!before?.effects?.length || before.value === actor.system.stamina.temporary) return;
    const run = (chains.get(actor.uuid) ?? Promise.resolve()).then(async () => {
      const expired = await reconcileTemporaryStamina(actor, before);
      if (!expired.length) return;
      await postExpiry(actor, before, expired);
    });
    chains.set(actor.uuid, run.catch(e => error("temporaryStamina.expiry", e)));
  });
}

async function postExpiry(actor, before, expired) {
  const { postRecordCard } = await import("../engine/synthetic.mjs");
  const token = tokenOnScene(actor, actor.token?.parent?.id ?? globalThis.canvas?.scene?.id);
  if (!token) return;
  const target = targetFromTokenDoc(token), burst = temporaryExplosionOps(actor, expired, "expiry");
  await postRecordCard({ title: game.i18n.localize("DSAUTO.Aura.TemporaryExpired"), sourceActor: actor, targets: { ...burst.targets, [target.key]: target },
    ops: { expiry: { opId: "expiry", kind: "temporaryExpiry", status: "applied", mode: "manual", targetKeys: [target.key], temporaryBefore: before, temporaryExpired: expired, afterTemporary: actor.system.stamina.temporary, seq: 1 }, ...burst.ops }, user: game.user });
}

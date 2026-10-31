/** Rule helpers whose effects require a choice or a tracked temporary allocation. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { askFeature } from "./engine.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { distanceSquares } from "../triggers/eligibility.mjs";
import { positionOf, samePosition } from "../delegation/teleport.mjs";

export async function prepareSpecial(item, rule, event, tokens) {
  let effects = rule.effects;
  if (rule.special === "thunderMother") {
    const token = tokens[0];
    if (!token) return null;
    const answer = await askFeature(item, rule, { kind: "performanceAttack", tokens: [token] });
    if (answer?.messageId) {
      const ids = [...(item.actor.flags?.[MODULE_ID]?.performanceTargets?.[item.system._dsid] ?? []), token.uuid];
      await item.actor.update({ [`flags.${MODULE_ID}.performanceTargets.${item.system._dsid}`]: ids });
    }
    return null;
  }
  if (rule.special === "immunityChoice") {
    const types = ["acid", "cold", "corruption", "fire", "lightning", "poison", "sonic"];
    const existing = item.flags?.[MODULE_ID]?.wardDamageType;
    const answer = types.includes(existing) ? { ids: [existing] } : await askFeature(item, rule, { kind: "choice", choices: types.map(id => ({ id, name: id })) });
    const type = answer?.ids?.find(id => types.includes(id));
    if (!type) return null;
    if (existing !== type) await item.update({ [`flags.${MODULE_ID}.wardDamageType`]: type });
    effects = [{ id: "immunity", type: "modifier", key: `system.damage.immunities.${type}`, value: "@R", mode: "add" }];
  }
  return { effects, tokens };
}

export async function applyFeatureMove(message, res, op) {
  const item = fromUuidSync(op.featureItemUuid ?? res.abilityUuid);
  const doc = fromUuidSync(res.targets[op.targetKeys[0]]?.tokenUuid ?? "");
  if (!item || !doc) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const startPos = positionOf(doc);
  const answer = await askFeature(item, { id: op.ruleId, label: op.label }, { kind: "destination", tokens: [doc], limit: op.distance });
  const pos = answer?.position;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  const source = op.moveStyle === "shift" ? doc : fromUuidSync(res.sourceTokenUuid ?? "");
  if (!source || source.parent?.id !== doc.parent?.id || distanceSquares(source, { x: pos.x, y: pos.y, width: doc.width, height: doc.height, parent: doc.parent }) > op.distance) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  if (samePosition(startPos, pos)) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  const size = Number(doc.parent.grid.size) || 100;
  const finalPos = { x: pos.x, y: pos.y, elevation: doc.elevation };
  const box = t => ({ x0: t.x, y0: t.y, x1: t.x + t.width * size, y1: t.y + t.height * size });
  const dest = box({ ...finalPos, width: doc.width, height: doc.height });
  const bounds = doc.parent.dimensions?.sceneRect;
  if (bounds && (dest.x0 < bounds.x || dest.y0 < bounds.y || dest.x1 > bounds.x + bounds.width || dest.y1 > bounds.y + bounds.height)) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  for (const t of doc.parent.tokens) {
    if (t.id === doc.id) continue;
    const b = box(t);
    if (dest.x0 < b.x1 && dest.x1 > b.x0 && dest.y0 < b.y1 && dest.y1 > b.y0) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  }
  if (op.moveStyle === "shift") {
    const center = p => ({ x: p.x + doc.width * size / 2, y: p.y + doc.height * size / 2 });
    const backend = CONFIG.Canvas?.polygonBackends?.move;
    if (backend?.testCollision?.(center(startPos), center(finalPos), { type: "move", mode: "any" })) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  }
  await doc.update(finalPos, { movement: { [doc.id]: { waypoints: [{ ...finalPos, action: op.moveStyle === "shift" ? "shift" : "teleport" }] } }, [MODULE_ID]: { internal: true } });
  return { status: OP_STATUS.APPLIED, moves: [{ tokenUuid: doc.uuid, startPos, finalPos }] };
}

export async function pickFeatureDestination(payload) {
  const doc = fromUuidSync(payload.tokens?.[0] ?? "");
  if (!doc?.object || doc.parent.id !== globalThis.canvas?.scene?.id) return {};
  const size = Number(doc.parent.grid.size) || 100;
  const region = await canvas.regions.placeRegion({ name: payload.label, shapes: [{ type: "rectangle", x: 0, y: 0,
    width: doc.width * size, height: doc.height * size, anchorX: 0, anchorY: 0, gridBased: true }],
    visibility: CONST.REGION_VISIBILITY.ALWAYS, color: game.user.color, displayMeasurements: true });
  if (!region) return {};
  try {
    const shape = region.shapes[0];
    const safe = await foundry.applications.api.DialogV2.confirm({ window: { title: payload.label },
      content: `<p>${game.i18n.localize("DSAUTO.Feature.SafeDestination")}</p>`, rejectClose: false });
    return safe ? { position: { x: shape.x, y: shape.y, elevation: doc.elevation } } : {};
  } finally { await region.delete(); }
}

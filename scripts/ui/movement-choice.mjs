/**
 * Local-only canvas preview; the answer never writes a token or trusts a client undo log. Milestone 9 (D6): a teleport
 * with a boost offer adds a number input (`boost` in the answer; the GM checks it, engine/forced.mjs boostSpend).
 * 0.16.0: Apply stays disabled until a square (or a vertical distance, or the teleport destination) is chosen, and the
 * squares left are shown. The answer carries `by`, the user who gave it (set by the asking GM).
 * 0.17.0: forced moves come here only without Combat Tools (with it they run in its own picker,
 * delegation/forced-picker.mjs); the movement select is shown only when there is a choice.
 */
import { QUERY_PROMPT } from "../constants.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { registerPromptType, routePrompt } from "../relay/prompt-router.mjs";
import { positionOf, samePosition } from "../delegation/teleport.mjs";
import { distanceSquares } from "../triggers/eligibility.mjs";

export async function handleMovementChoice(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  const doc = fromUuidSync(payload.tokenUuid), chooser = fromUuidSync(payload.chooserActorUuid);
  if (!chooser?.isOwner) throw new Error("DSAUTO.Relay.Denied");
  if (!doc?.object || doc.parent.id !== canvas.scene?.id || (!game.user.isGM && (!doc.object.visible || doc.hidden))) return { unavailable: true };
  const G = Number(doc.parent.grid.size) || 100, start = positionOf(doc);
  // Milestone 9 (D6): a teleport boost lets the click reach `max * per` squares further (the GM checks the spend).
  const boost = validBoost(payload.boost) && payload.kind === "teleport" ? payload.boost : null;
  const reach = Number(payload.distance) + (boost ? boost.max * boost.per : 0);
  const points = [];
  let destination = null, dialog, timer, timedOut = false;
  const refresh = () => {
    const root = dialog?.element;
    if (!root?.querySelector) return;
    const vertical = Number(root.querySelector('[name="vertical"]')?.value ?? 0) || 0;
    const chosen = payload.kind === "teleport" ? !!destination : (points.length > 0 || vertical !== 0);
    const ok = root.querySelector('button[data-action="ok"]');
    if (ok) ok.disabled = !chosen;
    const left = root.querySelector(".ds-auto-remaining");
    if (left) left.textContent = game.i18n.format("DSAUTO.Movement.Remaining", { n: Math.max(0, Number(payload.distance) - points.length) });
  };
  const graphics = new PIXI.Graphics();
  graphics.eventMode = "static";
  graphics.hitArea = canvas.dimensions.rect;
  canvas.stage.addChild(graphics);
  const draw = () => {
    graphics.clear(); graphics.lineStyle(3, 0x77ccff, 0.9);
    graphics.moveTo(start.x + doc.width * G / 2, start.y + doc.height * G / 2);
    for (const point of points) graphics.lineTo(point.x * G + doc.width * G / 2, point.y * G + doc.height * G / 2);
    if (destination) graphics.drawRect(destination.x, destination.y, doc.width * G, doc.height * G);
    refresh();
  };
  const click = event => {
    const button = event.button ?? event.data?.button ?? 0;
    if (button === 2) { points.pop(); destination = null; draw(); return; }
    if (button !== 0) return;
    event.stopPropagation?.();
    const pos = event.getLocalPosition?.(canvas.stage) ?? event.data?.getLocalPosition(canvas.stage);
    if (!pos) return;
    const cell = { x: Math.floor(pos.x / G), y: Math.floor(pos.y / G) };
    if (payload.kind === "teleport") {
      const proposal = { x: cell.x * G, y: cell.y * G, elevation: doc.elevation };
      if (distanceSquares(doc, { ...proposal, width: doc.width, height: doc.height, parent: doc.parent }) > reach) return;
      destination = proposal;
    } else {
      const prev = points.at(-1) ?? { x: start.x / G, y: start.y / G };
      if (Math.max(Math.abs(cell.x - prev.x), Math.abs(cell.y - prev.y)) !== 1 || points.length >= payload.distance) return;
      points.push(cell);
    }
    draw();
  };
  graphics.on("pointerdown", click);
  const escape = foundry.utils.escapeHTML;
  const movements = payload.movements ?? [];
  const remaining = payload.kind === "teleport" ? "" : `<p class="ds-auto-remaining"></p>`;
  // One movement: a hidden field (nothing to choose).
  const movementField = movements.length > 1 ? `<select name="movement">${movements.map(m => `<option value="${m}">${escape(m)}</option>`).join("")}</select>`
    : movements.length ? `<input type="hidden" name="movement" value="${escape(movements[0])}">` : "";
  const content = `<p>${game.i18n.localize("DSAUTO.Movement.Instructions")}</p><p>${escape(payload.label)}: ${payload.distance}</p>${remaining}${movementField}${payload.vertical ? `<label>${game.i18n.localize("DSAUTO.Movement.Vertical")} <input name="vertical" type="number" min="-${payload.distance}" max="${payload.distance}" value="0"></label>` : ""}${boost ? `<p>${escape(boost.label ?? "")}</p><label>${escape(game.i18n.format("DSAUTO.Movement.Boost", { name: boost.name ?? "", max: boost.max }))} <input name="boost" type="number" min="0" max="${boost.max}" step="1" value="0"></label>` : ""}`;
  try {
    const answer = await foundry.applications.api.DialogV2.prompt({ window: { title: payload.label }, content, rejectClose: false,
      render: (_event, app) => {
        dialog = app; timer = setTimeout(() => { timedOut = true; void app.close(); }, 120_000);
        app.element?.addEventListener?.("input", refresh); app.element?.addEventListener?.("change", refresh); refresh();
      },
      ok: { label: "DSAUTO.Card.Apply", callback: (_event, button) => ({ destination, path: [...points], movement: button.form.elements.namedItem("movement")?.value,
        verticalDistance: Number(button.form.elements.namedItem("vertical")?.value ?? 0),
        ...(boost ? { boost: Math.max(0, Math.floor(Number(button.form.elements.namedItem("boost")?.value ?? 0)) || 0) } : {}) }) } });
    return timedOut ? { unavailable: true } : answer && samePosition(start, positionOf(doc)) ? answer : { declined: true };
  } finally { clearTimeout(timer); graphics.off("pointerdown", click); graphics.destroy(); if (dialog?.rendered) await dialog.close(); }
}

/** Milestone 9 (D6): a payload's boost offer `{max 1-20, per 1-10, label?, name?}`, or none. */
function validBoost(b) {
  return !!b && typeof b === "object" && Number.isInteger(b.max) && b.max >= 1 && b.max <= 20 && Number.isInteger(b.per) && b.per >= 1 && b.per <= 10
    && (b.label == null || (typeof b.label === "string" && b.label.length <= 200)) && (b.name == null || (typeof b.name === "string" && b.name.length <= 80));
}

export async function askMovementChoice(message, res, op, doc, { movements = [], distance = op.distance, vertical = false, boost = null } = {}) {
  const actor = op.kind === "teleport" ? doc.actor : fromUuidSync(res.sourceActorUuid ?? "");
  const author = message.author ?? game.users.get(res.authorUserId);
  const owners = actor?.type === "npc" ? [] : ownersOf(actor);
  const recipient = owners.find(u => u.id === author?.id) ?? owners[0] ?? game.users.activeGM;
  // Milestone 9 (D6): the mover's own name for its heroic resource ("Essence").
  const name = boost ? ((op.boost?.resource === "heroic" ? doc.actor?.system?.hero?.primary?.label : null) || game.i18n.localize(`DSAUTO.Entry.Resource.${op.boost?.resource ?? "heroic"}`)) : null;
  const payload = { type: "movementChoice", tokenUuid: doc.uuid, chooserActorUuid: actor?.uuid, kind: op.kind,
    movements, distance, vertical, label: op.label ?? res.abilityName ?? "Movement",
    ...(boost?.max > 0 ? { boost: { ...boost, name } } : {}) };
  const query = u => u?.isSelf ? routePrompt(payload, { user: game.user }) : u?.query(QUERY_PROMPT, payload, { timeout: 122_000 });
  // Who answered, as the asking GM knows it (a client's own `by` is overwritten).
  const tagged = (answer, u) => answer && typeof answer === "object" && !answer.unavailable && !answer.declined ? { ...answer, by: u?.id ?? null } : answer;
  try {
    const answer = await query(recipient);
    if (!answer?.unavailable) return tagged(answer, recipient) ?? { declined: true };
  } catch (_error) { /* Director takeover after timeout or disconnect */ }
  return recipient?.id !== game.users.activeGM?.id ? tagged(await query(game.users.activeGM), game.users.activeGM) : { declined: true };
}
export function registerMovementChoice() { registerPromptType("movementChoice", handleMovementChoice); }

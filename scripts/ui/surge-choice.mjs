import { wrap } from "../compat/lib-wrapper.mjs";
/**
 * Ask once before an original hit is written. The GM validates every returned allocation.
 * 0.17.0: one dialog for both spends: a dropdown per damage row (0 to 3 surges) and, for an effect a target resisted
 * by exactly one, "Potency +1 (2 surges)" (engine/surges.mjs potencySurgeable). The dialog keeps the total within the
 * hero's surges; the 3-surge cap covers damage only (M7 R17).
 */
import { QUERY_PROMPT, OP_STATUS } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { routePrompt, registerPromptType } from "../relay/prompt-router.mjs";
import { availableSurges, surgeActor, surgeDamage, MAX_SURGES, POTENCY_SURGE_COST, liveSurgeOps, potencySurgeable, potencySurgePatch } from "../engine/surges.mjs";
import { opLabel } from "../parts/view.mjs";
import { log } from "../log.mjs";

const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

/** The payload checks of `surgeChoice` (types and lengths; ownership is checked by the handler). */
export function validSurgeChoice(p) {
  if (!p || typeof p !== "object" || p.type !== "surgeChoice" || !str(p.actorUuid, 300) || !Number.isInteger(p.damage) || p.damage < 0) return false;
  const rows = Array.isArray(p.rows) && p.rows.length <= 50
    && p.rows.every(r => r && str(r.id, 300) && typeof r.name === "string" && r.name.length <= 200 && Number.isInteger(r.max) && r.max >= 0 && r.max <= MAX_SURGES);
  const potency = p.potency === undefined || (Array.isArray(p.potency) && p.potency.length <= 50
    && p.potency.every(r => r && str(r.id, 300) && typeof r.label === "string" && r.label.length <= 400));
  return rows && potency;
}

/** The dialog's markup: a select per damage row, a checkbox per potency row (the label wraps the box, full width). */
export function surgeChoiceContent(payload, available) {
  const escape = foundry.utils.escapeHTML ?? (v => String(v));
  const loc = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
  const damage = payload.rows.map(r => {
    const options = Array.from({ length: r.max + 1 }, (_v, n) => `<option value="${n}">${n}</option>`).join("");
    return `<div class="form-group"><label>${escape(r.name)}</label><div class="form-fields">
      <select name="${escape(r.id)}" data-surge-damage>${options}</select></div></div>`;
  }).join("");
  const potency = (payload.potency ?? []).map(r => `<label class="ds-auto-surge-potency"><input type="checkbox" name="${escape(r.id)}" data-surge-potency>
      <span>${escape(loc("DSAUTO.Surge.Potency", { cost: POTENCY_SURGE_COST, label: r.label }))}</span></label>`).join("");
  const intro = loc(payload.potency?.length ? "DSAUTO.Surge.AvailablePotency" : "DSAUTO.Surge.Available", { count: available, damage: payload.damage, cost: POTENCY_SURGE_COST });
  return `<p>${escape(intro)}</p>${damage}${potency}<p class="hint" data-surge-left></p>`;
}

/**
 * Keep the form within `available`: options and checkboxes that would spend more than is left are disabled, and the
 * line under the fields says how many are left.
 */
export function limitSurgeForm(form, available) {
  const selects = [...form.querySelectorAll("select[data-surge-damage]")];
  const boxes = [...form.querySelectorAll("input[data-surge-potency]")];
  const spent = () => selects.reduce((n, s) => n + (Number(s.value) || 0), 0) + boxes.filter(b => b.checked).length * POTENCY_SURGE_COST;
  const update = () => {
    const left = available - spent();
    for (const s of selects) {
      const own = Number(s.value) || 0;
      for (const o of s.options) o.disabled = Number(o.value) > own + left;
    }
    for (const b of boxes) b.disabled = !b.checked && left < POTENCY_SURGE_COST;
    const line = form.querySelector("[data-surge-left]");
    if (line) line.textContent = game.i18n.format("DSAUTO.Surge.Left", { count: left });
  };
  form.addEventListener("change", update);
  update();
}

export async function handleSurgeChoice(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  if (!validSurgeChoice(payload)) throw new Error("DSAUTO.Relay.BadRequest");
  const actor = fromUuidSync(payload.actorUuid);
  if (!actor?.isOwner) throw new Error("DSAUTO.Relay.Denied");
  const available = availableSurges(actor);
  const app = foundry.applications.api.DialogV2;
  let dialog;
  let timer;
  try {
    const result = await app.prompt({ window: { title: game.i18n.localize("DSAUTO.Surge.Choose"), icon: "fa-solid fa-bolt" },
      classes: ["ds-auto-surge-dialog"],
      content: surgeChoiceContent(payload, available),
      rejectClose: false,
      render: (_event, application) => {
        dialog = application;
        timer = setTimeout(() => application.close(), 30_000);
        const root = application.element;
        const form = root?.matches?.("form") ? root : (root?.querySelector?.("form") ?? application.form);
        if (form) limitSurgeForm(form, available);
      },
      ok: { label: "DSAUTO.Card.Apply", callback: (_event, button) => {
        const el = button.form.elements;
        return {
          damage: Object.fromEntries(payload.rows.map(r => [r.id, Number(el.namedItem(r.id)?.value ?? 0)])),
          potency: (payload.potency ?? []).filter(r => el.namedItem(r.id)?.checked).map(r => r.id),
        };
      } } });
    return result && typeof result === "object" ? result : {};
  } finally { clearTimeout(timer); if (dialog?.rendered) await dialog.close(); }
}

/**
 * Active GM, inside applyOpList: ask the hero's user how to spend surges on this call's hits. Damage rows get
 * `surgeSpend`; a chosen potency row gets the potency spend (`potencySurgePatch`): a condition joins `ops` (applied after
 * the damage), a forced move gets `patches[id]` and moves in the move phase. `potencyBlocked(op)`: the row's 1.2 part
 * carries the system's own potency adjustment.
 */
export async function prepareSurgeChoice(message, res, ops, { covered = () => false, potencyBlocked = () => false, patches = null } = {}) {
  if (setting("enabled") === false || res.synthetic) return;
  const actor = surgeActor(res.sourceActorUuid);
  const item = fromUuidSync(res.abilityUuid ?? "");
  if (!actor || !item?.system?.power?.roll?.enabled) return;
  const available = availableSurges(actor), damage = surgeDamage(actor);
  if (!available || !damage) return;
  const hits = ops.filter(o => o.kind === "damage" && !o.surge && !o.surgeChoiceDone && !o.surgeSpend && !o.nativeSurges
    && o.status === OP_STATUS.PENDING && !o.noApply && !o.auraNegated && !o.auraCauseOpId && !o.temporaryCauseOpId && !o.judgementCauseOpId && !covered(o));
  if (!hits.length) return;
  // Potency is offered with the hits only, and only where +1 makes the effect land.
  const potencyOps = available >= POTENCY_SURGE_COST
    ? Object.values(res.ops ?? {}).filter(o => potencySurgeable(o) && !o.potencyChoiceDone && !potencyBlocked(o) && !ops.some(x => x.opId === o.opId))
    : [];
  const author = message.author ?? game.users.get(res.authorUserId);
  const owners = ownersOf(actor);
  const recipient = owners.find(u => u.id === author?.id) ?? owners[0] ?? game.users.activeGM;
  const targetName = o => res.targets?.[o.targetKeys?.[0]]?.name ?? item.name;
  const payload = { type: "surgeChoice", actorUuid: actor.uuid, damage,
    rows: hits.map(o => ({ id: o.opId, name: targetName(o),
      max: Math.max(0, Math.min(available, MAX_SURGES - liveSurgeOps(res, o.opId).reduce((n, s) => n + s.surge.count, 0))) })),
    potency: potencyOps.map(o => ({ id: o.opId, label: `${targetName(o)}: ${opLabel(res, o)}` })) };
  let answer = {};
  try { answer = recipient?.isSelf ? await routePrompt(payload, { user: game.user }) : await recipient?.query(QUERY_PROMPT, payload, { timeout: 32_000 }) ?? {}; }
  catch (_error) { /* timeout means no spend */ }
  // Answers before 0.17.0 were `{[opId]: n}`.
  const counts = answer?.damage && typeof answer.damage === "object" ? answer.damage : answer;
  const chosen = new Set(Array.isArray(answer?.potency) ? answer.potency : []);
  let remaining = availableSurges(actor);
  for (const op of hits) {
    op.surgeChoiceDone = true;
    const n = Number(counts?.[op.opId]);
    const max = payload.rows.find(r => r.id === op.opId).max;
    if (Number.isInteger(n) && n > 0 && n <= max && n <= remaining) {
      op.surgeSpend = { count: n, actorUuid: actor.uuid, perSurge: damage };
      remaining -= n;
    }
    res.ops[op.opId] = op;
  }
  for (const op of potencyOps) {
    if (!chosen.has(op.opId) || remaining < POTENCY_SURGE_COST) continue;
    remaining -= POTENCY_SURGE_COST;
    const next = { ...potencySurgePatch(op, actor.uuid), potencyChoiceDone: true, potencyBefore: { status: op.status, reason: op.reason ?? null, potency: op.potency } };
    res.ops[op.opId] = next;
    if (op.kind === "condition") ops.push(next);
    else if (patches) patches[op.opId] = { status: next.status, reason: null, potency: next.potency, surge: next.surge, potencyChoiceDone: true };
    log("surge.potency", { opId: op.opId, kind: op.kind });
  }
}
export function registerSurgeChoice() { registerPromptType("surgeChoice", handleSurgeChoice); }

const nativeDialogs = new WeakMap();
export function registerNativeSurgeTracking() {
  wrap("ds.data.pseudoDocuments.messageParts.AbilityResult.prototype.modifyDamageDialog", async function(wrapped, roll) {
    let actor = this.ability?.actor;
    if (actor?.type === "retainer") actor = actor.system.retainer.mentor;
    nativeDialogs.set(this, { actor, before: availableSurges(actor) });
    try { return await wrapped(roll); } finally { nativeDialogs.delete(this); }
  }, "MIXED");
  wrap("ds.data.pseudoDocuments.messageParts.AbilityResult.prototype.createModifiedDamageRoll", async function(wrapped, roll, ...args) {
    const context = nativeDialogs.get(this);
    const count = context ? Math.max(0, context.before - availableSurges(context.actor)) : 0;
    const previous = roll.options;
    if (count) roll.options = { ...previous, dsAutoNativeSurges: (previous?.dsAutoNativeSurges ?? 0) + count };
    try { return await wrapped(roll, ...args); } finally { roll.options = previous; }
  }, "MIXED");
}

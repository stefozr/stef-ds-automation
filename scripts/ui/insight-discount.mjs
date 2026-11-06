/**
 * Shadow "Insight" (class feature dsid `insight`): a heroic ability with a power roll costs 1 fewer Insight when the
 * roll has an edge (net of banes) against at least one target. The Use Ability dialog shows the lower cost and the
 * system charges what the dialog returns, so only the dialog's resource value is adjusted (every client).
 *
 * State per dialog instance (WeakMap): `base` (the cost the dialog opened with), `shown` (the value we last put in
 * the field), `edited` (the player typed another cost: never override again) and `applied` (the hint is shown).
 * A manual edit is a `formData.resource` that differs from `shown` when the form changes (`_refreshInputs`); an edge
 * or bane change re-renders the dialog and moves the field between `base` and `base - 1` while it is not edited.
 * `_processFormData` repeats the decision so a stale render cannot charge the full cost.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { itemDsid } from "../library/identity.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";

const DIALOG = "ds.applications.apps.AbilityConfigurationDialog.prototype.";
const MAX_EDGE = 2;
const states = new WeakMap();
let registered = false;
const list = c => c?.contents ?? (c ? [...c] : []);
const clamp = (n, max) => Math.min(Math.max(Number(n) || 0, 0), max);

/** Edges beat banes on one roll's modifiers. */
const netEdge = m => !!m && (Number(m.edges) || 0) > (Number(m.banes) || 0);

/** The modifiers a target's roll uses: the dialog's combined ones, else target plus global modifiers. */
function rollModifiers(target, global) {
  if (target.combinedModifiers) return target.combinedModifiers;
  return { edges: clamp((target.modifiers?.edges ?? 0) + (global?.edges ?? 0), MAX_EDGE), banes: clamp((target.modifiers?.banes ?? 0) + (global?.banes ?? 0), MAX_EDGE) };
}

/** Whether the discount applies to this dialog right now. */
export function insightDiscountApplies(dialog) {
  if (setting("enabled") === false || setting("libraryEnabled") === false || setting("insightDiscount") === false) return false;
  if (!game.combat?.started) return false;
  const item = dialog?.item, system = item?.system, actor = item?.actor ?? dialog?.actor;
  if (!system?.power?.roll?.enabled || system.category !== "heroic" || !(Number(system.resource) > 0)) return false;
  if (!list(actor?.items).some(i => itemDsid(i) === "insight" && !i.flags?.[MODULE_ID]?.disabled)) return false;
  const context = dialog.options?.context ?? {};
  const targets = Object.values(context.targets ?? {});
  // Without a target the roll is made once with the global modifiers.
  if (!targets.length) return netEdge(context.modifiers);
  return targets.some(t => netEdge(rollModifiers(t, context.modifiers)));
}

/** The dialog's tracking record, created on the first preparation of the ability part. */
function stateOf(dialog) {
  let st = states.get(dialog);
  if (!st) {
    const value = Number(dialog.options?.context?.resource?.value);
    st = { base: Number.isFinite(value) ? value : null, shown: Number.isFinite(value) ? value : null, edited: false, applied: false };
    states.set(dialog, st);
  }
  return st;
}

const wanted = (st, applies) => (applies ? Math.max(0, st.base - 1) : st.base);

function prepareAbility(context, dialog) {
  const resource = context?.resource;
  if (!resource || !dialog?.item?.system?.resource) return;
  const st = stateOf(dialog);
  if (st.base === null || st.edited) { st.applied = false; return; }
  const applies = insightDiscountApplies(dialog) && st.base > 0;
  const value = wanted(st, applies);
  resource.value = value;
  st.shown = value;
  st.applied = applies && value !== st.base;
}

function refreshInputs(dialog, formData) {
  const st = states.get(dialog);
  if (!st || st.edited || !formData || !("resource" in formData)) return;
  const typed = Number(formData.resource);
  if (Number.isFinite(typed) && typed !== st.shown) st.edited = true;
}

function processForm(dialog, config) {
  const st = states.get(dialog);
  if (!st || st.edited || st.base === null || !config || typeof config.resource !== "number") return config;
  // Only the two values we own are corrected; any other number was typed by the player.
  if (config.resource !== st.shown && config.resource !== st.base) return config;
  config.resource = wanted(st, insightDiscountApplies(dialog) && st.base > 0);
  return config;
}

/** Whether the dialog currently shows the discounted cost (tests, hint). */
export const insightDiscountShown = dialog => !!states.get(dialog)?.applied;

/** The hint line under the cost field. */
function showHint(app, element) {
  const html = globalThis.HTMLElement && element instanceof HTMLElement ? element : (element?.[0] ?? element);
  html?.querySelectorAll?.(".dsauto-insight-discount").forEach(n => n.remove());
  if (!states.get(app)?.applied) return;
  const group = html?.querySelector?.('input[name="resource"]')?.closest(".form-group");
  if (!group) return;
  const hint = document.createElement("p");
  hint.className = "hint dsauto-insight-discount";
  hint.textContent = loc("DSAUTO.Insight.Discount");
  group.append(hint);
}

/**
 * Combat Tools' edge / bane pills change `options.context.targets[*].modifiers` without re-rendering the dialog (seen
 * live on CT 2.2), so the "ability" part never re-prepares. After every click or change inside the dialog, recompute the
 * cost and write it into the field (and the hint) unless the player typed their own value.
 */
export function syncInsightField(app) {
  const html = app?.element;
  const input = html?.querySelector?.('input[name="resource"]');
  const st = states.get(app);
  if (!input || !st || st.edited || st.base === null) return;
  const applies = insightDiscountApplies(app) && st.base > 0;
  const value = wanted(st, applies);
  st.shown = value;
  st.applied = applies && value !== st.base;
  const resource = app.options?.context?.resource;
  if (resource) resource.value = value;
  if (Number(input.value) !== value) input.value = String(value);
  showHint(app, html);
}

function watchDialog(app, element) {
  const html = globalThis.HTMLElement && element instanceof HTMLElement ? element : (element?.[0] ?? element);
  if (!html?.addEventListener || html.dataset?.dsautoInsightWatch) return;
  html.dataset.dsautoInsightWatch = "1";
  const later = () => setTimeout(() => {
    try {
      syncInsightField(app);
    } catch (_err) { /* dialog closed */ }
  }, 50);
  html.addEventListener("click", later);
  html.addEventListener("change", later);
}

export function registerInsightDiscount() {
  if (registered) return;
  registered = true;
  wrap(`${DIALOG}_preparePartContext`, async function(wrapped, partId, context, ...rest) {
    const result = await wrapped(partId, context, ...rest);
    if (partId === "ability") prepareAbility(result ?? context, this);
    return result;
  });
  wrap(`${DIALOG}_refreshInputs`, function(wrapped, formData, ...rest) {
    refreshInputs(this, formData);
    return wrapped(formData, ...rest);
  });
  wrap(`${DIALOG}_processFormData`, function(wrapped, ...args) {
    return processForm(this, wrapped(...args));
  });
  Hooks.on("renderAbilityConfigurationDialog", (app, element) => {
    showHint(app, element);
    watchDialog(app, element);
  });
}

/**
 * 0.15.0: the library's "choose one" groups (Practical Magic, Primordial Bane, ...) are picked in the system's Use
 * Ability dialog (AbilityConfigurationDialog) instead of on the card afterwards.
 *
 * The dialog re-renders its parts after every form change (draw-steel.mjs PowerRollDialog#_onChangeForm, 20 ms) and
 * its footer alone on a roll-mode switch, so the radios are inserted again on every render and the pick lives in
 * `app.options.context.dsAutoChoices` (kept across renders). The radios have no `name`: the system's
 * `_processFormData` never sees them. Use Ability stays disabled until every group has a pick (Stefan's call).
 *
 * The system carries nothing of the dialog onto the card, so the pick takes the spend capture's path
 * (engine/spend.mjs): noted when the dialog closes with a result, taken once by the seed on the author's client
 * (engine/use-choices.mjs, engine/seed.mjs `choices`). The engine's resolve keeps a seeded pick that names an option of the plan's group
 * (engine.mjs resolveMessage) and skips the other options' rows; the card still shows the group with the pick
 * highlighted, changeable until one of its rows is applied.
 *
 * Abilities with a Combat Tools `dsct.choose` effect are left to Combat Tools' own prompt (one prompt per use).
 *
 * i18n keys: DSAUTO.UseChoice.Required, DSAUTO.Card.ChooseOne.
 */
import { loc } from "../constants.mjs";
import { error } from "../log.mjs";
import { setting } from "../settings.mjs";
import { resolveAbility } from "../library/resolve.mjs";
import { automates } from "../engine/seed.mjs";
import { dsctChooseGated } from "../compat/dsct.mjs";
import { MAX_CHOICE_ID, noteChoices } from "../engine/use-choices.mjs";

const ROOT_CLASS = "ds-auto-use-choice";

const esc = v => {
  const s = String(v ?? "");
  const fn = globalThis.foundry?.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const validId = v => typeof v === "string" && v.length > 0 && v.length <= MAX_CHOICE_ID;

const dialogItem = app => app?.item ?? app?.options?.ability ?? null;

/** The choice groups the dialog offers for this ability: `[{id, label, options: [{id, label}]}]`, else []. */
export function choiceGroupsFor(item) {
  try {
    if (!item || !setting("enabled") || dsctChooseGated(item) || !automates(item)) return [];
    const r = resolveAbility(item);
    if (r.disabled) return [];
    return (r.choices ?? [])
      .filter(g => validId(g?.id) && (g.options?.length ?? 0) > 1)
      .map(g => ({ id: g.id, label: g.label || "", options: g.options.filter(o => validId(o?.id)).map(o => ({ id: o.id, label: o.label || o.id })) }));
  } catch (err) {
    error("useChoice.groups", err);
    return [];
  }
}

const picksOf = app => {
  const picks = app?.options?.context?.dsAutoChoices;
  return picks && typeof picks === "object" ? picks : {};
};
const complete = (groups, picks) => groups.every(g => g.options.some(o => o.id === picks[g.id]));

/** Use Ability is disabled while a group has no pick (the footer re-renders on its own: checked on every render). */
function refreshSubmit(app, groups) {
  const button = app.element?.querySelector?.('button[type="submit"]');
  if (!button) return;
  const ready = complete(groups, picksOf(app));
  button.disabled = !ready;
  if (ready) {
    if (button.dataset.dsAutoChoiceTip) {
      delete button.dataset.dsAutoChoiceTip;
      delete button.dataset.tooltip;
    }
  } else {
    button.dataset.dsAutoChoiceTip = "1";
    button.dataset.tooltip = loc("DSAUTO.UseChoice.Required");
  }
}

function groupHtml(app, g) {
  const picked = picksOf(app)[g.id];
  const options = g.options.map(o => `<label class="ds-auto-use-choice-option">`
    + `<input type="radio" data-ds-auto-group="${esc(g.id)}" value="${esc(o.id)}"${o.id === picked ? " checked" : ""}> `
    + `<span>${esc(o.label)}</span></label>`).join("");
  return `<legend>${esc(g.label || loc("DSAUTO.Card.ChooseOne"))}</legend>${options}`;
}

function onRender(app, element) {
  try {
    const groups = choiceGroupsFor(dialogItem(app));
    if (!groups.length) return;
    const root = element ?? app.element;
    if (!root?.querySelector) return;
    const host = root.querySelector("section.ability-config") ?? root.querySelector('[data-application-part="ability"]');
    // A footer-only render keeps the part (and our radios): only the button state is refreshed.
    if (host && !host.querySelector(`.${ROOT_CLASS}`)) {
      const sets = [];
      for (const g of groups) {
        const set = document.createElement("fieldset");
        set.className = ROOT_CLASS;
        set.dataset.dsAutoGroup = g.id;
        set.innerHTML = groupHtml(app, g);
        set.addEventListener("change", event => {
          // No 20 ms re-render of the system's dialog for our own inputs.
          event.stopPropagation();
          const input = event.target;
          if (!input?.matches?.('input[type="radio"]')) return;
          // Unnamed radios do not exclude each other: this group's others are cleared by hand.
          for (const other of set.querySelectorAll('input[type="radio"]')) if (other !== input) other.checked = false;
          const context = (app.options.context ??= {});
          context.dsAutoChoices = { ...picksOf(app), [g.id]: input.value };
          refreshSubmit(app, groups);
        });
        sets.push(set);
      }
      host.prepend(...sets);
    }
    refreshSubmit(app, groups);
  } catch (err) {
    error("useChoice.render", err);
  }
}

/** Note the dialog's picks when it closes with a result (a cancelled dialog has no `config`). */
function onClose(app) {
  try {
    if (!app?.config) return;
    const item = dialogItem(app);
    const groups = choiceGroupsFor(item);
    if (!groups.length) return;
    const picks = picksOf(app);
    if (!complete(groups, picks)) return;
    noteChoices(item.uuid, Object.fromEntries(groups.map(g => [g.id, picks[g.id]])));
  } catch (err) {
    error("useChoice.close", err);
  }
}

export function registerUseChoice() {
  Hooks.on("renderAbilityConfigurationDialog", onRender);
  Hooks.on("closeAbilityConfigurationDialog", onClose);
}

export const _test = { onRender, onClose };

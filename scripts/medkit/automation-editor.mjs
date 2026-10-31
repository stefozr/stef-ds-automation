/** Form-based authoring. Draft changes never write until Save is pressed. */
import { MODULE_ID, coreApi } from "./shared.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = key => game.i18n.localize(`DSMEDKIT.Editor.${key}`);
const PRIMARY = {
  damage: ["value", "damageType"], heal: ["value", "recoveries", "temporary"],
  condition: ["status", "end", "until"], cleanse: ["statuses", "count"], resource: ["value", "resource"],
  forced: ["movement", "distance"], teleport: ["distance", "autoStart"],
  modifier: ["key", "value", "mode"], note: ["text"],
};
const CHOICE_KEYS = {
  "": "default", use: "use", passive: "passive", "damage.after": "damageAfter", "turn.start": "turnStart",
  "turn.end": "turnEnd", "round.start": "roundStart", "round.end": "roundEnd", "strike.damage": "strikeDamage",
  targets: "targets", self: "self", subject: "subject", source: "source", aura: "aura", encounter: "encounter",
  creature: "creature", each: "each", turn: "turn", round: "round", all: "all", allies: "allies", enemies: "enemies", selfAlly: "selfAlly",
  turnEnd: "turnEndDuration", nextTurnEnd: "nextTurnEnd", nextTurnStart: "nextTurnStart", sourceNextTurnStart: "sourceNextTurnStart",
  sourceNextTurnEnd: "sourceNextTurnEnd", roundEnd: "roundEndDuration", encounterEnd: "encounterEnd", auto: "auto", manual: "manual",
  shift: "shift", blocking: "blocking", immunityChoice: "immunityChoice", recoveryChoices: "recoveryChoices", spotlight: "spotlight", thunderMother: "thunderMother",
  yourNextTurnStart: "yourNextTurnStart", yourNextTurnEnd: "yourNextTurnEnd", save: "save", respite: "respite", true: "true", false: "false",
  damage: "damage", heal: "heal", condition: "condition", cleanse: "cleanse", resource: "resource", forced: "forced", teleport: "teleport", modifier: "modifier", note: "note",
};
const configured = v => v != null && v !== "" && v !== false && (!Array.isArray(v) || v.length > 0) && (typeof v !== "object" || Object.keys(v).length > 0);
const ruleAdvanced = r => [r.keywords, r.range, r.limit, r.end, r.cost, r.optional, r.activateOnUse, r.special, ...Object.values(r.require ?? {})].filter(configured).length;
const effectAdvanced = e => [...(FIELDS[e.type] ?? []).filter(k => !PRIMARY[e.type]?.includes(k)).map(k => e[k]), e.targets === "self", e.tiers, e.potency, e.when].filter(configured).length;
const countHint = count => count ? `${count} ${L(count === 1 ? "ConfiguredOne" : "Configured")}` : L("OptionalSettings");
const ruleSummary = r => `${label(r.event)} \u2192 ${r.targets === "targets" || !r.targets ? L("Choices.selectedTargets") : label(r.targets)} \u2192 ${r.effects.length ? r.effects.map(e => `${label(e.type)}${e.value != null ? ` (${e.value})` : e.distance != null ? ` (${e.distance})` : e.status ? ` (${label(e.status)})` : ""}`).join(", ") : L("NoEffectsShort")}`;
const TYPES = ["damage", "heal", "condition", "cleanse", "resource", "forced", "teleport", "modifier", "note"];
const FIELDS = {
  damage: ["value", "damageType", "ignoredImmunities"], heal: ["value", "recoveries", "temporary"],
  condition: ["status", "effect", "uuid", "end", "until", "stacking", "temporaryStamina"], cleanse: ["statuses", "ends", "count", "afterMove"],
  resource: ["value", "resource"], forced: ["distance", "movement", "vertical", "ignoresStability", "properties"],
  teleport: ["distance", "autoStart", "hideAfter", "hideWhileObserved", "hideSurge"],
  modifier: ["key", "value", "mode"], note: ["text"],
};
const BOOLEANS = new Set(["temporary", "stacking", "vertical", "ignoresStability", "autoStart", "hideAfter", "hideWhileObserved"]);
const ARRAYS = new Set(["ignoredImmunities", "statuses", "ends", "properties", "tiers"]);
const NUMBERS = new Set(["recoveries", "count", "hideSurge"]);
const LABELS = { "system.movement.value": "Speed", "system.movement.disengage": "Disengage distance", "system.combat.save.bonus": "Saving throw bonus", "system.damage.immunities.all": "All damage immunity", "system.roll.bonuses": "Power roll bonus", "system.roll.edges": "Power roll edges", "system.roll.banes": "Power roll banes" };
const label = value => (CHOICE_KEYS[value] ? L(`Choices.${CHOICE_KEYS[value]}`) : null) ?? LABELS[value] ?? (value ? value.replace(/^benefit:/, "").replace(/^system.damage.immunities./, "Damage immunity: ").replaceAll(".", " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^[a-z]/, s => s.toUpperCase()) : "Default");
const options = (list, current, overrides = {}) => [...new Set([...list, ...(current && !list.includes(current) ? [current] : [])])].map(value => ({ value, label: overrides[value] ? L(`Choices.${overrides[value]}`) : label(value), selected: value === current }));
const VOCAB = {
  targets: ["targets", "self"], resource: ["surge", "heroic", "epic", "recovery"], movement: ["push", "pull", "slide"],
  end: ["", "turn", "save", "encounter", "respite"], until: ["", "yourNextTurnStart", "yourNextTurnEnd"],
  mode: ["add", "override"],
  key: ["benefit:sanctuary", "benefit:entropy", "benefit:concealment", "benefit:acrobatics", "benefit:takeTwo", "benefit:radical", "benefit:dying", "benefit:moonlight", "system.movement.value", "system.movement.disengage", "system.combat.save.bonus", "system.damage.immunities.all", "system.roll.bonuses", "system.roll.edges", "system.roll.banes"],
};

export class AutomationEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.item = options.item;
    this.viewState = { disclosures: {}, presetId: "", presetName: "", presetAppend: false };
    const api = coreApi().library;
    this.draft = api.editableAutomation(this.item, api.resolve(this.item));
    // Tier variants become independent editable rows with their tier gate retained.
    for (const r of this.draft.rules) r.effects = r.effects.flatMap(e => e.byTier
      ? Object.entries(e.byTier).map(([tier, values]) => { const { byTier, ...base } = e; return { ...base, ...values, id: `${e.id}-${tier}`, tiers: [Number(tier)] }; }) : [e]);
  }
  static DEFAULT_OPTIONS = {
    classes: ["ds-auto-medkit", "automation-editor"], tag: "form",
    window: { icon: "fa-solid fa-pen-ruler", resizable: true }, position: { width: 720, height: 680 },
    form: { handler: AutomationEditor.submit, closeOnSubmit: false },
    actions: {
      addRule() {
        this.readDraft(); const id = `rule-${foundry.utils.randomID(10).toLowerCase()}`;
        this.draft.rules.push({ id, event: "use", targets: "targets", effects: [] });
        this.nextFocus = `${id}:label`; this.render();
      },
      removeRule(_event, target) {
        this.readDraft(); const index = Number(target.dataset.rule); this.draft.rules.splice(index, 1);
        const next = this.draft.rules[Math.min(index, this.draft.rules.length - 1)];
        this.nextFocus = next ? `${next.id}:label` : "addRule"; this.render();
      },
      addEffect(_event, target) {
        this.readDraft(); const r = this.draft.rules[Number(target.dataset.rule)];
        const id = `effect-${foundry.utils.randomID(10).toLowerCase()}`;
        r.effects.push({ id, type: "damage", value: "0", targets: "targets" });
        this.nextFocus = `${r.id}:${id}:type`; this.render();
      },
      removeEffect(_event, target) {
        this.readDraft(); const r = this.draft.rules[Number(target.dataset.rule)];
        r.effects.splice(Number(target.dataset.effect), 1); this.nextFocus = `${r.id}:addEffect`; this.render();
      },
      async savePreset() {
        this.readDraft();
        try {
          const preset = await coreApi().library.savePreset(this.viewState.presetName, this.draft);
          this.viewState.presetId = preset.id; this.errors = null; this.render();
        }
        catch (e) { this.showErrors(e); }
      },
      async applyPreset() {
        const id = this.element.querySelector('[name="presetId"]').value;
        const append = this.element.querySelector('[name="presetAppend"]').checked;
        const preset = coreApi().library.presets().find(p => p.id === id);
        if (!preset) return;
        if (!append && this.draft.rules.length && !await foundry.applications.api.DialogV2.confirm({ window: { title: "DSMEDKIT.Editor.Replace" }, content: `<p>${game.i18n.localize("DSMEDKIT.Editor.ReplaceHint")}</p>`, rejectClose: false })) return;
        this.readDraft();
        const next = coreApi().library.presetDraft(preset.automation, this.draft, { append });
        this.draft = next; this.errors = null; this.render();
      },
      async deletePreset() {
        this.readDraft(); const id = this.viewState.presetId; if (!id) return;
        try { await coreApi().library.deletePreset(id); this.viewState.presetId = ""; this.render(); }
        catch (e) { this.showErrors(e); }
      },
      async renamePreset() {
        this.readDraft();
        const api = coreApi().library;
        const p = api.presets().find(p => p.id === this.element.querySelector('[name="presetId"]').value);
        if (p) {
          try { await api.savePreset(this.viewState.presetName, p.automation, p.id); this.render(); }
          catch (e) { this.showErrors(e); }
        }
      },
      async clearAutomation() {
        if (!await foundry.applications.api.DialogV2.confirm({ window: { title: "DSMEDKIT.Editor.Clear" }, content: `<p>${game.i18n.localize("DSMEDKIT.Editor.ClearHint")}</p>`, rejectClose: false })) return;
        await coreApi().library.clearAutomation(this.item); await this.close();
      },
    },
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/medkit/automation-editor.hbs`, scrollable: [".ds-editor-scroll"] } };
  get title() { return `${game.i18n.localize("DSMEDKIT.Editor.Title")} — ${this.item.name}`; }
  _prepareContext() {
    const statusChoices = ["", ...(CONFIG.statusEffects ?? []).map(s => s.id)];
    const damageChoices = ["", ...Object.keys(globalThis.ds?.CONFIG?.damageTypes ?? {})];
    return {
      itemName: this.item.name, presetName: this.viewState.presetName, presetAppend: this.viewState.presetAppend,
      hasPresets: coreApi().library.presets().length > 0,
      errors: this.errors, performance: !!this.draft.performance, isGM: game.user.isGM,
      areas: options(["auto", "manual"], this.draft.area ?? "auto"),
      presets: coreApi().library.presets().map(p => ({ ...p, selected: p.id === this.viewState.presetId })),
      native: [...(this.item.system?.power?.effects?.contents ?? [])].map(e => ({ id: e.id, name: e.name || e.type, selected: this.draft.suppress?.includes(e.id) })),
      rules: this.draft.rules.map((r, ri) => ({
        ...r, ri, summary: ruleSummary(r), advancedSummary: countHint(ruleAdvanced(r)), displayName: r.label || `${game.i18n.localize("DSMEDKIT.Editor.Rule")} ${ri + 1}`, subjects: options(["", "self", "creature"], r.require?.subject ?? ""), specials: options(["", "shift", "blocking", "immunityChoice", "recoveryChoices", "spotlight", "thunderMother"], r.special ?? ""), events: options(["use", "passive", "damage.after", "turn.start", "turn.end", "round.start", "round.end", "strike.damage"], r.event),
        targetOptions: options(["targets", "self", "subject", "source", "aura", "encounter"], r.targets ?? "targets", { targets: "selectedTargets" }),
        frequencies: options(["each", "turn", "round", "encounter"], r.once ?? "each", { encounter: "onceEncounter" }),
        ends: options(["", "turnEnd", "nextTurnEnd", "nextTurnStart", "sourceNextTurnStart", "sourceNextTurnEnd", "roundEnd", "encounterEnd", "passive"], r.end ?? "", { passive: "whilePresent" }),
        filters: options(["all", "allies", "enemies", "selfAlly"], r.filter ?? "all"), keywords: (r.keywords ?? []).join(", "),
        effects: r.effects.map((e, ei) => ({
          ...e, ei, ri, advancedSummary: countHint(effectAdvanced(e)), types: options(TYPES, e.type),
          fields: [...(PRIMARY[e.type] ?? []), ...(FIELDS[e.type] ?? []).filter(k => !PRIMARY[e.type]?.includes(k)), "targets", "tiers", "potencyCharacteristic", "potencyValue", "whenSpend", "whenStrained"].map(key => {
            let value = key === "potencyCharacteristic" ? e.potency?.characteristic : key === "potencyValue" ? e.potency?.value : e[key];
            if (key === "whenSpend" || key === "whenStrained") value = e.when?.[key === "whenSpend" ? "spend" : "strained"] == null ? "" : String(e.when[key === "whenSpend" ? "spend" : "strained"]);
            if (Array.isArray(value)) value = value.join(", ");
            const choices = key === "whenSpend" || key === "whenStrained" ? ["", "true", "false"] : key === "status" ? statusChoices : key === "damageType" ? damageChoices : key === "key" ? [...VOCAB.key, ...damageChoices.filter(Boolean).map(t => `system.damage.immunities.${t}`)] : key === "potencyCharacteristic" ? ["", ...Object.keys(globalThis.ds?.CONFIG?.characteristics ?? {})] : VOCAB[key];
            const choiceLabels = key === "end" ? { turn: "turnEndDuration", encounter: "encounterEnd" }
              : key === "whenSpend" ? { "": "noRequirement", true: "withSpend", false: "withoutSpend" }
              : key === "whenStrained" ? { "": "noRequirement", true: "strained", false: "notStrained" } : {};
            return {
              key, multiline: key === "text", wide: ["text", "targets", "tiers"].includes(key), primary: PRIMARY[e.type]?.includes(key),
              hint: ["value", "distance", "potencyValue"].includes(key) ? L("FormulaHint") : key === "targets" ? L("OverrideHint") : key === "tiers" ? L("TiersHint") : null,
              name: `rules.${ri}.effects.${ei}.${key}`, value: value ?? "", checkbox: BOOLEANS.has(key),
              choices: choices ? options(choices, value ?? "", choiceLabels) : null,
              label: key === "targets" ? L("EffectRecipients") : ["key", "mode", "whenSpend", "whenStrained"].includes(key) ? L(key) : game.i18n.localize(`DSAUTO.Entry.Field.${key}`),
            };
          }),
        })),
      })),
    };
  }
  controlKey(control) {
    const rule = control.closest?.("[data-rule-id]")?.dataset.ruleId;
    const effect = control.closest?.("[data-effect-id]")?.dataset.effectId;
    const field = control.name?.replace(/^rules\.\d+\.(?:effects\.\d+\.)?/, "") || (control.hasAttribute?.("data-effect-type") ? "type" : control.dataset?.action);
    return [rule, effect, field].filter(Boolean).join(":");
  }
  captureView() {
    if (!this.element?.querySelector) return;
    const state = this.viewState;
    for (const d of this.element.querySelectorAll("details[data-disclosure]")) state.disclosures[d.dataset.disclosure] = d.open;
    state.scrollTop = this.element.querySelector(".ds-editor-scroll")?.scrollTop ?? 0;
    for (const name of ["presetId", "presetName", "presetAppend"]) {
      const el = this.element.querySelector(`[name="${name}"]`);
      if (el) state[name] = name === "presetAppend" ? el.checked : el.value;
    }
    const active = this.element.ownerDocument?.activeElement;
    if (active && this.element.contains(active)) state.focus = { key: this.controlKey(active), start: active.selectionStart, end: active.selectionEnd };
  }
  showErrors(error) {
    this.errors = game.i18n.localize(String(error.message));
    for (const match of this.errors.matchAll(/Rule (\d+):/g)) {
      const r = this.draft.rules[Number(match[1]) - 1];
      if (!r) continue;
      this.viewState.disclosures[`rule:${r.id}`] = true;
      for (const e of r.effects) this.viewState.disclosures[`effect:${r.id}:${e.id}`] = true;
    }
    this.render();
  }
  updatePresetButtons() {
    const selected = !!this.element.querySelector('[name="presetId"]')?.value;
    const named = !!this.element.querySelector('[name="presetName"]')?.value.trim();
    for (const button of this.element.querySelectorAll('[data-preset-action]')) {
      button.disabled = button.dataset.action === "savePreset" ? !named : button.dataset.action === "renamePreset" ? !selected || !named : !selected;
    }
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.editorEvents?.abort();
    this.editorEvents = new AbortController();
    const signal = this.editorEvents.signal;
    for (const d of this.element.querySelectorAll("details[data-disclosure]")) d.open = !!this.viewState.disclosures[d.dataset.disclosure];
    const scroll = this.element.querySelector(".ds-editor-scroll");
    if (scroll) scroll.scrollTop = this.viewState.scrollTop ?? 0;
    const key = this.nextFocus ?? this.viewState.focus?.key;
    const controls = [...this.element.querySelectorAll("input, select, textarea, button")];
    const control = controls.find(el => this.controlKey(el) === key);
    if (control) {
      control.focus({ preventScroll: true });
      if (this.nextFocus) control.scrollIntoView({ block: "nearest" });
      else if (control.setSelectionRange && this.viewState.focus?.start != null) {
        try { control.setSelectionRange(this.viewState.focus.start, this.viewState.focus.end); } catch (_) { /* number inputs have no selection */ }
      }
    }
    this.nextFocus = null;
    this.updatePresetButtons();
    if (this.errors) this.element.querySelector('[role="alert"]')?.scrollIntoView({ block: "nearest" });
    this.element.querySelectorAll('[data-effect-type]').forEach(select => select.addEventListener("change", () => {
      this.readDraft();
      const r = this.draft.rules[Number(select.dataset.rule)], e = r.effects[Number(select.dataset.effect)];
      const type = select.value;
      const common = Object.fromEntries(["id", "label", "targets", "tiers", "potency", "when"].filter(k => e[k] !== undefined).map(k => [k, e[k]]));
      r.effects[Number(select.dataset.effect)] = { ...common, type, targets: e.targets ?? "targets", ...(type === "modifier" ? { key: "system.movement.value", value: "0", mode: "add" } : type === "teleport" ? { targets: "self", distance: "5", autoStart: true } : {}) };
      this.render();
    }, { signal }));
    this.element.addEventListener("input", event => {
      if (event.target.hasAttribute("data-effect-type")) return;
      this.readDraft(); this.updatePresetButtons();
      for (const card of this.element.querySelectorAll("[data-rule-id]")) {
        const r = this.draft.rules.find(r => r.id === card.dataset.ruleId);
        card.querySelector("[data-rule-summary]").textContent = ruleSummary(r);
        card.querySelector("[data-rule-title]").textContent = r.label || `${L("Rule")} ${this.draft.rules.indexOf(r) + 1}`;
        card.querySelector("[data-rule-advanced-summary]").textContent = countHint(ruleAdvanced(r));
        for (const effect of card.querySelectorAll("[data-effect-id]")) {
          const e = r.effects.find(e => e.id === effect.dataset.effectId);
          effect.querySelector("[data-effect-advanced-summary]").textContent = countHint(effectAdvanced(e));
        }
      }
    }, { signal });
  }
  readDraft() {
    if (!this.element) return;
    this.captureView();
    const get = name => this.element.querySelector(`[name="${name}"]`);
    const val = name => get(name)?.value;
    this.draft.performance = !!get("performance")?.checked;
    this.draft.area = val("area") ?? this.draft.area;
    this.draft.suppress = [...this.element.querySelectorAll('[name="suppress"]:checked')].map(e => e.value);
    for (const [ri, r] of this.draft.rules.entries()) {
      const prefix = `rules.${ri}.`;
      for (const k of ["event", "targets", "once", "end", "filter", "label"]) if (get(prefix + k)) r[k] = val(prefix + k);
      const require = { ...(r.require ?? {}) };
      for (const k of ["adjacent", "dying", "dead", "subject", "subjectKeyword", "sourceWithin"]) delete require[k];
      for (const k of ["adjacent", "dying", "dead"]) if (get(prefix + "require." + k)?.checked) require[k] = true;
      for (const k of ["subject", "subjectKeyword", "sourceWithin"]) if (val(prefix + "require." + k)) require[k] = val(prefix + "require." + k);
      r.require = require;
      if (val(prefix + "special")) r.special = val(prefix + "special"); else delete r.special;
      r.activateOnUse = !!get(prefix + "activateOnUse")?.checked;
      r.optional = !!get(prefix + "optional")?.checked;
      r.keywords = (val(prefix + "keywords") ?? "").split(",").map(s => s.trim()).filter(Boolean);
      for (const k of ["range", "limit"]) { const v = val(prefix + k); if (v) r[k] = v; else delete r[k]; }
      const cost = Number(val(prefix + "cost")); if (cost) r.cost = cost; else delete r.cost;
      for (const [ei, e] of r.effects.entries()) {
        let chr, potency;
        for (const k of [...(FIELDS[e.type] ?? []), "targets", "tiers", "potencyCharacteristic", "potencyValue", "whenSpend", "whenStrained"]) {
          const el = get(`${prefix}effects.${ei}.${k}`); if (!el) continue;
          if (k === "whenSpend" || k === "whenStrained") { const gate = k === "whenSpend" ? "spend" : "strained"; e.when ??= {}; if (el.value) e.when[gate] = el.value === "true"; else delete e.when[gate]; continue; }
          if (k === "potencyCharacteristic") { chr = el.value; continue; }
          if (k === "potencyValue") { potency = el.value; continue; }
          if (BOOLEANS.has(k)) e[k] = el.checked;
          else if (!el.value.trim()) delete e[k];
          else if (ARRAYS.has(k)) e[k] = el.value.split(",").map(s => s.trim()).filter(Boolean).map(s => k === "tiers" ? Number(s) : s);
          else if (NUMBERS.has(k)) e[k] = Number(el.value);
          else e[k] = el.value;
        }
        if (chr && potency) e.potency = { characteristic: chr, value: potency }; else delete e.potency;
      }
    }
  }
  static async submit() {
    this.readDraft();
    try { await coreApi().library.saveAutomation(this.item, this.draft); this.errors = null; await this.close(); }
    catch (e) { this.showErrors(e); }
  }
}
export function openAutomationEditor(item) { return new AutomationEditor({ item }).render({ force: true }); }

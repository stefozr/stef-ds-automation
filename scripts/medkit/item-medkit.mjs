import { openAutomationEditor } from "./automation-editor.mjs";
/**
 * Automation window of one ability: its status, the layers the engine uses (native effects, the
 * library overlay or detached entries), its triggers and trackers, Combat Tools' own state, the item's
 * options, and the actions
 * Disable / Enable, Lock / Unlock, Detach, Re-sync, Reset. Every action goes through stef-ds-automation's
 * `api.library` (flags and our own entries only).
 * 0.4.0 (core 0.9.0): a class feature with resource gains shows only its "Resource gains" section (the
 * overlay's rules) and Disable / Enable (a disabled feature grants nothing; the core's gain rules skip it).
 * i18n: DSMEDKIT.Gain.Heading (template).
 */
import { MODULE_ID, coreApi, statusInfo } from "./shared.mjs";
import { describeEffect, describeGain, describeNative, describeTracker, describeTrigger } from "./describe.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ItemMedkit extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.item = options.item;
  }

  static DEFAULT_OPTIONS = {
    classes: ["ds-auto-medkit", "item-medkit"],
    tag: "form",
    window: { icon: "fa-solid fa-kit-medical", resizable: true },
    position: { width: 520, height: "auto" },
    form: { handler: ItemMedkit.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      useAutomation() { return run(() => coreApi().library.useAutomation(this.item, [...game.user.targets].map(t => t.document.uuid))); },
      performanceStart() { return run(() => coreApi().library.setPerformance(this.item, true)); },
      auraStop() { return run(() => coreApi().library.setAura(this.item, false)); },
      auraEnhance() { return run(() => coreApi().library.enhanceAura(this.item)); },
      performanceStop() { return run(() => coreApi().library.setPerformance(this.item, false)); },
      editAutomation() { return openAutomationEditor(this.item); },
      disable: ItemMedkit.#onToggle("disable", true),
      enable: ItemMedkit.#onToggle("disable", false),
      lock: ItemMedkit.#onToggle("lock", true),
      unlock: ItemMedkit.#onToggle("lock", false),
      detach: ItemMedkit.#onAction("detach"),
      resync: ItemMedkit.#onAction("resync"),
      reset: ItemMedkit.#onAction("reset"),
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/medkit/item-medkit.hbs`, scrollable: [""] },
  };

  get title() {
    return game.i18n.format("DSMEDKIT.Item.Title", { name: this.item?.name ?? "" });
  }

  /** Re-render when the item or the registry changes. */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._hooks = [
      ["updateItem", Hooks.on("updateItem", item => { if (item === this.item || item.uuid === this.item?.uuid) this.render(); })],
    ];
    this._offRegistry = coreApi()?.library?.onChange?.(() => this.render());
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const [name, id] of this._hooks ?? []) Hooks.off(name, id);
    this._offRegistry?.();
  }

  async _prepareContext() {
    const api = coreApi();
    const item = this.item;
    if (item?.type !== "ability" && !api.library.resolve(item).automation) return featureContext(api, item);
    const r = api.library.resolve(item);
    const overlay = r.overlay;
    const flags = item.flags?.[MODULE_ID] ?? {};
    const dsct = api.library.dsctState(item);
    const canEdit = item.isOwner && !item.pack;
    const config = (overlay?.config ?? []).map(c => ({
      ...c, value: r.config?.[c.key] ?? c.default, isCheckbox: c.type === "checkbox", isNumber: c.type === "number", isSelect: c.type === "select",
      options: (c.options ?? []).map(o => ({ ...o, selected: o.value === (r.config?.[c.key] ?? c.default) })),
    }));
    return {
      item, key: r.key, status: statusInfo(r.status), layer: game.i18n.localize(`DSMEDKIT.Layer.${r.layer}`),
      overlay: overlay ? { version: overlay.version, source: overlay.source, notes: overlay.notes, monster: overlay.monster?.join(", ") ?? null } : null,
      detachedVersion: flags.overlay?.version ?? null,
      native: describeNative(item).map(n => ({ ...n, suppressed: r.suppress?.has?.(n.id) })),
      nativeFilter: r.nativeFilter ? game.i18n.localize(`DSMEDKIT.Item.NativeFilter.${r.nativeFilter}`) : null,
      rules: (r.automation?.rules ?? []).map(rule => ({ label: rule.label || item.name, event: rule.event, targets: rule.targets, effects: rule.effects.map(e => e.type === "modifier" ? { what: `${e.key.replace(/^system.movement.value$/, "Speed").replace(/^benefit:/, "")} ${e.value}`, detail: rule.end } : describeEffect(e, item)) })),
      effects: r.effects.map(e => describeEffect(e, item)),
      // Overlay-level reactions (core 0.7.0): when the ability reacts, and whom it re-targets.
      triggers: (r.triggers ?? []).map(t => describeTrigger(t, item)),
      trackers: (r.trackers ?? []).map(k => describeTracker(k, item)),
      covered: r.dsctCovered?.length ? r.dsctCovered.map(t => game.i18n.localize(`DSMEDKIT.Type.${t}`)).join(", ") : null,
      dsct, config, hasConfig: config.length > 0,
      auraActive: !!r.automation?.aura && !!flags.aura?.active, nullField: item.system?._dsid === "null-field", auraOption: flags.aura?.option ?? "",
      isPerformance: !!r.automation?.performance, canUseAutomation: canEdit && item.type !== "ability" && r.automation?.rules?.some(r => r.event === "use"),
      canEdit, canAuthor: canEdit && !r.locked, disabled: r.disabled, locked: r.locked,
      canDetach: canEdit && !r.locked && !!overlay && r.layer !== "detached",
      canResync: canEdit && !r.locked && !!overlay && r.layer === "detached",
      canReset: canEdit && !r.locked && r.layer === "detached",
      inPack: !!item.pack,
    };
  }

  static #onToggle(kind, value) {
    return async function () {
      await run(() => coreApi().library[kind](this.item, value));
    };
  }

  static #onAction(kind) {
    return async function () {
      if (kind === "reset" || kind === "resync") {
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: `DSMEDKIT.Action.${kind}` },
          content: `<p>${game.i18n.localize(`DSMEDKIT.Confirm.${kind}`)}</p>`,
          rejectClose: false,
        });
        if (!ok) return;
      }
      await run(() => coreApi().library[kind](this.item));
    };
  }

  static async #onSubmit(_event, _form, formData) {
    const values = formData.object;
    const out = {};
    for (const [k, v] of Object.entries(values)) if (k.startsWith("config.")) out[k.slice(7)] = v;
    await run(() => coreApi().library.configure(this.item, out));
  }
}

/**
 * The window of a class feature (core 0.9.0): its overlay's resource gains, no ability layers. Only
 * Disable / Enable act on it (the gains have no entries to detach).
 */
function featureContext(api, item) {
  const overlay = api.library.find?.(item) ?? null;
  const flags = item.flags?.[MODULE_ID] ?? {};
  const canEdit = item.isOwner && !item.pack;
  const disabled = !!flags.disabled;
  return {
    item, feature: true, key: api.library.keys?.itemKey?.(item) ?? null,
    status: statusInfo(disabled ? "disabled" : (overlay?.gains ?? []).length ? "automated" : "manual"),
    layer: game.i18n.localize(`DSMEDKIT.Layer.${disabled ? "disabled" : overlay ? "overlay" : "none"}`),
    overlay: overlay ? { version: overlay.version, source: overlay.source, notes: overlay.notes, monster: null } : null,
    gains: (overlay?.gains ?? []).map(g => describeGain(g, null, item.actor ?? null)),
    canEdit, canAuthor: canEdit && !flags.lock, disabled, locked: !!flags.lock, inPack: !!item.pack,
    canDetach: false, canResync: false, canReset: false, hasConfig: false,
  };
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.startsWith("DSAUTO.")) ui.notifications.warn(game.i18n.localize(msg));
    else Hooks.onError(`${MODULE_ID}.action`, err, { log: "error", notify: "error" });
  }
}

/** Open (or bring to front) the medkit of an item. */
export function openItemMedkit(item) {
  const existing = foundry.applications.instances.get(`ds-auto-medkit-${item.uuid.replace(/\./g, "-")}`);
  if (existing) return existing.render({ force: true });
  return new ItemMedkit({ item, id: `ds-auto-medkit-${item.uuid.replace(/\./g, "-")}` }).render({ force: true });
}

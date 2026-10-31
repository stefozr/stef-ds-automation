/**
 * Actor-wide automation view: every ability of the actor with its status, bulk actions on the selected
 * ones, and for NPCs the monster key the library matches monster-specific overlays with (pin a key
 * when the automatic one matches the wrong monster). With core 0.7.0, a line whether the actor's
 * triggered action of this round is still available. With core 0.8.0, the actor's live summons
 * (`api.summons.of`) with a Dismiss button for the GM and the actor's owners.
 *
 * i18n (Milestone 6): DSMEDKIT.Summons.{Heading, None, Line, Dismiss}, DSMEDKIT.Summon.Lasts.<end> (dynamic).
 *
 * With core 0.9.0 (Milestone 7), each section shown only when the core has the API and there is something
 * to list: heroes, "Resource gains" (their rules from `api.resources.rules`, used this round / encounter from
 * `api.resources.ledger`, a Director-only Release → `api.resources.release`); NPCs, "Villain actions" (used this
 * encounter, `api.villain.used`, Reset for GMs → `api.villain.reset`); everyone, "Areas" (live zones the actor
 * created, `api.zones.list`, Dismiss for the GM and the actor's owners → `api.zones.dismiss`).
 * i18n (M7-DESIGN §5.4): DSMEDKIT.Gain.{Heading, Used, UsedEncounter, Release}, DSMEDKIT.Villain.{Heading, Line,
 * Reset}, DSMEDKIT.Zones.{Heading, Line, Dismiss}; the core's DSAUTO.Zone.Lasts.<end> (the area line's ends).
 */
import { MODULE_ID, coreApi, statusInfo } from "./shared.mjs";
import { openItemMedkit } from "./item-medkit.mjs";
import { describeGain } from "./describe.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ActorMedkit extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.actor = options.actor;
  }

  static DEFAULT_OPTIONS = {
    classes: ["ds-auto-medkit", "actor-medkit"],
    tag: "form",
    window: { icon: "fa-solid fa-kit-medical", resizable: true },
    position: { width: 640, height: 600 },
    form: { handler: ActorMedkit.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      open: ActorMedkit.#onOpen,
      bulk: ActorMedkit.#onBulk,
      selectAll: ActorMedkit.#onSelectAll,
      unpin: ActorMedkit.#onUnpin,
      dismissSummon: ActorMedkit.#onDismissSummon,
      releaseGain: ActorMedkit.#onReleaseGain,
      resetVillain: ActorMedkit.#onResetVillain,
      dismissZone: ActorMedkit.#onDismissZone,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/medkit/actor-medkit.hbs`, scrollable: [""] },
  };

  get title() {
    return game.i18n.format("DSMEDKIT.Actor.Title", { name: this.actor?.name ?? "" });
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const mine = doc => doc?.parent === this.actor || doc === this.actor;
    this._hooks = ["updateItem", "createItem", "deleteItem", "updateActor", "updateActiveEffect"].map(name => [name, Hooks.on(name, doc => { if (mine(doc)) this.render(); })]);
    // The triggered-action line, the gains' ledger and the villain markers follow the combat (round, flags).
    for (const name of ["updateCombat", "deleteCombat"]) this._hooks.push([name, Hooks.on(name, () => { if (this._hasBudget || this._hasGainApi || this._hasVillainApi) this.render(); })]);
    // The summons list follows stef-ds-automation's summon tokens (created or removed anywhere).
    const summonToken = doc => !!doc?.flags?.[MODULE_ID]?.summon;
    for (const name of ["createToken", "deleteToken"]) this._hooks.push([name, Hooks.on(name, doc => { if (this._hasSummons && summonToken(doc)) this.render(); })]);
    // The areas list follows stef-ds-automation's zone regions.
    const zoneRegion = doc => !!doc?.flags?.[MODULE_ID]?.zone;
    for (const name of ["createRegion", "deleteRegion"]) this._hooks.push([name, Hooks.on(name, doc => { if (this._hasZoneApi && zoneRegion(doc)) this.render(); })]);
    this._offRegistry = coreApi()?.library?.onChange?.(() => this.render());
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const [name, id] of this._hooks ?? []) Hooks.off(name, id);
    this._offRegistry?.();
  }

  async _prepareContext() {
    const api = coreApi();
    const actor = this.actor;
    const rows = actor.items.filter(i => ["ability", "feature", "ancestryTrait"].includes(i.type)).sort((a, b) => a.name.localeCompare(b.name)).map(item => {
      const r = api.library.resolve(item);
      return { uuid: item.uuid, name: item.name, img: item.img, key: r.key, status: statusInfo(r.status), version: r.version ?? "" };
    });
    const counts = {};
    for (const r of rows) counts[r.status.id] = (counts[r.status.id] ?? 0) + 1;
    const npc = actor.type === "npc";
    const pinned = actor.getFlag?.(MODULE_ID, "monsterKey") ?? null;
    const budget = budgetLine(api, actor);
    this._hasBudget = !!budget;
    const summons = summonLines(api, actor);
    this._hasSummons = !!summons;
    // Milestone 7 (core 0.9.0): null without the API, hidden when empty.
    const gains = gainLines(api, actor);
    const villain = villainLines(api, actor);
    const zones = zoneLines(api, actor);
    this._hasGainApi = !!gains;
    this._hasVillainApi = !!villain;
    this._hasZoneApi = !!zones;
    return {
      actor, rows, npc, pinned, budget, summons, summonsApi: !!summons,
      gains: gains?.length ? gains : null, villain: villain?.length ? villain : null, zones: zones?.length ? zones : null,
      isGM: !!game.user?.isGM,
      canDismiss: !!(game.user?.isGM || actor.isOwner),
      monsterKey: npc ? api.library.keys.monsterKey(actor) : null,
      summary: Object.entries(counts).map(([id, n]) => ({ ...statusInfo(id), n })),
      canEdit: actor.isOwner,
    };
  }

  static #onOpen(_event, target) {
    const item = fromUuidSync(target.closest("[data-uuid]")?.dataset.uuid ?? "");
    if (item) openItemMedkit(item);
  }

  static #onSelectAll(_event, target) {
    const on = target.checked ?? true;
    for (const box of this.element.querySelectorAll("input.ds-medkit-select")) box.checked = on;
  }

  static async #onBulk(_event, target) {
    const action = target.dataset.bulk;
    const api = coreApi();
    const uuids = [...this.element.querySelectorAll("input.ds-medkit-select:checked")].map(b => b.value);
    if (!uuids.length) return ui.notifications.warn(game.i18n.localize("DSMEDKIT.Actor.NoneSelected"));
    let done = 0;
    let failed = 0;
    for (const uuid of uuids) {
      const item = fromUuidSync(uuid);
      if (!item) continue;
      try {
        const r = api.library.resolve(item);
        if (action === "disable") await api.library.disable(item, true);
        else if (action === "enable") await api.library.disable(item, false);
        else if (action === "lock") await api.library.lock(item, true);
        else if (action === "unlock") await api.library.lock(item, false);
        else if (action === "detach" && r.overlay && r.layer !== "detached" && !r.locked) await api.library.detach(item);
        else if (action === "resync" && r.overlay && r.layer === "detached" && !r.locked) await api.library.resync(item);
        else continue;
        done++;
      } catch (_err) {
        failed++;
      }
    }
    ui.notifications.info(game.i18n.format("DSMEDKIT.Actor.BulkDone", { done, failed }));
  }

  static async #onDismissSummon(_event, target) {
    const id = target.closest("[data-summon-id]")?.dataset.summonId;
    const dismiss = coreApi()?.summons?.dismiss;
    if (!id || typeof dismiss !== "function") return;
    target.disabled = true;
    try {
      await dismiss(id);
    } catch (err) {
      // Relay refusals arrive as i18n keys (DSAUTO.Relay.*): localized, anything else shown as is.
      const msg = String(err?.message ?? err ?? "");
      ui.notifications.warn(msg.startsWith("DSAUTO.") ? game.i18n.localize(msg) : msg);
    }
    this.render();
  }

  /** Director: release one gain rule's ledger entry (the rule may grant again this round / encounter). */
  static async #onReleaseGain(_event, target) {
    const row = target.closest("[data-rule-key]");
    const release = coreApi()?.resources?.release;
    if (!row || typeof release !== "function" || !game.user?.isGM) return;
    target.disabled = true;
    await relayed(() => release(this.actor, row.dataset.ruleKey, { encounter: row.dataset.encounter === "true" }));
    this.render();
  }

  /** Director: forget this NPC's villain action markers of the current combat. */
  static async #onResetVillain(_event, target) {
    const reset = coreApi()?.villain?.reset;
    if (typeof reset !== "function" || !game.user?.isGM) return;
    target.disabled = true;
    await relayed(() => reset(this.actor));
    this.render();
  }

  /** The GM or an owner of the creator: end one of the actor's areas (relay `zoneDismiss`). */
  static async #onDismissZone(_event, target) {
    const id = target.closest("[data-zone-id]")?.dataset.zoneId;
    const dismiss = coreApi()?.zones?.dismiss;
    if (!id || typeof dismiss !== "function") return;
    target.disabled = true;
    await relayed(() => dismiss(id));
    this.render();
  }

  static async #onUnpin() {
    await this.actor.unsetFlag(MODULE_ID, "monsterKey");
  }

  static async #onSubmit(_event, _form, formData) {
    const key = String(formData.object.monsterKey ?? "").trim();
    if (this.actor.type !== "npc") return;
    if (key) await this.actor.setFlag(MODULE_ID, "monsterKey", key);
  }
}

/**
 * "Triggered action this round" from stef-ds-automation's `api.triggers.budget` (0.7.0): available, used (by
 * which ability) or not tracked. Null (line hidden) without that API.
 */
export function budgetLine(api, actor) {
  const fn = api?.triggers?.budget;
  if (typeof fn !== "function") return null;
  try {
    const b = fn(actor);
    if (!b) return null;
    if (!b.tracked) return game.i18n.localize("DSMEDKIT.Trigger.BudgetUntracked");
    if (b.available) return game.i18n.localize("DSMEDKIT.Trigger.BudgetAvailable");
    return game.i18n.format("DSMEDKIT.Trigger.BudgetUsed", { ability: b.usedAbility || "-" });
  } catch (_err) {
    return null;
  }
}

/**
 * The actor's live summons from stef-ds-automation's `api.summons.of` (0.8.0): one line each (names, scene, how
 * long it lasts). Null (fieldset hidden) without that API or when it fails.
 */
export function summonLines(api, actor) {
  const fn = api?.summons?.of;
  if (typeof fn !== "function") return null;
  try {
    return (fn(actor) ?? []).map(info => ({
      summonId: info.summonId,
      line: game.i18n.format("DSMEDKIT.Summons.Line", {
        names: (info.names ?? []).join(", ") || "?",
        scene: game.scenes?.get?.(info.sceneId)?.name ?? info.sceneId ?? "?",
      }),
      lasts: (info.lasts ?? []).map(v => game.i18n.localize(`DSMEDKIT.Summon.Lasts.${v}`)).join(", "),
    }));
  } catch (_err) {
    return null;
  }
}

/** Run a core API call; refusals arrive as i18n keys (DSAUTO.*): localized, anything else shown as is. */
async function relayed(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = String(err?.message ?? err ?? "");
    ui.notifications.warn(msg.startsWith("DSAUTO.") ? game.i18n.localize(msg) : msg);
    return null;
  }
}

/**
 * A hero's resource gain rules (`api.resources.rules`, the amount with its upgrades) and whether each was used
 * this round or encounter (`api.resources.ledger`). Null without that API (stef-ds-automation < 0.9.0), for non-heroes
 * or when it fails.
 */
export function gainLines(api, actor) {
  const rules = api?.resources?.rules;
  if (typeof rules !== "function" || actor?.type !== "hero") return null;
  try {
    const ledger = api.resources.ledger?.(actor) ?? {};
    return (rules(actor) ?? []).map(view => {
      const round = !!ledger.round?.[view.ruleKey];
      const encounter = !round && !!ledger.encounter?.[view.ruleKey];
      const d = describeGain(view.rule, view, actor);
      return {
        ruleKey: view.ruleKey, what: d.what, detail: d.detail, encounter,
        used: round ? game.i18n.localize("DSMEDKIT.Gain.Used") : encounter ? game.i18n.localize("DSMEDKIT.Gain.UsedEncounter") : null,
      };
    });
  } catch (_err) {
    return null;
  }
}

/** An NPC's villain actions used in the current combat (`api.villain.used`). Null without the API or for non-NPCs. */
export function villainLines(api, actor) {
  const used = api?.villain?.used;
  if (typeof used !== "function" || actor?.type !== "npc") return null;
  try {
    return (used(actor) ?? []).map(v => ({ dsid: v.dsid, line: game.i18n.format("DSMEDKIT.Villain.Line", { name: v.name ?? v.dsid ?? "?", round: v.round ?? "?" }) }));
  } catch (_err) {
    return null;
  }
}

/** The live areas (zones) the actor created (`api.zones.list`). Null without the API or when it fails. */
export function zoneLines(api, actor) {
  const list = api?.zones?.list;
  if (typeof list !== "function" || !actor?.uuid) return null;
  try {
    return (list({ creatorActorUuid: actor.uuid }) ?? []).map(z => ({
      zoneId: z.zoneId,
      line: game.i18n.format("DSMEDKIT.Zones.Line", {
        label: z.label ?? "?",
        lasts: (z.lasts ?? []).map(v => game.i18n.localize(`DSAUTO.Zone.Lasts.${v}`)).join(", "),
      }),
    }));
  } catch (_err) {
    return null;
  }
}

export function openActorMedkit(actor) {
  const id = `ds-auto-medkit-actor-${actor.uuid.replace(/\./g, "-")}`;
  const existing = foundry.applications.instances.get(id);
  if (existing) return existing.render({ force: true });
  return new ActorMedkit({ actor, id }).render({ force: true });
}

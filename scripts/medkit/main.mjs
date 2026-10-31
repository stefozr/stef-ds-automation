/**
 * Medkit — the user interface of the suite's ability library (formerly the separate module ds-auto-medkit).
 *   - Item sheets of abilities: a status badge in the window header (click: the Automation window) and
 *     an "Automation" header control (`getHeaderControlsDrawSteelItemSheet`; class hooks fire along the
 *     sheet's class chain, so Draw Steel Plus' item sheet gets them too).
 *   - Actor sheets: an "Automation" header control with every ability's status and bulk actions.
 *   - Settings: a coverage report of the ability compendiums.
 *   - 0.4.0 (core 0.9.0): class feature items whose library overlay has resource gains get the same
 *     header control and badge; their window shows the gains only (no ability layers).
 *   - 0.5.0 (core 0.10.0, docs/M8-DESIGN.md §5.4): two entries in the core settings window's Maintenance
 *     tab through the hook `dsAuto.settingsMenu` (`registry.addMaintenance({id, label, hint, icon, run})`): the
 *     coverage report, and the items whose automation is stored on the item (customized or outdated). An older core
 *     never fires the hook, so nothing changes there (the coverage report stays a settings menu either way).
 * All writes go through stef-ds-automation's `api.library` (flags and its own entries only).
 *
 * i18n (Milestone 8): DSMEDKIT.Maintenance.{coverage, coverageHint, customized, customizedHint, customizedNone}.
 */
import { MODULE_ID, coreApi, isGainFeature, mayUseMedkit, statusInfo } from "./shared.mjs";
import { ItemMedkit, openItemMedkit } from "./item-medkit.mjs";
import { ActorMedkit, openActorMedkit } from "./actor-medkit.mjs";
import { CoverageReport, coverageData } from "./coverage.mjs";

function registerSettings() {
  game.settings.register(MODULE_ID, "medkitRole", {
    name: "DSMEDKIT.Settings.medkitRole.name", hint: "DSMEDKIT.Settings.medkitRole.hint",
    scope: "world", config: true, type: Number, default: 3,
    choices: { 1: "USER.RolePlayer", 2: "USER.RoleTrusted", 3: "USER.RoleAssistant", 4: "USER.RoleGamemaster" },
  });
  game.settings.register(MODULE_ID, "showBadge", {
    name: "DSMEDKIT.Settings.showBadge.name", hint: "DSMEDKIT.Settings.showBadge.hint",
    scope: "client", config: true, type: Boolean, default: true,
  });
  game.settings.registerMenu(MODULE_ID, "coverage", {
    name: "DSMEDKIT.Coverage.Title", label: "DSMEDKIT.Coverage.Open", hint: "DSMEDKIT.Coverage.Hint",
    icon: "fa-solid fa-chart-simple", type: CoverageReport, restricted: true,
  });
}

const isAbility = doc => doc?.documentName === "Item" && doc.type === "ability";

/** stef-ds-automation's settings window hook (`HOOKS.settingsMenu` of core 0.10.0; a string so an older core costs nothing). */
const SETTINGS_MENU_HOOK = "dsAuto.settingsMenu";
/** Statuses whose automation lives on the item (detached entries a cleanup removes and a library update misses). */
const CUSTOMIZED = new Set(["customized", "outdated"]);

const escapeHtml = text => (foundry.utils?.escapeHTML
  ? foundry.utils.escapeHTML(String(text ?? ""))
  : String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]));

/**
 * The world's items and the actors' items (abilities and gain features) whose library status is customized or
 * outdated: `[{uuid, name, actor, status}]`, sorted by actor then item name. World actors only (unlinked tokens
 * share their base actor's items unless edited; those stay out).
 */
export function customizedItems(api = coreApi()) {
  if (!api?.library?.status) return [];
  const out = [];
  const look = (item, actor) => {
    if (!medkitItem(item)) return;
    let status;
    try {
      status = api.library.status(item);
    } catch (_err) {
      return;
    }
    if (CUSTOMIZED.has(status)) out.push({ uuid: item.uuid, name: item.name, actor: actor?.name ?? null, status });
  };
  for (const item of game.items ?? []) look(item, null);
  for (const actor of game.actors ?? []) for (const item of actor.items ?? []) look(item, actor);
  return out.sort((a, b) => (a.actor ?? "").localeCompare(b.actor ?? "") || a.name.localeCompare(b.name));
}

/** Maintenance entry "Customized items": a list dialog, or a notice when there is none. Returns the list. */
async function showCustomized() {
  const list = customizedItems();
  if (!list.length) {
    ui.notifications.info(game.i18n.localize("DSMEDKIT.Maintenance.customizedNone"));
    return list;
  }
  const rows = list.map(e => {
    const s = statusInfo(e.status);
    const link = `<a class="content-link" data-link data-uuid="${escapeHtml(e.uuid)}" data-type="Item"><i class="${s.icon}" inert></i>${escapeHtml(e.name)}</a>`;
    return `<li>${e.actor ? `${escapeHtml(e.actor)}: ` : ""}${link} (${escapeHtml(s.label)})</li>`;
  }).join("");
  await foundry.applications.api.DialogV2.prompt({
    window: { title: "DSMEDKIT.Maintenance.customized", icon: "fa-solid fa-pen-ruler" },
    content: `<p>${escapeHtml(game.i18n.localize("DSMEDKIT.Maintenance.customizedHint"))}</p><ul class="ds-medkit-customized">${rows}</ul>`,
    rejectClose: false,
  });
  return list;
}

/** `dsAuto.settingsMenu` (core 0.10.0): the medkit's Maintenance entries. */
function addMaintenance(registry) {
  if (typeof registry?.addMaintenance !== "function") return;
  try {
    registry.addMaintenance({
      id: `${MODULE_ID}.coverage`, label: "DSMEDKIT.Maintenance.coverage", hint: "DSMEDKIT.Maintenance.coverageHint",
      icon: "fa-solid fa-chart-simple", run: () => new CoverageReport().render({ force: true }),
    });
    registry.addMaintenance({
      id: `${MODULE_ID}.customized`, label: "DSMEDKIT.Maintenance.customized", hint: "DSMEDKIT.Maintenance.customizedHint",
      icon: "fa-solid fa-pen-ruler", run: showCustomized,
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | maintenance entries`, err);
  }
}

/** Items the medkit opens: abilities, and (0.4.0) class features with resource gains. */
const medkitItem = doc => isAbility(doc) || ["feature", "ancestryTrait"].includes(doc?.type);

function itemControls(app, controls) {
  const item = app.document;
  if (!coreApi()?.library || !medkitItem(item)) return;
  controls.push({
    action: "dsAutoMedkit", icon: "fa-solid fa-kit-medical", label: "DSMEDKIT.Control.Item",
    visible: () => mayUseMedkit(), onClick: () => openItemMedkit(item),
  });
}

function actorControls(app, controls) {
  const actor = app.document;
  if (actor?.documentName !== "Actor" || !coreApi()?.library) return;
  controls.push({
    action: "dsAutoMedkitActor", icon: "fa-solid fa-kit-medical", label: "DSMEDKIT.Control.Actor",
    visible: () => mayUseMedkit(), onClick: () => openActorMedkit(actor),
  });
}

/** Status badge next to the sheet title (as Combat Tools' enhanced badge). */
function injectBadge(app) {
  try {
    const item = app.document;
    if (!game.settings.get(MODULE_ID, "showBadge")) return;
    const api = coreApi();
    if (!api?.library || !medkitItem(item)) return;
    const header = app.element?.querySelector?.(".window-header");
    if (!header) return;
    header.querySelector(".ds-auto-medkit-badge")?.remove();
    const s = statusInfo(api.library.status(item));
    const a = document.createElement("a");
    a.className = `ds-auto-medkit-badge ${s.cls}`;
    a.innerHTML = `<i class="${s.icon}" inert></i>`;
    a.dataset.tooltip = `<strong>${s.label}</strong><br>${s.hint}`;
    a.setAttribute("aria-label", s.label);
    if (mayUseMedkit()) {
      a.addEventListener("pointerdown", ev => ev.stopPropagation());
      a.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        openItemMedkit(item);
      });
    }
    header.insertBefore(a, header.querySelector(".window-title"));
  } catch (err) {
    console.warn(`${MODULE_ID} | badge`, err);
  }
}

Hooks.once("init", () => {
  registerSettings();
  Hooks.on("getHeaderControlsDrawSteelItemSheet", itemControls);
  Hooks.on("getHeaderControlsDrawSteelActorSheet", actorControls);
  Hooks.on("renderDrawSteelItemSheet", injectBadge);
  Hooks.on(SETTINGS_MENU_HOOK, addMaintenance);
});

// The suite's API exists once the core part has initialized (`dsAuto.init`); the medkit's own methods sit under `api.medkit`.
Hooks.once("dsAuto.init", api => {
  if (api) {
    api.medkit = {
      openItem: item => openItemMedkit(typeof item === "string" ? fromUuidSync(item) : item),
      openActor: actor => openActorMedkit(typeof actor === "string" ? fromUuidSync(actor) : actor),
      coverage: () => new CoverageReport().render({ force: true }),
      coverageData,
      customizedItems: () => customizedItems(),
      ItemMedkit, ActorMedkit, CoverageReport,
    };
  }
});

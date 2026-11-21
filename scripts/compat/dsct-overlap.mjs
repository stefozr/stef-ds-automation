/**
 * 1.2.2: Combat Tools switches that duplicate what the suite already does. The suite has priority and never changes a
 * Combat Tools setting by itself; this module only LISTS the switches that are on and, on the Director's click, turns
 * them off.
 *
 *   world   hiwEnabled (only while abilityAutomationEnabled is on), judgementAutomation, markAutomation
 *   client  autoApplyOwnAbilities (this Director's own client only)
 *
 * At `ready` the active GM sees one dialog (DialogV2) with the list. "Not now" stores a signature (Combat Tools version
 * + the sorted switch list) in the hidden world setting `ctOverlapDismissed`; the dialog comes back only when the
 * signature changes. The settings window's Maintenance tab and selfCheck show the same list.
 * i18n keys: DSAUTO.Overlap.*, DSAUTO.SelfCheck.ctOverlap.
 */
import { DSCT_ID, HOOKS, MODULE_ID, loc } from "../constants.mjs";
import { dsctActive, dsctSetting } from "./dsct.mjs";
import { error } from "../log.mjs";
import { setting } from "../settings.mjs";

/** The switch table: what Combat Tools does, and what the suite does instead. */
const SWITCHES = Object.freeze([
  { namespace: DSCT_ID, key: "hiwEnabled", scope: "world", labelKey: "DSAUTO.Overlap.hiw", suiteDoes: "DSAUTO.Overlap.hiwDoes", needs: "abilityAutomationEnabled" },
  { namespace: DSCT_ID, key: "judgementAutomation", scope: "world", labelKey: "DSAUTO.Overlap.judgement", suiteDoes: "DSAUTO.Overlap.judgementDoes" },
  { namespace: DSCT_ID, key: "markAutomation", scope: "world", labelKey: "DSAUTO.Overlap.mark", suiteDoes: "DSAUTO.Overlap.markDoes" },
  { namespace: DSCT_ID, key: "autoApplyOwnAbilities", scope: "client", labelKey: "DSAUTO.Overlap.autoApply", suiteDoes: "DSAUTO.Overlap.autoApplyDoes" },
]);

/** The Combat Tools switches that are on and duplicate the suite: `{namespace, key, scope, labelKey, suiteDoes}`. Empty without Combat Tools. */
export function overlapSwitches() {
  if (!dsctActive()) return [];
  const out = [];
  for (const { needs, ...entry } of SWITCHES) {
    if (needs && dsctSetting(needs, true) !== true) continue;
    if (dsctSetting(entry.key, false) === true) out.push({ ...entry });
  }
  return out;
}

/** "<Combat Tools version>|<sorted keys>": what a dismissal is tied to. */
export function overlapSignature(version, switches) {
  const keys = [...(switches ?? [])].map(s => `${s.namespace}.${s.key}`).sort();
  return `${version ?? ""}|${keys.join(",")}`;
}

/** The dialog is due: there are switches, and the stored dismissal is not this signature. */
export function overlapDue(switches, stored, version) {
  return !!switches?.length && stored !== overlapSignature(version, switches);
}

const ctVersion = () => game.modules?.get?.(DSCT_ID)?.version;

/** Plain-words HTML of the list. */
function dialogContent(switches) {
  const items = switches.map(s => `<li><strong>${loc(s.labelKey)}</strong>: ${loc(s.suiteDoes)}</li>`).join("");
  const client = switches.some(s => s.scope === "client") ? `<p><em>${loc("DSAUTO.Overlap.clientNote")}</em></p>` : "";
  return `<p>${loc("DSAUTO.Overlap.intro")}</p><ul>${items}</ul>${client}`;
}

/** Turn the listed switches off (world ones need a GM; the client one affects this client only). */
export async function turnOverlapOff(switches) {
  for (const s of switches) await game.settings.set(s.namespace, s.key, false);
}

/**
 * Show the dialog for the current list. `manual` (settings window): no dismissal is stored and an empty list says so.
 * @returns {Promise<"off"|"later"|null>}
 */
export async function showOverlapDialog({ manual = false } = {}) {
  const switches = overlapSwitches();
  if (!switches.length) {
    if (manual) ui.notifications?.info?.(loc("DSAUTO.Overlap.none"));
    return null;
  }
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return null;
  const answer = await DialogV2.wait({
    window: { title: loc("DSAUTO.Overlap.title") },
    content: dialogContent(switches),
    buttons: [
      { action: "off", label: loc("DSAUTO.Overlap.turnOff"), default: true, callback: () => "off" },
      { action: "later", label: loc("DSAUTO.Overlap.notNow"), callback: () => "later" },
    ],
    rejectClose: false,
  });
  if (answer === "off") await turnOverlapOff(switches);
  else if (answer === "later" && !manual) await game.settings.set(MODULE_ID, "ctOverlapDismissed", overlapSignature(ctVersion(), switches));
  return answer ?? null;
}

/** At ready, the active GM only: show the dialog when the list is new. */
export async function checkOverlapAtReady() {
  if (!game.users?.activeGM?.isSelf) return null;
  const switches = overlapSwitches();
  if (!overlapDue(switches, setting("ctOverlapDismissed"), ctVersion())) return null;
  return showOverlapDialog();
}

/** The labels of the list for selfCheck, "" when there is nothing. */
export function overlapSummary() {
  return overlapSwitches().map(s => loc(s.labelKey)).join(", ");
}

export function registerDsctOverlap() {
  Hooks.once("ready", () => {
    checkOverlapAtReady().catch(err => error("ctOverlap.ready", err));
  });
  // Maintenance tab of the settings window (ui/settings-menu.mjs collectMaintenanceEntries).
  Hooks.on(HOOKS.settingsMenu ?? "dsAuto.settingsMenu", registry => {
    try {
      registry?.addMaintenance?.({
        id: `${MODULE_ID}.ctOverlap`, label: "DSAUTO.Overlap.menuLabel", hint: "DSAUTO.Overlap.menuHint",
        icon: "fa-solid fa-clone", run: () => showOverlapDialog({ manual: true }),
      });
    } catch (err) {
      error("ctOverlap.menu", err);
    }
  });
}

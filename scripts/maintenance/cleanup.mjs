/**
 * Uninstall preparation, world data other than chat cards (Milestone 8, docs/M8-DESIGN.md §6.2). `api.cleanup` and the
 * settings window's "Cleanup report". Calling GM, who must be the active GM. Dry run by default: every row is reported
 * and nothing is written. Per row, `report` only counts; the action (when asked for) is:
 *   zones          dismiss  end each zone (our regions are deleted)
 *   untilEffects   convert  `duration.expiry` "dsAutoUntil" set to null and our flags dropped (the effect stays until
 *                           removed by hand)
 *   summons        dismiss  dismiss each summon (its tokens go)
 *   items          remove   our `dsAuto.*` special effects and our flags removed from items (customizations lost)
 *   folders        delete   the "Summons (ds-auto)" actor folder, only when it is empty
 *   nativeTargeted (report) native targeted condition effects of ours: left, they are the system's own representation
 * Never throws halfway: errors are collected. Fires `dsAuto.cleaned(report)`.
 *
 * i18n keys: DSAUTO.Cleanup.Progress, DSAUTO.Cleanup.Done.
 */
import { HOOKS, MODULE_ID, UNTIL_EXPIRY, loc } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { ZONE_END, endZone, listZones } from "../zones/registry.mjs";
import { REMOVAL, dismissSummon, listSummons } from "../summons/registry.mjs";
import { entrySources } from "../library/entries.mjs";
import { requireActiveGM } from "./strip.mjs";
import * as targeted from "../engine/targeted.mjs";

const ACTIONS = Object.freeze({
  zones: ["report", "dismiss"],
  untilEffects: ["report", "convert"],
  summons: ["report", "dismiss"],
  items: ["report", "remove"],
  folders: ["report", "delete"],
});

const forcedDeletion = () => new foundry.data.operators.ForcedDeletion();
const contentsOf = c => (c?.contents ?? (c ? [...c] : []));

/** Every actor of the world: world actors and the synthetic actors of unlinked tokens on every scene (deduplicated). */
function allActors() {
  const out = new Map();
  for (const a of contentsOf(game.actors)) if (a?.uuid) out.set(a.uuid, a);
  for (const scene of contentsOf(game.scenes)) {
    for (const t of contentsOf(scene?.tokens)) {
      const a = t?.actorLink ? null : t?.actor;
      if (a?.uuid && !out.has(a.uuid)) out.set(a.uuid, a);
    }
  }
  return [...out.values()];
}

/** Effects of ours whose end the module manages (`duration.expiry` "dsAutoUntil"). */
function untilEffects() {
  const out = [];
  for (const actor of allActors()) {
    for (const effect of contentsOf(actor.effects)) {
      const expiry = effect?._source?.duration?.expiry ?? effect?.duration?.expiry;
      if (expiry === UNTIL_EXPIRY) out.push(effect);
    }
  }
  return out;
}

/** Items with our flags or `dsAuto.*` special effects: world items and the items of every actor. */
function customizedItems() {
  const items = [...contentsOf(game.items)];
  for (const actor of allActors()) items.push(...contentsOf(actor.items));
  const out = [];
  for (const item of items) {
    const entries = Object.keys(entrySources(item));
    const flags = !!(item?._source?.flags?.[MODULE_ID] ?? item?.flags?.[MODULE_ID]);
    if (entries.length || flags) out.push({ item, entries, flags });
  }
  return out;
}

/** Our summons folders ("Summons (ds-auto)"). */
function summonFolders() {
  return contentsOf(game.folders).filter(f => f?.type === "Actor" && f.flags?.[MODULE_ID]?.summons);
}

function folderEmpty(folder) {
  const docs = folder?.contents ?? [];
  const children = folder?.children ?? [];
  return !(docs.length ?? docs.size) && !(children.length ?? children.size);
}

/** Native targeted effects of ours (engine/targeted.mjs nativeTargetedEffects). */
async function nativeTargeted() {
  try {
    const list = targeted.nativeTargetedEffects?.() ?? [];
    return Array.isArray(list) ? list : [...list];
  } catch (_err) {
    return [];
  }
}

const label = doc => doc?.parent?.name ? `${doc.parent.name}: ${doc.name ?? doc.id}` : (doc?.name ?? doc?.id ?? "");

/**
 * Report and (optionally) remove the module's world data beyond chat cards.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]
 * @param {"report"|"dismiss"} [options.zones="dismiss"]
 * @param {"report"|"convert"} [options.untilEffects="convert"]
 * @param {"report"|"dismiss"} [options.summons="report"]
 * @param {"report"|"remove"} [options.items="report"]
 * @param {"report"|"delete"} [options.folders="report"]
 * @returns {Promise<{dryRun, zones, untilEffects, summons, items, folders, nativeTargeted, errors}>}
 *   each row `{action, count, done, list?}`
 */
export async function cleanup({ dryRun = true, zones = "dismiss", untilEffects: untilAction = "convert", summons = "report", items = "report", folders = "report" } = {}) {
  requireActiveGM();
  const chosen = { zones, untilEffects: untilAction, summons, items, folders };
  for (const [row, action] of Object.entries(chosen)) if (!ACTIONS[row].includes(action)) throw new Error("DSAUTO.Relay.BadRequest");
  const zoneList = listZones({});
  const effects = untilEffects();
  const summonList = listSummons({});
  const itemList = customizedItems();
  const folderList = summonFolders();
  const native = await nativeTargeted();
  const report = {
    dryRun: !!dryRun,
    zones: { action: zones, count: zoneList.length, done: 0, list: zoneList.map(z => z.label ?? z.zoneId) },
    untilEffects: { action: untilAction, count: effects.length, done: 0, list: effects.map(label) },
    summons: { action: summons, count: summonList.length, done: 0, list: summonList.map(s => s.name ?? s.summonId) },
    items: { action: items, count: itemList.length, done: 0, list: itemList.map(r => label(r.item)) },
    folders: { action: folders, count: folderList.length, done: 0, empty: folderList.filter(folderEmpty).length },
    nativeTargeted: { action: "report", count: native.length, done: 0 },
    errors: [],
  };
  if (dryRun) {
    log("cleanup.dryRun", { zones: zoneList.length, untilEffects: effects.length, summons: summonList.length, items: itemList.length, folders: folderList.length, nativeTargeted: native.length });
    return report;
  }
  const work = [];
  if (zones === "dismiss") for (const z of zoneList) work.push(["zones", z.zoneId, async () => (await endZone(z.zoneId, ZONE_END.DISMISS, { quiet: true }))?.ended !== false]);
  if (untilAction === "convert") {
    for (const effect of effects) {
      work.push(["untilEffects", effect.uuid ?? effect.id, async () => {
        await effect.update({ "duration.expiry": null, [`flags.${MODULE_ID}`]: forcedDeletion() });
        return true;
      }]);
    }
  }
  if (summons === "dismiss") {
    for (const s of summonList) work.push(["summons", s.summonId, async () => (await dismissSummon(s.summonId, REMOVAL.DISMISS, { quiet: true }))?.error == null]);
  }
  if (items === "remove") {
    for (const { item, entries, flags } of itemList) {
      work.push(["items", item.uuid ?? item.id, async () => {
        const update = {};
        for (const id of entries) update[`system.effects.${id}`] = forcedDeletion();
        if (flags) update[`flags.${MODULE_ID}`] = forcedDeletion();
        await item.update(update);
        return true;
      }]);
    }
  }
  if (folders === "delete") {
    for (const f of folderList.filter(folderEmpty)) {
      work.push(["folders", f.uuid ?? f.id, async () => {
        await f.delete();
        return true;
      }]);
    }
  }
  let bar = null;
  try {
    bar = work.length ? ui.notifications?.info?.(loc("DSAUTO.Cleanup.Progress"), { progress: true }) : null;
  } catch (_err) { /* no progress bar */ }
  let n = 0;
  for (const [row, id, fn] of work) {
    try {
      if (await fn()) report[row].done++;
    } catch (err) {
      error("cleanup.item", err, { row, id });
      report.errors.push({ row, id, message: String(err?.message ?? err) });
    }
    n++;
    try {
      bar?.update?.({ pct: n / work.length, message: loc("DSAUTO.Cleanup.Progress") });
    } catch (_err) { /* ignore */ }
  }
  log("cleanup.done", Object.fromEntries(Object.keys(ACTIONS).map(k => [k, report[k].done])));
  try {
    ui.notifications?.info?.(loc("DSAUTO.Cleanup.Done", { count: n - report.errors.length }));
  } catch (_err) { /* ignore */ }
  Hooks.callAll(HOOKS.cleaned ?? "dsAuto.cleaned", report);
  return report;
}

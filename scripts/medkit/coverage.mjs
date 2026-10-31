/**
 * Coverage report: for every Item compendium with abilities, how many have library automation, how
 * many only the system's native power roll effects, how many nothing. Read only (overlays are virtual,
 * nothing needs to be written to the packs).
 */
import { MODULE_ID, coreApi } from "./shared.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export async function coverageData() {
  const api = coreApi();
  const out = [];
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    let index;
    try {
      index = await pack.getIndex({ fields: ["type", "system._dsid", "system.power.effects"] });
    } catch (_err) {
      continue;
    }
    const abilities = index.filter(e => ["ability", "feature", "ancestryTrait"].includes(e.type));
    if (!abilities.length) continue;
    const row = { id: pack.collection, title: pack.title, total: abilities.length, overlay: 0, native: 0, manual: 0, missing: [] };
    for (const e of abilities) {
      const dsid = e.system?._dsid || CONFIG.Item.documentClass.generateDSID?.(e.name);
      const key = `${e.type}:${dsid}`;
      const pres = Object.values(e.system?.power?.effects ?? {});
      const native = pres.some(p => ["damage", "applied", "forced"].includes(p?.type));
      if (api.library.has(key)) row.overlay++;
      else if (native) row.native++;
      else {
        row.manual++;
        row.missing.push(e.name);
      }
    }
    row.pct = Math.round((100 * (row.overlay + row.native)) / row.total);
    out.push(row);
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export class CoverageReport extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ds-auto-medkit-coverage",
    classes: ["ds-auto-medkit", "coverage"],
    window: { title: "DSMEDKIT.Coverage.Title", icon: "fa-solid fa-chart-simple", resizable: true },
    position: { width: 640, height: 560 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/medkit/coverage.hbs`, scrollable: [""] },
  };

  async _prepareContext() {
    const info = coreApi()?.library?.info?.() ?? { overlays: 0, sources: [] };
    return { packs: await coverageData(), info, sources: info.sources.map(s => `${s.id} (${s.overlays})`).join(", ") };
  }
}

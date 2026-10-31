/**
 * 1.0.0: the suite was three modules before (ds-auto-core, ds-auto-library, ds-auto-medkit). On the first load the
 * active GM imports their stored data (scripts/legacy-migration.mjs): world, user and client settings (the medkit's
 * `medkitRole` and `showBadge` included; the ledger is copied verbatim, its signatures do not cover the module id),
 * every `flags["ds-auto-core"]` scope, and here the zone region behaviors, whose type names the module
 * (`ds-auto-core.zone` -> `stef-ds-automation.zone`): a type cannot be updated, so each is recreated with its id.
 * `api.migrateLegacy({dryRun, force})` reruns it.
 */
import { MODULE_ID } from "../constants.mjs";
import { ZONE_TYPE } from "../library/schema.mjs";
import { registerLegacyMigration } from "../legacy-migration.mjs";

export const LEGACY_IDS = Object.freeze(["ds-auto-core", "ds-auto-medkit", "ds-auto-library"]);
const LEGACY_ZONE_TYPE = "ds-auto-core.zone";

/** Recreate each old-type zone behavior as ours (same id, name, system data and flags). */
async function migrateZoneBehaviors({ dryRun, report }) {
  for (const scene of game.scenes ?? []) {
    for (const region of scene.regions ?? []) {
      const old = (region._source.behaviors ?? []).filter(b => b.type === LEGACY_ZONE_TYPE);
      if (!old.length) continue;
      report.extra.push(`${region.uuid}: ${old.length} zone behavior(s)`);
      if (dryRun) continue;
      const data = old.map(b => {
        const copy = foundry.utils.deepClone(b);
        copy.type = ZONE_TYPE;
        if (copy.flags?.[LEGACY_IDS[0]]) {
          copy.flags[MODULE_ID] = { ...copy.flags[LEGACY_IDS[0]], ...(copy.flags[MODULE_ID] ?? {}) };
          delete copy.flags[LEGACY_IDS[0]];
        }
        return copy;
      });
      try {
        await region.deleteEmbeddedDocuments("RegionBehavior", old.map(b => b._id), { [MODULE_ID]: { internal: true } });
        await region.createEmbeddedDocuments("RegionBehavior", data, { keepId: true, [MODULE_ID]: { internal: true } });
      } catch (err) {
        report.errors.push({ uuid: region.uuid, error: err?.message ?? String(err) });
      }
    }
  }
}

export const legacy = registerLegacyMigration({
  moduleId: MODULE_ID,
  legacyIds: [...LEGACY_IDS],
  version: "1.0.0",
  extra: migrateZoneBehaviors,
});

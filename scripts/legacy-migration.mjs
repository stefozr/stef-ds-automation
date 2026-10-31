/**
 * One-time import of the data a module stored under its pre-1.0 id (or ids) into its current id.
 *
 * What moves, on the active GM at `ready` (once per world, remembered in the hidden world setting `legacyMigration`):
 * - world and user settings: each stored `<oldId>.<key>` whose `<newId>.<key>` is registered and not stored yet is
 *   copied verbatim (the serialized value, so no type conversion happens);
 * - document flags: every world document, and every embedded document at any depth (actors and their items and
 *   effects, unlinked token actors, chat messages, combats and combatants, scenes, tokens, regions, users, folders,
 *   journals...), that carries `flags.<oldId>` gets that scope under `flags.<newId>` (values already under the new id
 *   win) and loses the old scope;
 * - `extra(context)`: module-specific steps (setting values that name the old id, sheet classes, image paths...).
 * What moves on every client at `init`: its client settings in localStorage (`<oldId>.<key>` -> `<newId>.<key>`).
 *
 * Writes carry the update option `{[newId]: {legacyMigration: true}}`. Never throws: errors are collected and logged.
 * Rerun by hand with `api.migrateLegacy({dryRun: true})` (report only) or `api.migrateLegacy({force: true})`.
 */

const SETTING = "legacyMigration";

/**
 * @param {object} config
 * @param {string} config.moduleId            The current module id.
 * @param {string[]} config.legacyIds         The ids the module had before (flags and settings are read from them).
 * @param {string} config.version             Bumped when the migration itself changes, so it runs again.
 * @param {(ctx: object) => Promise<void>} [config.extra]  Module-specific steps. `ctx` has `dryRun`, `report`,
 *                                            `update(doc, changes)`, `allDocuments()` and `options()`.
 * @param {(key: string, legacyId: string) => string|null} [config.mapKey]  Renames a setting key on the way
 *                                            (return null to skip it). Default: the same key.
 * @returns {{migrate: (opts?: {dryRun?: boolean, force?: boolean}) => Promise<object>}}
 */
export function registerLegacyMigration({ moduleId, legacyIds, version, extra = null, mapKey = key => key }) {
  const tag = `${moduleId} | legacy migration`;

  Hooks.once("init", () => {
    game.settings.register(moduleId, SETTING, { scope: "world", config: false, type: String, default: "" });
    copyClientSettings(moduleId, legacyIds, mapKey, tag);
  });

  Hooks.once("ready", () => {
    if (!game.users?.activeGM?.isSelf || typeof game.settings?.storage?.get !== "function") return;
    if (game.settings.get(moduleId, SETTING) === version) return;
    migrate().catch(err => console.error(tag, err));
  });

  async function migrate({ dryRun = false, force = false } = {}) {
    const report = { dryRun, settings: [], documents: 0, extra: [], errors: [] };
    if (!game.user?.isGM) throw new Error(`${tag}: only a GM can migrate`);
    if (!force && !dryRun && game.settings.get(moduleId, SETTING) === version) return report;
    const options = () => ({ render: false, [moduleId]: { legacyMigration: true } });
    const update = async (doc, changes) => {
      if (dryRun) return true;
      try {
        await doc.update(changes, options());
        return true;
      } catch (err) {
        report.errors.push({ uuid: doc.uuid, error: err?.message ?? String(err) });
        return false;
      }
    };

    await copyStoredSettings({ moduleId, legacyIds, mapKey, dryRun, report });

    for (const doc of allDocuments()) {
      const changes = flagChanges(doc, moduleId, legacyIds);
      if (changes && await update(doc, changes)) report.documents += 1;
    }

    if (extra) {
      try {
        await extra({ dryRun, report, update, allDocuments, options });
      } catch (err) {
        report.errors.push({ step: "extra", error: err?.message ?? String(err) });
      }
    }

    if (!dryRun) await game.settings.set(moduleId, SETTING, version);
    const moved = report.settings.length + report.documents + report.extra.length;
    if (moved || report.errors.length) console.log(tag, report);
    if (moved && !dryRun) {
      const extra = report.extra.length ? ` and ${report.extra.length} other change(s)` : "";
      ui.notifications?.info(`${game.modules.get(moduleId)?.title ?? moduleId}: imported ${report.settings.length} `
        + `settings and data on ${report.documents} documents${extra} from ${legacyIds.join(", ")}. Reload (F5) to apply them.`,
      { permanent: true });
    }
    return report;
  }

  return { migrate };
}

/** Client settings live in this browser's localStorage under `<namespace>.<key>`. */
function copyClientSettings(moduleId, legacyIds, mapKey, tag) {
  try {
    const storage = game.settings?.storage?.get?.("client");
    if (!storage) return;
    for (const legacyId of legacyIds) {
      const prefix = `${legacyId}.`;
      for (let i = 0; i < storage.length; i++) {
        const stored = storage.key(i);
        if (!stored?.startsWith(prefix)) continue;
        const key = mapKey(stored.slice(prefix.length), legacyId);
        if (!key || storage.getItem(`${moduleId}.${key}`) !== null) continue;
        storage.setItem(`${moduleId}.${key}`, storage.getItem(stored));
      }
    }
  } catch (err) {
    console.warn(tag, "client settings", err);
  }
}

/** World and user settings are Setting documents; the serialized value is copied as it is. */
async function copyStoredSettings({ moduleId, legacyIds, mapKey, dryRun, report }) {
  const world = game.settings.storage.get("world");
  const Setting = foundry.utils.getDocumentClass("Setting");
  for (const legacyId of legacyIds) {
    const prefix = `${legacyId}.`;
    for (const doc of world.contents.filter(s => s.key?.startsWith(prefix))) {
      const key = mapKey(doc.key.slice(prefix.length), legacyId);
      const target = key ? `${moduleId}.${key}` : null;
      if (!target || !game.settings.settings.has(target)) continue;
      const user = doc._source.user ?? null;
      if (world.getSetting(target, user)) continue;
      report.settings.push(user ? `${target} (user ${user})` : target);
      if (dryRun) continue;
      try {
        await Setting.create({ key: target, value: doc._source.value, user });
      } catch (err) {
        report.errors.push({ setting: target, error: err?.message ?? String(err) });
      }
    }
  }
}

/** `flags.<legacyId>` merged under `flags.<moduleId>` (the current id wins) and the old scope removed. */
function flagChanges(doc, moduleId, legacyIds) {
  const flags = doc?._source?.flags;
  if (!flags) return null;
  const present = legacyIds.filter(id => flags[id] !== undefined);
  if (!present.length) return null;
  // Top-level keys only: a deep merge would expand keys that contain dots.
  const merged = {};
  for (const id of [...present, moduleId]) Object.assign(merged, foundry.utils.deepClone(flags[id] ?? {}));
  const changes = { [`flags.${moduleId}`]: merged };
  for (const id of present) changes[`flags.${id}`] = new foundry.data.operators.ForcedDeletion();
  return changes;
}

/**
 * Every world document and, recursively, every embedded document; unlinked tokens add their synthetic actor (whose
 * changes land in the token's delta). Invalid embedded documents are skipped.
 */
export function allDocuments() {
  const out = [];
  const seen = new Set();
  const visit = doc => {
    if (!doc?.uuid || seen.has(doc.uuid)) return;
    seen.add(doc.uuid);
    out.push(doc);
    for (const name of Object.values(doc.constructor.metadata?.embedded ?? {})) {
      const collection = doc[name];
      if (collection?.contents) for (const child of collection.contents) visit(child);
    }
    if (doc.documentName === "Token" && !doc.actorLink && doc.actor) visit(doc.actor);
  };
  for (const collection of game.collections.values()) {
    if (collection.documentName === "Setting") continue;
    for (const doc of collection.contents) visit(doc);
  }
  return out;
}

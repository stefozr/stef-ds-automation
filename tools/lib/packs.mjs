/**
 * Read Foundry LevelDB compendium packs from node. Packs are copied to `.cache/ldb` first (without the
 * LOCK file), so the tools work while Foundry runs and has the packs open.
 * `classic-level` comes from, in order: a `node_modules` next to or above the tools (Node's own lookup: the
 * repository's `node_modules` after `npm install`), `DS_AUTO_NODE_MODULES`, the repository root's `node_modules`, then the npx cache
 * (Windows `%LOCALAPPDATA%/npm-cache/_npx`, elsewhere `~/.npm/_npx`) (docs/M8-DESIGN.md §10.5).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadClassicLevel() {
  try {
    return (await import("classic-level")).ClassicLevel;
  } catch (_err) { /* not installed next to the tools */ }
  const dirs = [];
  if (process.env.DS_AUTO_NODE_MODULES) dirs.push(path.resolve(process.env.DS_AUTO_NODE_MODULES));
  // The repository root (REPO/tools/lib -> REPO/node_modules).
  dirs.push(path.resolve(HERE, "..", "..", "node_modules"));
  const npxCaches = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx") : null,
    path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx"),
    path.join(os.homedir(), ".npm", "_npx"),
  ].filter(Boolean);
  for (const npx of [...new Set(npxCaches)]) {
    if (fs.existsSync(npx)) for (const d of fs.readdirSync(npx)) dirs.push(path.join(npx, d, "node_modules"));
  }
  for (const d of dirs) {
    const entry = path.join(d, "classic-level", "index.js");
    if (fs.existsSync(entry)) return (await import(pathToFileURL(entry).href)).ClassicLevel;
  }
  throw new Error("classic-level not found: run `npm install` at the repository root (or `npm i classic-level` in tools/), "
    + "or set DS_AUTO_NODE_MODULES to a node_modules folder that has it");
}

function copyPack(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === "LOCK") continue;
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
}

/**
 * All documents of a pack, embedded documents attached as `__<collection>` arrays to their direct parent.
 * Keys nest to any depth (Milestone 7): `!actors.items!a.i` is item `i` of actor `a`, and
 * `!actors.items.effects!a.i.e` is effect `e` of that item (attached to the item, not the actor).
 * @param {string} packDir   The pack folder (LevelDB).
 * @param {string} cacheDir  Where to copy it.
 */
export async function readPack(packDir, cacheDir) {
  const ClassicLevel = await loadClassicLevel();
  const copy = path.join(cacheDir, "ldb", path.basename(packDir));
  copyPack(packDir, copy);
  const db = new ClassicLevel(copy, { valueEncoding: "json" });
  await db.open();
  const docs = new Map();
  // Every document by its full key ("actors!a", "actors.items!a.i"): parents of the next level.
  const byKey = new Map();
  const embedded = [];
  for await (const [key, value] of db.iterator()) {
    const [, coll, ids] = key.split("!");
    byKey.set(`${coll}!${ids}`, value);
    if (coll?.includes(".")) embedded.push([coll, ids, value]);
    else docs.set(`${coll}!${ids}`, value);
  }
  await db.close();
  for (const [coll, ids, value] of embedded) {
    const colls = coll.split(".");
    const idList = String(ids ?? "").split(".");
    const parent = byKey.get(`${colls.slice(0, -1).join(".")}!${idList.slice(0, -1).join(".")}`);
    if (!parent) continue;
    (parent[`__${colls.at(-1)}`] ??= []).push(value);
  }
  return [...docs.values()];
}

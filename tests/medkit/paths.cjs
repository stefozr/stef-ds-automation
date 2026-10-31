// Roots for the medkit's tests (docs/M8-DESIGN.md §10.5, D33). CommonJS so check.cjs requires it; harness.mjs loads it
// through createRequire. Since 1.0.0 the medkit is part of the suite: its scripts are scripts/medkit and its templates
// templates/medkit of the one module folder; the variables still move the roots.
//   DS_AUTO_MEDKIT      the module folder                 (default: this file's ../..)
//   DS_AUTO_CORE        the module folder                 (default: <medkit>)
//   DS_AUTO_LIBRARY     the folder with src/overlays, dist (default: <medkit>)
//   DS_AUTO_HANDLEBARS  a Handlebars module path (file or folder) used first by handlebars()
//   FOUNDRY_APP         a Foundry install's resources/app (Handlebars fallback; default on win32 only:
//                       C:/Program Files/Foundry Virtual Tabletop/resources/app)
// Folder constants that end in a separator (SCRIPTS, TEMPLATES, CORE_SCRIPTS, CORE_TESTS) are meant for `X + "file"`.
"use strict";
const path = require("path");

const MEDKIT = path.resolve(process.env.DS_AUTO_MEDKIT || path.join(__dirname, "..", ".."));
const CORE = path.resolve(process.env.DS_AUTO_CORE || MEDKIT);
const LIBRARY = path.resolve(process.env.DS_AUTO_LIBRARY || MEDKIT);
const DEFAULT_FOUNDRY_APP = "C:/Program Files/Foundry Virtual Tabletop/resources/app";

/** Handlebars: DS_AUTO_HANDLEBARS, then require("handlebars") (repo node_modules), then
 *  FOUNDRY_APP/node_modules/handlebars (default install path only on win32). Throws a clear message otherwise. */
function handlebars() {
  const tried = [];
  const attempt = (spec) => {
    tried.push(spec);
    try { return require(spec); } catch (err) {
      if (err?.code !== "MODULE_NOT_FOUND") throw err;
      return null;
    }
  };
  if (process.env.DS_AUTO_HANDLEBARS) {
    const hb = attempt(path.resolve(process.env.DS_AUTO_HANDLEBARS));
    if (hb) return hb;
  }
  const local = attempt("handlebars");
  if (local) return local;
  const app = process.env.FOUNDRY_APP || (process.platform === "win32" ? DEFAULT_FOUNDRY_APP : null);
  if (app) {
    const hb = attempt(path.join(path.resolve(app), "node_modules", "handlebars"));
    if (hb) return hb;
  }
  throw new Error(`Handlebars not found (tried: ${tried.join(", ")}). Run "npm install" at the repository root, or set ` +
    "DS_AUTO_HANDLEBARS to a handlebars module, or FOUNDRY_APP to a Foundry install's resources/app folder.");
}

module.exports = {
  MEDKIT,
  SCRIPTS: path.join(MEDKIT, "scripts", "medkit") + path.sep,
  TEMPLATES: path.join(MEDKIT, "templates", "medkit") + path.sep,
  CORE,
  CORE_SCRIPTS: path.join(CORE, "scripts") + path.sep,
  CORE_TESTS: path.join(CORE, "tests") + path.sep,
  LIBRARY,
  handlebars,
};

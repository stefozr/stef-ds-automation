// i18n audit of the three ds-auto modules (docs/M8-DESIGN.md §8.3; the M8 research script R4 §4.2, made a test).
//   node i18n-audit.cjs [--json] [--quiet]
// Roots from tests/paths.cjs (DS_AUTO_CORE, DS_AUTO_LIBRARY, DS_AUTO_MEDKIT); a missing module is skipped with a note.
// Per module: defined keys (lang/en.json), used keys (literals in scripts/**/*.mjs and templates/**/*.hbs, setting names
// and hints, `warnOnce("code")`, `reason:` / `code:` literals), keys proven by a dynamic prefix (template literals
// `PREFIX.${x}`, a literal that names a key group such as LOCALIZATION_PREFIXES, tests/i18n-dynamic.json) and
// hard-coded English in user-facing positions (notifications, `new Error` texts, UI properties such as title / label /
// content, DOM text assignments, HTML text in strings, .hbs text nodes and attributes). Tests are not scanned.
// Exit code 1 on a missing key or a hard-coded string (tests/i18n-dynamic.json `hardcodedAllow` lists the accepted
// ones); unused keys are warnings. check.cjs requires this file and uses `audit()` for the library and the medkit.
"use strict";
const fs = require("fs");
const path = require("path");

const PATHS = (() => {
  try { return require("./paths.cjs"); } catch {
    const CORE = path.resolve(__dirname, "..");
    return { CORE, LIBRARY: CORE, MEDKIT: CORE };
  }
})();
const { stripComments } = require("./check.cjs");
const DYNAMIC_FILE = path.join(__dirname, "i18n-dynamic.json");

const KEY_PREFIXES = ["DSAUTO", "DSMEDKIT", "TYPES"];
const KEY_RE = /["'`]((?:DSAUTO|DSMEDKIT|TYPES)\.[A-Za-z0-9_.\-]*[A-Za-z0-9_])["'`]/g;
const DYN_RE = /`((?:DSAUTO|DSMEDKIT|TYPES)\.[A-Za-z0-9_.\-]*)\$\{/g;
const ENGLISH = /[A-Za-z]{3,}\s+[A-Za-z]{2,}/;
const OWN_KEY = /^(DSAUTO|DSMEDKIT|USER|SETTINGS|TYPES|DRAW_STEEL|DOCUMENT|CONTROLS|COMBAT|PERMISSION|FILES)\./;

// Since 1.0.0 the core, the library content and the medkit are one module with one lang file (both prefixes).
function modules(roots = {}) {
  return [{ id: "stef-ds-automation", root: roots.core ?? PATHS.CORE, prefixes: ["DSAUTO", "DSMEDKIT"] }];
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".cache", "node_modules", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
function flatten(o, pre = "", out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out); else out[key] = v;
  }
  return out;
}
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

function loadDynamic() {
  try { return JSON.parse(fs.readFileSync(DYNAMIC_FILE, "utf8")); } catch { return {}; }
}

/** Values of a constant in a source text: `id: "x"` entries when present, the property names of an object, else every quoted word of an array. */
function constantValues(src, name) {
  const at = src.search(new RegExp(`\\b${name}\\s*=`));
  if (at < 0) return [];
  const open = src.slice(at).search(/[[{]/);
  if (open < 0) return [];
  let i = at + open;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "[" || src[i] === "{") depth++;
    else if (src[i] === "]" || src[i] === "}") { depth--; if (!depth) break; }
  }
  const block = src.slice(start, i + 1);
  const ids = [...block.matchAll(/\bid:\s*"([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
  if (ids.length) return ids;
  // An object constant (e.g. PROBLEM_TEXT): its property names, one per line.
  if (block.startsWith("{")) return [...block.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*):/gm)].map(m => m[1]);
  return [...block.matchAll(/"([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
}

/** The core's setting keys with name/hint (DEFINITIONS entries without `hidden: true`). */
function coreSettingKeys(settingsSrc) {
  const block = /const DEFINITIONS = \{([\s\S]*?)\n\};/.exec(settingsSrc)?.[1] ?? "";
  const starts = [...block.matchAll(/^ {2}([A-Za-z]+):\s*\{/gm)];
  const out = [];
  starts.forEach((m, i) => {
    const text = block.slice(m.index, starts[i + 1]?.index ?? block.length);
    out.push({ key: m[1], hidden: /\bhidden:\s*true\b/.test(text), menu: /\bmenu:\s*"([A-Za-z]+)"/.exec(text)?.[1] ?? null });
  });
  return out;
}

/**
 * Run the audit.
 * @param {object} [options]
 * @param {object} [options.roots]   {core, library, medkit} folders (default: tests/paths.cjs)
 * @param {object} [options.lang]    {<module id>: path of an en.json to use instead}
 */
function audit({ roots = {}, lang = {} } = {}) {
  const dyn = loadDynamic();
  const mods = modules(roots);
  const notes = [];
  const defined = {};          // key -> module id
  const perMod = {};
  for (const m of mods) {
    const file = lang[m.id] ?? path.join(m.root, "lang", "en.json");
    if (!fs.existsSync(file)) { notes.push(`${m.id}: no lang file at ${file} (skipped)`); m.skip = true; continue; }
    perMod[m.id] = flatten(JSON.parse(fs.readFileSync(file, "utf8")));
    for (const k of Object.keys(perMod[m.id])) defined[k] = m.id;
  }
  const used = new Map();      // key -> [where]
  const prefixes = new Set();  // proven dynamic prefixes (ending in ".")
  const hardcoded = [];
  const add = (k, where) => { if (!used.has(k)) used.set(k, []); used.get(k).push(where); };
  const allowHard = (dyn.hardcodedAllow ?? []);
  const isAllowed = (file, text) => allowHard.some(a => file.endsWith(a.file) && text.includes(a.text));
  const hard = (m, f, src, idx, kind, text) => {
    const rel = `${m.id}/${path.relative(m.root, f).split(path.sep).join("/")}`;
    if (isAllowed(rel, text)) return;
    hardcoded.push({ where: `${rel}:${lineOf(src, idx)}`, kind, text: text.slice(0, 120) });
  };

  for (const m of mods) {
    if (m.skip) continue;
    const files = [...walk(path.join(m.root, "scripts")), ...walk(path.join(m.root, "templates"))].filter(f => /\.(mjs|hbs)$/.test(f));
    for (const f of files) {
      const raw = fs.readFileSync(f, "utf8");
      const where = idx => `${m.id}/${path.relative(m.root, f).split(path.sep).join("/")}:${lineOf(raw, idx)}`;
      for (const mm of raw.matchAll(KEY_RE)) add(mm[1], where(mm.index));
      for (const mm of raw.matchAll(DYN_RE)) prefixes.add(mm[1].endsWith(".") ? mm[1] : `${mm[1]}.`);
      if (f.endsWith(".mjs")) {
        const src = stripComments(raw);
        for (const mm of src.matchAll(/\bwarnOnce\(\s*"([A-Za-z]+)"\s*\)/g)) add(`DSAUTO.Warning.${mm[1]}`, `${m.id} warnOnce`);
        for (const mm of src.matchAll(/\breason:\s*"([A-Za-z]+)"/g)) add(`DSAUTO.Reason.${mm[1]}`, `${m.id} reason`);
        for (const mm of src.matchAll(/\bcode:\s*"([A-Za-z]+)"/g)) add(`DSAUTO.Warning.${mm[1]}`, `${m.id} code`);
        // Hard-coded English in user-facing positions.
        for (const mm of src.matchAll(/ui\.notifications\??\.(info|warn|error)\??\.?\(\s*(["'`])([^"'`]*)\2/g)) {
          if (!OWN_KEY.test(mm[3])) hard(m, f, src, mm.index, `notify.${mm[1]}`, mm[3]);
        }
        for (const mm of src.matchAll(/new Error\(\s*(["'`])([^"'`]+)\1/g)) {
          if (!OWN_KEY.test(mm[2]) && /[A-Za-z]{3,}/.test(mm[2])) hard(m, f, src, mm.index, "Error", mm[2]);
        }
        for (const mm of src.matchAll(/\b(title|label|content|hint|flavor|alias|tooltip|placeholder|text|name)\s*:\s*(["'`])([^"'`\n]{3,})\2/g)) {
          const t = mm[3];
          if (OWN_KEY.test(t)) continue;
          const plain = t.replace(/\$\{[^}]*\}?/g, " ").replace(/<[^>]*>?/g, " ").trim();
          if (!ENGLISH.test(plain)) continue;
          hard(m, f, src, mm.index, `prop.${mm[1]}`, t);
        }
        for (const mm of src.matchAll(/\.(textContent|innerText|title)\s*=\s*(["'`])([^"'`\n]*)\2/g)) {
          const plain = mm[3].replace(/\$\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ").trim();
          if (/[A-Za-z]{3,}/.test(plain) && !OWN_KEY.test(mm[3])) hard(m, f, src, mm.index, `dom.${mm[1]}`, mm[3]);
        }
        for (const mm of src.matchAll(/>([^<>{}$`"\n]*[A-Za-z]{3,}[^<>{}$`"\n]*)</g)) {
          const t = mm[1].trim();
          if (t && ENGLISH.test(t) && !/=>|\?\.|\)\s*[;,]?$|^[\w.]+\(/.test(t)) hard(m, f, src, mm.index, "html", t);
        }
      } else {
        const stripped = raw.replace(/\{\{!--[\s\S]*?--\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
        for (const mm of stripped.matchAll(/\{\{\s*localize\s+["']([^"']+)["']/g)) add(mm[1], where(mm.index));
        for (const mm of stripped.matchAll(/data-tooltip=["']([A-Z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)["']/g)) add(mm[1], where(mm.index));
        const textOnly = stripped.replace(/\{\{[\s\S]*?\}\}/g, "");
        for (const mm of textOnly.matchAll(/>([^<>]*)</g)) {
          const t = mm[1].trim();
          if (/[A-Za-z]{2,}/.test(t)) hard(m, f, textOnly, mm.index, "hbs-text", t);
        }
        for (const mm of stripped.matchAll(/\b(title|aria-label|placeholder|data-tooltip|alt)=["']([^"'{]*[A-Za-z]{3,}[^"'{]*)["']/g)) {
          if (!/^[A-Z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(mm[2])) hard(m, f, stripped, mm.index, `hbs-attr.${mm[1]}`, mm[2]);
        }
      }
    }
  }

  // Core settings: name/hint of every entry that is not hidden; the menu's own keys.
  const core = mods.find(m => m.id === "stef-ds-automation");
  if (!core.skip) {
    const settingsFile = path.join(core.root, "scripts", "settings.mjs");
    if (fs.existsSync(settingsFile)) {
      for (const s of coreSettingKeys(fs.readFileSync(settingsFile, "utf8"))) {
        if (s.hidden) continue;
        add(`DSAUTO.Settings.${s.key}.name`, "settings (computed)");
        add(`DSAUTO.Settings.${s.key}.hint`, "settings (computed)");
      }
    }
  }
  // tests/i18n-dynamic.json: lists proven from a source constant (check.cjs verifies the constant matches).
  for (const d of dyn.dynamic ?? []) for (const v of d.values ?? []) add(`${d.prefix}${v}`, "i18n-dynamic.json");
  for (const k of dyn.consumedByFoundry ?? []) {
    if (k.endsWith(".")) prefixes.add(k); else add(k, "consumed by Foundry");
  }
  // A literal that names a key group (LOCALIZATION_PREFIXES, keyed(list, group)) proves the keys below it.
  for (const k of used.keys()) if (!(k in defined) && Object.keys(defined).some(d => d.startsWith(`${k}.`))) prefixes.add(`${k}.`);
  const proven = k => [...prefixes].some(p => k.startsWith(p));

  const ownerOf = k => mods.find(m => m.prefixes.some(p => k.startsWith(`${p}.`)))?.id ?? (k.startsWith("TYPES.") ? null : undefined);
  const missing = [];
  for (const [k, ws] of used) {
    if (!KEY_PREFIXES.some(p => k.startsWith(`${p}.`)) || k.startsWith("TYPES.")) continue;
    if (k in defined || proven(k)) continue;
    // A literal that names a group of keys is not a key itself.
    if (Object.keys(defined).some(d => d.startsWith(`${k}.`))) continue;
    const owner = ownerOf(k);
    if (owner && mods.find(m => m.id === owner)?.skip) continue;
    missing.push({ key: k, at: ws.slice(0, 3) });
  }
  const allowUnused = new Set(dyn.allowUnused ?? []);
  const report = {};
  for (const m of mods) {
    if (m.skip) continue;
    const keys = Object.keys(perMod[m.id]);
    report[m.id] = {
      defined: keys.length,
      used: keys.filter(k => used.has(k)).length,
      missing: missing.filter(x => ownerOf(x.key) === m.id),
      unused: keys.filter(k => !used.has(k) && !proven(k) && !allowUnused.has(k)),
    };
  }
  const crossAllowed = dyn.crossModule ?? [];
  const crossModule = [];
  for (const [k, ws] of used) {
    const owner = defined[k];
    if (!owner) continue;
    for (const w of ws) {
      const user = mods.find(m => w.startsWith(`${m.id}/`))?.id;
      if (!user || user === owner) continue;
      const ok = crossAllowed.some(c => c.module === user && k.startsWith(c.prefix));
      crossModule.push({ key: k, definedIn: owner, usedAt: w, allowed: ok });
    }
  }
  for (const c of crossModule) if (!c.allowed) missing.push({ key: c.key, at: [c.usedAt], crossModule: true });
  return { modules: report, missing, hardcoded, crossModule, prefixes: [...prefixes].sort(), notes };
}

module.exports = { audit, constantValues, coreSettingKeys };

if (require.main === module) {
  // DSAUTO_CHECK_SKIP_I18N=1 (M8 work packages, as in check.cjs): missing keys are reported, not counted.
  const SKIP = !!process.env.DSAUTO_CHECK_SKIP_I18N;
  const r = audit();
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else {
    for (const n of r.notes) console.log(`note: ${n}`);
    for (const [id, m] of Object.entries(r.modules)) {
      console.log(`${id}: ${m.defined} defined, ${m.used} used literally, ${m.missing.length} missing, ${m.unused.length} unused`);
      if (m.unused.length && !process.argv.includes("--quiet")) console.log(`  warn unused: ${m.unused.join(", ")}`);
    }
    for (const x of r.missing) console.log(`FAIL missing key ${x.key}${x.crossModule ? " (cross-module use not allowed)" : ""} at ${x.at.join(", ")}`);
    for (const h of r.hardcoded) console.log(`FAIL hard-coded ${h.kind} at ${h.where}: ${h.text}`);
    const allowedCross = r.crossModule.filter(c => c.allowed).length;
    if (allowedCross) console.log(`cross-module uses (allowed): ${allowedCross}`);
    if (SKIP && r.missing.length) console.log(`DSAUTO_CHECK_SKIP_I18N set: ${r.missing.length} missing key(s) not counted`);
    const n = (SKIP ? 0 : r.missing.length) + r.hardcoded.length;
    console.log(n ? `\n${n} problem(s)` : "\ni18n audit passed");
  }
  process.exit((SKIP ? 0 : r.missing.length) + r.hardcoded.length ? 1 : 0);
}

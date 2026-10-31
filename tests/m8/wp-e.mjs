// WP-E scenarios (docs/M8-DESIGN.md §12.1 H32-H33, §7 library `overlays`, §10.5 medkit paths, §10.6 dist freshness).
// H32  the library: tools/dist-check.mjs passes on the real library; on a copy, CRLF line endings still pass, one byte
//      changed in an overlay source fails, a version in module.json that differs from the dist header fails, a dist
//      without the hash header fails; scripts/main.mjs's `api.overlays` is a frozen copy and `reregister` works.
// H33  the medkit: its tests/check.cjs and tests/harness.mjs pass through tests/paths.cjs (sibling defaults and explicit
//      DS_AUTO_* variables); the harness covers the Maintenance entries (registered when the core fires
//      `dsAuto.settingsMenu`, none without it, as with a 0.9.x core).
// No new i18n keys in the core (library: none; medkit: DSMEDKIT.Maintenance.*, in its own lang file).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Run a node script; {status, out} (stdout + stderr). */
function runNode(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function firstJson(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = firstJson(p);
      if (f) return f;
    } else if (e.name.endsWith(".json")) return p;
  }
  return null;
}

export default async function (ctx) {
  const { mocks, assert } = ctx;
  const { paths, api } = mocks;
  const LIB = paths.LIBRARY;
  const MEDKIT = paths.MEDKIT;
  const distCheckFile = path.join(LIB, "tools", "dist-check.mjs");
  const dc = await import(pathToFileURL(distCheckFile).href);

  /* ---------- H32a: the real library's dist is fresh (CLI exit code) ---------- */
  {
    const r = runNode([distCheckFile, "--root", LIB]);
    assert.equal(r.status, 0, `dist-check on the library failed:\n${r.out}`);
    assert.match(r.out, /dist fresh: stef-ds-automation \S+, \d+ overlay files/);
    const version = JSON.parse(fs.readFileSync(path.join(LIB, "module.json"), "utf8")).version;
    const header = dc.parseHeader(fs.readFileSync(path.join(LIB, "dist", "overlays.mjs"), "utf8").split(/\r?\n/, 1)[0]);
    assert.ok(header, "dist/overlays.mjs has the src-sha256 header");
    assert.equal(header.version, version);
    assert.equal(header.hash, dc.srcHash(LIB).hash);
    assert.equal(dc.headerLine(header), dc.headerLine({ ...header }), "headerLine round-trips");
    assert.deepEqual(dc.parseHeader(dc.headerLine(header)), header);
    console.log("ok H32a dist-check passes on the library (header version = module.json, hash = src/overlays)");
  }

  /* ---------- H32b: a copy: CRLF passes, one byte fails, a version change fails, an old header fails ---------- */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ds-auto-wp-e-"));
    try {
      fs.copyFileSync(path.join(LIB, "module.json"), path.join(tmp, "module.json"));
      copyDir(path.join(LIB, "dist"), path.join(tmp, "dist"));
      copyDir(path.join(LIB, "src", "overlays"), path.join(tmp, "src", "overlays"));
      assert.equal(dc.checkDist(tmp).ok, true, "an unchanged copy passes");
      // DS_AUTO_LIBRARY selects the root as well as --root.
      assert.equal(runNode([distCheckFile], { env: { DS_AUTO_LIBRARY: tmp } }).status, 0, "DS_AUTO_LIBRARY root");

      const file = firstJson(path.join(tmp, "src", "overlays"));
      const original = fs.readFileSync(file, "utf8");
      // Line endings do not count (a Windows checkout and CI agree).
      fs.writeFileSync(file, original.replace(/\r?\n/g, "\r\n"));
      assert.equal(dc.checkDist(tmp).ok, true, "CRLF line endings give the same hash");
      // One byte changed.
      const i = original.indexOf('"version"');
      assert.ok(i >= 0, "the overlay has a version field");
      fs.writeFileSync(file, `${original.slice(0, i + 1)}V${original.slice(i + 2)}`);
      let r = dc.checkDist(tmp);
      assert.equal(r.ok, false, "one byte changed fails");
      assert.ok(r.problems.some(p => /src\/overlays changed/.test(p)), r.problems.join("; "));
      const cli = runNode([distCheckFile, "--root", tmp]);
      assert.equal(cli.status, 1, "the CLI exits 1");
      assert.match(cli.out, /dist stale/);
      fs.writeFileSync(file, original);
      assert.equal(dc.checkDist(tmp).ok, true, "restored");
      // A new overlay file counts too.
      fs.writeFileSync(path.join(path.dirname(file), "zz-extra.json"), "{}");
      assert.equal(dc.checkDist(tmp).ok, false, "an added source file fails");
      fs.rmSync(path.join(path.dirname(file), "zz-extra.json"));
      // module.json's version differs from the dist header.
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "module.json"), "utf8"));
      fs.writeFileSync(path.join(tmp, "module.json"), JSON.stringify({ ...manifest, version: "99.0.0" }));
      r = dc.checkDist(tmp);
      assert.equal(r.ok, false, "a version bump without a rebuild fails");
      assert.ok(r.problems.some(p => /module\.json says 99\.0\.0/.test(p)), r.problems.join("; "));
      fs.writeFileSync(path.join(tmp, "module.json"), JSON.stringify(manifest));
      // A dist of an older build (no hash) fails.
      const dist = fs.readFileSync(path.join(tmp, "dist", "overlays.mjs"), "utf8");
      fs.writeFileSync(path.join(tmp, "dist", "overlays.mjs"),
        dist.replace(/^[^\n]*\n/, `// Generated by tools/build.mjs from src/overlays (stef-ds-automation ${manifest.version}, Draw Steel 1.1.2). Do not edit.\n`));
      r = dc.checkDist(tmp);
      assert.equal(r.ok, false, "a header without src-sha256 fails");
      assert.ok(r.problems.some(p => /no src-sha256 header/.test(p)));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log("ok H32b dist-check on a copy: CRLF passes; a changed byte, an added file, a version bump, an old header fail");
  }

  /* ---------- H32c: scripts/content/main.mjs: api.content.overlays frozen copy, reregister ---------- */
  {
    const listeners = {};
    const onceOrig = Hooks.once;
    Hooks.once = (name, fn) => { (listeners[name] ??= []).push(fn); return fn; };
    const logOrig = console.log;
    const logged = [];
    try {
      await import(pathToFileURL(path.join(LIB, "scripts", "content", "main.mjs")).href);
      Hooks.once = onceOrig;
      assert.ok(listeners["dsAuto.init"]?.length, "registers on dsAuto.init");
      console.log = (...a) => logged.push(a.join(" "));
      listeners["dsAuto.init"][0](api);
      console.log = logOrig;
      assert.equal(logged.length, 1, "registered once");
      const lib = api.content;
      assert.ok(lib, "api set");
      const dist = (await import(pathToFileURL(path.join(LIB, "dist", "overlays.mjs")).href)).default;
      const a = lib.overlays;
      assert.ok(Object.isFrozen(a), "frozen");
      assert.equal(a.length, dist.length);
      assert.equal(lib.count, dist.length);
      assert.notEqual(a, dist, "not the live array");
      assert.notEqual(lib.overlays, a, "a fresh copy per read");
      assert.throws(() => a.push({ key: "ability:x" }), TypeError);
      assert.throws(() => { a[0] = null; }, TypeError);
      assert.throws(() => { lib.overlays = []; }, TypeError, "no setter");
      assert.equal(lib.overlays.length, dist.length, "unchanged after the attempts");
      api.library.unregisterSource("stef-ds-automation.library");
      assert.equal(api.library.has("ability:catch-breath"), false);
      const res = lib.reregister();
      assert.deepEqual([res.id, res.accepted, res.rejected], ["stef-ds-automation.library", dist.length, 0]);
      assert.equal(api.library.has("ability:catch-breath"), true, "reregister registers again");
    } finally {
      Hooks.once = onceOrig;
      console.log = logOrig;
      api.library.unregisterSource("stef-ds-automation.library");
      api.library.registerSource(mocks.LIB_SOURCE);
    }
    console.log("ok H32c library api.overlays is a frozen copy per read; reregister registers the built overlays again");
  }

  /* ---------- H33: the medkit's tests through its tests/paths.cjs ---------- */
  {
    const tests = path.join(paths.CORE, "tests", "medkit");
    const env = { DS_AUTO_CORE: paths.CORE, DS_AUTO_LIBRARY: LIB, DS_AUTO_MEDKIT: MEDKIT };
    const pc = runNode(["-e", "const p=require(process.argv[1]);console.log(JSON.stringify([p.MEDKIT,p.CORE,p.LIBRARY]))",
      path.join(tests, "paths.cjs")], { env: { DS_AUTO_CORE: "", DS_AUTO_LIBRARY: "", DS_AUTO_MEDKIT: "" } });
    assert.equal(pc.status, 0, pc.out);
    assert.deepEqual(JSON.parse(pc.out), [MEDKIT, MEDKIT, MEDKIT].map(p => path.resolve(p)), "every root defaults to the module folder");
    const check = runNode([path.join(tests, "check.cjs")], { cwd: os.tmpdir(), env });
    assert.equal(check.status, 0, `medkit check.cjs failed:\n${check.out}`);
    assert.match(check.out, /all checks passed/);
    const harness = runNode([path.join(tests, "harness.mjs")], { cwd: tests });
    assert.equal(harness.status, 0, `medkit harness.mjs failed:\n${harness.out.slice(-4000)}`);
    assert.match(harness.out, /ok maintenance entries/);
    assert.match(harness.out, /ALL MEDKIT TESTS PASSED/);
    for (const f of ["check.cjs", "harness.mjs", "paths.cjs"]) {
      const src = fs.readFileSync(path.join(tests, f), "utf8");
      assert.ok(!/["'`][A-Za-z]:[\\/](FoundryVTT|Users)[\\/]/.test(src), `${f}: no absolute local paths`);
    }
    console.log("ok H33 medkit check.cjs and harness.mjs green through tests/paths.cjs (Maintenance entries via dsAuto.settingsMenu)");
  }
}

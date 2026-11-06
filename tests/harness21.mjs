// Twenty-first harness (Draw Steel 1.2.0): class-scoped feature overlays. `class` on an overlay limits it to heroes of that
// hero class (essence: Elementalist / Summoner, ferocity: Fury / Beastheart share dsids); overlays without `class` are unchanged.
// Pure registry / schema / identity checks plus the shipped library; no Foundry world needed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.game ??= { modules: new Map(), settings: { get: () => undefined } };
const { registerSource, unregisterSource, findOverlay, overlaysFor, registryInfo } = await imp("library/registry.mjs");
const { validateOverlay } = await imp("library/schema.mjs");
const { actorClassDsid } = await imp("library/identity.mjs");

const heroOf = (cls, type = "hero") => ({ type, items: [], system: { class: cls ? { dsid: cls, system: { _dsid: cls } } : null } });
const feat = (dsid, actor) => ({ type: "feature", name: dsid, system: { _dsid: dsid }, actor });
const gain = { id: "g", event: "damage", amount: 1, label: "Gain on damage" };
const mk = (key, extra = {}) => ({ key, version: "1.0.0", name: key, effects: [], gains: [gain], ...extra });
let n = 0;
const run = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

const src = "h21";
registerSource({ id: src, priority: 90, overlays: [mk("feature:essence", { class: "elementalist" }), mk("feature:ferocity", { class: "fury" }), mk("feature:plain")] });
try {
  run("actorClassDsid reads system.class._dsid, fallback dsid, null without class", () => {
    assert.equal(actorClassDsid(heroOf("summoner")), "summoner");
    assert.equal(actorClassDsid({ system: { class: { dsid: "fury" } } }), "fury");
    assert.equal(actorClassDsid(heroOf(null)), null);
    assert.equal(actorClassDsid(null), null);
  });
  run("Elementalist hero gets feature:essence", () => {
    const a = heroOf("elementalist");
    assert.equal(findOverlay(feat("essence", a), a)?.class, "elementalist");
  });
  run("Summoner hero with an essence feature gets no overlay", () => {
    const a = heroOf("summoner");
    assert.equal(findOverlay(feat("essence", a), a), null);
  });
  run("Fury gets feature:ferocity, Beastheart does not", () => {
    const f = heroOf("fury"), b = heroOf("beastheart");
    assert.equal(findOverlay(feat("ferocity", f), f)?.class, "fury");
    assert.equal(findOverlay(feat("ferocity", b), b), null);
  });
  run("a hero whose class is unknown keeps the pre-1.2.0 behavior (the scoped overlay applies)", () => {
    const a = heroOf(null);
    assert.equal(findOverlay(feat("essence", a), a)?.class, "elementalist");
  });
  run("overlay without class applies to every hero class, unchanged", () => {
    for (const c of ["summoner", "elementalist", null]) {
      const a = heroOf(c);
      assert.ok(findOverlay(feat("plain", a), a), `class ${c}`);
    }
  });
  run("class-scoped overlays do not count as registry collisions", () => {
    registerSource({ id: "h21b", priority: 10, overlays: [mk("feature:essence", { class: "summoner", version: "1.0.1" })] });
    const a = heroOf("summoner"), e = heroOf("elementalist");
    assert.equal(findOverlay(feat("essence", a), a)?.class, "summoner");
    assert.equal(findOverlay(feat("essence", e), e)?.class, "elementalist");
    assert.equal(overlaysFor("feature:essence").length, 2);
    assert.ok(!registryInfo().collisions.some(c => c.key === "feature:essence"));
    unregisterSource("h21b");
  });
  run("schema: class validated (dsid shape, feature keys only, not with monster)", () => {
    assert.ok(validateOverlay(mk("feature:essence", { class: "elementalist" })).ok);
    assert.ok(!validateOverlay(mk("feature:essence", { class: "Not A Dsid" })).ok);
    assert.ok(!validateOverlay(mk("feature:essence", { class: 3 })).ok);
    assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", class: "fury", effects: [{ id: "n", type: "note", text: "t" }] }).ok);
    assert.ok(!validateOverlay(mk("feature:essence", { class: "fury", monster: ["m"] })).ok);
  });
  run("shipped library: essence is elementalist-only, ferocity fury-only", () => {
    const ov = JSON.parse(readFileSync(paths.LIBRARY_OVERLAYS + "elementalist/essence.json", "utf8"));
    const fu = JSON.parse(readFileSync(paths.LIBRARY_OVERLAYS + "fury/ferocity.json", "utf8"));
    assert.equal(ov.class, "elementalist");
    assert.equal(fu.class, "fury");
    assert.ok(validateOverlay(ov).ok && validateOverlay(fu).ok);
  });
} finally {
  unregisterSource(src);
}
console.log(`harness21: ${n} scenarios passed`);

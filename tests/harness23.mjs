// Twenty-third harness (Draw Steel 1.2.x): a heal effect's `recoveries` may be a formula ("1 + @spend", Breath of Dawn
// Remembered). Schema, planning (spend in the formula, clamped to the payer's remaining Recoveries, "noRecoveries" on 0),
// applying (the target pays), integer recoveries unchanged, and the shipped overlay.
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { registry } = await import("./harness12.mjs");
const { libraryOps } = await imp("engine/library-plan.mjs");
const { applyRecoveries } = await imp("engine/library-apply.mjs");
const { validateOverlay } = await imp("library/schema.mjs");
const { spendFromUse } = await imp("engine/spend.mjs");

const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
ds.utils.evaluateFormula = (f, rd) => {
  const src = String(f).replace(/@([A-Za-z_][A-Za-z0-9_.]*)/g, (_m, p) => {
    const v = getPath(rd, p);
    if (v === undefined || v === null || typeof v === "object") throw new Error(`no @${p}`);
    return `(${Number(v)})`;
  });
  if (!/^[\d\s+\-*/().]+$/.test(src)) throw new Error(`bad formula ${f}`);
  return Function(`return (${src})`)();
};

let n = 0;
const run = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };

const ally = {
  uuid: "Actor.h23ally00000001", name: "Ally", type: "hero", isMinion: false,
  system: { recoveries: { value: 5, max: 8, recoveryValue: 7 }, stamina: { value: 5, max: 60, temporary: 0 } },
  getRollData: () => ({ recoveries: { recoveryValue: 7 } }),
  async update(d) { for (const [k, v] of Object.entries(d)) { const p = k.split("."); let o = this; for (const x of p.slice(0, -1)) o = o[x]; o[p.at(-1)] = v; } return this; },
  async modifyTokenAttribute(_attr, amount) { this.system.stamina.value = Math.min(this.system.stamina.max, this.system.stamina.value + amount); },
};
registry.set(ally.uuid, ally);
const item = { uuid: "Item.h23breath0000001", name: "Breath", getRollData: () => ({ chr: 3 }) };
const tgt = { actorUuid: ally.uuid, tokenUuid: null, tier: null };
const plan = (effects, spend) => {
  const lib = { effects, config: {} };
  const { ops } = libraryOps({
    lib, item, targets: { t1: tgt }, selfKey: null, self: {}, use: { spend: !!spend, strained: false },
    assignment: null, decideMode: () => "auto", forcedRow: () => null, spend, noPowerRoll: true, warnings: [], order: 0,
  });
  return Object.values(ops);
};
const heal = recoveries => [{ id: "recover", type: "heal", recoveries }];
const reset = value => { ally.system.recoveries.value = value; ally.system.stamina.value = 5; };

await run("schema: formula or integer 1-5", () => {
  const ok = r => validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "a", type: "heal", recoveries: r }] }).ok;
  assert.ok(ok(1) && ok(5) && ok("1 + @spend") && ok("max(1, @spend)"));
  assert.ok(!ok(0) && !ok(6) && !ok("1 +") && !ok("eval(1)") && !ok(1.5));
});

await run("shipped overlay validates and uses the spend formula", () => {
  const o = JSON.parse(fs.readFileSync(`${paths.LIBRARY}/src/overlays/elementalist/breath-of-dawn-remembered.json`, "utf8"));
  assert.ok(validateOverlay(o).ok, validateOverlay(o).errors?.join("; "));
  assert.equal(o.key, "ability:breath-of-dawn-remembered");
  assert.equal(o.effects[0].recoveries, "1 + @spend");
  assert.equal(o.effects[0].spender, undefined);
});

await run("spendAmounts: the essence spent is the sum", () => {
  assert.deepEqual(spendFromUse({ spendAmounts: { spend00000000000: 2 } }), [2]);
  assert.deepEqual(spendFromUse({ spendAmounts: { spend00000000000: 0 } }), [0]);
});

await run("0 essence: the target pays 1 and heals 1x", async () => {
  reset(5);
  const [op] = plan(heal("1 + @spend"), [0]);
  assert.deepEqual([op.kind, op.recoveries, op.amount, op.status], ["heal", 1, 7, "pending"]);
  const r = await applyRecoveries({}, { targets: { t1: tgt } }, { ...op, targetKeys: ["t1"] });
  assert.equal(r.status, "applied");
  assert.deepEqual([ally.system.recoveries.value, ally.system.stamina.value, r.recoveriesSpent], [4, 12, 1]);
});

await run("no spend list at all behaves as 0", () => {
  reset(5);
  assert.equal(plan(heal("1 + @spend"), null)[0].recoveries, 1);
});

await run("2 essence: the target pays 3 and heals 3x", async () => {
  reset(5);
  const [op] = plan(heal("1 + @spend"), [2]);
  assert.deepEqual([op.recoveries, op.amount], [3, 21]);
  const r = await applyRecoveries({}, { targets: { t1: tgt } }, { ...op, targetKeys: ["t1"] });
  assert.deepEqual([r.status, ally.system.recoveries.value, ally.system.stamina.value, r.recoveriesSpent], ["applied", 2, 26, 3]);
});

await run("clamped to the payer's remaining Recoveries", () => {
  reset(2);
  const [op] = plan(heal("1 + @spend"), [3]);
  assert.deepEqual([op.recoveries, op.amount, op.status], [2, 14, "pending"]);
});

await run("a payer with 0 Recoveries is skipped (noRecoveries)", () => {
  reset(0);
  const [op] = plan(heal("1 + @spend"), [2]);
  assert.deepEqual([op.status, op.reason, op.amount], ["skipped", "noRecoveries", 0]);
});

await run("an invalid formula fails the row", () => {
  reset(5);
  const [op] = plan(heal("1 + @nothing"), [1]);
  assert.deepEqual([op.status, op.reason], ["failed", "formulaInvalid"]);
});

await run("integer recoveries are unchanged (spend ignored, no clamp at plan time)", () => {
  reset(5);
  const [op] = plan(heal(2), [4]);
  assert.deepEqual([op.recoveries, op.amount, op.status], [2, 14, "pending"]);
  reset(0);
  const [none] = plan(heal(1), null);
  assert.deepEqual([none.recoveries, none.status], [1, "pending"], "applyRecoveries refuses a payer with none");
});

console.log(`harness23: ${n} checks passed`);

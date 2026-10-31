/**
 * The suite's built-in ability library (formerly the separate module ds-auto-library): registers the built overlays
 * (dist/overlays.mjs, made by tools/build.mjs from src/overlays) as a library source when the core part initializes
 * (`dsAuto.init`).
 * API (`game.modules.get("stef-ds-automation").api.content`): `overlays` (a getter: a frozen shallow copy of the built
 * overlays, so a consumer cannot change what `reregister` registers; Milestone 8, D26), `count`, `reregister()`.
 */
import overlays from "../../dist/overlays.mjs";
import { MODULE_ID } from "../constants.mjs";

const SOURCE_ID = `${MODULE_ID}.library`;
const PRIORITY = 50;

Hooks.once("dsAuto.init", api => {
  if (!api?.library?.registerSource) return;
  const result = api.library.registerSource({ id: SOURCE_ID, overlays, priority: PRIORITY });
  console.log(`${MODULE_ID} | ${result.accepted} library overlays registered${result.rejected ? `, ${result.rejected} rejected (see the warnings above)` : ""}`);
  api.content = {
    get overlays() { return Object.freeze([...overlays]); },
    count: overlays.length,
    reregister: () => api.library.registerSource({ id: SOURCE_ID, overlays, priority: PRIORITY }),
  };
});

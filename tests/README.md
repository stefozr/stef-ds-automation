# Tests

Run from this folder with Node 20+ (no Foundry needed):

```
node check.cjs      # syntax, JSON, manifest paths, i18n coverage, import graph, libWrapper rules
node harness.mjs    # engine scenarios against mocked Foundry / Draw Steel APIs
node harness2.mjs   # delegation, lock mapping, private cards, hooks, late targets, template render
node harness3.mjs   # M1b: GM relay authorization, player buttons, mode overrides, two GMs, hidden numbers
node harness4.mjs   # M1.5: half damage, status immunity, surges, revival, api.applyDamage, delay, dialog
node harness5.mjs   # M2: turn dedupe, saves (auto / prompt / fallback), save-part and exit fixes, ongoing damage, until
node harness6.mjs   # M3: forced movement (Combat Tools form 3, undo log, fallback line), lock, edits, @spend, move cards
node harness7.mjs   # M4: ability library (registry, resolve, library rows, choices, teleports by owners, adoption, entries, keeper)
node harness8.mjs   # M5: triggers, holds, prompts, budget, trackers, roll lock
node harness9.mjs   # M6: summoning
node harness10.mjs  # M7: resources and zones (about a minute)
node harness11.mjs  # M8: runner of the work-package scenario files m8/wp-*.mjs and m9/*.mjs (node harness11.mjs wp-c runs one)
node harness16.mjs  # M9 WP-C: Persistent abilities (= node harness11.mjs persistent; tests/m9/*.mjs run by harness11 after the m8 files)
```

Paths (paths.cjs): since 1.0.0 the core, the library content and the medkit are one
module, so every root defaults to this repository. `DS_AUTO_CORE`, `DS_AUTO_LIBRARY`, `DS_AUTO_MEDKIT` still move
them (a copy of the module, for instance), `DS_AUTO_HANDLEBARS` picks a handlebars module (then
`require("handlebars")` after `npm install`, then `FOUNDRY_APP`/node_modules/handlebars, default
`C:/Program Files/Foundry Virtual Tabletop/resources/app` on Windows), `DS_AUTO_NODE_MODULES` (library tools).
`DSAUTO_CHECK_SKIP_I18N=1 node check.cjs` reports the i18n key problems without failing (M8 work packages until WP-D
merges every key); never set it globally, harness10 H42 expects a missing key to fail.

m8/ holds one scenario file per M8 work package (`wp-a.mjs` .. `wp-f.mjs`, each `export default async function (ctx)`
with `ctx = {world, mocks, assert, log, sw, asUser}`); harness11 skips a missing one with a note.
The medkit's tests live in `tests/medkit/` (`node medkit/check.cjs`, `node medkit/harness.mjs`; the harness reuses
this folder's mocked world).

From the repository root, `npm test` (`node tests/run-all.mjs`) runs every offline test in order: check, i18n
audit, harness 1-16, the medkit's check and harness, and the library's dist-check. `npm run test:list` lists them.

The mocks mirror the installed system 1.1.2 / Combat Tools 1.2.3 sources (0.16.0: harness13 mirrors Combat Tools
1.2.6's range exemption and area-picker preconditions; 0.17.0 retired the engine-seam checks with the path bridge); they do not replace a live run in Foundry.
harness2, harness8 and harness9 compile the template with the Handlebars that paths.cjs finds (by default the copy bundled in the Foundry install).
harness8 registers the real wave-2 overlays from ../src/overlays and runs every client in one process
(AsyncLocalStorage gives each client its own `game.user`); its prompt clock is manual (server time moves only when a scenario advances it).
harness9 builds its own Milestone 6 world on top of harness.mjs's (the mocks live in the file: per-client world actors,
unlinked token actors, a scene with a level and a scene rectangle, core's `placeTokens(create: false)` driven by
scripted clicks, an unlinked combat with groups and the system's turn events, Combat Tools' squad turns and Death
Tracker's cleanup stand-ins); it registers the six summon overlays of the library and requires `check.cjs` for its
reserved-names rule (requiring it runs no check).
harness10 builds the Milestone 7 world on harness9's mocks (copied into the file, every client in one process) and
registers every overlay of the library (175). Its own mocks: `CONFIG.RegionBehavior` and
`foundry.data.regionBehaviors.RegionBehaviorType` installed before `main.mjs` loads, regions with inline behaviors and
movement events (in / within / out, continued segments, pending waypoints, forced one-square updates, teleports) on
every client, the `moveToken` hook, core's `placeRegion(create: false)` driven by scripted clicks, `scene.grid`
geometry, `game.settings.set` with options, the system's world settings `heroTokens` / `malice` and their
`game.actors` getters, a scripted `foundry.dice.Roll`, the system's `takeDamage` model (wrapped) on heroes and
monsters, writers that fire `updateActor` / `updateCombatantGroup` with the writing user, `stamina.winded`,
`recoveries.recoveryValue`, `CONFIG.specialStatusEffects`, a `renderChatMessageHTML` DOM and `AbilityModel#use`.
H42 runs `check.cjs` on copies of `lang/en.json` with one dynamic key removed (`DSAUTO_CHECK_LANG`, with
`DSAUTO_CHECK_SKIP_SYNTAX` to skip the syntax pass). Never write `reason: "..."` or `code: "..."` literals in a test:
check.cjs scans every script, tests included, for reason and warning keys.

`node harness16.mjs` tests the 0.14.0 Persistent abilities (M9 WP-C): it runs harness11 with the scenario
`tests/m9/persistent.mjs` (P1-P12: the overlay field, the resolve record and the combat index, Keep with a free
re-roll and its chain, release, out of distance, cannot pay, timeout and offline owners, held conditions, Swarm of
Spirits' aura, the turn end with an open prompt, Keep-card undo, combat deletion). harness11's runner also loads
`tests/m9/<name>.mjs` after the m8 files (same `ctx`; a name argument picks from either folder). The other M9 work
packages extend existing harnesses: harness8 lists the M9 prompt types (`cleanseChoice`, `targetPick`,
`persistentUpkeep`, `persistentUpkeepCancel`) in its `promptTypes()` check, harness10 adds H50 (areas adopted at
resolve) and H51 (difficult terrain), and harness10 and harness12 assert 175 library overlays. `tests/run-all.mjs` runs harness16 too.

`node harness15.mjs` tests the 0.13.0 compact card: the Details fold of Target Damage's panel (rule, badge, toggle memory), the folded Combat Tools teleport message (expectations around `api.teleport`, tagging in preCreateChatMessage, swap, cancelled picker) and the compact / classic template.

`node harness14.mjs` tests Limerick native activation, real lifecycle and prompt handlers, owner routing, independent recovery decisions, Combat Tools coexistence, payment/refunds and Undo.

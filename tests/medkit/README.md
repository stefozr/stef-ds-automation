# Tests

Run from the module folder (or from `tests/medkit/`) with Node 20+ (no Foundry needed):

```
node tests/medkit/check.cjs     # syntax, manifest paths, i18n coverage, template renders
node tests/medkit/harness.mjs   # header controls, badge, item / actor windows, coverage, triggers / trackers, summons, resource gains / areas / villain actions, Maintenance entries (against stef-ds-automation's mocked world)
node tests/medkit/editor-browser.cjs # optional Chromium DOM/layout checks; requires Chromium and Foundry's installed stylesheet
```

Paths (`tests/medkit/paths.cjs`): the medkit is part of the suite, so every root defaults to the module folder
(scripts in `scripts/medkit`, templates in `templates/medkit`). Each root can be moved with an environment variable:

| Variable | What | Default |
|---|---|---|
| `DS_AUTO_MEDKIT` | the module folder holding `scripts/medkit` and `templates/medkit` | `tests/medkit/../..` |
| `DS_AUTO_CORE` | the module folder (its `tests/harness.mjs` world and `scripts/library/schema.mjs`) | `<medkit>` |
| `DS_AUTO_LIBRARY` | the folder holding `dist/overlays.mjs` | `<medkit>` |
| `DS_AUTO_HANDLEBARS` | a Handlebars module (file or folder), tried first | none |
| `FOUNDRY_APP` | a Foundry install's `resources/app` (Handlebars fallback after `require("handlebars")`) | `C:/Program Files/Foundry Virtual Tabletop/resources/app` on Windows only |
| `DS_AUTO_NODE_MODULES` | a `node_modules` with `classic-level` (the library's tools only, not these tests) | none |

`check.cjs` compiles the templates with Handlebars: `npm install` at the repository root provides it.

`editor-browser.cjs` uses the real editor and template with a mock world in headless Chromium.
It checks all nine effect types, draft-only editing, collapsed values, focus/scroll restoration,
stable disclosure IDs, effect-type changes, preset operations, validation and responsive layout.
Screenshots cover dark/light themes, a 430px-wide editor, a short viewport, effects and expanded settings.
Set `DS_AUTO_CHROME` to a Chromium executable, `FOUNDRY_APP` to the installed Foundry app directory,
or `DS_AUTO_EDITOR_ARTIFACTS` to choose an artifact directory. Defaults use the installed Chrome/Foundry
paths on Windows and a new temporary artifact directory. It never connects to or modifies a Foundry world.

Medkit 0.6.1 (2026-10-08): static checks, the Medkit harness and all eight Chromium fixture variants passed.
Screenshots were visually inspected. Live Foundry desktop verification remains pending because the
computer-use helper was unavailable during this run.

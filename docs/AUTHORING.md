# Authoring overlays

An overlay tells Stef's Automation Suite what an ability does that the system's own power roll
effects do not already describe. It is plain JSON in `src/overlays/<group>/<dsid>.json`, one file per
ability. `node tools/build.mjs` validates everything and writes `dist/overlays.mjs`, which the module
registers at startup. Nothing is ever written to anyone's items.

```
node tools/index-system.mjs   # once (and after a system update): index the system packs into .cache/
node tools/validate.mjs       # check src/overlays
node tools/build.mjs          # check + write dist/overlays.mjs and dist/coverage.md
node tools/dist-check.mjs     # is dist/overlays.mjs built from the current src/overlays? (no system data needed)
node tools/show.mjs <dsid>    # what the index knows about an ability (or feature:<dsid>)
```

`dist/overlays.mjs` is committed. Its first line carries the module version and a SHA-256 of `src/overlays`
(`src-sha256: ...`); CI runs `tools/dist-check.mjs`, which fails when an overlay source changed without a rebuild
or when `module.json`'s version differs from the one the dist was built for. So after any change to
`src/overlays` or to the version: `node tools/build.mjs`, and commit the dist with the change.
`dist/coverage.md` is a developer report (it lists adventure actors) and is not shipped in the release zip.

The index (0.4.0) also reads the class features (`classes` pack), the Delian Tomb's monsters and malice
features when that module is installed (`--extra-monster-packs a,b` to list other monster packs, paths
relative to the Data folder), and the actors of the Delian Tomb's and Road to Broadhurst's adventures
(`--adventure-packs a,b`; coverage report only). `--copy-dir <dir>` puts the pack copies it reads
somewhere else than `.cache/`. Abilities without a `_dsid` are keyed by the slug of their name, as the core
keys them (Dame Cornelia's "Parry!" is `parry`).

The schema is `the suite/scripts/library/schema.mjs` (the runtime checks overlays with the same
code). Read its header first; this file is the how-to.

## Rules

1. **No rules text.** `name` is the ability's own name (a title, required to match). `notes`, note
   `text`, `label`s and choice labels are short reminders in your own words, at most 200 characters,
   no markup. The validator fails any of them that shares 6 consecutive words with the ability's text.
2. **Only what is certain.** Automate a part only when the text leaves no judgement call. Anything
   conditional that the engine cannot check ("if the target is winded", "the first time", "if you
   moved", "until you take damage") is a `note`, or the effect gets `"manual": true` so it waits for a
   click. Better a reminder than a wrong application.
3. **Never duplicate native effects.** If the ability's power roll already has an `applied` effect for
   a condition (the index shows its power roll effects as `pres`), the core applies it per tier with
   potency already. Do not add it again. Damage in the tier lines is native too.
4. **Each overlay automates something.** At least one effect that is not a `note`, or a trigger or
   tracker (see **Triggers and trackers**), or resource gains, or a Persistent re-roll or hold
   (`persistent.keep` with `reroll` or `extend`; `manual` alone does not count). Do not write overlays
   that only remind.
5. **Skip** abilities Draw Steel: Combat Tools automates itself (its enhanced abilities, see below)
   and anything whose effect is mostly narrative. Triggered actions are in scope from 0.2.0:
   describe when they can react with `triggers`, not with effects. Summons are in scope from 0.3.0
   (`summon` effects, see **Summon effects**). Resource gains of class features and lasting areas are in
   scope from 0.4.0 (see **Resource gains** and **Zone effects**).
6. **Monsters get monster overlays.** From core 0.9.0 an NPC never borrows a generic (hero) overlay of
   the same key: write a monster overlay (`monster`) for a monster ability. The build lists the monster
   abilities that share a generic overlay's key and have none (a warning and a coverage section).

## Fields that decide who and when

- `targets`: `"targets"` (default: each target, on its own tier) or `"self"` (the ability's user, one
  row per card). Read the sentence: "the target" / "each enemy" = targets, "you" = self. From core
  0.14.0 also `"pick"` (a creature within N squares that is not a target, see **Target picks**) and
  `"area"` (the creatures inside the placed area, see **Allies in the area**).
- `filter`: `"allies"` or `"enemies"` restricts targets by token side ("each ally in the area").
- `tiers`: `[1]`, `[2, 3]`, ... when the text is in a tier line of the power roll. Text outside the
  tier lines (the effect paragraph) applies on any tier: leave `tiers` out. Abilities without a power
  roll (the index says `powerRoll: false`) must not use tiers. For `self` effects the card's tier is
  used (the highest when targets rolled different tiers).
- `byTier`: per-tier overrides of value fields (`{"2": {"value": 4}, "3": {"value": 6}}`).
- `when.spend: true`: only when the user spent their resource on the ability's "Spend" option (the
  card shows that special effect). `@spend` in formulas is the amount spent.
- `when.strained: true`: only when the Talent is strained (the card shows the Strained effect).
- `potency`: `{characteristic, value}` gates a condition, damage, forced move or teleport on targets:
  it applies when the target fails (`"@potency.weak|average|strong"` or a number).
- `choices` + `choice`: "choose one" options the card offers as buttons; rows of the unpicked options
  are skipped. Every option needs at least one effect (a note is fine for an option that stays manual).

## Effect types

| type | fields | notes |
|---|---|---|
| `condition` (also `until`: `yourNextTurnStart` / `yourNextTurnEnd`, the user's next turn, in combat) | `status` (bleeding, dazed, frightened, grabbed, prone, restrained, slowed, surprised, taunted, weakened, ...) or `effect` (the ability's own ActiveEffect id from the index) or `uuid` (a compendium effect), `end` (`turn` = EoT, `save`, `encounter`, `respite`) | `[[/apply <id>]]` with the ability's effect id -> `effect`; `[[/apply taunted turn]]` -> `status` + `end`. The ability's own effects keep their own duration unless `end` is given. Frightened, taunted and grabbed go through Combat Tools. |
| `heal` | `value` (formula) and `temporary`, or `recoveries` (n) with `spender` (`target` default, or `self`: the user pays and the target regains the user's recovery value) | "spend a Recovery and regain Stamina equal to your recovery value" = `recoveries: 1` (on whoever spends it). "regain Stamina equal to X" without spending = `value`. `[[/heal 10 type=temporary]]` = `value: 10, temporary: true`. `@target.<path>` reads the healed creature's own data. |
| `cleanse` | `statuses` and/or `ends` (`save`, `turn`, `encounter`, `respite`), `count` (null = all) | "end one effect that is ended by a saving throw or ends at the end of their turn" = `ends: ["save", "turn"], count: 1`. "stand up" = `statuses: ["prone"]`. With more candidates than `count`, the card asks which (core 0.14.0: the affected creature's owner is asked first, the Director for an NPC). |
| `resource` | `resource` (`surge`, `heroic`, `epic`, `recovery`), `value` | `[[/surge 2]]` = surge 2; `[[/gain 1 heroic]]` = heroic 1. Heroes (and retainers for recovery) only. |
| `forced` | `movement` (`push`, `pull`, `slide` or a list), `distance`, `vertical`, `ignoresStability`, `properties` (Combat Tools' `no-collision-damage`, `no-mover-collision-damage`, `no-obstacle-collision-damage`) | Only when the system has no forced effect for it. |
| `teleport` | `distance` (formula), `mode` (`normal`), `autoStart`, `hideAfter`, `hideWhileObserved`, `hideSurge` (0-3), `boost` (`{resource: "heroic" \| "surge" \| "epic", per (squares per point, default 1), max?, label?}`, self teleports only) | Self teleports: the owner picks the square on their screen. `autoStart` opens the picker in automatic mode. `hideAfter` offers an optional Hide after the recorded move; the observed exception applies only to that attempt. `hideSurge` grants surges only after confirmed success and respects resource mode. The opt-in flow requires `targets: self`. Extra squares bought with essence (1 per point) = `boost: {resource: "heroic", per: 1}`; the mover is asked in their teleport step, the Director checks the number and charges it once the teleport landed (Undo gives it back). |
| `damage` | `value`, `damageType`, `ignoredImmunities` | Only unconditional damage on use; damage from triggers stays a note. |
| `modifier` | `key` (an actor property: `system.damage.weaknesses.all` / `.<type>`, `system.damage.immunities.<type>`, the feature rules' movement, save and roll keys), `value` (formula, -50..50), `mode` (`add` default, `override`), `end` (`turnEnd`, `nextTurnEnd`, `nextTurnStart`, `sourceNextTurnStart`, `sourceNextTurnEnd`, `roundEnd`, `encounterEnd`; absent = stays until undone) | Damage weakness X lasting to the target's next turn end = `key: "system.damage.weaknesses.all", value: X, end: "nextTurnEnd"`. `nextTurnEnd` / `nextTurnStart` are the creature's own turn, `source*` the user's. Potency may gate it. Outside combat a modifier with an end only goes by Undo. One modifier per item, effect and creature: a second use replaces the first. Needs core 0.14.0; see **Modifiers**. |
| `note` | `text` | A reminder row on the card; never applied. |
| `summon` | `actors`, `quantity`, `distance`, `origin`, `side`, `turn`, `actsThisRound`, `squad`, `lasts`, `upkeep`, `carryStamina`, `lockOnZero` | Creatures that appear on the map; always on the user's own row. See **Summon effects**. |
| `zone` | `value`, `damageType`, `ignoredImmunities`, `zoneEvents`, `once`, `onceShared`, `perSquare`, `affects`, `exceptKeywords`, `exceptMonsters`, `shape`, `size`, `width`, `range`, `lasts`, `upkeep`, `forcedCounts` | A lasting area placed on the canvas that damages creatures entering it, moving in it or starting / ending a turn in it; always on the user's own row. See **Zone effects**. |

## Target picks

Needs (core 0.14.0). `targets: "pick"` with `pick: {count (1-5, default 1), within (squares, formula), of
("self" default: the user's token | "target": the card's first target), filter? ("allies" | "enemies"),
damageTypes? (damage effects only: the picker chooses one; then no `damageType`)}` — for "a creature within N
squares" that is not one of the ability's targets. The card shows a Pick row on the user's own row; the user's
owner is asked once after the card resolves (and after its choice-group option is picked), or presses Pick. The
Director checks the pick (inside `within`, on `filter`'s side, at most `count`, never the user) and resolves the
card again: the picked creature gets the effect's rows on the card's tier (a picked target keeps its own tier).
Not for summons, zones or notes. Example (The Green Within, the Green Without):
`{type: "forced", movement: "slide", distance: 2, targets: "pick", pick: {count: 1, within: 10, of: "target"}}`.
The validator warns on `pick.of: "target"` on a self-only ability.

## Allies in the area

Needs (core 0.14.0). `targets: "area"` (damage, heal, condition, cleanse, resource, note, modifier) = every
creature inside the area the use placed, never the user; `filter` as for targets ("each ally in the area" =
`targets: "area", filter: "allies"`). The creatures are noted when the area is placed (automatic areas, the
author's client); otherwise the card's own template is read; without either the card shows "area not found" and
those rows are left to the table. Use it for creatures that are not the ability's targets (an enemy-targeting area
that also helps allies). The validator warns on an ability without an area. Example:
`src/overlays/elementalist/test-of-rain.json` (a cleanse on the user and on each ally in the cube, each owner
choosing which effect ends).

## Modifiers

Needs (core 0.14.0). A `modifier` effect writes one ActiveEffect per creature (id from the item, the effect
and the creature), with the same keys as the feature rules' modifiers (`custom.mjs modifierKeyOk`). Give it an
`end` unless it should stay until Undo (the validator warns otherwise); `nextTurnEnd` ends at the end of the
creature's own next turn (in combat). The card row reads "<label> (+N)": give a short `label` in our words.
Example: `src/overlays/kits/weakening-brand.json` (damage weakness equal to the roll characteristic).

## Overlay fields

`key` (`ability:<dsid>`), `version` (`1.0.0`; bump on any change of behaviour), `name`, `notes` (what
stays manual, shown on the card), `native.suppress` (power roll effect ids the overlay replaces, for
data defects such as an applied effect meant for the user), `native.filter` (`"enemies"` or `"allies"`:
the system's own rows, damage included, only for targets of that side; the others stay on the card as
skipped. Awe: "if you target an enemy, you make a power roll"), `config` (options per item, set in the
medkit), `choices`, `effects`, `triggers`, `trackers` (below). `monster` (a list of monster keys: the
compendium uuid of the monster, or its name slug) makes an overlay monster-specific; its texts are linted
against that monster's ability. List the uuid **and** the slug: the uuid survives renamed adventure actors
(the Delian Tomb's "Queen Bargnot" is a Goblin Monarch), the slug covers hand-made copies. Delian Tomb
monsters are `Compendium.draw-steel-delian-tomb.monsters.Actor.<id>`.

From 0.4.0 (core 0.9.0): `gains` (a class feature's resource gains, **Resource gains**) and `npc: true`. An
NPC gets only monster-specific overlays of its ability's key; a generic overlay that is right for monsters
too opts in with `npc: true` (never together with `monster`). No shipped overlay sets it.

## Triggers and trackers

Needs (core 0.7.0). A trigger says when the ability can react and what it changes; the core asks
the owner (or the Director) with a countdown, holds the damage, roll or turn meanwhile, and records the
reaction on its own card (cost, the round's triggered action, undo). **A trigger overlay may have
`effects: []`**: what the ability does on its own card (a heal, a teleport) stays in `effects`, and a `use`
step posts that card. The trigger list is overlay-level data: it is not a special effect, and a detached
item keeps it in its detach stamp.

**Trigger** (`triggers`, at most 4 per overlay; the vocabulary is `the suite/scripts/triggers/taxonomy.mjs`):

| field | values | notes |
|---|---|---|
| `id` | 1-24 lowercase letters, digits, dashes | unique in the overlay |
| `event` | `damage.before`, `damage.after`, `roll.before`, `turn.start`, `turn.end`, `forced.before`, `move.before` | "takes damage" with a halving or potency change = `damage.before`; a reaction to damage taken = `damage.after`; "makes an ability roll" = `roll.before`; "ends their turn" = `turn.end` |
| `subject` | `self` (default), `ally`, `selfOrAlly`, `enemy`, `creature`, `selfOrCreature` | who the event happens to, seen from the reactor (token sides). Match the ability's target (the validator warns otherwise on damage and roll triggers); for "another hero" use `creature` with `require.subjectType: "hero"` |
| `attacker` | `any` (default), `creature`, `enemy` | damage events only: who must have dealt it ("a creature deals damage") |
| `free` | `true` | never use the round's triggered action. Leave it out: the item's type decides (`freeTriggered` is free). Needed on a trigger of an ability that is not a triggered action |
| `range` | `ability` (default), `unlimited`, a number or a formula | `ability` = the ability's own distance (melee / ranged primary, self = 0) |
| `loe` | `true` (default), `false` | line of effect from the reactor to the subject |
| `cost` | 0-10 | heroic resource paid on every use; default the item's own cost |
| `spend` | `{cost: 1-5, range?, label?}` | the ability's optional "Spend": the owner chooses it in the prompt; `range` when the spend extends the distance ("1 + @R") |
| `require` | `keywords` (the source ability has all, lowercase), `fromAbility: true` (damage from an ability card), `damaging: true` (roll of a damage-dealing ability), `subjectType` (`hero` / `npc`), `notStartedByThis: true` (turn.end), `meleeReach: true` (a melee + ranged strike counts only within its melee distance), `recoveries` (1-3, the reactor has that many) | what the engine can check; anything else stays a note |
| `label` | short text | prompt subtitle in our words |
| `steps` | 1-6 steps, at least one that is not a plain note (a note with `effect: true` counts) | |

**Steps** (`when: {spend: true|false}` limits a step to the spend or to no spend; two steps of one type must
differ in it; `halve` and `takeTurnNext` at most once):

| type | fields | events |
|---|---|---|
| `halve` | | `damage.before` |
| `potency` | `delta` (-3 to 3, not 0), `scope` (`all` default, `one`) | `damage.before` |
| `edge` | `amount` (1 = an edge, 2 = a double edge) | `roll.before` |
| `use` | `targets` (`subject` default, `source`, `none`: no preset target, a self ability on its user) | damage, `turn.start` and move events: posts the ability's own card (its `effects` apply there) |
| `freeStrike` | `by` (`subject` default, `reactor`) | damage events: a free strike against the attacker (melee, or ranged when the melee one does not reach) |
| `takeTurnNext` | | `turn.end` (required there: `turn.end` is offered only between heroes' turns, for Hesitation is Weakness) |
| `note` | `text`, `effect` (`true`: a real effect done by hand, such as a shift) | any event: a reminder row on the trigger's card (shifts, choices). A reaction whose only steps left are plain notes is not offered (e.g. its halving is moot because the hit is already halved); an `effect` note keeps it worth the triggered action |

**Tracker** (`trackers`, at most 2): `{id, effect, onZero: "retarget", endPrevious?, endOnSourceDying?, label?}`.
`effect` is the ability's own effect id and must be applied by a `condition` effect of the same overlay
that does not stack (a stacking copy gets a new id, which a tracker cannot follow).
When a creature with that effect from this source drops to 0 Stamina, the source's owner is asked to use
the ability on a new target; `endPrevious` (default `true`) ends the older effect when the ability is used
again; `endOnSourceDying` (default `false`) ends it when the source is dying (Mark).

**Spend with a use step** (core 0.14.0): a trigger with `spend` whose steps include `use` (the reaction uses the
ability) is paid by the ability itself: the prompt's spend tick opens the roll dialog with the ability's spend
effect ticked, the system charges it, and the overlay's `when: {spend: true}` effects appear on the card. The
ability needs its own spend special effect. If the spend adds only effects of the used ability (no extra trigger
step), add a spend-only `note` step (`when: {spend: true}`): a spend whose step list equals the base one is not
offered. Example: `src/overlays/censor/my-life-for-yours.json`.

Examples: `src/overlays/tactician/parry.json` (spend with a range, halve, potency, an `effect` note per spend choice),
`src/overlays/conduit/word-of-guidance.json` (edge or double edge by spend),
`src/overlays/shadow/in-all-this-confusion.json` (halve, then `use` posts the teleport card),
`src/overlays/censor/judgement.json` (tracker), `src/overlays/monsters/skitter.json` (a monster).

## Summon effects

Needs (core 0.8.0). A `summon` effect says which stat block appears, how many, where, on whose side,
when it acts and how long it stays. The core puts one **Summon** row on the user's own row (never applied
by itself, never part of "Apply all"): whoever clicks it (the summoner's owner, or the Director) picks
the squares on their canvas, the Director's client creates the tokens, adds them to a running combat
and removes them when their time is up. The ability's cost is spent by the system when it is used; the
row never spends it again.

| field | values | default | notes |
|---|---|---|---|
| `targets` | `"self"` only | `"self"` | a summon always sits on the user's row; anything else is an error |
| `actors` | 1-6 `{uuid, label?}` | required | the stat block(s): `Compendium.draw-steel.monsters.Actor.<id>`, or `Actor.<id>` (the world-relative link the pack text sometimes has) which the core maps to the monsters pack. Several = "choose one" (the clicker picks). `label` is short text in our words. The validator checks each uuid against the monsters pack |
| `quantity` | formula | `"1"` | how many; evaluated, floored and clamped to 1-10. A literal number must be 1-10. May vary by tier |
| `distance` | formula | the ability's own distance | "within distance" needs nothing; give it when the ability's distance is `special` or the summon has its own (adjacent = `"1"`) |
| `origin` | `self`, `target` | `self` | where `distance` is measured from: the summoner's footprint, or the card's first target's footprint |
| `side` | `summoner`, `hostile` | `summoner` | the summoner's token disposition and owners, or hostile (nobody owns it) |
| `turn` | `after`, `own`, `with`, `none` | `own` | `after`: takes its turn right after the summoner (the core chains it; held until then); `own`: a combatant of its side, activated as usual; `with`: same as `after` for now; `none`: no combatant |
| `actsThisRound` | `true`, `false` | `true` | whether it can act in the round it arrives |
| `squad` | `join`, `new`, `none` | `join` | minions only: join a squad of the same summoner and stat block that has not acted yet, or start one. Non-minions are never grouped (the validator warns when a non-minion has a squad) |
| `lasts` | a list of `summonerTurnStart`, `summonerTurnEnd`, `encounterEnd`, `summonerDying`, `zeroStamina`, `manual` | `["encounterEnd"]` | when it goes: the summoner's next turn start or end, the end of the encounter, the summoner dying, 0 Stamina (after a 2 s re-check), or only by hand (`manual` alone). Every summon has a Dismiss button anyway |
| `upkeep` | 1-10 or absent | none | Persistent cost in the summoner's heroic resource, asked at the summoner's turn start; needs `summonerTurnStart` in `lasts` (letting it go = the start-of-turn dismissal) |
| `carryStamina` | `true`, `false` | `false` | its Stamina carries over between uses in one encounter |
| `lockOnZero` | `true`, `false` | `false` | once it drops to 0 Stamina, the ability is locked until the hero earns a Victory |

Rules of thumb:
- **Two origins.** "within distance" = `origin: "self"`; "adjacent to the target" / "around the target" =
  `origin: "target"`, `distance: "1"` (distance counts from the footprint, so adjacent is 1). The validator
  warns when the ability targets a creature but the summon is measured from the summoner ("origin target?").
- Monster reinforcements are monster-specific overlays (`monster`), `turn: "own"`, `squad: "join"`,
  `lasts: ["encounterEnd"]`; Death Tracker takes care of the dead ones.
- `potency`, `filter`, `tiers` without a power roll: errors, as for other effects. Only `quantity`,
  `distance` and `label` can vary by tier.
- Write what the summon may do on its turn, "cannot regain Stamina" and usage limits in `notes`.

What stays manual (notes or the Dismiss button): Ravenous Horde (a delayed summon per hero), joining at
partial or winded Stamina, usage limits (once per encounter, not two rounds in a row), "cannot regain
Stamina", the Persistent damage break (Dismiss by hand), line of effect to the square, elevation (summons
appear at the summoner's), hexagonal grids, companions and clones.

Examples: `src/overlays/elementalist/summon-source-of-earth.json` (after the summoner, Persistent 2, Stamina
carried, locked at 0), `src/overlays/monsters/get-in-here.json` (two minions join a squad),
`src/overlays/monsters/an-army-from-blood.json` (adjacent to the target).

## Resource gains

Needs (core 0.9.0). A class feature's overlay (`key: "feature:<dsid>"`, the feature item's dsid from the
`classes` pack, `effects: []`) lists in `gains` the events that give the hero heroic resource (or surges):
"the first time each combat round you take damage, gain 1 ferocity". The core watches those events during a
combat, claims each rule once per round (or encounter), and adds an undoable **gain** row to the damage card
that caused it, or to a small gain card. The turn-start gain is the system's own; never repeat it. At most 6
rules per feature.

| field | values | default | notes |
|---|---|---|---|
| `id` | 1-24 lowercase letters, digits, dashes | required | unique in the overlay |
| `event` | `damage`, `forcedMove`, `abilityUse`, `naturalRoll`, `winded`, `heroDeath` | required | what happened |
| `once` | `round`, `encounter`, `each` | `round` | "the first time each combat round" = `round`; "the first time in an encounter" = `encounter`; every time = `each` |
| `resource` | `heroic`, `surge`, `epic` | `heroic` | |
| `amount` | 1-20, or dice `1d3` / `1d3 + 1` | `1` | dice are rolled when the row applies |
| `amountBy` | up to 4 `{feature, amount}` | none | upgrades that **replace** the amount when the hero has that feature (the highest present wins: Damaging Ferocity 2, Primordial Ferocity 3). The build checks the feature dsids |
| `taker` | `self`, `ally`, `selfOrAlly`, `enemy`, `creature`, `selfOrCreature`, `hero` | damage, winded, heroDeath: `self`; forcedMove: `selfOrCreature` | who took the damage / was moved / became winded / died (heroDeath: `self`, `hero`, `ally`, `selfOrAlly`) |
| `dealer` | `any`, `self`, `ally`, `selfOrAlly`, `enemy`, `director` | `any` | damage: who dealt it (`director` = an NPC, or a GM's card without a source) |
| `user` | `any`, `self`, `ally`, `enemy`, `hero`, `director` | `any` | abilityUse, naturalRoll: who used the ability / rolled |
| `takerEffect`, `dealerEffect` | `{ability, effect?}` | none | damage: the taker (or dealer) carries the effect of the gainer's ability (judged, marked): the ability dsid and its effect id from the index |
| `within` | 1-100 | none | squares from the gainer (the gainer itself always counts) |
| `withinAbility` | an ability dsid | none | abilityUse: the gainer's aura ability's distance is the radius (Null Field); not with `within` |
| `notTypes` | damage types, `""` = untyped | `[]` | damage: types that do not count (Essence: untyped and holy) |
| `minSurges` | 1-3 | none | damage: the hit carried that many damage surges |
| `category` | `heroic`, `signature`, `villain` | none | abilityUse: the ability's category |
| `actionType` | `main`, `maneuver`, `freeManeuver`, `triggered`, `freeTriggered`, `move`, `none`, `villain` | none | abilityUse: the ability's type |
| `costsMalice` | `true` | none | abilityUse: an NPC ability that spent Malice |
| `heroesInTurn` | 2-6 | none | abilityUse with `user: "hero"`: that many heroes used an ability this turn |
| `natural` | list of 2-20 | required for naturalRoll | the natural results |
| `loe` | `true`, `false` | `false` | naturalRoll: the roller must be in the gainer's line of effect |
| `states` | `winded`, `dying` | `["winded"]` | winded: which states count |
| `confirm` | `true`, `false` | `false` | the row waits for the Director (rules the engine can only approximate) |
| `label` | short text | required | the row's text, our own words (linted against the feature's text) |

A field that does not belong to the event is an error ("field `user` does not go with forcedMove").
Examples: `src/overlays/fury/ferocity.json` (damage with upgrades, winded or dying 1d3 per encounter),
`src/overlays/tactician/focus.json` (marked creature, an ally's heroic ability), `src/overlays/troubadour/drama.json`.
What stays manual: Conduit prayer and domains, Melodrama's extra events, the revival at 30 drama, Talent strain
damage, Mind Recovery's swap, the Shadow's cheaper cost, level-raised turn gains.

## Zone effects

Needs (core 0.9.0). A `zone` effect is a lasting area (Wall of Fire, Swamp Gas). The core puts one
**Area** row on the user's own row (never part of "Apply all"). With the core setting **Areas** on Automatic
(the default, core 0.14.0), the row is applied when the card resolves if the ability drew its area on use (the
system's cube, line or wall template) or the area is a burst or aura around the creator: the Director's client
copies the drawn area and deletes the template. Otherwise whoever clicks **Place** draws the area on their canvas
from the ability's distance (or reuses the card's own template); the Director's client checks it and creates a
region. A `size` larger than the drawn cube (strained Incinerate) is centred on it. Creatures that enter it, move in it or start / end a turn in it take the damage on a card of
their own (immunities, squads, triggers and gains apply), once per round per creature unless said otherwise.

| field | values | default | notes |
|---|---|---|---|
| `targets` | `"self"` only | `"self"` | |
| `value` | formula | required unless `terrain` is set | damage per hit, or per square with `perSquare` (0-200) |
| `damageType`, `ignoredImmunities` | as `damage` | untyped | |
| `zoneEvents` | `enter`, `move`, `turnStart`, `turnEnd` | `["enter", "turnStart"]` | "enters the area or starts their turn there" = the default; "for each square moved in the area" = `["move"]`; `enter` and `move` cannot be combined |
| `once` | `round`, `none` | `round` | `round`: entering hits once per round, a turn start once per turn; `none`: every trigger hits (`move` needs it) |
| `onceShared` | `true`, `false` | `false` | one hit per creature per round for every trigger together (the rules text keeps entering and starting a turn separate) |
| `perSquare` | `true`, `false` | `false` | `value` times the area squares the move crossed (or the creature occupies at its turn start / end) |
| `affects` | `enemies`, `allies`, `all` | `enemies` | relative to the creator's token; the creator itself is never hit |
| `exceptKeywords` | up to 4 lowercase monster keywords | `[]` | "each non-goblin" = `affects: "all", exceptKeywords: ["goblin"]` |
| `exceptMonsters` | up to 20 monster keys (uuids, slugs) | `[]` | monsters never hit, as `monster` lists them: for adventure monsters that lack the keyword (the Delian Tomb's goblins carry only `humanoid`) |
| `shape` | `ability`, `wall`, `cube`, `line`, `burst`, `aura` | `ability` | `ability` = the ability's own area distance; an ability without one needs a shape and `size` (the build fails otherwise) |
| `size`, `width`, `range` | formulas | the ability's distance | wall squares / cube side / line length / burst radius (1-30); line width (1-10); squares from the creator where it may be placed (wall, cube: the second distance number; line: the third; burst, aura: 0). `size` may vary by tier |
| `lasts` | as summons, the "summoner" being the area's creator | `["summonerTurnStart"]` | `zeroStamina` = the creator at 0 Stamina |
| `upkeep` | 1-10 or absent | none | Persistent cost asked at the creator's turn start (needs `summonerTurnStart`) |
| `forcedCounts` | `true`, `false` | `true` | forced movement and teleports into the area count as entering |
| `terrain` | `difficult` or absent | none | the creatures `affects` names treat the area as difficult terrain (ground moves cost double; fly, swim, burrow, jump, teleports and forced moves never pay). With `terrain`, `value` may be left out: the zone then deals no damage (core 0.14.0) |

`filter` and `potency` are refused on zones; only `value`, `size` and `label` vary by tier. The build warns
when `range` is larger than the ability's, when no listed monster carries an `exceptKeywords` keyword and when
an `exceptMonsters` key is no indexed monster. Examples: `src/overlays/elementalist/wall-of-fire.json` (per
square, Persistent 1), `src/overlays/talent/incinerate.json` (strained: a bigger area that ends with the turn),
`src/overlays/monsters/swamp-gas-dt.json` (spares the adventure's goblins by monster key),
`src/overlays/elementalist/unquiet-ground.json` (terrain only, until the encounter ends).
What stays manual: moving an area, Persistent's extra squares, conditions on entering, line of effect, adjacency
areas, gridless and hex scenes; difficult terrain for creatures the zone does not affect, and terrain that is not
tied to a zone. Overlapping difficult zones multiply (two of them cost ×4).

## Persistent abilities

Needs (core 0.14.0). An Elementalist ability with **Persistent N** can be kept at the user's turn start for
N essence. `persistent` (an overlay-level field) tells the core what keeping it does; the core asks the player,
pays, and does it.

| field | values | default | notes |
|---|---|---|---|
| `keep` | `"reroll"`, `"extend"`, `"manual"` or a list of one or two of them | required | `reroll`: the power roll again, free (no essence); `extend`: the use's effects last to the next keep decision (the durations that end at the user's next turn start); `manual`: only the Keep / Let it go prompt and payment, the table does the rest. `manual` stands alone. |
| `cost` | 1-10 | the ability's own Persistent value | only when the item's Persistent value is wrong |
| `targets` | `"recorded"`, `"area"` | `"recorded"` | with `reroll`: the use's own targets (still alive, within the ability's distance) or every enemy within the distance with line of effect (aura / burst abilities) |
| `note` | short text | none | required with `manual`: what keeping it does, in your words (shown in the Keep dialog) |

Rules:

- `extend` needs something to hold: a `condition` effect with `until` (`yourNextTurnStart` is held while kept;
  `yourNextTurnEnd` stays as written until the first Keep turns it into a held turn-start end) or an aura
  (`automation.aura`). Conditions without `until` (the ability's own duration, save ends) are left alone.
- Never on an overlay with a `summon` or `zone` effect: those keep themselves with their own `upkeep` (one prompt
  per thing kept).
- Heroes only: not with `monster` or `npc`. The ability must have the system's Persistent special effect; `reroll`
  needs a power roll. `targets: "area"` warns on an ability whose area is not an aura or burst; the `note` is
  licensing-checked.
- An ability whose own effect already ends where it should (a system duration that fits) needs no `extend`.
- What stays manual: options to re-use the ability as a maneuver, Recovery spending at the turn start, anything the
  text makes conditional (write it in `notes`).

Examples: `src/overlays/elementalist/the-flesh-a-crucible.json` (`effects: []`, roll again at the same target),
`swarm-of-spirits.json` (roll again at every enemy in the aura, the aura held: `keep: ["reroll", "extend"],
targets: "area"`), `no-more-than-a-breeze.json` (one held condition and a note), `subverted-perception-of-space.json`
(the native applied effect suppressed, tier 2 / 3 conditions held).

## Combat Tools enhanced abilities (skip unless only a kind it does not cover is missing)

apex-predator, black-ash-teleport (its flat effect covers the condition, not the teleport),
carving-dagger, defensive-roll, do-not-hesitate-in-the-wode, faith-is-our-armor, feedback-loop,
fire-up-the-night, fulfill-your-destiny, dsct-hide, my-life-for-yours, prescient-grace,
in-a-puff-of-ash, puppet-strings, revelator, dsct-search, sticky-bomb, wode-sickness. On items that
carry Combat Tools' own automation of a kind, the core drops library effects of that kind anyway. A
trigger is never covered by Combat Tools, so an enhanced triggered ability may get one (My Life for
Yours: its heal and cleanse apply only on a stock item).

## Examples

See `src/overlays/basic/*.json` (Catch Breath, Heal with a choice, Defend, Stand Up, Claw Dirt with a
suppressed native effect), `src/overlays/talent/iron.json` (target and self effects, strained),
`src/overlays/talent/awe.json` (ally filter, cleanse) and `src/overlays/shadow/black-ash-teleport.json`.
From 0.8.0: `src/overlays/kits/weakening-brand.json` (modifier), `src/overlays/elementalist/practical-magic.json`
(choices, a pick with a damage type, a teleport boost), `src/overlays/elementalist/the-green-within-the-green-without.json`
(a pick near the target), `src/overlays/elementalist/test-of-rain.json` (area allies, owner-side cleanse),
`src/overlays/censor/my-life-for-yours.json` (spend with a use step),
`src/overlays/elementalist/unquiet-ground.json` (difficult terrain) and
`src/overlays/elementalist/the-flesh-a-crucible.json` (Persistent re-roll).

## Generic feature rules

An overlay can provide `automation: {version: 1, rules: [...]}` with an empty `effects` list.
Use `feature:<dsid>`, `ancestryTrait:<dsid>` or `ability:<dsid>` as appropriate. The common rule schema
and supported modifier keys live in core's `scripts/library/custom.mjs`. The Medkit editor provides
item-local authoring and world presets without changing compendiums. Use the existing monster key
list (or explicit NPC opt-in) for monster content. Validate and rebuild after changing overlays;
`dist/coverage.md` includes a feature-rule section.

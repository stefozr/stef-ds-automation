# Changelog

All notable changes to Stef's Automation Suite for Draw Steel. Dates are YYYY-MM-DD.

## [1.0.0] - 2026-10-31

First public release. The three private modules **Draw Steel: Automation Core** (`ds-auto-core` 0.18.1),
**Draw Steel: Automation Library** (`ds-auto-library` 0.8.1) and **Draw Steel: Automation Medkit**
(`ds-auto-medkit` 0.7.0) are now one module, **Stef's Automation Suite for Draw Steel** (`stef-ds-automation`).

### Upgrading
- Enable this module and disable the three old ones. On the first load the active Director's client imports their
  data once: world, user and client settings (the card ledger included, so existing cards stay signed and their undo
  keeps working), every flag stored under `ds-auto-core` on chat cards, combats, combatants, tokens, regions,
  actors, items, effects, users and folders, and zone region behaviors (recreated as `stef-ds-automation.zone`).
  A notification lists what was imported; reload once afterwards.
- `api.migrateLegacy({dryRun: true})` reports what would be imported; `api.migrateLegacy({force: true})` runs it
  again.
- API: `game.modules.get("stef-ds-automation").api` replaces `game.modules.get("ds-auto-core").api` with the same
  methods. The library's API moved to `api.content` (`overlays`, `count`, `reregister()`) and the medkit's to
  `api.medkit` (`openItem`, `openActor`, `coverage`, `coverageData`, `customizedItems`). The `dsAuto.*` hooks are
  unchanged. Library entries register as the source `stef-ds-automation.library`.

### What the suite does
- Per-target resolution of ability cards: damage, healing, temporary Stamina and conditions at each target's own
  tier, with immunities, weaknesses, minion squads, potency, surges and half damage; a per-target summary and undo
  on the card; Target Damage and Combat Tools buttons locked once a result is applied.
- Turns: saving throws roll themselves (heroes are asked), ongoing damage ticks once per turn, "until" effects end
  on time, encounter effects end when a creature leaves combat.
- Movement: push, pull, slide and teleports through Combat Tools (or a straight line of its own), with undo.
- Ability library (175 entries, no rules text): conditions from the ability text, healing and Recoveries, surges and
  heroic resource, choose-one options, triggered actions (Parry, Inertial Shield, Word of Guidance and more) offered
  with a countdown, Judgement and Mark trackers, summons placed by the summoner's player, heroic resource gains from
  events, Malice and villain-action tracking, lasting areas such as Wall of Fire, target picks and Persistent
  abilities.
- Medkit: an Automation window on ability, feature and actor sheets, a custom automation editor with world presets,
  a coverage report and Maintenance entries.
- Settings window with twelve tabs, mode per creature type, self-check, Prepare to uninstall and a cleanup report.

### Changed
- Settings window: the Other modules tab lists Stef's Auto FX and Stef's Quality of Life Improvements instead of the
  library and medkit modules (they are built in now).
- Release: one `module.json` and `module.zip` per GitHub release, built by `.github/workflows/release.yml`.

### Fixed
- Medkit Automation window: the Library line showed "Â·" between the source and its version instead of "·".

## Before 1.0 (private development)

The entries below are the history of the three modules before they were merged, under their old names.

### Draw Steel: Automation Core (ds-auto-core)

#### 0.18.1

Checked against the Combat Tools family update of 2026-10-31: Combat Tools 1.2.8, ctlib 1.5.1 and Triggers 1.3.0
(still disabled). Death Tracker, Target Damage, Battle Log and the system are unchanged. Nothing we call broke. Details
are in docs/COMBAT-TOOLS-1.2.8.md.

Live-checked on 2026-10-31 (TESTING.md §28). Combat Tools 1.2.8, ctlib 1.5.1 and Triggers 1.3.0 are now in `VERIFIED`,
and ds-local-fixes 1.13.2 lists Combat Tools 1.2.8 in `DSCT_VERIFIED`.

- selfCheck's `unverifiedVersion` text points at the newest family live check in TESTING.md instead of §27.

- selfCheck's foreign-settings table shows Combat Tools' new `neutralFoesHostile` setting (on by default). With it on,
  Combat Tools turns Neutral NPCs Hostile when combat starts. Our zones, library and triggers read token dispositions,
  so those monsters now count as enemies.
- Comments only: Combat Tools 1.2.8 wraps `takeDamage` with a libWrapper WRAPPER, which runs outside our external-hold
  MIXED wrapper. Before, it was a reassignment inside our wrapper. On a full negate, cover immunity is now cleared
  twice, which is harmless.

#### 0.18.0

Adapts to the Combat Tools family update of 2026-10-30: Combat Tools 1.2.7, ctlib 1.5.0, Death Tracker 1.2.2, Battle
Log 1.5.0 and Triggers 1.2.0 (still disabled). Details are in docs/COMBAT-TOOLS-1.2.7.md.

Live-checked on 2026-10-30 (TESTING.md §27). The new versions are now in `VERIFIED`, and ds-local-fixes 1.12.1 lists
Combat Tools 1.2.7 in `DSCT_VERIFIED`.

- **Forced movement counts Combat Tools' extra squares.** Combat Tools now adds a target's `forcedMovementTaken`
  (Choking Dust, Unmooring and Water Wing give +2) before stability. Our checks count it too:
  - the stability refusal;
  - the length check of a player's pick, which before rolled a full-length pick back as `badDestination`;
  - the recorded `movedDistance`.
- **A move Combat Tools did not make is no longer recorded as applied.** Combat Tools 1.2.7 answers a fully resisted
  or self move with `noMove` and an empty undo log; before, it returned nothing. The row now ends `notMoved`, through
  the new shared check `dsctMoved`.
- **Combat Tools' Advanced Enrichers can't apply an automated card a second time.** This Combat Tools world setting
  is on by default and puts per-target faces and value chips in the card text:
  - The lock now also swallows a face, chip or link click that would repeat one of our applied (or held) ops for
    that target. An `[[/apply]]` chip is locked only by the same status or effect. Damage, healing, gain,
    forced-movement, teleport and cleanse chips are locked only by ops our library planned from the effect text.
    Extra text damage that our power-roll rows don't cover stays free; the live run found that the first,
    kind-wide rule blocked it.
  - A face Combat Tools applied itself can still be clicked, to undo it.
  - Locked faces and chips are dimmed and show the lock tip.
  - selfCheck warns with `advancedEnrichers` while the setting is on, because Combat Tools' own enricher auto-apply
    cannot be stopped by a click guard. It warns with `autoApplyOwn` while this client auto-applies its own abilities.
  - Enricher pushes pass our forced-movement gate. Holding them left a move that couldn't be undone.
- **Trigger range is 3D, as in ctlib 1.5.0.** `distanceSquares` takes the larger of the footprint gap and the
  vertical gap between the two token columns. ctlib's `range3d` switch turns it back to flat. Line of effect now
  follows ctlib's rule, which replaces the system's check for every module.
- **Battle Log 1.5.0 no longer logs our undo as a separate heal.** Undo stamina and squad-pool writes carry
  `dsblUndo: true`, so Battle Log cancels the hit instead.
- **The lock tooltip shows on Combat Tools buttons again.** ctlib's rich tips remove `data-tooltip`, so the lock text
  uses `ctlib.setTip` on elements that already have a rich tip.
- **selfCheck `dsctHandlers`.** It reports when another module takes over Combat Tools' forced movement or teleports
  (`registerForcedMovementHandler` / `registerTeleportHandler`).
- **Not changed (documented):**
  - Battle Log's new "Abilities" chat tab hides our standalone cards. Stay on "All".
  - Triggers 1.2.0 stays disabled.
- Tests: harness2 (enricher lock, `dsblUndo`); harness13 (`forcedMovementTaken`, `noMove`, 3D distance).

#### 0.17.1

- **No long pause before a card resolves while the Director's window is in the background.**
  - Dice So Nice doesn't animate in a hidden tab: it holds the roll until the tab is shown. The active GM waited
    for its own, never-played animation for the full 15 s cap before resolving ("Wait for Dice So Nice").
  - Table report: The Green Within, the Green Without rolled from the player window resolved 11-12 s after the roll.
  - Now a hidden Director asks the card's author to wait for the dice on their own screen (prompt `diceWait`,
    `relay/dice-wait.mjs`). There's no wait when the author is the Director or offline.
  - A visible Director waits on its own screen as before.
  - New log line `resolve.wait {how: "local" | "author" | "none", ms}`.
- Tests: harness4 (hidden Director, the author answering or timing out, an own roll, an offline author, the author's
  handler); harness8 prompt types.

#### 0.17.0

Table feedback of 2026-10-26 (TESTING.md §25). Works with ds-local-fixes 1.12.0 and ds-auto-library 0.8.1.

- **One surge dialog for damage and potency.**
  - Each damage row gets a dropdown (0-3) instead of a number field.
  - For an effect a target resisted by exactly one, the dialog also offers "Potency +1 (2 surges)", so for example
    Eviscerate can spend 2 on Bleeding and 1 on damage.
  - Options beyond the surges left are disabled, and the Director checks the total again. Before, rows over budget
    were dropped silently.
  - The 3-surge cap still covers damage only.
  - The card's ⚡ button uses a dropdown too. Its potency button and the dialog share one helper
    (`engine/surges.mjs potencySurgePatch`).
  - A potency spend on a forced move is written as pending and moves in the move phase.
- **Healing a defeated creature above 0 revives it.** New world setting **Revive when healed** (`reviveOnHeal`, on by
  default; `resources/revive-on-heal.mjs`).
  - Death Tracker marks NPCs dead and nothing lifted that on a heal. Now the Dead status, the defeated mark and the
    skull go through Death Tracker's `reviveTokens`.
  - Heroes, retainers and minions are left alone, and so is a creature killed at positive Stamina. Our own undo is
    marked and revives by itself.
  - `compat/death-tracker.mjs` revives a token once when two callers ask at the same time.
- **Forced movement through Combat Tools' picker, on the screen of whoever used the ability.**
  - Slides, "push or pull", vertical and flying moves (and setting `forcedPath` "choose") no longer open our path
    dialog. Combat Tools' canvas picker and its Vertical Distance window open for the user (prompt `forcedStep`,
    `delegation/forced-picker.mjs`). "Push or pull" asks Push / Pull first.
  - The Director picks when the user cannot (timeout, other scene) or when it is an NPC's ability.
  - A player's answer is checked: Combat Tools' `lastFmMoveId` on the target, the distance, and only undo entries
    that put back the Director's own snapshot (`cleanUndoLog`). A failed check puts the target back.
  - Straight pushes and pulls stay on `fastMove` with no picker.
  - The path bridge of 0.12-0.16 (`delegation/dsct-picked-path.mjs`) and its `forcedBridge` self-check row are
    removed.
  - Our dialog remains for moves without Combat Tools. It no longer shows a one-option movement select, and allows an
    upward pull towards a higher source.
- **Practical Magic.** A library choice option may name the Combat Tools choice that picks it (`dsctOption`,
  `library/choose-compat.mjs dsctPickedOption`). The card then takes Combat Tools' pick instead of asking again, and
  with Knockback the native push row runs by itself.
- Live run (TESTING.md §25, 2026-10-26): the surge dialog's potency row is a full-width checkbox label
  (`.ds-auto-surge-dialog`); a pending picked move reads "the path is picked on the canvas" (it said the Director picks).
- Tests (harness13 0.17.0 blocks):
  - the surge dialog;
  - forced picks: the Director's own pick, a cancel, a player's pick checked, a forged moveId, too far, a takeover,
    undo-log cleaning, push or pull;
  - choose picks answering a library group;
  - revive on heal.

#### 0.16.0

The Combat Tools 1.2.6 family (Combat Tools 1.2.6, ctlib 1.4.0, Death Tracker 1.2.1, Battle Log 1.4.1, Triggers 1.1.0);
see docs/COMBAT-TOOLS-1.2.6.md.

- **Forced movement moves again.**
  - A push or pull that needs no pick is carried out at once in Combat Tools' straight line (`fastMove`), as before
    0.12.0. Since 0.12.0 every forced row first opened our path dialog, and Apply with no square chosen moved
    nothing.
  - Slides, "push or pull" and vertical or flying moves keep the dialog. Its Apply stays disabled until a square,
    a vertical distance or a destination is chosen, and it shows the squares left. The Director may hand the move
    to Combat Tools' own picker.
  - The path bridge to Combat Tools' engine is gated on the verified versions and its two seams; otherwise it falls
    back to Combat Tools' picker (`pickFallback`) instead of failing. It was pinned to Combat Tools 1.2.3.
  - With Draw Steel: Triggers active, our moves skip its forced-movement hold (`bypassNextFmGate`).
  - New log lines: `forced.pick`, `forced.bridge`, `forced.refused`. New reason: "no path was chosen" (`pickEmpty`).
- **Melee-or-ranged abilities at range (Eviscerate).** Combat Tools measures them by their melee distance unless
  the card shows ranged damage, and it remembers its melee/ranged choice for 5 minutes. When every target is within
  the longer distance, our `use` wrapper now asks Combat Tools to skip its range check for that use
  (`api.allowOutOfRange`, log `use.rangeExempt`).
- **Area abilities with Combat Tools' area picker (Incinerate).**
  - When Combat Tools places the area itself, we no longer place a second one: its region becomes the use's area.
  - A use whose roll dialog another module vetoed never resolves. The next use of the same item now takes it over
    instead of being refused, so Combat Tools' re-entry reaches the dialog and the card is posted.
- **Cleanse (My Life for Yours).**
  - Ends are matched through the system's `effectEnds` and the legacy `system.end.type`.
  - Expired, disabled and Combat Tools bookkeeping effects are never ended.
  - A cleanse that found nothing lists what it saw (Director tooltip, log `cleanse.none`).
- **Resource gains.** A `gain.ledger` log line per matched gain, and the round slot in the Director's row detail. New
  world setting **Undone gains keep their slot** (`gainUndoKeepsSlot`, off by default).
- **Hero tokens reroll power rolls (house rule, off by default).** New world setting `heroTokenRerollPowerRolls`:
  hero ability cards get "Reroll (hero token)". It undoes the applied rows, spends a token through the system
  (spend type `dsAutoRerollPower`), rolls the 2d10 again for every target with its own modifiers, rebuilds the tier
  parts and resolves the card again. The token comes back if the reroll fails. Draw Steel 1.1.2 cards only.
- **Verified family versions.** `compat/version-gate.mjs VERIFIED`, `selfCheck()` rows `familyVersions` and
  `forcedBridge`, and the problem `unverifiedVersion`. The Director gets a warning once per client and version set.
  `module.json` recommends Combat Tools 1.2.6, ctlib 1.4.0, Death Tracker 1.2.1 and Battle Log 1.4.1.
- Adopted templates that Combat Tools deleted first are no longer reported as errors.
- Live check (TESTING.md §24) fixes:
  - The range exemption no longer outlives its use: a later use of the ability that does not qualify revokes it
    (`use.rangeExemptRevoked`). Before, any target was allowed for 60 s after an exempted use.
  - "Reroll (hero token)" is shown to the hero's owner who used the ability even after its rows were applied. It
    followed "Use my targets", which refuses players once anything is applied, so players never saw it.
  - A cleanse skipped while planning logs `cleanse.none` as well.
- harness13: straight push without a dialog, slide dialog, empty pick, unverified bridge fallback, Director-only
  Combat Tools picker, seams, range exemption, area picker adoption and vetoed uses, cleanse candidates, versions and
  banner, hero-token reroll. harness10 H10: slot kept on undo.

#### 0.15.0

- **"Choose one" in the Use Ability dialog** (`ui/use-choice.mjs`, `engine/use-choices.mjs`): an ability whose library
  automation has a choice group (Practical Magic, Primordial Bane, Time Bomb, Heal, ...) shows its options as radio
  buttons in the system's dialog; Use Ability stays disabled until every group has a pick (tooltip "Choose an option
  first"). The pick is noted when the dialog closes and seeded on the card (`choices.<group>.{picked, by}`, author's
  client, consumed once, like the dialog's spend); the resolve keeps it when the option exists and skips the other
  options' rows. The card keeps the group's buttons with the pick highlighted, changeable until a row of it is applied.
  Abilities with a Combat Tools `dsct.choose` effect keep Combat Tools' own prompt. The resolve now keeps who picked
  (`by`) on a re-resolve.

#### 0.14.2

- **Compact card clipping**: the one-line check now counts the chip next to the name (`ONE_LINE_CHARS` 18 → 20 with the
  chip; a "T2" row behaves as before). A "Resource gain" row's chip left its label no room, so only the icon showed; it
  now takes the two-line layout. A detail with less than 6em beside the label wraps under it instead of showing one
  letter and an ellipsis, and a one-line row's text never shrinks below 4.5em (the row wraps instead).

#### 0.14.1

Fixes from the Milestone 9 live run (TESTING.md §20-22, 2026-10-17):

- **Cleanse choice on a card's first resolve**: the Director asks the creature's owner before the card's record is
  written, so the owner's client found no row and answered "nothing" at once (the row then waited for its Apply). The
  prompt now carries the row's `statuses` / `ends` (checked like the other payload fields) and the owner's client reads
  the candidates from those.
- **Compact card status**: a pending or failed row shows one short word (Waiting, Confirm, Manual, Failed; keys
  `DSAUTO.Status.short.*`), the full status stays the tooltip. "Manual: apply when ready" squeezed the row's label into
  a narrow column.
- **Areas drawn half a square off the grid**: Draw Steel's cube preview can snap to an edge midpoint, so a 2-cube may be
  drawn half a square off the grid (its targets count on the edge). The zone copied from it now takes the grid position
  covering the card's targets (else the nearest one, as before); before it could leave the target outside.

#### 0.14.0

Milestone 9: seven ability-automation gaps (docs/M9-DESIGN.md). Needs ds-auto-library 0.8.0 for the new overlays
(175 in all).

Picks, areas and prompts to the affected creature (work package A):

- **Modifier rows** (library effect type `modifier`): an ActiveEffect that changes one actor property (damage
  weaknesses and immunities, speed, ... — the feature rules' allow-list, now with `system.damage.weaknesses.all`) on
  each target, applied and undone like a feature rule's modifier and ended by `end` (`nextTurnEnd` = the end of the
  creature's own next turn). A second use on the same creature replaces the first; Undo brings it back.
- **Target picks** (`targets: "pick"` + `pick: {count, within, of, filter?, damageTypes?}`): the card shows a Pick row on
  the user's own row; the Director's client asks an owner of the ability's user once (the card's author first, the
  Director without one; 122 s) and, when the effect lets the picker choose, the damage type. The Director checks the
  pick (range, side, count, never the user) and resolves the card again: the picked creature gets its rows on the
  card's tier (a picked target keeps its own). Unanswered: the row's Pick button opens the same picker. A reload never
  asks twice.
- **Allies in the area** (`targets: "area"`): the creatures inside the area the use placed get rows of their own (with
  `filter` as for targets). The author's client notes them when the area is placed (automatic areas); else the
  Director reads the card's own template; else a banner says the area was not found.
- **Cleanse choices by the affected creature's owner**: a cleanse row that may end fewer effects than the creature has
  is offered first to that creature's owner (an NPC: the Director), all such rows of one apply at once, 32 s. A choice
  is recorded with who made it; without an answer the row waits for its Apply as before.
- **A trigger's spend with a use step is paid by the system's dialog**: when the reactor ticks the spend in the prompt
  and the reaction uses the ability (My Life for Yours), the ability's roll dialog opens with its spend already ticked;
  the system charges it once and the card shows the spend rows. The trigger card charges nothing for it.
- **Teleport boost** (`boost: {resource, per, max?, label?}` on a self teleport): the mover's own teleport step (or the
  fallback picker) asks how many points to spend for extra squares; the Director checks the number, allows the longer
  move and charges a resource row that Undo gives back with the teleport.
- New prompt types `cleanseChoice`, `targetPick`; relay action `pick`; card kinds `modifier`, `pick` (crosshair icon).
- Detached entries: `dsAuto.modifier`; the pick fields (`pickCount`, `pickWithin`, `pickOf`, `pickFilter`,
  `pickDamageTypes`) and a teleport's boost (`boostResource`, `boostPer`, `boostMax`); `targets` offers pick and area.

Areas from the area drawn on use, difficult terrain (work package B):

- **Areas from the area drawn on use** (setting **Areas** on Automatic): when an ability already drew its wall, cube
  or line on use (Incinerate, Unquiet Ground, Wall of Fire with automatic areas), the card's **Area** row is applied
  when the card resolves, with no **Place** click. The Director's client copies the drawn area into the automation's
  own region and deletes the system template. The row reads "from the area drawn on use". A burst or aura built
  around its creator is applied at resolve too. If the template is already gone (Combat Tools removes it after
  5 s), the author's card carries the drawn position (positions only: sizes always come from the Director's client,
  and the position counts only if the author could have clicked Place on that row). A strained Incinerate centres
  its larger cube on the drawn one. An area out of range or off the scene leaves the row failed and **Place**
  working; with no drawn area the row waits for Place as before. **Ask** and **Manual** never apply it themselves.
- **Difficult terrain**: a zone may be difficult terrain (`terrain: "difficult"`) for the creatures it affects
  (enemies by default). Their ground moves (walk, crawl, climb) cost double on every client's ruler and movement.
  Flying, swimming, burrowing, jumping, teleports and forced movement never pay; Radical heroes keep ignoring it.
- **Terrain-only zones claim no credits**: a zone that deals no damage (terrain only, or a damage formula that
  evaluated to 0) never opens a tally or claims a hit credit.
- The row detail shows "difficult terrain for enemies" (and drops "hits enemies" on a zone that deals nothing).
- New record fields: `areaTemplate` (author seed, deleted once used), `ops.<id>.adopted` ("template" | "seed" | null);
  behavior field `terrain`.

Persistent abilities (work package C):

- **Persistent abilities** (setting **Persistent abilities** `persistentUpkeep`, Summons tab, on): a library overlay's
  new `persistent` field makes a Persistent use last. The resolve write records it on the card (`res.persistent =
  {cost, keep, targets, note, parent, free}`, a card banner says what keeping it does) and the active GM indexes it on
  the Combat (`flags["ds-auto-core"].persistent[messageId]`). At the user's next turn start their player gets the M6
  Keep / Let it go dialog with the countdown (`summonUpkeepSeconds`); nobody online: the Director's own dialog with
  `triggerFallback` "director", else a whisper and the use ends. Keep posts a small undoable card that spends the cost
  (heroic −cost; a constant turn gain such as the Elementalist's 2 covers it at 0 essence, as summons and zones).
  Not answered by the end of that turn, a cost that cannot be paid, or the end of the encounter: the use ends (a note
  card says why, quiet at the encounter end).
- **Keep: roll again** (`keep: "reroll"`, The Flesh, a Crucible): the power roll is made again for free on the
  player's client (the system's use dialog with the cost set to 0, the recorded target re-targeted, or every enemy in
  the area with `targets: "area"`); the new card is marked "no essence spent" and becomes the use's new entry, so the
  next turn asks again. A re-roll-only use with no target left within distance ends at the turn start without asking.
  A cancelled use dialog keeps the use (a note says the roll was not made).
- **Keep: extend** (`keep: "extend"`, No More Than a Breeze, Luminous Champion Aloft, Subverted Perception of Space,
  Magma Titan, The Green Defends Its Servants, Swarm of Spirits): conditions that last to the user's next turn start
  are held while the use is kept (a named hold on the until spec, `turn/until.mjs registerHold`), a condition that
  lasts to the end of the user's next turn is swapped to a held turn-start one on Keep, an aura (Swarm of Spirits) is
  held through the turn start and past the turn end once kept. Letting the use go ends the held effects (save-ends
  and base durations stay).
- The Green Defends Its Servants and Swarm of Spirits lose their dsid special cases (library-plan.mjs, auras.mjs):
  the overlays' `persistent` decides.
- Undoing a Keep card refunds the cost without ending the use (as summons and zones).
- New hook `dsAuto.persistentEnd` (active GM, `(entry, {reason})`); new prompt types `persistentUpkeep` /
  `persistentUpkeepCancel`; new relay action `persistent` (a re-roll's `useStarted` / `useCancelled` report, checked
  against the GM's own expectation); `triggerRun` kind `persistentUse`; selfCheck problem `promptPersistent`.
- harness16 (`node tests/harness16.mjs` = harness11's `tests/m9/persistent.mjs`); harness10 H50 (adoption) and H51
  (terrain); harness8 lists the four new prompt types; harness10 / harness12 assert 175 overlays.

Behaviour changes:

- Cleanse rows that need a choice are now asked of the affected creature's owner during automatic resolve and
  **Apply all**; those two (and a choice-group pick) no longer leave such rows out. An unanswered row comes back
  pending its choice.
- Swarm of Spirits with **Persistent abilities** off: a held spec is not held (ends as written) and a Persistent
  Swarm of Spirits ends at the end of its next turn (its unkept duration), no longer at the next turn start.
- A damaging zone whose formula evaluated to 0 no longer claims hit credits (it never dealt damage anyway).

Review fixes (cross-package review before release):
- A card resolved again (Use my targets, a pick, a forced re-resolve) keeps its Persistent record as it was: an old card
  re-resolved in a later encounter no longer starts a Keep/Release chain; the record names the combat it was made in.
- A cleanse row's owner prompt is asked once per row (`cleanseAsked`, kept across re-resolves); afterwards the row's
  own Apply lets the clicker choose, as before.
- A free re-roll whose use fails on the owner's client drops the Director's expectation, so the next paid use is not
  taken for the free one.
- A re-roll targets only the card's real targets (never picked-only or area-only creatures).
- The schema refuses an effect-level `filter` on a pick effect (the side goes in `pick.filter`).

Known limits:

- Practical Magic's Knockback option stays a reminder; My Life for Yours' turn-start trigger stays manual.
- A GM reload while a Persistent prompt is open loses that prompt (the next turn asks again).
- The medkit does not show or edit the overlay-level `persistent` field.
- Overlapping difficult zones multiply (two of them cost ×4).

#### 0.13.2

- Compact card: a long result label ("Spend 1 Recovery: +15 Stamina") no longer runs under the status mark. A target
  whose name and label do not fit one line takes the two-line layout; labels wrap inside their column; the status column
  is 48 px.

#### 0.13.1

- Compact card polish after the first live look (292 px sidebar): banner text wraps over the full width instead of
  squeezing beside its button; the status column ends at the same x on every row; a target without a tier shows a
  plain dash instead of a chip; the Details badge counts results once (Target Damage's quick and full Apply share an
  operation), ignores edge/bane pills and Death Tracker's buttons.

#### 0.13.0

- **Compact card** (client setting `compactCard`, on): the Automation section is the card's apply / undo surface,
  one line per target (18 px portrait, name, tier chip "T2", result, status icon with a short word only for waiting or
  failed rows, buttons); a target with several results gets one indented line per result. Details, squad members and
  the full tier label move to tooltips; the "Automation" header line is dropped (synthetic cards keep it). One
  template: the classic layout comes back with the setting off.
- **Details fold** (client setting `foldDetails`, on): on cards the automation resolved, Draw Steel: Target Damage's
  panel is folded under a **Details** button in the card's footer (with a count of the live buttons inside). It is never
  removed: Combat Tools' rows (forced movement, teleport, conditions, roll pills) and Update Targets stay one click away
  and stay locked where we already applied. The fold is a class on the message plus one CSS rule, so it survives Target
  Damage rebuilding its panel; open cards are remembered per message for the session. Supersedes the design's
  "never hide the panel" note (docs/DESIGN.md §B.12a).
- **Folded teleport message**: Combat Tools' own "X teleported N squares" message for a teleport our card ran is tagged on
  the client that created it (an expectation around our awaited `api.teleport`) and shrinks to one muted line. The
  card's row Undo puts the tokens back; it does not reverse what Combat Tools' undo log also restores (fall damage,
  statuses), so the folded message keeps Combat Tools' Undo Teleport behind a chevron. Teleports from Combat Tools' own
  buttons are not folded.
- New stylesheet `styles/ds-auto-compact.css`: relaunch the world once so the server serves the new manifest.
- harness15 covers the fold rule, the badge, the teleport expectations (match once, other token, scene, expiry,
  cancelled picker, swap) and the compact / classic template.

#### 0.12.4

- Teleports again open Combat Tools' teleport mode (its highlighted square picker) on the screen of the recipient's owner,
  for Black Ash Teleport and every other library, Judgement or recipient teleport. Since 0.12.0 they opened Automation Core's
  own destination dialog instead. The active Director still asks, records the move from Foundry's own report, refuses
  moves that are too far (or not closer, for the Exorcist teleport) and puts the token back. When the owner's client cannot
  pick (offline, timed out, other scene) the Director gets the picker. A cancelled pick leaves the row's Apply available.
  Automation Core's own destination dialog remains the fallback when Combat Tools' teleport is not available.
- harness7 runs its library teleports through the real owner path again; harness13 covers the Combat Tools path.

#### 0.12.3

- Revitalizing Limerick activates through native use and offers up to Presence recipients at the performer's turn end. Each owning player independently accepts or declines spending a Recovery, with Director fallback for offline owners.
- Accepted recovery offers commit immediately alongside Combat Tools, include clear healing/payment outcomes and support Undo. Selection limits, timeouts and duplicate events are covered by integration tests.

All notable changes to this module are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


#### [0.12.2] - 2026-10-09

- Clear the previous card reference when reserving a new turn's optional feature opportunity, preventing Gravitic Disruption from being blocked before movement selection.
- Recover already-blocked signed opportunity cards whose old message reference is missing, provided no other card records an applied effect for the same opportunity. Current successful claims still block other cards.
- Display aura activation and enhancement names, icons and the enhancement's expiry on chat cards, including existing cards.
- Verify live Gravitic damage prompt and movement chooser in the Director's Chrome session; decline test movement to preserve positions. Regression tests also cover Anchor's target-start effect, Synaptic aura boundaries and claim recovery/duplicate rejection.

#### [0.12.1] - 2026-10-09

- Attach automatically created aura regions to the caster token using Foundry's native attachment, and reuse the existing attached aura when the ability or chat Place Template is used again.
- Repair old Automation Core static aura regions on the active Director client's ready/canvasReady hooks: attach a lone region at the current caster position, or remove the old duplicate when a matching attached region exists. Unrelated templates and burst regions are preserved.
- Remove automatic aura visuals when the aura stops; cancelling a repeated use preserves its existing visual.
- Add regression tests for attachment data, chat/repeated-use deduplication, cancellation, repair and cleanup.

#### [0.12.0] - 2026-10-09

- Ask the ability user for forced movement and each recipient for teleport destinations; validate on the Director client, with offline/timeout fallback and optional decline.
- Offer attacker surges after the power roll, apply damage and payment together, and grant Shadow Insight from incorporated or native surge spending.
- Commit Revitalizing Limerick recovery healing with payment verification and refunds on failed healing.
- Grant I Work Better Off Alone before the roll when no other ally is adjacent to the target.
- Automate first-Judgement Oracle, Paragon and Exorcist benefits, with turn limits and dependent Undo.
- Track moving auras, Null Field upgrades, recipient entry/exit, overlapping modifiers, and aura interception.
- Remove temporary-Stamina-dependent effects when their pool is depleted or replaced; record restoration for Undo and Green Shield explosion damage.
- Add regression coverage in harness13; preserve installed system and Combat Tools files.


##### Added

- Version 1 item-local feature rules and independent world presets: on use, passive, damage taken,
  turn and round events, and extra melee strike damage. Rules support damage, healing, conditions,
  resource gains, forced movement, teleportation and managed attribute modifiers with recorded Undo.
- Automatic native area targeting before the roll: centered bursts and auras, one placement for aimed
  areas, replacement of stale targets, and cancellation cleanup.
- Feature and performance lifecycle, owner choices, shared Malice costs, frequency claims, temporary
  heroic-resource credits, and native roll/target restrictions for supported performances.


##### Fixed

- Combine feature restrictions and automatic area targeting into one ability-use wrapper, preventing
  libWrapper's duplicate-registration error during startup.
- Black Ash Teleport opens the owner's destination picker in automatic mode, offers its optional Hide while
  observed at eligible destinations, and grants one surge only after confirmed success. Record the Hide and reward
  for cascade Undo, preserving pre-existing hidden relationships and later changes.
- Restore the settings window's vertical navigation height under Foundry 14's grid layout and make tab labels and
  icons pass clicks to the tab anchor. Verified with the live GM session and Maintenance coverage report.
- Treat a region whose scene was deleted during encounter cleanup as already gone, including a concurrent parent
  deletion while the region delete request is pending.

#### [0.10.0] - 2026-10-08

Milestone 8: release hardening, completed offline. Live matrix results are tracked in TESTING.md.
Requires: Foundry 14.368, Draw Steel 1.1.2 (1.2 development builds: see README), libWrapper.

##### Added

- Per-card Draw Steel 1.2 targetResult reader with exact token matching, ambiguous-tier safety, squad grouping,
  per-target potency adjustments and per-part system button locks. Natural-roll gains count once per card.
- Native summon interception when the system exposes performSummon: owner-side placement, active-Director
  validation and the existing summon registry, ownership, squads, turn chain, dismissal and undo. The system's
  portfolio cost is not refunded by our Undo.
- Native frightened, taunted and grabbed effects, source defeat/revival handling, endTargeted API and a player-side
  frightened movement warning. No grabber-state or movement-following automation.
- Mode overrides by target creature category, including ongoing damage and zone hits; twelve-tab settings window
  with reset controls, Maintenance and medkit extension entries.
- Dry-run-first stripParts and cleanup APIs; readable synthetic cards after uninstall preparation.
- API version, module version, modeFor and GM-only diagnostics; frozen compatibility snapshots.
- Portable harness paths, harness11 covering WP-A through WP-F, cross-module i18n audit, release tooling and
  explicit ship lists, API/coexistence/uninstall documentation, and the unrun T122-T153 live matrix.

##### Changed

- Automatic targeted conditions use Combat Tools when enabled, otherwise the native builder.
- The active Director migrates heroOverride once to modeByActorType; the legacy fallback stays for this minor version.
- World settings move into the dedicated window; the plain list retains enabled and the two client options.
- dump, request, triggers.offer and zones.hit are deprecated GM-gated forwards to api.debug (removal in 0.11.0).
  Raw internal relay actions require an explicit internal option on debug.request.
- Code is MIT with a centrally stamped MCDM independence notice. System verification remains 1.1.2.

##### Fixed

- Behavior probes gate the system save-card and exit fixes; exit cleanup still removes our until effects on fixed builds.
- Delegated targeted-condition Undo restores replaced effects, including native copies.
- Non-active Director resource/villain resets throw rather than silently refusing; player calls keep returning false.
- Self-check problems and unknown relay failures are localized.
- Final integration routes deprecated request through debug.request, refusing players before relay authorization.

##### Removed

- Dead utilsPerformSummon probe and unused zoneGone translation key.

#### [0.9.1] - 2026-10-07

fixes from the Milestone 7 live run

Findings of TESTING.md §14 (library 0.4.1 and medkit 0.4.1 carry their wording parts).

- **Squad pool lost update (T107).** Two zone hits on different members of one squad at once both read the same
  pool value, so one hit was lost (13 -> 12 instead of 11). The Stamina queue (`turn/ongoing.mjs`, used by
  ongoing damage and zone hits) is now keyed per Stamina pool: `staminaKey(tokenUuid)` is `group:<uuid>` for a squad
  member, the token otherwise.
- **A held summon's activate (T116).** The tracker's button raises a combatant at initiative 0 to its turns count
  instead of lowering it, so a player's click on a summon held after its summoner went to the server and was
  refused ("lacks permission to update Combatant"). `summons/activate.mjs` now also vetoes and relays a player's
  raise from 0. The GM answers SummonHeld before SummonCannotAct, so the toast reads "This summon acts right after
  its summoner."
- **Malice reminder Use stuck (T111).** When another module vetoes the system's ability dialog (Combat Tools'
  range check against the Director's current targets), the system's `use()` never resolves. The Use button
  stayed disabled for good. Now it comes back after 4 s with "<name>: its dialog did not open …" (`DIALOG_WAIT_MS`,
  on the prompt clock); an open dialog is still waited for.
- **Hero tokens (T103).**
  - The card's banner reads "Waiting for Test" (the hold marker carries `kind: "heroToken"`).
  - After an undone spend, a re-ask answered "Take the hit" skips the earlier spend's row ("not spent this time",
    no Apply button) instead of leaving it pending.
- **Wording.**
  - "1 square placed" / "N squares placed", "Wall of fire (1 square)", "+1 surge" / "+2 surges", "+1 hero token".
  - A dice gain row shows "rolled N" only while applied.
  - The Malice card shows the `api.malice.adjust` reason ("Malice pool (live test)").
  - The zone upkeep dialog logs as `zone.upkeepDialog`.
- **Self-check.** A problem line when the viewed scene's grid distance is not 1 (areas and the system's own templates
  are sized in squares × distance pixels; scene Start is 5 ft).
- **Docs.**
  - docs/M7-DESIGN.md §6.7: the recovery after "Undo Last Activation" erased a gain is "add the amount back
    on the sheet, leave the row" (Release + re-apply nets 0).
  - The README limits now say this too.
  - TESTING.md §2i: Borin's actor id, Grid Distance 1, the `keepId: false` second import, the tracker-style
    squad activation, a wall for T117, and summon after the chain is on (T116).
- harness10 H49 (a-e). H49a and H49b fail with the old code.

#### [0.9.0] - 2026-10-07

Milestone 7, resources and zones

Design `docs/M7-DESIGN.md` (revision 2). Requires ds-auto-library 0.4.0 for the content (ds-auto-library 0.4.0
requires this version).

- **Resource gains** (`resources/rules.mjs`, `facts.mjs`, `gains.mjs`, `gain-card.mjs`, `stamina-watch.mjs`): `gains`
  rules on `feature:<dsid>` overlays; facts from our own damage and forced moves (a step at the end of `applyOpList`),
  from Stamina and squad-pool changes the active GM saw land (Target Damage application records, `takeDamage` reports
  that only add type and source), Combat Tools pushes, ability cards, natural rolls, winded / dying crossings and hero
  deaths. Op kind **`gain`** (undoable; ledgers `eventGains` / `eventGainsEncounter` on the Combat; auto rows claim
  synchronously, waiting rows claim nothing). Undoing a damage or forced row also undoes the gains it caused.
- **Ops created during an apply** (`engine/engine.mjs registerCreated`, `createdOf`, `opWrite`): gain rows and
  hero-token heals are registered out of band and written as full ops with their gain-only target records by every
  writer (`resolveMessage` included). Records with `gainOnly` are never targets: set aside before a re-resolve and
  written back unchanged; gain rows and hero-token heals are kept as history in any status (`engine/record.mjs
  sideOnly`).
- **Native resource rows** (`engine/native.mjs`, `engine/plan.mjs`): the system's "gain N surges" power-roll effects
  become `resource` rows per target at its tier (overlay suppression, Combat Tools' picks and its flat resource
  automation respected); `ui/gain-lock.mjs` locks the system's button once ours applied.
- **Hero tokens** (`resources/hero-tokens.mjs`, `ui/hero-token-dialog.mjs`): a step after the M5 pre-pass asks the
  hero's owner (prompt types `heroTokenRegain` / `heroTokenRegainCancel`) when our damage would drop a hero to 0 or
  less; Spend inserts a heal row (`heroToken`) before the hit, paid from the world setting on its own chain; undone at
  once (`damageNotApplied`) when the hit does not land, and with the hit on undo. Ongoing ticks detach from the
  lifecycle queue when a prompt may open (`turn/ongoing.mjs`).
- **Malice and villain actions** (`resources/world-resources.mjs`, `malice-reminders.mjs`, `villain.mjs`,
  `ui/malice-reminder.mjs`): world-resource ops (`resource: "malice" | "heroToken"`) on per-key chains; NPC trigger
  costs paid from Malice (`canPay`, shared pending debits); relay action `malice` (Malice card); reminder whispers;
  villain-action markers per encounter and per round with banner warnings `villainActionReused` / `villainActionRound`.
  Every resource read-modify-write of ours (library `resource` rows included) runs on one chain per actor.
- **Zones** (`zones/*`, `ui/zone-prompts.mjs`): library effect `zone` -> op kind **`zone`** on the user's own row
  (never automatic, never "Apply all"); placement on the clicking client (`zones/place.mjs`, relay `apply` with
  `zonePlaces`, shapes only); the active GM validates and creates our own region with the RegionBehavior type
  `ds-auto-core.zone` (`module.json documentTypes`); movement hits per (zone, token) tally, turn start / end from our
  lifecycle (registered after ongoing damage), credits per round in `zoneHits`; lifetime, Persistent upkeep (prompt
  types `zoneUpkeep` / `zoneUpkeepCancel`, the M6 dialog with zone texts), Dismiss (relay `zoneDismiss`), Undo.
- **Summon activation** (`summons/activate.mjs`): a player's activation of their own summon is vetoed on their client
  and relayed (`summonActivate`).
- Relay: `validZonePlaces`, `zoneDismiss`, `malice`, `summonActivate` routed before the card check; `holdDone` takes
  `type`, `source`, `groupUuid`, `staminaLoss`, `reportOnly` (a non-active GM forwards a report to the active one);
  `holdWaitMs` is `3T + 20 s` (the hero-token step may follow the M5 pre-pass). Auth: `isOwnZone`, `zoneEnded`,
  `mayDismissZone`.
- External damage (`triggers/external.mjs`): while a gain rule wants it, every external `takeDamage` reports to the
  active GM (report-only plans never held: Stamina loss, forced-move damage, squad minions); damage types are
  normalized (`"untyped"` -> `""`).
- Card: gain rows (resource, rule, "now N", the roll, "waits for the Director"), gain-only records, zone rows with
  Place and Dismiss, hero-token heal rows, Malice rows, villain banners (`styles/ds-auto-resources.css`). M6 follow-ups:
  "within 1 square", the automatic-placement text for the Director, stale row fields cleared on a re-resolve
  (`reason: noAnchor` after "Use my targets").
- Settings: **Resource gains**, **Hero tokens on a lethal hit**, **Malice reminders**, **Villain action tracking**,
  **Areas**, **Area damage**; the upkeep prompt's hint covers areas.
- API: `api.resources`, `api.malice`, `api.villain`, `api.zones`. Hooks `dsAuto.preGain`, `dsAuto.gain`,
  `dsAuto.heroToken`, `dsAuto.preZoneHit`, `dsAuto.zoneHit`, `dsAuto.zoneEnd`. `compat`: `regionBehaviors`,
  `zoneType`, `resourcesUi`, `dsctTemplateCleanup`, `dstdHidesGainButtons`, `delianTomb`. `selfCheck` reports gains,
  the Stamina watch, hero tokens, Malice, the zone type and live zones.
- Library (WP-D): `gains` and `zone` schema, `npc` and the **NPC overlay guard** (an NPC uses only monster overlays
  or generic ones marked `npc: true`), detached `dsAuto.zone` entries.
- `tests/check.cjs`: the §5.6 dynamic key lists (zone ends, zone entry choices, zone words, behavior fields, the
  Malice / hero-token resources). `tests/harness7.mjs` and `harness8.mjs`: the NPC guard's intended change (a pinned
  monster key gives an NPC no generic overlay; the test-only goblin overlay is `npc: true`) and the four new prompt
  types.
- **`tests/harness10.mjs`** (docs/M7-DESIGN.md §7.1, H1-H46): Milestone 7 against harness9's world with the M7 mocks
  (RegionBehavior config before `main.mjs` loads, regions with inline behaviors and movement events on every client,
  `placeRegion(create: false)` with scripted clicks, `scene.grid` geometry, `settings.set` with options, the system's
  `heroTokens` / `malice` world settings and `game.actors` getters, a scripted `Roll`, the system's `takeDamage` model
  on every actor, writers firing `updateActor` with the writing user, squads with a pool model, a
  `renderChatMessageHTML` DOM). `tests/check.cjs` takes `DSAUTO_CHECK_LANG` (another en.json) and
  `DSAUTO_CHECK_SKIP_SYNTAX` (H42: a removed dynamic key fails the check).
- Fixed while writing harness10:
  - Two cards' waiting gain rows of one rule in one round (prompt or manual mode, a confirm rule, a player-vouched
    fact) share an op id (rule, gainer, round): applying the second after the first applied it again (+2 instead of
    "already gained"). The ledger entry and the claim are now matched by their card too (`resources/gains.mjs
    sameRow`); a claim made before its gain card exists still matches its own row (H11).
  - A `takeDamage` report a non-active GM forwards to the active one arrived as the forwarding GM's: the active GM
    matched it against the forwarder's writes only, so a player's hit forwarded that way never made a gain. The
    forward now names its reporter (`holdDone.reporter`, believed only from a GM relay; `triggers/holds.mjs`,
    `relay/queries.mjs`, `resources/gain-card.mjs observeExternalReport`), and the row's "vouched" follows the reporter
    (H14 (m)).

#### [0.8.1] - 2026-10-07

fixes from the Milestone 6 live run

- The end of an encounter removes summons only after core's "combatEnd" effect refresh is done
  (`turn/lifecycle.mjs combatEndSettled`, at most 5 s). Core's `Combat#_onDelete` starts that refresh without awaiting
  it; it marks Combat Tools' squad label effects on the summons as expired while our removal deleted their tokens, so
  with several squads the Director's console showed "A parent Document provided to the database operation must be a
  Document instance" and the server "id … does not exist" (TESTING.md T88).
- Unlinked NPC summoners reuse one world actor per stat block again (CH1): Foundry v14 has no `Actor#baseActor`, so
  `summonSourceUuid` fell back to the token's synthetic item uuid and every monster token imported its own copy. The
  base actor is now read through `TokenDocument#baseActor` (`library/identity.mjs baseActorOf`, also used for monster
  keys).
- `tests/harness9.mjs`: synthetic actors have no `baseActor` (as in v14) and `TokenDocument#baseActor` exists; the
  combat's delete starts the "combatEnd" refresh like core; new H37c (removal waits for that refresh, and not for a
  failed one).

#### [0.8.0] - 2026-10-07

Milestone 6, summoning

- **Library effect `summon`** (design `docs/M6-DESIGN.md`; schema `library/schema.mjs`, detached entry type
  `dsAuto.summon`): stat blocks, how many, distance from the summoner or the card's target, side, turn (`after`,
  `own`, `with`, `none`), squads, how long it lasts, Persistent upkeep, Stamina carried over and the 0-Stamina lock.
  Reserved names (`summon`, `portfolioSummon`, `performSummon`, ...) are never used for our types.
- **One op kind `summon`** on the summoner's own row (`engine/library-plan.mjs summonRow`): never automatic, never
  in "Apply all", applied in its own phase after movement (`engine/summon.mjs`), undone by dismissing. World actors
  are imported or reused inside the card lock before the single resolve write (`summons/actors.mjs`, folder
  "Summons (ds-auto)"); a row whose import failed is prepared again by the Summon button (relay `summonPrepare`).
- **Placement** on the clicking client (`summons/place.mjs`): core `placeTokens(create: false)` with synchronous
  checks (range from the footprint, occupancy, scene rectangle, level); the squares travel in `apply` as `places`
  and are checked again on the active Director under a placement lock (`summons/squares.mjs`). The Director's own
  rows can use the nearest free squares (setting **Director's summon placement**).
- **Combat** (`summons/combat.mjs`): combatants and minion squads when the summoner's token is in a started combat
  (found through combatants: core combats have no scene); "after" summons are held at initiative 0 and chained right
  after their summoner (`summons/turn-chain.mjs`, registered before Hesitation is Weakness, which is then offered
  for the summoner once the chain is done: `triggers/turn-order.mjs runHiwFor`).
- **Registry and ends** (`summons/registry.mjs`): token flags, a combat index, the summoner's turn start / end,
  the end of the encounter, dying, 0 Stamina, manual **Dismiss** (row button, relay `summonDismiss`,
  `api.summons.dismiss`), a GM whisper of what was removed. **Persistent upkeep** with a countdown on the owner's
  client (`summons/upkeep.mjs`, `ui/summon-upkeep.mjs`, prompt types `summonUpkeep` / `summonUpkeepCancel`).
- Engine: `applyOps` / `applyOpList` carry `clientPlaces`; a record write that fails after summon tokens exist
  removes them again; noPowerRoll cards keep a summon's anchor target; `prepareSummon`. `lifecycle.currentActivation`.
  Relay: `places` validated on `apply`; actions `summon`, `summonPrepare`, `summonDismiss`; auth `isOwnSummon` (the
  summoner's owner places it whatever the role floor; never on `api.summon` cards), `mayDismissRow`, `mayDismissSummon`.
- Card: summon rows with range, who places it (per viewer), the names placed, "n of m placed", the turn, why it went;
  **Summon** and **Dismiss** buttons (`styles/ds-auto-summons.css`).
- Settings: **Summons**, **Director's summon placement**, **Summons act after their summoner**, **Label summon
  squads**, **Summons at the end of the encounter**, **Summoner potency link**, **Persistent upkeep prompt (seconds)**.
- API: `api.summon`, `api.summons` (`list`, `get`, `of`, `dismiss`, `worldActor`). Hooks: `dsAuto.preSummon`,
  `dsAuto.summon`, `dsAuto.dismissSummon`. `selfCheck` reports the summon rows (the system's own summon pieces,
  Combat Tools' squad labeller, the upkeep prompt type, live and orphan summons, the folder) and the squad / Death
  Tracker settings next to them. `compat` probes `dsctSquadLabels`, `portfolioSummon`, `summonAdvancement`,
  `utilsPerformSummon`, `companionType`.
- `tests/check.cjs`: the §5.6 dynamic key lists (checked against `SUMMON_LASTS` and `REMOVAL`) and a reserved-names
  rule (no type, part, prompt or card action named after the system's summoning, no write of the system's summoner
  flag; requiring the file exports the rule and runs no check); every op kind needs its card icon.
- `tests/harness9.mjs` (docs/M6-DESIGN.md §7.1, H1-H56 and H17b): the summon effect, placement on the owner's
  client, the GM's checks, combat and squads, the chain and its hold, upkeep, end triggers, dismissal, undo,
  `api.summon`, the view, selfCheck and the locks, against mocks of core's placement, unlinked combats, Combat
  Tools' squad turns and Death Tracker's cleanup. TESTING.md §2h is the live matrix (T78-T96).
- Requires ds-auto-library 0.3.0 for the summon content (Summon Source of Earth, Get in Here!, Call Abyssal Hyenas,
  Arise My Children, An Army From Blood, New Dawn). Relaunch the world after updating (new stylesheet).
- Review fixes (harness9 H24, H29b, H32b, H37b, H40b and additions to H10, H12, H14, H18, H32, H44, H45):
  - End-trigger arms carry the lifecycle's activation epoch (new per load, `resetActivations`), whether the
    summoner's activation was open, and the summoner's combatant id. An arm from another epoch or combatant (GM
    reload, another active GM, Death Tracker revival) is compared by round only: in its own round a turn end
    always counts, a turn start unless it may repeat the arm's own activation. A `summonerTurnEnd` summon made
    before an F5 is dismissed at that turn's end, not a round later.
  - The chain: the ungrouped members of one `after`/`with` summon (non-minions, squad "none") get one chained turn
    each (`chainedIds`, no one stranded at 0); a squad has ONE chained turn per round even when a later summon
    joined it (every entry sharing the group is marked); the hold of a shared group finds every entry holding it
    (the creator's entry may be dismissed).
  - Alternative initiative: dismissing a summon on one of its own turns moves to the next combatant that is not
    being removed (else the next round, on a survivor), never onto a sibling token that is deleted while current.
  - Origin "target": the squares (GM search, picker previews, api pick) sit at the ANCHOR's elevation; a summoner
    at another height no longer makes every square "too far".
  - The ability's range for a summon without `distance`: cube and wall `secondary`, line `tertiary` (was the
    area's size).
  - `deletePresent`: a batch refused because another module's delete was in flight (Death Tracker's
    clearSkullsOnCombatEnd) is retried with the ids still present, so living summon tokens never stay behind.
  - Security: a non-GM write of the summon token flag is stripped by the active GM; a summon's members come from
    the GM-written combat index entry or the signed card record when one exists (a forged flag never makes a token
    part of another summon or its summoner the forger's hero; zero Stamina checks only members).
  - D10: an `api.summon` row is the Director's whatever the role floor and mode (apply, undo, prepare); a world
    actor named as is in `api.summon` is never granted OWNER.
  - summonPlacement "auto": a Director's row offering several stat blocks keeps the Summon button (choice dialog,
    then the GM search through `places: {[opId]: {actor}}`); `api.summon` with places "auto" keeps its `pick`.
  - The summon row's label counts `placed` only while applied (after Undo: the quantity the next pick offers).
- Review fixes, round 2 (harness9 H11b, H29c, H31c, H34b, H42b and additions to H6, H19, H45, H48; the mocks now
  write `operation.parent` as core does, so a frozen operation object fails offline too):
  - Blocker: the registry's and the chain's update options were frozen shared objects; core assigns
    `operation.parent` to them (strict mode TypeError), so every token delete of a dismissal, the flag strips and
    the held / chained group writes failed live. Now a fresh object per write.
  - Upkeep: a prompt still open when the combat is deleted is cancelled at `deleteCombat` (whatever
    `summonEncounterEnd`); Keep re-checks that the combat still runs; index patches never fall back to a deleted
    Combat. No resource spent after combat.
  - A `turn: "none"` summon made in a running combat is indexed (no combatant), so `summonerTurnStart` /
    `summonerTurnEnd` and Persistent upkeep fire for it; its token flag records the combat.
  - `zeroStamina` on a summon of several creatures removes only the creatures at 0 (combatants, tokens, index
    entry's ids); the last one dismisses the summon, its Stamina snapshot taken from the creature that dropped.
  - Owner bypass: a summon row whose summon is gone (dismissed, expired, died, encounter end, undone as
    `alreadyGone`) no longer lets the summoner's owner Undo and re-apply it (a free new summon); the Director still may.
  - Combat Tools squad turns: a squad member whose start key the round-start hold took (DSCT skips it at the
    chained group drop) gets its turn start from the chain (`_onStartTurn` and the `turnStart` refresh).
  - `api.summon` squares without elevation sit at the anchor's elevation for origin "target" (D12).
  - The picker checks the viewed scene and level again after the choice dialog, the relay calls and the grant wait.
  - The GM's apply refuses a row without a distance as `noDistance` (was `noSpace` / `tooFar`).
  - Square refusals on the card and in the warnings use the summon wording (`DSAUTO.Summon.Picker.*`), not forced
    movement's; a summon row without a summoner token says `noSummonerToken` and offers no Summon button.

#### [0.7.0] - 2026-10-07

Milestone 5, triggered actions

- **Trigger engine** (`scripts/triggers/`, design `docs/M5-DESIGN.md`): overlays and detach stamps may carry
  `triggers` and `trackers` (taxonomy in `triggers/taxonomy.mjs`, schema in `library/schema.mjs`). On the
  active Director, a trigger event (damage about to land or landed, a damage-dealing roll, a hero's turn
  ended, a forced move or a move) is matched against reactors on the event's scene; eligibility checks
  combat, restrictions (Surprised only in round 1), the round's triggered action, relation by token
  disposition, range (footprint distance, spend ranges), line of effect and cost (`eligibility.mjs`). One
  prompt per reactor, all in parallel, within a server-time deadline; player side applied first.
  `dsAuto.preTrigger` can veto a reactor, `dsAuto.trigger` reports every final outcome.
- **Holds**: our damage is held by a pre-pass at the top of the engine's apply list, before the Death
  Tracker note and the ctlib batch (`triggers/holds.mjs`): nothing is written while a prompt is open; the
  card's `hold` marker ("Waiting for triggered actions: ...") is written once, right before the first
  prompt is sent, and removed by the final write. A halving halves every damage row of that target once
  (never stacks, `op.half`), a potency change re-checks the target's conditions and forced movement
  (`triggerResisted`); movement after a resolve or a pick is taken from the final row states. Reactions
  whose damage did not land are released (no card, no cost). Re-applying a row keeps a used reaction
  without asking again.
- **External damage** (system Apply button, Target Damage rows, Combat Tools) is held by a libWrapper MIXED
  wrapper on `BaseActorModel#takeDamage` with a two-phase commit (relay actions `hold` / `holdDone`, at most
  12 s), the system's half-damage clicks are marked by a WRAPPER on `DamageRoll#applyDamage`; our own
  writes carry `{"ds-auto-core": {internal: true}}` and pass through (`engine/damage.mjs`).
- **Prompts**: the prompt query is a router by type (`relay/prompt-router.mjs`: `save`, `trigger`,
  `triggerCancel`, `triggerRun`); the owner's dialog has a countdown, Decline as default and "Not this
  round"; the Director's indicator has Release; a player whose click is held sees a waiting line
  (`triggers/prompt.mjs`, `ui/trigger-dialog.mjs`, `ui/trigger-indicator.mjs`, `styles/ds-auto-triggers.css`).
- **Trigger cards** (`shape: "trigger"`, posted through `engine/synthetic.mjs postRecordCard`): cost row,
  the new op kind `budget` (the card's undo anchor, always applied; charges the round's triggered action
  on the combat and Combat Tools' effect), note rows, a bleeding reminder; undo is Director-only and revokes
  that reaction's entry on the hit (halving and potency recomputed from the other entries). The hit's row
  shows "halved by Parry (Benedikt)", potency changes, Director-only notes for declined / timed out /
  unanswered / closed / not needed reactions, and on an undone row "still spent" with an "Undo triggered
  action" button (`parts/view.mjs`, `templates/parts/resolution.hbs`).
- **Follow-ups** (`use`, `freeStrike`, tracker `retarget`) run on the owner's client; a cancelled one
  undoes the card or keeps its halving and re-tags the budget (relay action `trigger`).
- **Rolls**: Word of Guidance locks the roll dialog until the ally answered (relay actions `preRoll`,
  `preRollCancel`, `preRollDone`, `triggers/roll-lock.mjs`).
- **Trackers** (Judgement, Mark: `triggers/trackers.mjs`), **Hesitation is Weakness** (`triggers/turn-order.mjs`),
  movement gates and remote forced-move notices (`moveGate`, `fmActive`; our own Combat Tools calls run in
  `withOwnForcedMove` and are never gated; our own token moves carry the internal marker).
- Engine: `annotateOps`, `messageIdle`, `applyingMessageFor`; another Director's live hold refuses actions
  on that card (`DSAUTO.Relay.Busy`) and the ready sweep leaves it alone; the relay's `damage` action waits
  as long as `apply`. Ongoing damage ticks no longer wait for a held application (`applyAsync`). Library
  conditions carry the card's id; undo restores effects with a restore marker. Surges on a halved hit are
  halved with it; a `triggerResisted` row takes the +1 potency surge. Target Damage rows of a held target
  are locked. `lifecycle.onRoundEvent`.
- Settings: **Triggered actions**, **Triggered action prompt (seconds)**, **Owner not connected**, **Triggered
  actions outside combat**, **Director's creatures react**, **Hold damage from other buttons**, **Judgement
  and Mark trackers**, **Hold rolls for triggered actions**, **Leave triggers to Draw Steel: Triggers**.
- API: `api.triggers` (`active`, `reactors`, `budget`, `open`, `release`, `offer`). Hooks: `dsAuto.preTrigger`,
  `dsAuto.trigger`, `dsAuto.trackerZero`. `selfCheck` reports the trigger engine, the prompt types, the three
  new wrappers and Combat Tools' own triggered-action settings.
- `tests/harness8.mjs` (docs/M5-DESIGN.md §7.1, H1-H50) and `tests/check.cjs` (the §5.6 dynamic key lists, checked
  against the event kinds, the outcomes the card shows and the op statuses). Fixed on the way: a second potency
  change on a row the first one left pending (Parry -1, then Inertial Shield's -1 with the spend) was lost when
  the second one made the row resisted.
- Requires ds-auto-library 0.2.0 for the wave-2 content (Parry, Inertial Shield, Riposte, My Life for Yours,
  Word of Guidance, Hesitation is Weakness, Unearthly Reflexes, In All This Confusion, Judgement, Mark,
  Skitter).
- Review fixes (harness8 H51-H59 and changes to H3, H9, H10, H14, H16, H44):
  - Waits: a reactor's queued prompt gives up at its offer's deadline - 3 s instead of waiting for the
    reactor's earlier prompt (engine.offer, trackers; §6.2). External holds prompt at most 10 s and end by
    P + 3 s, under Target Damage's 15 s. The relay's `surge` and `undo` wait out a hold of the card
    (30 s + 2T + 9 s), long actions two of them; a held card hides Undo and the surge buttons.
  - External damage: Target Damage's own Shift+Click half is marked (capture listener for a GM's click, its
    socket request on the active GM for a player's), so a halve step is moot; a hit halved to 0 still goes
    through the system's takeDamage (weakness applies, as on our own path). Remote forced-move windows
    cover only Combat Tools' own damage calls (a `staminaLoss` key) of that mover, or sourceless ones on its
    target; the requester refreshes the window while the move runs and ends it when the move ends.
  - Reactions: a note step may carry `effect: true` (a shift done by hand): such a reaction stays worth
    offering, and is kept, when its halving is moot. A used reaction whose halving was moot only because
    the earlier apply was "Apply half" halves a plain re-apply (`couldHalve`). An undone trigger card's rows
    cannot be applied again (Director included).
  - Follow-ups: reports are taken once per card, only from users the active GM started a follow-up for, and
    never after one started (no late refund). A use whose dialog closed without a card ends the watch at
    once; targets are restored only when the user has not retargeted. Riposte's free strike is the ranged
    one when the melee one does not reach; an NPC's system free strike runs on the GM without its second
    dialog.
  - Roll lock without pills adds only the edges the dialog's 0-2 select can hold (none: the hold is
    released). `api.triggers.budget` is "not tracked" while the engine is off or deferred. `turn.start`
    triggers are offered (turn-order.mjs). The schema refuses a tracker on a stacking condition. The trigger
    cache follows monster key changes (rename, pinned key); detach stamps on unlinked tokens count.
- Second review fixes (harness8 H60-H72):
  - Active GM change mid-hold: `hold` / `preRoll` answer with `gmId`; `holdDone` / `preRollDone` go to that GM
    (`requestOpVia`), which takes its own pending commits; a GM that is no longer active forwards its used
    reactions to the active GM (relay `triggerCommit`), which posts their cards (cost and budget charged).
  - Holds: a second potency step on a row an earlier one made resisted keeps it skipped (a `hookVetoed` skip is
    never lifted); several pending surge rows applied in one list count each other (`earlier`, halved hit); a
    re-resolve carries a reaction's potency change to the rebuilt rows; a hit immunity reduces to 0 offers
    nothing (card and external); Death Tracker's cause is refreshed every 5 s while an external prompt is open;
    a roll appended while a fresh card is held gets its row.
  - External damage: Combat Tools' own Apply button handling (Shift+Click halved without `DamageRoll#applyDamage`)
    is marked by a WRAPPER on `DamageRoll.applyDamageCallback` (relay `halfMark` for creatures the clicker does
    not own), as are its purifying fire button and area hook on Target Damage rows. Forced moves run on this
    client open a local window (the vertical branch never sets Combat Tools' FM flag); a move not seen running
    (flag, picker, popup) for 5 s ends its windows, so a move that never started no longer lets damage through.
  - Eligibility: object actors are neither allies / enemies nor attacking creatures. The roll lock escapes the
    names it hands to Combat Tools' pill (its innerHTML).
  - Trackers: a re-target after a kill ends only the downed creature's effect (Anticipation keeps its second
    mark); with Combat Tools' picker and nobody in range a notice (`DSAUTO.Trigger.Notify.NoTarget`); without it
    the downed creature (still targeted) is never re-used and the targets are checked after the dialog.
  - Prompts: ticking an option's spend box selects that option; a trigger / tracker `label` shows as the
    option's subtitle. Schema rule 9 counts a note with `effect: true` (as the engine), so `forced.before`
    triggers validate.
- Third review fixes (harness8 H73-H83, H44 changed):
  - Half damage (C16): Shift+Click half marks pause while a hold waits on that client (`pauseExternalHalf`,
    around planExternal's hold and the relay `hold`), so a later target of one click is not halved twice after
    an earlier target's prompt; a half application marks only its own targets (`halfActors` per uuid, no global
    counter), so unrelated damage meanwhile keeps its halving reaction; a Shift+Click the row lock swallows
    marks nothing.
  - Combat Tools' FM flag no longer lets every damage on the client through: only its forced-move damage calls
    (a `staminaLoss` key, a source without `ability`) when no local window is open; forced-move windows also
    refuse an ability-card source (Combat Tools' Apply button).
  - Sweep: a hold marker this GM wrote before a reload is dead (resolved, marker removed); another GM's live
    hold is swept again once it ran out, and a held card re-renders when its hold ends (waiting banner gone,
    Resolve banner back).
  - Holds: revoking a reaction drops a pending potency surge the row no longer needs (never paid) or keeps its
    +1; pending and applied surge rows count in the immunity-to-0 check.
  - Eligibility: a hero or retainer at or below its Stamina minimum (-winded) is dead (no reaction); `use` on the
    subject and a free strike by the subject are moot for a dead subject (My Life for Yours, Riposte).
  - Ongoing damage: one creature's ticks run on a chain, each awaiting its application (no lost Stamina write);
    with a reactor on the scene the chain runs off the lifecycle queue (C12).
  - `turn.end` triggers need a `takeTurnNext` step and hero subjects (schema; `use` no longer goes with
    `turn.end`); runHiw gives the turn only to a decision that takes it, others run their follow-ups.
  - Re-target: Combat Tools' picker hint says to click a creature (`PickTargetHint`); a cancelled dialog says the
    follow-up ended (`DSAUTO.Trigger.Notify.RetargetCancelled`).
  - Library 0.2.0: the Human Blackguard's "Parry!" has its own overlay (it fell back to the Tactician's).
- Fourth review fixes (harness8 H84-H91; H3, H44, H60, H64, H70, H76 extended):
  - Death Tracker's cause: an external hold's 5 s refresh and its note before the write never touch the one
    cause slot while other damage may be settling (an engine apply list, a Combat Tools batch), and the
    refresh stops once another application noted its own cause (`causeNoteCount`, `damageInFlight`).
  - Active GM change: a GM that is no longer active forwards the damage.after events of a hit that landed
    there with its decisions (`triggerCommit.afterEvents`, validated, re-stamped), external holds included.
  - Trackers: a re-target registers before its waits and goes on only while its kill is current (generation
    per fired key): a revive and a second kill meanwhile give one prompt, not two.
  - Holds: a hit that never lands restores its potency rows exactly (an undone or failed row is never revived
    as pending); revoking the halving reaction keeps the hit halved while another live reaction could halve it
    (`couldHalve`); a potency step counts only on rows it can change (pending, applied for the late warning,
    or a resisted row a few steps flip), so a spend that only lowers an already-resisted row is not offered.
  - External damage: no fallback on Combat Tools' FM flag (stuck when a move throws); a held forced.before move
    opens its window right before `resume()` (the resumed run skips the hook), pass-through moves at once. A
    Shift+Click half mark is consumed even when the half rounds to 0; Target Damage healing rows never mark.
  - Eligibility: a spend range ("Melee 1 + Reason") gets the kit distance bonus the ability's own distance has;
    a non-minion NPC at 0 Stamina or `dying` is dead (no reaction); an optional spend that is the option's only
    effect (Inertial Shield on a halved hit) is required (pre-ticked), never an unticked box whose Use does nothing.
  - Roll lock: Word of Guidance is committed only when the edge is still on the submitted roll (its pill
    enabled, or the edges select not lowered); otherwise released.
  - Card: a held card hides "Undo all" too. A fresh card's hold cap counts from its last server-set change
    (`_stats.modifiedTime`, the hold's own write), so a card resolved minutes after it was posted keeps its hold.
  - Library: a detach stamp records the overlay's `monster`; a detached copy follows the live overlay of its key
    only when it is the same one (a Blackguard "Parry!" keeps its own triggers; older stamps follow the key).

#### [0.6.1] - 2026-10-06

fixes from the Milestone 4 live run

- Overlays can keep the system's own rows to one side: `native: {filter: "enemies" | "allies"}`. Native
  damage, conditions and forced movement for targets of the other side are skipped (reason "an ally: the
  ability spares allies"); the Director can still apply such a row by hand. Detached items keep the filter
  in their stamp. Found live: Awe dealt its psychic damage to an ally.
- New status `covered`: the overlay adds nothing on this item because Combat Tools automates all of its
  effects (was shown as "automated").
- Disable / Enable, Lock / Unlock and Reset no longer leave `disabled: false`, `lock: false` or an empty
  `flags["ds-auto-core"]` behind (`flagChange` in `library/actions.mjs`); the keeper treats the removal of
  our whole flag scope as our own write.
- A disabled ability no longer shows its overlay notes on the card.
- Heroic resource rows name the hero's resource ("+1 Clarity") when the system prepared its label.
- "Use my targets" is hidden on cards of abilities that target only their user (Catch Breath).
- `tests/harness7.mjs`: native filter, covered status, flag cleanup, labels.

#### [0.6.0] - 2026-10-06

Milestone 4, ability library

- **Library runtime** (`scripts/library/`): a virtual overlay registry (`registry.mjs`, `api.library.registerSource`
  on `dsAuto.init`; priority per source; monster-specific overlays by monster key: pinned flag, compendium
  source or name slug), identity keys (`identity.mjs`), the overlay schema shared with the content tools
  (`schema.mjs`: effect types, fields, formula syntax check, choices, config), formulas with `@tier`,
  `@spend`, `@config.*`, `@target.*` (`formula.mjs`), three-layer resolution with statuses for the medkit
  (`resolve.mjs`), Combat Tools "choose one" picks (`choose-compat.mjs`, replaces the 0.1 prompt gate when
  the card carries picks), detached entries (`entries.mjs`, `types/special-effects.mjs`: `dsAuto.damage`,
  `.heal`, `.condition`, `.cleanse`, `.resource`, `.forced`, `.teleport`, `.note`, registered at import),
  item actions (`actions.mjs`: configure, disable, lock, detach, resync, reset) and the keeper (`keeper.mjs`:
  puts detached entries back into Combat Tools' `applyEnhanced` update and into the system's Update Source
  replacement; a single entry deleted on the sheet stays deleted).
- **Library rows** (`engine/library-plan.mjs`, `engine/library-apply.mjs`): overlay effects become rows of the
  existing kinds plus `cleanse` (end effects by status or end; a choice when more candidates than allowed),
  `resource` (surges, heroic, epic, Recoveries; delta undo) and `note` (reminder, never applied); healing
  with Recoveries (the healed creature's own or the user's, `spender: "self"`); conditions from statuses, the
  ability's own effects or compendium effects (replaced copy kept for undo), with `until` the start / end of
  the user's next turn (Milestone 2 `until`); `filter` allies / enemies; `when` spend / strained / config;
  `tiers` / `byTier`; potency; forced movement properties. Effects on the ability's user get their own row
  (also without a power roll; targets that get nothing are dropped then). Native power roll effects can be
  suppressed by an overlay (data defects).
- **Choose one** groups (`chooseOption`, relay action `choose`): rows wait for a pick; the other options'
  rows are skipped; locked once one of them was applied; kept when the card is resolved again.
- **Self teleports**: the mover's owner may apply them whatever the role floor; Combat Tools' picker runs
  on their client and the active Director records the move (`apply` with `moves`, checked: the op's mover,
  where the token stands, no longer than the distance).
- **Adoption**: a recent ability card without a record (its author's client did not seed it) is taken over
  by the active Director when the engine automates its ability (targets from the rolls).
- Seeding happens for abilities the library automates even without native effects.
- Settings: **Ability library**, **Library: leave Combat Tools' own automation alone**, **Resources** (mode).
- `selfCheck` lists library sources, overlay counts, invalid overlays, key collisions and whether the
  `dsAuto.*` types registered.
- `tests/harness7.mjs`.
- Review before release (15 findings, all fixed; `tests/harness7.mjs` "review findings"):
  - a player's self-teleport is recorded from Foundry's own `moveToken` report of that player's move since
    the card resolved (`engine/move-log.mjs`): the request only claims it (`moves: {opId: true}`), the start
    position is never taken from the client, elevation counts in the distance, only self-teleports qualify;
    the player's client puts the token back when the Director's client refuses; "Apply all" never opens a
    square picker;
  - the user's own row no longer blocks Target Damage's late area targets, the fallback to its targets, or a
    player's retarget after a self effect was applied;
  - detached items keep their choice groups, options and notes in the stamp (library off, other monster
    key); a choice group the item does not know makes the row wait for a click;
  - `whenSpend` / `whenStrained` on entries are three-state fields (a checkbox turned "either" into "no"
    on every save of the sheet);
  - Edit: `effects` only on cleanse rows, no apply of a row still waiting for (or left out by) a choice;
  - cleanse rows that need a choice keep their mode (players with the rights can choose) and never apply by
    themselves; grabs are not ended by a cleanse (Combat Tools);
  - library forced distances use the library's formula data, potency is checked once; an unknown `@path`
    makes a formula invalid instead of 0;
  - picking an option runs its automatic movement rows; detached entries with the same effect id get their
    own rows; the keeper's restore memo is per update and expires; medkit select options compare as text.
- Known limits: no dice in library formulas; no shift, aura / zone, edge / bane or weakness effect types;
  effects reach only the targets or the user (not "allies adjacent to you" who were not targeted); choose
  groups are per card, not per target; `until` only in a started combat; the keeper and the
  `dsAuto.*` sheet partial are unverified live.

#### [0.5.0] - 2026-10-06

Milestone 3, forced movement, teleport, row edits

- **Forced movement rows** (`engine/plan.mjs forcedOp`, `engine/forced.mjs`, `delegation/forced-movement.mjs`):
  one row per (forced movement effect, target) for the target's tier: distance from the tier's formula
  (with `@spend`), plus the ability's bonuses per movement type (kits) and +1 for a larger creature with a
  melee weapon ability (Combat Tools adds it only on its own buttons); a real potency characteristic gates
  it (moves only on a failed check); the system's "ignores stability" property (key `ignoresImmunity`) and
  Combat Tools' collision properties are passed on; a creature never pushes or pulls itself.
  New settings: **Forced movement** (mode, default Automatic), **Forced movement path** (straight line /
  Director picks), **Forced movement without Combat Tools** (on).
  - With Combat Tools (`forcedMovementEnabled`): API form 3 with `suppressMessage` (its engine moves the
    token, applies stability, collisions, falls), `fastMove` for straight pushes and pulls; its undo log is
    kept on the row. Applied after the card's damage and conditions.
  - Slides, vertical moves and "push or pull" need a choice: they wait for the Director (the path picker
    opens on the Director's screen; "push or pull" asks first, Apply all leaves them out).
  - Without Combat Tools: our own straight line (8 directions) on square grids, stopped by walls and
    creatures; the squares left for collision damage are shown. Slides and vertical moves stay reminders.
  - Undo: Combat Tools' log replayed with ctlib's `replayUndo` (the position is kept when the creature moved
    since), creatures its collision damage defeated are revived (Death Tracker), ended grabs restored.
  - Combat Tools' own forced movement buttons are locked on results whose targets we moved.
  - +1 potency surges (2 surges) work on forced movement rows resisted by exactly one.
- **Edit** (`engine editOp`, relay action `edit`, `api.editOp`, Directors only): rows not yet applied can
  be changed: amount (damage keeps immunities and weaknesses), healing as temporary Stamina, forced
  distance and movement type; save or apply at once. Empty field = the ability's value.
- **Teleport and forced movement cards** (`api.teleport`, `api.forcedMovement`; relay action `move`,
  Directors only): synthetic cards with undo; teleport to a given destination, or through Combat Tools'
  square picker (modes normal / swap / adjacent).
- `@spend`: the roll dialog's spend choice is noted on the author's client (`closeAbilityConfigurationDialog`)
  and stored on the record (`spend`), so forced distances see what damage formulas saw.
- The ability's user token on a card is checked against the ability's actor (the seeded speaker is
  author-written).
- `tests/harness6.mjs`.
- Review before release (11 findings; 10 fixed, the teleport one is a known limit below; `tests/harness6.mjs` "review findings"):
  - undoing a move reverses only its own collision damage: Combat Tools' log writes back the Stamina from
    before the move, which wiped damage dealt since, or dealt an undone hit again; its Stamina entries are
    rewritten as a delta (dropped when the move dealt nothing) and only creatures the collision changed are
    revived;
  - a cleared Edit field is deleted from the stored record (a merge update kept it); Edit + Apply deals
    full damage after an earlier half application;
  - Combat Tools' per-target forced movement rows inside Target Damage's panel are locked too;
  - automatic moves run after the card is written (Combat Tools may still ask about friendly fire or a fall);
    relayed apply / edit / move requests wait up to 5 minutes for a pick on the Director's screen;
  - our straight pull stops at the square next to the source (no overshoot);
  - Edit is the Director's (it can exceed what was rolled);
  - ended grabs come back with each grabber's grab count, and not when the creature stays where it was pushed;
  - once Edit picked "push" for a "push or pull" row it moves in a straight line; flying targets always get
    the picker (Combat Tools turns their push vertical and asks); API cards asked for by another Director
    wait for a click instead of opening a picker on the active Director's screen;
  - stale "squares left" / "grabs not restored" notes cleared on re-apply.
- Live run (TESTING.md section 9, T40-T47 pass): the end position of a Combat Tools move is read once the
  token settled (its own `finalPos` is mid-animation); the straight-line fallback no longer cuts wall
  corners diagonally; all movement types of an applied "push or pull" effect lock Combat Tools' buttons;
  a push stability fully absorbs says so.
- Known limits: the picker opens on the active Director's screen even when another Director clicked; a
  teleport through Combat Tools' picker is undone by position only (grabs, statuses and fall damage it
  changed stay) and Combat Tools also posts its own card for it; Combat Tools' friendly-fire question
  (setting) waits for an answer before the move lands.
- Not built from the plan: teleport rows for Combat Tools' own `dsctTeleport` effects (its buttons already
  do it with its picker; the library brings teleport rows in M4); the `dsct.preForcedMovement` hold (M5).

#### [0.4.0] - 2026-10-06

Milestone 2, durations, saves, ongoing damage

- **libWrapper is now required.** All registrations go through `compat/lib-wrapper.mjs` and are listed by
  `api.selfCheck()`; WRAPPER or MIXED only, never OVERRIDE.
- **Turn lifecycle** (`turn/lifecycle.mjs`): every creature's turn start and turn end is delivered once
  (per combat, round, creature) on the active Director, including the extra squad members Combat Tools'
  simultaneous squad turns handle, through a WRAPPER on the effect registry's `refresh`. Hook
  `dsAuto.turnEvent`. `Combat#_onEndTurn` (MIXED) runs once per creature and turn on the active Director
  only: Combat Tools called it again for the activated squad member and on every Director client, which
  opened duplicate save dialogs.
- **Saving throws** (`turn/saves.mjs`, MIXED on `SavingThrowManager.delegateSavingThrow`), new settings:
  - player-owned creatures (default **Ask the player**): the owner's client opens the system's save
    dialog (query `ds-auto-core.prompt`); no answer within "seconds to answer" (60) or no owner online =>
    the Director's client rolls automatically (or opens the dialog for the Director: "No answer"). Closing
    the dialog skips the save. Draw Steel's own handling crashed when the player cancelled.
  - the Director's creatures (default **Roll automatically**): no dialog; the card has the system's save
    part (visibility setting: Director's roll mode / everyone / Director only / blind).
  - one creature's saves are rolled one after another; a save already running is not started twice; dead
    creatures and effects that already ended are skipped. Hooks `dsAuto.preSave` (cancellable), `dsAuto.save`.
  - `api.rollSave(effect, {policy})`.
- **Ongoing damage** (`turn/ongoing.mjs`, setting mode default Automatic): Burning and any effect whose
  text says "takes [[/damage X type]] damage at the start/end of each of their turns", or that carries
  `flags["ds-auto-core"].ongoing`, posts an `api.applyDamage`-style card once per turn (roll shown for Dice
  So Nice, immunities, squads, Death Tracker attribution, undo). Hook `dsAuto.preOngoing` (cancellable).
  Synthetic cards accept internal `{rolls, meta}` (`record.ongoing` names the effect).
- **Until** (`turn/until.mjs`, `api.until`): end conditions in `flags["ds-auto-core"].until`: until the end
  of a combatant's next turn (set during its own turn, that turn does not count), until the start of its
  next turn, until dying/dead, until the token moves. Expiry key `dsAutoUntil` ("Special (Automation)")
  unless `keepExpiry`. Ending follows `CONFIG.ActiveEffect.expiryAction`.
- **System fixes** (setting "Fix Draw Steel 1.1 turn bugs", on; only on system versions below 1.2.0):
  - save cards keep the `savingThrow` part (effect link and hero-token button) that `DSRoll#toMessage`
    replaced with a plain roll part;
  - a creature leaving combat, or the end of the encounter, deletes its save-ends, turn, round and
    encounter effects of that combat (the system's `new Set("save", ...)` bug kept them); waits 400 ms
    for core's un-awaited encounter-end refresh.
- Verified before building: Draw Steel: Battle Log 1.3.0 no longer vetoes chat messages during a hero-token
  spend (it only tags them), so save cards need no wait; the `_onExit` Set bug is still in 1.1.2.
- Not built from the design: a combined "saves" card part (the system's own part, restored, does the job).
- Review before release (7 findings, all fixed, `tests/harness5.mjs` "review findings"):
  - turn events are tracked per **activation**, not per round: solo monsters with 2-3 turns a round save
    and take ongoing damage on every turn (a round-keyed dedupe swallowed the later turns);
  - the creature a turn event is about is read before the effect refresh awaits (core rewrites
    `combat.previous` in place); skipped turns (alternative initiative) are ignored;
  - no Director fallback roll when the effect already ended while the player was asked;
  - `/damage` arguments parsed like the system (`type=a/b`, `ignoredImmunities=`, `&`-joined formulas,
    `scaling`/`aoe` dropped; invalid formulas ignored);
  - turn-end ongoing damage uses the effects active when the turn ended, before that turn's saves;
  - "until the end of its next turn" set during a Combat Tools squad follower's turn waits for the next one;
  - the saves wrapper respects the module's "enabled" switch.
- Live run (TESTING.md section 8, T30-T37 pass): fixed ongoing damage never recognising effect text
  (`Roll.validate` was called without its class), and automatic saves showing their flavor inside the
  formula.

#### [0.3.0] - 2026-10-05

Milestone 1.5, hardening

- **Revive on undo** (new setting, on): undoing damage that defeated a creature revives it through Draw
  Steel: Death Tracker (defeated status lifted, back in combat and in its squad, captain restored, tokens
  killed in the same stroke too). The squad pool is not restored twice (Death Tracker's own pool restore is
  skipped because the undo already restored it). Needs the Director to view the creature's scene; otherwise
  the row says to use Raise Dead, as before.
- **Half damage**: damage rows that can be applied get a ½ button (half the damage, rounded down, before
  immunities, like the system's shift-click). A plain Apply deals full damage again.
- **Status immunities**: a condition the target is immune to (every status of the effect) is skipped with
  "immune to this condition" instead of being created with a warning; the Director can still apply it.
- **Surges**, spent by the hero's owner (or the Director) whatever "Who may use card buttons" says:
  - ⚡ on a damage row: 1 to 3 surges as extra damage on that target (highest characteristic per surge,
    retainers use their mentor's surges). The extra damage is its own row; immunity and weakness count once
    for the whole hit; squads take it into the pool with the area cap. At most 3 surges per damage row.
  - ⏫ on a condition the target resisted by exactly one: 2 surges for +1 potency, so it fails.
  - The new or changed row follows its base row: it lands at once when the base row was applied
    automatically (or the Director spends), otherwise it waits like the base row. Surges are paid when the
    row lands and given back when it is undone (or when there are too few left: "not enough surges").
- **`api.applyDamage({targets, amount, type, ignoredImmunities, aoe, source, flavor, half, kind, mode})`**
  (Directors only, relayed): posts a card that applies damage, healing or temporary Stamina like an
  ability's results, with the same rows, squad pools, immunities, Death Tracker attribution and undo. The
  substrate for ongoing damage, triggered damage and zones later.
- **`api.surge(messageId, opId, {count | potency})`** and `api.applyOps(messageId, opIds, {half})`.
- **Delay before applying** (ms, default 0) and **Wait for Dice So Nice** (default on; acts only when Dice
  So Nice is active): automatic results land after the dice stop rolling on the Director's screen (at most
  15 s).
- **Confirmation dialog** (client setting, off): the Director's client opens a dialog for results that wait
  for confirmation (Ask the Director), with a checkbox per row: apply now or later from the card.
- Warnings: warnings about one row are shown on that row (e.g. "'always' with potency treated as on
  failure"); warnings about targets the card no longer shows are listed for the Director under **Notes**.
- `selfCheck` reports the Death Tracker version, whether revival is on and whether Dice So Nice can be
  awaited. `dsAuto.resolved` gets a third argument `{reason}`.
- Found in the live run: undoing a squad hit now revives the defeated minions **before** restoring the pool
  (Death Tracker caps the pool at the living minions, so the pool came back 4 short), and revives as many
  minions as the restored pool needs, whoever Death Tracker defeated (it may pick a minion that was not
  hit). Synthetic cards show their title in the Automation header and no tier label.

#### [0.2.0] - 2026-10-05

Milestone 1b, players and modes

- GM relay: every card button and console call (`resolve`, `applyOps`, `undoOps`, `retarget`, new
  `request`) runs on the active Director's client through Foundry's user queries and is authorized there;
  the requesting user comes from Foundry, never from the request. Each requested row is logged as
  `relay.in {user, action, opId, allowed}`; refusals are console warnings.
- Players can use the Automation buttons when allowed: new settings **Who may use card buttons** (lowest
  role, default Game Master, i.e. unchanged behaviour) and **Which cards players may act on** (own cards, or
  also results whose targets they own). Above the role, users may always undo what they applied themselves.
  Skipped rows (resisted, minion heal, temporary Stamina not higher) remain the Director's override.
  Buttons are shown only to users who may use them; Apply all reports rows that were not theirs.
- The author may fix a forgotten target with **Use my targets** while nothing on the card has been applied
  (any time above the role), and gets **Resolve now** on their own unresolved card. Re-resolving a resolved
  card (`force`) stays Director-only.
- Two Directors: only the active one writes; clicks and API calls of another GM are relayed to it.
- New mode settings: **Results on heroes** (override the feature modes for hero targets; Off stays off,
  private cards stay manual) and **Cards posted by players** (cap automation of player cards at Ask the
  Director or Manual; it wins over a looser hero override). The record's `modes` lists both.
- **Respect Target Damage applications** (default on) switches the 0.1.1 "Applied elsewhere" detection.
- Players no longer see the target's characteristic in the potency text of creatures they do not own
  (only "M 2: fails"), like immunities and weaknesses.
- Unresolved cards re-render when a Director connects or leaves, and a Director who becomes the active GM
  runs the automatic sweep (Unresolved cards after reload = Resolve automatically).
- `selfCheck` reports whether the relay is registered and whether the user may query the Director.
- Cards re-render when "Who may use card buttons", "Which cards players may act on" or "Hide immunities
  from players" changes, so buttons appear and disappear right away (found in the live run).
- Record integrity: a card's author owns its chat message and could rewrite the Automation record from the
  console (for example reset it so "Resolve now" applies the damage again). The active Director now signs
  every record it writes (hashes in a hidden world setting only GMs can write). A record changed outside
  Automation Core is locked for everyone with a banner until a Director checks it (`api.dump(id)`) and
  runs `api.trustCard(id)`; `api.integrity(id)` reports fresh / ok / tampered / unsigned. At the first
  resolution only the seeded ability and target tokens are used: seeded rows are dropped, targets are
  rebuilt from their tokens, and the author's role and the source actor come from the server's author and
  the ability. Resolved cards from 0.1.x are trusted once, when the Director first loads 0.2.0.
  A locked card shows only its lock banner, no buttons (found in the live run).
- Players may retarget only to visible tokens on the active scene or the scene the Director views;
  "Ask the Director" rows wait for the Director even when players may use buttons.
- Console API: `applyOps`, `undoOps`, `resolve` and `retarget` now go through the relay and resolve with
  `{ok, refused}` (`refused`: row ids the caller may not change); they reject with a message instead of
  returning null (no active Director, unknown card, locked card, not allowed). `opIds` must be an array.

#### [0.1.1] - 2026-10-05

fixes from the first live test run

- No double application after Target Damage applied a row itself: if Target Damage (its row button or
  Combat Tools' Apply All) applied a damage, healing or status row that Automation Core had not applied
  (pending, undone or skipped), Automation Core's Apply now marks the row "Applied elsewhere: already
  applied from Target Damage" instead of applying it a second time. The Apply button stays and works again
  once Target Damage has undone its own application. Such rows no longer lock Target Damage's buttons.
- The row status follows Target Damage: when it applies or undoes a row, the Director's client updates our
  rows ("Applied elsewhere" ↔ pending) in one write. Apply all also retries "Applied elsewhere" rows, and
  "Use my targets" rebuilds them instead of keeping them as history.
- Target Damage's selected-token stacks, multi-token records and per-target tier overrides are recognised.
- A squad row whose minions Target Damage applied only partly is skipped with a note instead of applying
  the whole hit again.

#### [0.1.0] - 2026-10-05

Milestone 1a, auto-apply core for the Director's table

- Ability cards record their targeted tokens on the author's client and get an Automation section.
- The active Director resolves each card once: per-target tier, damage (immunities, weaknesses, temporary
  Stamina, squad pools with area cap), healing and temporary Stamina, potency-gated conditions with a
  per-target start combatant, frightened/taunted via Combat Tools, grabbed on confirmation.
- One message update per automatic resolution; Apply / Undo per row and for all rows (Director only).
- Undo restores Stamina absolutely when nothing changed since, otherwise reverses only its own change.
- Target Damage buttons of applied results are locked (capture guard + ctlib decorator).
- Late area targets from Target Damage, "Use my targets" retargeting, rolls added after resolution become
  manual rows, unresolved-card banner with Resolve now, private player rolls stay manual.
- Settings per feature (Automatic / Ask the Director / Manual / Off), potency options, lock and sweep
  options, debug logging. Console API `selfCheck`, `dump`, `resolve`, `applyOps`, `undoOps`, `retarget`.
- No libWrapper wrappers.

### Draw Steel: Automation Library (ds-auto-library)

#### [0.8.1] - 2026-10-26

Requires ds-auto-core 0.17.0 for the new option field (older cores ignore it).

##### Changed

- **Practical Magic**: each option names its Combat Tools choice (`dsctOption`), so the card takes the option picked in
  Combat Tools' own prompt and does not ask again; with Knockback the card's native Knockback row pushes the target.

#### [0.8.0] - 2026-10-16

Milestone 9. Requires ds-auto-core 0.14.0; 175 overlays.

##### Added

- **Weakening Brand** (Warrior Priest kit): damage weakness equal to the roll characteristic on the target until the end
  of its next turn (a modifier row; Undo removes it).
- **Practical Magic**: choose one — Knockback at range (a reminder), Reason damage of a chosen type to a creature within
  10 (picked on the user's client with its damage type), or a teleport of Reason squares with 1 extra square per
  essence spent.
- **The Green Within, the Green Without**: slide 2 for a creature within 10 of the target, picked on the user's client.
- **Test of Rain**: end one save-ends or end-of-turn effect on the user and on each ally in the placed cube; each
  creature's owner chooses which.
- **Unquiet Ground** (Elementalist): its area slows enemies as difficult terrain until the encounter ends (Dismiss ends
  it early); the power roll damage stays native. Uses core's zone `terrain`.
- The overlay-level `persistent` field and five overlays: **The Flesh, a Crucible** (free roll again), **No More Than a
  Breeze**, **Luminous Champion Aloft**, **Subverted Perception of Space** (the native applied effect replaced by the
  tier 2 / 3 effects so they can end) and **Magma Titan** (held effects with reminders).
- Validator warnings: an effect's `targets: "area"` on an ability without an area, `persistent.targets: "area"` on an
  ability whose area is not an aura or burst, `pick.of: "target"` on a self-only ability, a modifier without `end`; a teleport boost's label
  and the Persistent note are licensing-checked. Build lints: `persistent` needs the ability's Persistent special
  effect, a re-roll a power roll; rule 4 counts a Persistent re-roll or hold as automation.

##### Changed

- **My Life for Yours** 1.1.0: the reaction prompt offers the Wrath spend; ticking it opens the ability's roll dialog with
  its spend ticked (paid once, by the system). The choice between standing up and ending an effect is one dialog on
  the ally's owner's client, Prone among the candidates. The turn-start trigger stays manual.
- **Incinerate** 1.0.1: notes explain that the cube drawn on use becomes the column when the card resolves, and that a
  strained use centres the larger cube on it.
- **Swarm of Spirits** 1.2.0 (roll again at every enemy in the aura, aura held) and **The Green Defends Its Servants**
  1.2.0 (shield held) use `persistent` instead of core special cases.
- Overlays left without `persistent` on purpose (rule 4, nothing to hold or roll again): Web of All That's Come Before,
  Storm of Sands, Wode Remembers, O Flower Aid, Instantaneous Excavation, Conflagration, Behold the Mystery, Earth
  Rejects You. Wall of Fire and Summon Source of Earth keep their own `upkeep`.
- Regenerate the 175-overlay distribution; require Automation Core 0.14.0.

#### [0.7.1] - 2026-10-09

- Name Null Field's Gravitic Disruption and Inertial Anchor feature prompts and cards explicitly.

#### [0.7.0] - 2026-10-09

- Add structured content for sixteen non-performance auras, three Censor Judgement benefits, and The Green Defends Its Servants.
- Update Flip the Script, I Work Better Off Alone and Iron for recipient movement, pre-roll surges and temporary-Stamina dependencies.
- Include feature items stored in the abilities compendium when indexing; regenerate the 165-overlay distribution.
- Require Automation Core 0.12.0.


##### Added

- 27 feature-rule overlays: Barbed Tail, the 12 installed Wards, Goblin Mode, and the 13 installed
  Troubadour performances. Goblin Mode pays 3 Malice once and grants encounter goblins +2 speed until
  round end. Barbed Tail's optional once-per-round damage is added before mitigation.
- Expanded ancestry and monster-feature indexing and feature-rule coverage in generated reports.


##### Fixed

- Black Ash Teleport opts into the automatic picker and its optional observed Hide, with one surge on success.
  Overlay version 1.1.0; requires the updated Automation Core teleport follow-up support.

#### [0.5.0] - 2026-10-08

Milestone 8: release hardening (completed offline; M8 live testing pending) (no overlay changes).
Requires: Foundry 14.368, Draw Steel 1.1.2 (1.2 development builds: see ds-auto-core's README); ds-auto-core ≥ 0.9.0.

##### Added

- `tools/dist-check.mjs`: checks, without the system's packs, that `dist/overlays.mjs` was built from the current
  `src/overlays` and for the version in `module.json` (exit 1 otherwise; run in CI).
- README: a "For developers" section (`api.overlays`, `count`, `reregister`).

##### Changed

- `dist/overlays.mjs` starts with the module version and `src-sha256: <hex>`, a SHA-256 of `src/overlays/**/*.json`
  (sorted paths, line endings normalized), so a stale dist is caught without system data. `tools/build.mjs` writes it
  and fails when its own output does not pass `dist-check.mjs`. The dist is rebuilt (it said 0.4.0 since 0.4.1).
- `game.modules.get("ds-auto-library").api.overlays` is a getter returning a frozen copy of the built overlays (it was
  the live array); `count` and `reregister()` are unchanged.
- `tools/lib/packs.mjs` finds `classic-level` in the repository root's `node_modules` (after `npm install` there)
  before the npx cache, and looks in the npx cache of Linux and macOS (`~/.npm/_npx`) too.
- License: MIT for the code plus a plain notice that the module is not affiliated with MCDM Productions, LLC (README
  "License" section and `LICENSE`, kept in step by the repository's `legal.mjs`); the "Creator License decision is due"
  note is gone. `dist/coverage.md` is a developer report and is no longer part of the release zip.

#### [0.4.1] - 2026-10-07

Wording from the Milestone 7 live run.

- Wall of Fire 1.0.1: the card note reads "When you keep it (Persistent), add its extra square by hand." (it said
  "Extra squares from Persistent: place a second area by hand." on every use, also when nothing was kept).

#### [0.4.0] - 2026-10-07

Milestone 7, resources, zones, content waves 3-4.

- Needs ds-auto-core 0.9.0 (an older core rejects `gains`, `npc` and `zone` effects as unknown).
- **Resource gains** (`gains` on class feature overlays, `feature:<dsid>`, `effects: []`): Ferocity (first
  damage taken each round, Damaging / Primordial Ferocity 2 / 3; winded or dying 1d3 once per encounter),
  Wrath (your judged foe damaged you; you damaged your judged foe, Wrath Beyond Wrath 2), Essence (typed damage
  within 10, not untyped or holy; Font of Essence 2), Discipline (an enemy's main action in the Null Field,
  confirmed by the Director, Regenerative Field 2; the Director's Malice abilities), Insight (damage with a
  surge; Surge of Insight 2, Death Pool 3), Focus (your marked foe damaged by you or an ally, Focus on Their
  Weakness 2; an ally's heroic ability within 10), Clarity and Strain (a creature force moved, the Talent
  included; Mind Recovery 2, Clear Mind 3), Drama (three heroes in a turn and a natural 19 / 20 in sight, both
  confirmed by the Director; a hero winded; a hero's death +10).
- **Zone effects** (lasting areas): Wall of Fire (per square, Persistent 1), Righteous Phalanx (until the end
  of the encounter or the conduit is dying), Incinerate (normal, and strained with a 5-square column that ends
  with the turn), the Arixx's Acid Spew, the Goblin Stinker's Swamp Gas (each non-goblin per square moved) and
  the Delian Tomb Toxinaut's Swamp Gas (`swamp-gas-dt`, ignores poison immunity, spares the adventure's
  goblins by monster key since they carry no `goblin` keyword).
- **Monsters**: Sword Stab (Goblin Assassin) and Shadow Stab (Goblin Shadowknife): the edge bonus as a manual
  row; Oversurge (Mystic Queen Bargnot dazes herself); `monsters/parry.json` 1.1.0 adds Dame Cornelia (her
  Parry! has no `_dsid`, key `ability:parry`).
- **Wave 3**: Glowing Eyes (after you are damaged, its card against the attacker), Impart Force (psychic per
  square pushed, manual), Dance of Blows (one adjacent enemy's slide, manual), Choke (vertical pull 2, manual).
- The core's NPC guard (0.9.0) keeps generic overlays off monsters: the Rival Tactician's and Targon's
  Overwatch, the Castellan Hoplon's Inspiring Strike, the Hobgoblin Burning Witch's Soul Burn and the
  Olothec's Psychic Pulse no longer get the hero overlay of the same key (it did something else); they are
  manual until they get monster overlays.
- Tools: `readPack` attaches three-level embedded documents (`actors.items.effects`) to the item, so monster
  abilities keep their effect ids. `index-system.mjs` keys abilities without `_dsid` by the core's slug,
  indexes class features (`features`), the Delian Tomb's monsters (`--extra-monster-packs`) and malice
  features, the adventures' actors (`--adventure-packs`; coverage only) and the full distance (primary,
  secondary, tertiary); `--copy-dir` for the pack copies. `content.mjs`: `feature:` keys are checked against
  the features (name, licensing lint with gain labels), gain lints (upgrade features, judged / marked effects,
  the field ability), zone lints (an area to measure is required; range, keywords and monster keys warn),
  monster overlays are checked against their ability's effect ids; the M6 "monster collision" error is
  replaced by a warning list of monster abilities with a generic key and no monster overlay. The coverage
  report gains "Gains", "Monsters" and "Monsters in your adventures" sections and counts areas and gains.
  `show.mjs` shows `feature:` keys and the full distance.
- `AUTHORING.md`: sections **Resource gains** and **Zone effects**, `npc`, `exceptMonsters`, the monster rule.
- 118 overlays (13 monster-specific; 11 with triggers, 2 with trackers, 6 with summons, 6 with areas, 8 with
  resource gains).

#### [0.3.0] - 2026-10-07

Milestone 6, summons.

- Needs ds-auto-core 0.8.0 (an older core rejects `summon` effects as an unknown type).
- `summon` effects (core schema): Summon Source of Earth (new folder `src/overlays/elementalist/`: acts right
  after the elementalist, Persistent 2 asked at the turn start, Stamina carried through the encounter,
  locked at 0 Stamina until a Victory, gone at the next turn start, at 0 Stamina or at the end of the
  encounter) and five monster reinforcements (`src/overlays/monsters/`): Get in Here! (2 goblin runners),
  Call Abyssal Hyenas (2 abyssal hyenas), Arise, My Children (2 blood-starved vampires), An Army From Blood
  (3 hobgoblin recruits adjacent to the target) and New Dawn (4 angulotl pollywogs): their own turn, joining
  a squad, gone at the end of the encounter.
- Tools: `index-system.mjs` indexes the monsters pack's actors (`monsterActors`: name, organization, size,
  token size) and gives monster abilities their target type and distance. `validate.mjs` / `build.mjs`: summon
  `actors` must be stat blocks of the monsters pack (error); warnings for a squad on non-minions and for
  `origin: "self"` on an ability that targets a creature ("origin target?"); `actors[].label` is linted. The
  coverage report counts overlays with summons.
- `AUTHORING.md`: section **Summon effects**; summons are no longer skipped.
- 97 overlays (10 with triggers, 2 with trackers, 6 with summons).

#### [0.2.0] - 2026-10-07

Wave 2, triggered actions and trackers.

- Needs ds-auto-core 0.7.0 (an older core rejects overlays with `triggers` / `trackers` as unknown fields).
- Triggered actions (`triggers`, the core asks the owner and holds the damage, roll or turn): Parry,
  Inertial Shield, Unearthly Reflexes (halve, potency down, spend), Riposte (free strike after a melee
  strike), My Life for Yours (after damage, uses the ability on the ally; Recoveries checked), Word of
  Guidance (edge, double edge with the spend), Hesitation is Weakness (take the next turn), and the Arixx's
  Skitter (first monster overlay, `src/overlays/monsters/`: the Director is asked).
- In All This Confusion 1.1.0: the damage is halved by the trigger, which then posts the ability's card for
  the teleport.
- Judgement 1.1.0 and Mark 1.1.0: `trackers` (a new target when the judged or marked creature drops to 0
  Stamina; using it again ends the older effect; Mark ends when the tactician is dying).
- Tools: `index-system.mjs` also indexes each ability's target type and distance, and the monsters pack's
  abilities (text only, per monster). `validate.mjs` / `build.mjs`: the licensing lint covers trigger and
  tracker labels, the spend label and note steps, and monster overlays (against that monster's ability; a
  monster ability that cannot be found is an error); a trigger on an ability that is not a triggered action
  needs `free: true`; a warning when a damage or roll trigger's subject does not match the ability's target;
  a trigger or tracker overlay may have `effects: []`. The coverage report counts overlays with triggers and
  trackers.
- `AUTHORING.md`: section **Triggers and trackers**; triggered actions are no longer skipped.
- Review fixes: Parry 1.1.0 (its shift note is split by the spend, so the spend is offered whenever it
  buys the longer shift, also when protecting himself or an adjacent ally), Unearthly Reflexes 1.1.0 and
  Skitter 1.1.0: their shift notes carry `effect: true` (still offered, and kept, when the hit is already
  halved). `note` steps take `effect` (core schema).
- Third review: the Human Blackguard's "Parry!" shares the dsid `parry` with the Tactician's Parry and fell
  back to its overlay (potency -1, a shift, any damage): monster overlay `monsters/parry.json` (a strike's
  damage halved). `validate.mjs` / `build.mjs`: a generic overlay with triggers or trackers whose dsid a
  monster ability shares needs a monster overlay for that monster (error); a monster overlay is checked
  against the monster's ability only, never a hero ability of the same dsid. `AUTHORING.md`: `turn.end`
  needs `takeTurnNext` (core schema); `use` goes with `turn.start`, not `turn.end`.
- 91 overlays (10 with triggers, 2 with trackers).

#### [0.1.1] - 2026-10-06

- Awe 1.1.0: `native.filter: "enemies"`, so an ally targeted gets the temporary Stamina and the cleanse
  but none of the power roll's damage or fright (needs ds-auto-core 0.6.1); its "skip those rows" note is
  gone.
- `AUTHORING.md`: `native.filter`.

#### [0.1.0] - 2026-10-06

Wave 1.

- Module scaffold: registers `dist/overlays.mjs` with Draw Steel: Automation Core on `dsAuto.init`
  (priority 50).
- Tools: `index-system.mjs` (abilities, origins and character-options packs of the system, labeled text
  segments, own effects; the system's effects pack), `validate.mjs` (the core's schema, the key and name
  exist in the system, referenced power roll effects / own effects / compendium effects exist, file name =
  dsid, no tier conditions without a power roll, at least one non-reminder effect, licensing lint: no 6
  consecutive words shared with the ability's text), `build.mjs` (dist + coverage), `show.mjs`,
  `review.mjs`; `AUTHORING.md`.
- 82 overlays: Basic Abilities (Catch Breath, Heal, Defend, Stand Up, Claw Dirt), Censor (7), Fury (8),
  Null (5), Shadow (12), Tactician (12), Talent (21), Troubadour (10), Kits (Protective Attack),
  complication (Contact Spirits). Party abilities: Catch Breath, Heal, Defend, Stand Up, Judgement, Mark,
  To the Death!, Iron, Awe, Mind Spike, Entropic Bolt, Black Ash Teleport, I Work Better Alone, In All This
  Confusion, Dramatic Reversal, Contact Spirits. Party abilities with nothing beyond their native data, or
  only things the schema cannot express yet (shift, auras, edges / banes, dice), have no overlay.

### Draw Steel: Automation Medkit (ds-auto-medkit)

#### [0.7.0] - 2026-10-09

- Show active aura controls, including Stop and Null Field enhancement.
- Preserve new aura gates and temporary-Stamina dependencies when editing automation.
- Require Automation Core 0.12.0.


#### [0.6.1] - 2026-10-08

##### Changed

- Organize the automation editor into When, Who and What rule cards, with aligned fields,
  readable choices, inline guidance and collapsed advanced settings with configuration summaries.
- Group preset tools and ability settings separately; keep Save automation outside the scrolling body.
- Preserve draft values, disclosure state, scroll position and keyboard focus through editor actions.
  Type changes retain shared tier and potency gates, and validation expands the affected rule.

##### Fixed

- Preset rename and deletion preserve unsaved changes; unavailable preset actions are disabled.

#### [0.6.0] - 2026-10-08

##### Added

- Form-based automation authoring for abilities, features and ancestry traits; trigger requirements,
  recipient filters, formulas, tiers, potency, durations, costs and reusable world presets.
- Manual use of homebrew features and start/stop controls for performances.
- Feature and ancestry-trait coverage on actor and item sheets and compendium reports.

##### Fixed

- The complete Automation window scrolls within the viewport, including its bottom controls.


#### [0.5.0] - 2026-10-08

Milestone 8: release hardening (completed offline; M8 live testing pending).
Requires: Foundry 14.368, Draw Steel 1.1.2 (1.2 development builds: see ds-auto-core's README); ds-auto-core ≥ 0.9.0
(the Maintenance entries need ds-auto-core 0.10.0).

##### Added

- **Maintenance entries** in ds-auto-core's settings window (core 0.10.0, hook `dsAuto.settingsMenu`): "Automation
  coverage" opens the coverage report; "Customized items" lists the world's items and the actors' items whose
  automation is stored on the item (customized or outdated: the entries a cleanup would remove and a library update
  does not reach). With an older core nothing changes (the coverage report stays in the settings list).
- `tests/paths.cjs`: the tests find ds-auto-core, the library, the medkit and Handlebars through `DS_AUTO_CORE`,
  `DS_AUTO_LIBRARY`, `DS_AUTO_MEDKIT`, `DS_AUTO_HANDLEBARS` / `FOUNDRY_APP` (sibling folders and the repository's
  `node_modules` by default); no absolute paths left in the tests.
- README: a "License" section and the Maintenance entries.

##### Changed

- License: MIT for the code plus a plain notice that the module is not affiliated with MCDM Productions, LLC (README
  and `LICENSE`, kept in step by the repository's `legal.mjs`).
- The console warning without the core names ds-auto-core 0.9.0 (it said 0.6.0).

#### [0.4.1] - 2026-10-07

Wording from the Milestone 7 live run.

- Resource gains name the hero's own resource: "+1 Ferocity" instead of "+1 heroic resource" (actor window, and the
  feature's item window when the feature sits on a hero).

#### [0.4.0] - 2026-10-07

Milestone 7 (this entry was missing; written from the 0.4.0 manifest and ds-auto-core 0.9.0's notes).

- Needs ds-auto-core 0.9.0.
- **Class feature sheets**: a feature whose library overlay has resource gains (Ferocity, Focus, Drama, ...) gets the
  status badge and the **Automation** header control; its window lists the gains only (event, amount, once per round
  or encounter, upgrades) with Disable / Enable (a disabled feature grants nothing). No ability layers, no Lock.
- Actor window: for heroes, their **resource gains** (each rule with the amount their upgrades give and whether it
  was used this round or encounter, with a Release button for the Director, `api.resources`); for NPCs, the
  **villain actions** used this encounter (Reset for the Director, `api.villain`); for everyone, the live **areas**
  they created with a Dismiss button (`api.zones`). Each section is hidden without content or without the API.
- Item window: area effects in plain words ("Area: Wall of fire · Enters / Starts turn inside · enemies · until its
  creator's next turn") and their damage.
- `tests/check.cjs`: the gain `once` words and resources read from the core's `GAIN_ONCE` / `GAIN_RESOURCES`, the
  new sections' renders (shown with content, hidden without, Release / Reset only for the Director);
  `tests/harness.mjs`: the feature control and badge, the feature window, the area line, the actor window's gains,
  areas and villain actions.

#### [0.3.0] - 2026-10-07

Milestone 6.

- Needs ds-auto-core 0.8.0.
- Item window: summon effects in plain words ("Summons 2 × Goblin Runner", the stat block named from the
  pack index), with when it acts (right after you, own turn, with you, no turn) and how long it lasts; no
  "the user" bit (a summon is always the user's).
- Actor window: **Summons** (from the core's `api.summons.of`, hidden without it): the actor's live summons
  with their scene and how long they last, and a Dismiss button for the GM and the actor's owners;
  refreshed when a summon token is created or removed.
- `tests/check.cjs`: the summon turn words, the ends (read from the core's `SUMMON_LASTS`) and the Summons
  fieldset renders; `tests/harness.mjs`: the summon line and the Summons fieldset with Dismiss.
- Review fix: a refused Dismiss (no GM online, summon already gone, denied) shows the core's localized text, not
  the raw `DSAUTO.Relay.*` key (`tests/check.cjs` checks it).

#### [0.2.0] - 2026-10-07

Milestone 5.

- Needs ds-auto-core 0.7.0.
- Item window: **Triggers** (when the ability reacts, to whom, what it does, with the spend; whether it
  uses the round's triggered action and what it costs) and **Trackers** (the effect that gets a new target
  at 0 Stamina, and whether it ends when its source is dying). A trigger-only library overlay counts as
  Automated.
- Actor window: "Triggered action this round: available / used (ability) / not tracked", from the core's
  `api.triggers.budget` (hidden without it); refreshed on combat changes.
- `tests/check.cjs`: the trigger event and subject keys; `tests/harness.mjs`: triggers, trackers, the
  detach stamp and the triggered-action line.

#### [0.1.1] - 2026-10-06

- Status "Combat Tools" (`covered`): the library would add nothing because Combat Tools automates it all.
- Item window: a line when the overlay limits the system's own effects to enemies or allies.
- Actor window: icon and name on one line, the version next to the status badge.

#### [0.1.0] - 2026-10-06

Milestone 4.

- Status badge and **Automation** header control on ability sheets (`renderDrawSteelItemSheet`,
  `getHeaderControlsDrawSteelItemSheet`; Draw Steel Plus' sheet is a subclass and gets both).
- Item Automation window: status, layers, native and library effects in plain words, Combat Tools state,
  options (overlay `config`), Disable / Enable, Lock / Unlock, Detach, Re-sync, Reset.
- Actor Automation window: abilities with status, bulk actions, monster key with pin / unpin.
- Coverage report (settings menu) for ability compendiums.
- Settings: who may open it (default Assistant GM), status badge (client).
- `tests/check.cjs` (syntax, manifest, i18n, template renders), `tests/harness.mjs` (against ds-auto-core's
  mocked world).

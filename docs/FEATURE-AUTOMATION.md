# Generic feature automation

Implementation: core 0.11.0, library and Medkit 0.6.0. Stored rules use
`flags.stef-ds-automation.automation = {version: 1, rules: [...]}`. Existing native data, detached entries,
resource-gain rules and Black Ash Teleport remain supported. An absent flag needs no migration;
existing library effects can be copied into the editor's draft. Unknown versions are rejected.

The editor supports use, passive, damage.after, turn.start/end, round.start/end and strike.damage.
The last event adds damage to one original melee strike before immunity and halving. Self, selected
targets, event subject, attacker, aura and encounter recipients can be filtered by side, keywords,
range and trigger requirements. Each rule can have optional confirmation, a frequency limit,
Malice cost and duration. Special choice helpers cover shifts, safe area teleports, recovery
spending, damage-immunity choice, temporary heroic resources and Thunder Mother's native strike.

Supported content: Barbed Tail; Bastion, Entropy, Quickness, Repulsive, Sanctuary, Spirit, Steel,
Vanishing, Surprising Reactivity, Delightful Consequences, Excellent Protection and Nature's
Affection Wards; Goblin Mode; Acrobatics, Ballad of the Beast, Blocking, Choreography, Fire Up the
Night, Moonlight Sonata, Never-Ending Hero, Radical Fantasia, Revitalizing Limerick, Spotlight,
Take Two, Thunder Mother and We Can't Be Upstaged performances. Dirt Devil uses the system's
native damage and push after the new centered-area target selection.

Feature cards are signed and applied by the active GM, use the configured per-kind and actor-category
modes, and cap player-authored use cards. Frequency claims identify the applying card; duplicate
cards cannot consume the same use. Undo releases a claim after its remaining effects are undone.
Costs are applied before their followers and refunded when no follower applies. Modifier Undo
preserves changed or replaced effects. Synthetic event chains prevent a feature reacting to itself.

Auras select recipients on the relevant event. Turn-start bonuses persist through that recipient's
turn; maintaining or stopping a performance does not reroll already granted bonuses. Moonlight
Sonata asks dead recipients' owners and permits their turns without healing them; the ongoing
benefit depends on an active performer in range. Encounter end records their dust/death state.
Radical Fantasia uses the native terrain-cost interface and a once-per-round free triggered credit.
Acrobatics asks whether an otherwise unclassified test qualifies; Take Two recomputes ability tiers
and native damage after the accepted reroll. Fire Up the Night marks the first Search card as a free
maneuver; Draw Steel does not enforce a global main/maneuver action economy.

Offline verification: harness12 exercises authoring validation, independent presets, custom tiers,
self recipients, mitigation, Undo, frequency claims, shared Goblin Mode costs/prompts, Ward and
Barbed Tail integration, modifier preservation, performance activation/moving auras, temporary
resource expiry and centered area targeting. Existing regression harnesses cover the engine,
delegation, saving throws, resource gains, zones and Black Ash Teleport.

Live validation remains necessary after reloading Foundry: check short-height Medkit windows,
player-owned prompts, native roll dialogs for Take Two/Acrobatics, DSCT cover/concealment pills,
Moonlight turns with Death Tracker, and any third-party terrain-cost integration. No live result
for this change is claimed by the offline harnesses.

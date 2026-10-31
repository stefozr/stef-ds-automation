# Removing Stef's Automation Suite from a world

The module writes a little data into the world: a section on chat cards, a few flags, areas on the canvas, effects
with a special end, summoned creatures and their folder, and (only when you detached library automation in the
Smart Automation) special effects on items. If you disable the module without preparing, the world keeps working, but:

- ability cards show without their Automation section, and each card logs one console error at load;
- cards that consist only of our section (damage, trigger, resource gain, Malice, summon and area cards) **vanish
  from the chat log for everyone**, the Director included; what they applied stays applied;
- areas stay as regions whose behavior no longer works; effects that end "until ..." never end by themselves.

## Before you disable the module

Do this as the active Director (the only Director connected, or the one Foundry marks as active).

1. **Settings → Configure Settings → Stef's Automation Suite → Open settings → Maintenance → Prepare to
   uninstall.** It first counts what it would change (a dry run) and shows the numbers; confirm to run it. Ability
   cards lose our section and flags; cards that are only ours become plain text cards with a short summary (target,
   result, status per row), so the log stays readable. Undo on those cards is gone afterwards.
2. **Maintenance → Cleanup report**: what else is left. This report counts only; use `api.cleanup` to apply the actions in the table below.
3. Disable Stef's Automation Suite.

The same from the console:

```js
const api = game.modules.get("stef-ds-automation").api;
await api.stripParts();                              // dry run: counts only
await api.stripParts({ dryRun: false });             // convert our cards, strip ability cards
await api.cleanup();                                 // dry run: the report
await api.cleanup({ dryRun: false, summons: "dismiss", items: "remove", folders: "delete" });
```

`stripParts` options: `synthetic: "convert"` (default; plain text card) | `"delete"` (delete cards that are only
ours) | `"keep"`; `removeFlags` (default true); `olderThanDays` (only older cards); `batchSize` (100).

## What `api.cleanup` covers

| Item | Report (dry run) | Action |
|---|---|---|
| Areas (regions with the "Automation Zone" behavior) | count | `zones: "dismiss"` (default): ends each area and deletes its region |
| Effects that end "until ..." (`duration.expiry` `dsAutoUntil`) | count | `untilEffects: "convert"` (default): a normal effect that stays until removed by hand |
| Summoned creatures (tokens with `flags["stef-ds-automation"].summon`) | list | `summons: "dismiss"`: dismisses each (tokens removed) |
| Items with automation detached by Smart Automation (`dsAuto.*` special effects, `flags["stef-ds-automation"]`) | list per actor and item | `items: "remove"`: removes those entries and flags (your customizations are lost) |
| The actor folder "Summons (ds-auto)" | report | `folders: "delete"`: only when it is empty |
| Frightened, taunted and grabbed effects made by the core | count | left as they are: they are the system's own representation and keep working |

## If the core is already disabled

The API is gone, but the chat cards can still be stripped with a macro (Foundry API only). It cannot turn our own
cards into text: they stay invisible, or set `DELETE_OURS = true` to delete them.

```js
// Strip Stef's Automation Suite sections from chat cards (run as a Director).
if (!game.user.isGM) throw new Error("Run this macro as a Director.");
const DELETE_OURS = false; // true: delete the cards that consist only of our section
const Del = foundry.data.operators.ForcedDeletion;
const partsOf = m => Object.entries(m._source.system?.parts ?? {});
const isOurs = ([, p]) => p?.type === "dsAutoResolution";
const touched = game.messages.filter(m => partsOf(m).some(isOurs));
const onlyOurs = touched.filter(m => partsOf(m).every(isOurs));
const toDelete = DELETE_OURS ? onlyOurs.map(m => m.id) : [];
const updates = touched.filter(m => !toDelete.includes(m.id)).map(m => {
  const u = { _id: m.id, "flags.stef-ds-automation": new Del() };
  for (const [id, p] of partsOf(m)) if (isOurs([id, p])) u[`system.parts.${id}`] = new Del();
  return u;
});
for (let i = 0; i < updates.length; i += 100) await ChatMessage.implementation.updateDocuments(updates.slice(i, i + 100));
for (let i = 0; i < toDelete.length; i += 100) await ChatMessage.implementation.deleteDocuments(toDelete.slice(i, i + 100));
ui.notifications.info(`Stripped ${updates.length} chat card(s), deleted ${toDelete.length}.`);
```

Running it a second time finds 0 cards when everything is clean.

## The library and Smart Automation

The library content and Smart Automation store nothing of their own: the library only registers overlays at load, Smart Automation writes through
the core (item flags and `dsAuto.*` entries, covered by `api.cleanup` above).

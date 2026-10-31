// Stand-in for draw-steel-death-tracker/src/death-tracker.mjs (harness4): records reviveTokens calls
// and lifts the defeated status of the placeables it is given, like _doReviveV3's step 2.
export const calls = [];
export async function reviveTokens(tokenIds, options = {}) {
  calls.push({ tokenIds: [...tokenIds], options });
  for (const id of tokenIds) globalThis.canvas?.tokens?.get(id)?.actor?.statuses?.delete("dead");
}

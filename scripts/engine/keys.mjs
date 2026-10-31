/** Stable keys for targets and ops. Both are safe as dotted-path segments in document updates. */

/** Target key = token uuid with dots replaced (same convention as Draw Steel: Target Damage). */
export function targetKey(tokenUuid) {
  return String(tokenUuid ?? "").replace(/\./g, "__");
}

/** Op id from its parts; anything outside [A-Za-z0-9_-] becomes "-". */
export function opId(...parts) {
  return parts.map(p => String(p ?? "")).join("-").replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Token document id from a token uuid ("Scene.x.Token.y" -> "y"). */
export function tokenIdFromUuid(tokenUuid) {
  const m = /Token\.([A-Za-z0-9]{16})/.exec(String(tokenUuid ?? ""));
  return m ? m[1] : null;
}

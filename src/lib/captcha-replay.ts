/**
 * Single-use tracking for reCAPTCHA tokens.
 *
 * Google reCAPTCHA v2 tokens remain valid for roughly two minutes and can
 * otherwise be replayed to mint multiple Discord invites from one solve.
 * This cache rejects token reuse within that validity window. For
 * multi-instance production deployments, replace this with a shared store
 * such as Upstash Redis (SET with NX + EX 130s).
 */

const seenTokens = new Map<string, number>()

/** How long a consumed token stays rejected (slightly above Google validity). */
const TOKEN_TTL_MS = 130_000

/**
 * Attempt to consume a reCAPTCHA token.
 *
 * @param token - Raw reCAPTCHA response token from the client.
 * @returns True when the token was already consumed, false on first use.
 */
export function isTokenReplay(token: string): boolean {
  const now = Date.now()

  // Evict expired entries opportunistically to bound memory usage.
  for (const [key, expiresAt] of seenTokens) {
    if (expiresAt <= now) {
      seenTokens.delete(key)
    }
  }

  if (seenTokens.has(token)) {
    return true
  }

  seenTokens.set(token, now + TOKEN_TTL_MS)
  return false
}

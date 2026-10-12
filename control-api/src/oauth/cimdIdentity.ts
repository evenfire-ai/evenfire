/**
 * The platform CIMD client identity, without the router. Kept import-free so the
 * coherence reader (`mcpServerOAuthSpec.ts`) can recognise the CIMD client_id without
 * importing `cimd.ts`, which reaches the callback route and would close an import
 * cycle back to the reader.
 */

/** Path the CIMD document is served at, relative to the `/api/v1` mount in app.ts. */
export const CIMD_ROUTE_PATH = '/.well-known/evenfire-mcp-client'

/** Full public path of the served document (what `client_id` must equal, minus origin). */
export const CIMD_PUBLIC_PATH = `/api/v1${CIMD_ROUTE_PATH}`

// The CRD caps `spec.oauth.id` at 512: a longer client_id could never be written to the
// McpServer, so an install would only discover it after minting a client at the AS.
// Refusing it up front also bounds the work spent on attacker-supplied input.
export const MAX_CLIENT_ID_LENGTH = 512

const CIMD_PUBLIC_PATH_LOWER = CIMD_PUBLIC_PATH.toLowerCase()

/**
 * Whether a client_id names the platform CIMD document, on ANY origin.
 *
 * Matching the path rather than the currently configured origin is deliberate: a CR
 * written under an earlier public origin, or one that reaches us through an alias host,
 * still carries the one platform-wide identity whose document lists only the shared
 * callback. Express routes this path case-insensitively and with a trailing slash, so
 * those spellings are matched too. A false positive only rejects an id nobody but us
 * (or an attacker imitating us) would mint. Plain comparisons only: the input is
 * third-party data, and a backtracking pattern over a long run of `/` is quadratic.
 */
export function isCimdClientId(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.length > MAX_CLIENT_ID_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  const path = parsed.pathname.toLowerCase()
  return path === CIMD_PUBLIC_PATH_LOWER || path === `${CIMD_PUBLIC_PATH_LOWER}/`
}

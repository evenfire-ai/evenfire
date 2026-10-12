/**
 * Shared vocabulary for the errors Desktop main builds from upstream (rpc-proxy,
 * control-api, mcp-host) HTTP responses.
 *
 * Two concerns live here so every call site agrees on them:
 *
 * 1. The Host-access denial messages the renderer matches on
 *    (`ui/src/lib/format.ts isConfirmedHostAccessRevoked`). The strings are
 *    defined ONCE; `httpClient.requestJson` and the raw-`fetch` methods of
 *    `rpcProxyClient` all build them through {@link hostAccessDenialMessage}.
 * 2. A bounded, single-line excerpt of an upstream body for error messages
 *    ({@link boundedErrorExcerpt}), so a hostile or misbehaving upstream cannot
 *    push an unbounded payload through `Error.message` into logs, IPC and UI.
 */

/** Machine `code` rpc-proxy sets when the user's access to the Host was removed. */
export const HOST_ACCESS_REVOKED_CODE = 'host_access_revoked'
/** Machine `code` rpc-proxy sets for every other denial it authors itself. */
export const HOST_ACCESS_DENIED_CODE = 'host_access_denied'

/** The only message that lets the renderer treat a 403 as confirmed revocation. */
export const HOST_ACCESS_REVOKED_MESSAGE = `403 Forbidden: ${HOST_ACCESS_REVOKED_CODE}`
/** A 403 rpc-proxy authored that does NOT confirm revocation (renderer: generic 403). */
export const HOST_ACCESS_DENIED_MESSAGE = `403 Forbidden: ${HOST_ACCESS_DENIED_CODE}`

/** Upper bound (characters) of the upstream body excerpt embedded in a message. */
export const ERROR_EXCERPT_MAX_CHARS = 512

const RESERVED_HOST_ACCESS_TOKEN = /host_access_(revoked|denied)/gi

/**
 * A short single-line excerpt of an upstream body for an error message.
 *
 * Whitespace is collapsed, the result is cut at {@link ERROR_EXCERPT_MAX_CHARS}
 * characters (an ellipsis marks the cut), and the reserved Host-access tokens are
 * defused (`host_access_revoked` -> `host-access-revoked`): only
 * {@link hostAccessDenialMessage} may emit them, so a body that merely contains
 * the words can never forge a confirmed revocation.
 */
export function boundedErrorExcerpt(text: string): string {
  const collapsed = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(RESERVED_HOST_ACCESS_TOKEN, 'host-access-$1')
  return collapsed.length > ERROR_EXCERPT_MAX_CHARS
    ? `${collapsed.slice(0, ERROR_EXCERPT_MAX_CHARS)}…`
    : collapsed
}

/** The `code` string of a JSON error body, or null for non-JSON / code-less bodies. */
function machineCodeFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed?.code === 'string' ? parsed.code : null
  } catch {
    return null
  }
}

/**
 * The fixed Host-access message for a 403 response, or null when the response is
 * not one rpc-proxy authored with a Host-access `code`. Decided ONLY from the
 * parsed JSON `code` field: an `error` string, a text body or an interposed
 * proxy's page never qualifies.
 */
export function hostAccessDenialMessage(status: number, body: string): string | null {
  if (status !== 403) return null
  const code = machineCodeFromBody(body)
  if (code === HOST_ACCESS_REVOKED_CODE) return HOST_ACCESS_REVOKED_MESSAGE
  if (code === HOST_ACCESS_DENIED_CODE) return HOST_ACCESS_DENIED_MESSAGE
  return null
}

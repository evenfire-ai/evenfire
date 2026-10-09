/**
 * Shared vocabulary for the errors Desktop main builds from upstream (rpc-proxy,
 * control-api, mcp-host) HTTP responses.
 *
 * Two concerns live here so every call site agrees on them:
 *
 * 1. The Host-access denial messages the renderer matches on
 *    (`ui/src/lib/format.ts isConfirmedHostAccessRevoked`). The strings are
 *    defined ONCE. The default classifier is {@link hostAccessDenialMessage};
 *    AuthClient.issueRpcToken uses {@link rpcTokenMintRevocationMessage} to
 *    validate coverage of every requested Host.
 * 2. A bounded, single-line excerpt of an upstream body for error messages
 *    ({@link boundedErrorExcerpt}), so a hostile or misbehaving upstream cannot
 *    push an unbounded payload through `Error.message` into logs, IPC and UI.
 */

/** Revocation `code` authored by rpc-proxy and Control API's authenticated RPC mint. */
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
 * {@link hostAccessDenialMessage} and {@link rpcTokenMintRevocationMessage} may
 * emit them, so a body that merely contains the words cannot forge revocation.
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
 * not authored with a Host-access `code` by rpc-proxy or the authenticated mint.
 * Decided ONLY from the parsed JSON `code` field: error/text fields never qualify.
 * The mint caller uses {@link rpcTokenMintRevocationMessage} for requested-Host coverage.
 */
export function hostAccessDenialMessage(status: number, body: string): string | null {
  if (status !== 403) return null
  const code = machineCodeFromBody(body)
  if (code === HOST_ACCESS_REVOKED_CODE) return HOST_ACCESS_REVOKED_MESSAGE
  if (code === HOST_ACCESS_DENIED_CODE) return HOST_ACCESS_DENIED_MESSAGE
  return null
}

/**
 * Confirms an authenticated RPC mint revocation only when its string list is
 * exactly the mint's sorted, trimmed, deduplicated requested Host set.
 */
export function rpcTokenMintRevocationMessage(
  status: number,
  body: string,
  requestedHostRefs: unknown
): string | null {
  if (status !== 403 || !Array.isArray(requestedHostRefs)) return null

  const requestedRefs = new Set<string>()
  for (const value of requestedHostRefs) {
    if (typeof value !== 'string') return null
    const ref = value.trim()
    if (!ref || ref === '*') return null
    requestedRefs.add(ref)
  }
  if (requestedRefs.size === 0) return null

  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as { code?: unknown; revokedHostRefs?: unknown }
    if (
      record.code !== HOST_ACCESS_REVOKED_CODE ||
      !Array.isArray(record.revokedHostRefs) ||
      !record.revokedHostRefs.every((ref): ref is string => typeof ref === 'string')
    ) {
      return null
    }
    const canonicalRefs = Array.from(requestedRefs).sort()
    return record.revokedHostRefs.length === canonicalRefs.length &&
      record.revokedHostRefs.every((ref, index) => ref === canonicalRefs[index])
      ? HOST_ACCESS_REVOKED_MESSAGE
      : null
  } catch {
    return null
  }
}

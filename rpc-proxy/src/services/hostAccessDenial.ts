import type { Response as ExpressResponse } from 'express'

/**
 * rpc-proxy's OWN authorization denial for a Host (never a passthrough of an
 * mcp-host 403 body). Status stays 403 and `error` keeps its text; `code` is the
 * machine field Desktop uses to tell "access was removed from this user" from
 * "denied for a reason that does not prove revocation".
 */
export const HOST_ACCESS_DENIED_ERROR = 'Forbidden: user cannot access this host'

export type HostAccessDenialCode = 'host_access_revoked' | 'host_access_denied'

export type HostAccessDenial = { denied: true; code: HostAccessDenialCode }

/**
 * control-api denial reasons (control-api `RpcHostAccessDenialReason`) that
 * prove the access was actually removed from the user. Every other reason
 * (`host_disabled`, `host_missing`, `host_claim_missing`, `subject_mismatch`,
 * an unknown or absent reason) is a denial that does not prove revocation.
 * `subject_mismatch` in particular: rpc-proxy calls
 * `/rpc/access/users/:userId/...` with the token's own `sub` as `userId`
 * (control-api `routes/rpc-access/users.ts`), so a mismatch is a request-shape
 * error, never a grant that was removed.
 */
const REVOKED_CONTROL_API_REASONS: ReadonlySet<string> = new Set([
  'team_membership_missing',
  'directory_grant_missing',
])

export function hostAccessDenialCodeForReason(reason: unknown): HostAccessDenialCode {
  return typeof reason === 'string' && REVOKED_CONTROL_API_REASONS.has(reason)
    ? 'host_access_revoked'
    : 'host_access_denied'
}

export function hostAccessDenied(code: HostAccessDenialCode): HostAccessDenial {
  return { denied: true, code }
}

/** Narrows `resolveHostConnectionForUser`'s result: true means "respond 403". */
export function isHostAccessDenied<T extends object>(
  resolved: T | HostAccessDenial
): resolved is HostAccessDenial {
  return (resolved as Partial<HostAccessDenial>).denied === true
}

const RESERVED_HOST_ACCESS_CODES: ReadonlySet<unknown> = new Set<HostAccessDenialCode>([
  'host_access_revoked',
  'host_access_denied',
])

/**
 * The body rpc-proxy may relay for an upstream (mcp-host) response. Desktop
 * trusts the `code` of a 403 JSON body as rpc-proxy's own authorization verdict,
 * so a passthrough 403 must never carry a reserved Host-access code: an mcp-host
 * could otherwise forge a "confirmed revocation" that hides the agent. Such a
 * `code` field is dropped; the status and every other field are kept. A non-403
 * status, a non-JSON body and a JSON value that is not an object pass unchanged
 * (Desktop reads the code only from a parsed JSON object of a 403).
 */
export function withoutReservedHostAccessCode(status: number, body: string): string {
  if (status !== 403) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON: Desktop cannot read a `code` from it, so it is relayed as is.
    return body
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
  const { code, ...rest } = parsed as Record<string, unknown>
  if (!RESERVED_HOST_ACCESS_CODES.has(code)) return body
  console.warn(
    `[RPC_PROXY] dropped reserved host-access code from an upstream 403 body code=${String(code)}`
  )
  return JSON.stringify(rest)
}

/** The single writer of rpc-proxy's own Host authorization 403. */
export function respondHostAccessDenied(
  res: ExpressResponse,
  code: HostAccessDenialCode | HostAccessDenial
): void {
  res.status(403).json({
    error: HOST_ACCESS_DENIED_ERROR,
    code: typeof code === 'string' ? code : code.code,
  })
}

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
 * (`host_disabled`, `host_missing`, `host_claim_missing`, an unknown or absent
 * reason) is a denial that does not prove revocation.
 */
const REVOKED_CONTROL_API_REASONS: ReadonlySet<string> = new Set([
  'team_membership_missing',
  'directory_grant_missing',
  'subject_mismatch',
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

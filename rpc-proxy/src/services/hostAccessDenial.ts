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
 * control-api refused the request rather than the Host: a 401 without the
 * service gate's mark (the caller's RPC token, or an upstream 401 that
 * control-api forwards), or 409 (direct-run attribution). A 401 the service gate
 * marked is an unavailable authority, not a rejection.
 */
export type HostAccessRejection = { rejected: true; status: 401 | 409 }

/**
 * control-api could not complete the Host authorization: it timed out, the call
 * failed, it answered a status that is not an answer about access, its 200
 * answer cannot authorize a Host request (invalid binding status on POST, no
 * edge assertion), or it refused rpc-proxy's own service credential (a 401 that
 * carries the service gate's mark).
 */
export type HostAuthorityUnavailable =
  | {
      unavailable: true
      cause:
        | 'timeout'
        | 'request_failed'
        | 'invalid_binding_status'
        | 'edge_assertion_missing'
        | 'service_credential_rejected'
    }
  | { unavailable: true; cause: 'http_status'; status: number }

/** Every way a V1 Host resolve ends without a connection. */
export type HostResolveRefusal = HostAccessDenial | HostAccessRejection | HostAuthorityUnavailable

/** How a route answers a denial: 403 with the code, or 404 (task result and cancel). */
export type HostDenialAnswer = 'forbidden' | 'not_found'

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

/**
 * Narrows a Host resolve result: true means "answer it with
 * respondHostResolveRefusal". A connection carries none of the three keys.
 */
export function isHostResolveRefusal(value: object): value is HostResolveRefusal {
  return (
    Object.hasOwn(value, 'denied') ||
    Object.hasOwn(value, 'rejected') ||
    Object.hasOwn(value, 'unavailable')
  )
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

/**
 * The one writer of a Host resolve refusal, at a route's first resolve and at
 * the wake-and-hold re-resolve alike. A denial answers 403 with its code, or
 * 404 for the routes whose `denialAnswer` is `not_found`; a rejection answers
 * its own status; a control-api timeout answers 504 and every other
 * unavailability 503 `authority_unavailable`. No body carries a control-api
 * message. A committed response is left as it is, with one warn line.
 */
export function respondHostResolveRefusal(
  res: ExpressResponse,
  refusal: HostResolveRefusal,
  denialAnswer: HostDenialAnswer
): void {
  if (res.headersSent) {
    console.warn('[RPC_PROXY] suppressing duplicate terminal response (host-resolve-refusal)')
    return
  }
  if ('denied' in refusal) {
    if (denialAnswer === 'not_found') {
      res.status(404).json({ error: 'Host not found or not accessible' })
      return
    }
    respondHostAccessDenied(res, refusal)
    return
  }
  if ('rejected' in refusal) {
    if (refusal.status === 401) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    res.status(409).json({ error: 'Direct run attribution conflict' })
    return
  }
  if ('unavailable' in refusal) {
    switch (refusal.cause) {
      case 'timeout':
        res.status(504).json({ error: 'Gateway Timeout' })
        return
      case 'request_failed':
      case 'invalid_binding_status':
      case 'edge_assertion_missing':
      case 'http_status':
      case 'service_credential_rejected':
        res.status(503).json({ error: 'authority_unavailable' })
        return
      default: {
        // A new cause without a status decision above fails the build here.
        const unhandledCause: never = refusal
        throw new Error(`Unhandled host authority cause: ${JSON.stringify(unhandledCause)}`)
      }
    }
  }
  // A new refusal member without a branch above fails the build here.
  const unhandled: never = refusal
  throw new Error(`Unhandled host resolve refusal: ${JSON.stringify(unhandled)}`)
}

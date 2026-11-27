import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  INTERNAL_SERVICE_AUTH_REFUSAL_HEADER,
  INTERNAL_SERVICE_CREDENTIAL_REJECTED,
} from '../services/controlApiRestService.js'
import { hostAccessDenialCodeForReason } from '../services/hostAccessDenial.js'

/**
 * PR #849 R3-L9: cross-service guard for the Host-access denial contract.
 *
 * control-api names the denial reason (`RpcHostAccessDenialReason`) and sends it
 * in a response header; rpc-proxy reads that header, maps the reason to a
 * `HostAccessDenialCode`, and Desktop matches the code against its own
 * constants. The three services share no module, so each hop is read here as
 * source and compared. The rpc-proxy literals are also checked against the
 * running mapping, so a parse that drifted from the code fails instead of
 * comparing stale text.
 */

function read(relativeFromThisFile: string): string {
  return readFileSync(new URL(relativeFromThisFile, import.meta.url), 'utf-8')
}

/** Fail-loud single-match extraction — a miss means the source moved. */
function extractOne(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)
  if (!match || match[1] === undefined) {
    throw new Error(`Could not extract ${label} with ${pattern} — re-derive the guard`)
  }
  return match[1]
}

/** Every single-quoted literal of a union or array body; empty is a failure. */
function quotedLiterals(body: string, label: string): string[] {
  const literals = [...body.matchAll(/'([^']+)'/g)].map(match => match[1]!)
  if (literals.length === 0) throw new Error(`No literals found in ${label}`)
  return literals
}

const controlApiAuthorizer = read(
  '../../../control-api/src/services/access/rpcHostAccessAuthorizer.ts'
)
const controlApiRoute = read('../../../control-api/src/routes/rpc-access/users.ts')
const rpcProxyRestService = read('../services/controlApiRestService.ts')
const rpcProxyDenial = read('../services/hostAccessDenial.ts')
const desktopUpstreamErrors = read('../../../desktop-app/src/upstreamErrors.ts')
const controlApiGate = read('../../../control-api/src/middleware/internalServiceAuth.ts')
const controlApiApp = read('../../../control-api/src/app.ts')

const controlApiReasons = quotedLiterals(
  extractOne(
    controlApiAuthorizer,
    /export type RpcHostAccessDenialReason =([\s\S]*?)\n\n/,
    'control-api RpcHostAccessDenialReason'
  ),
  'control-api RpcHostAccessDenialReason'
)
const revokedReasons = quotedLiterals(
  extractOne(
    rpcProxyDenial,
    /const REVOKED_CONTROL_API_REASONS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/,
    'rpc-proxy REVOKED_CONTROL_API_REASONS'
  ),
  'rpc-proxy REVOKED_CONTROL_API_REASONS'
)
const rpcProxyCodes = quotedLiterals(
  extractOne(
    rpcProxyDenial,
    /export type HostAccessDenialCode = ([^\n]+)/,
    'rpc-proxy HostAccessDenialCode'
  ),
  'rpc-proxy HostAccessDenialCode'
)
const desktopRevokedCode = extractOne(
  desktopUpstreamErrors,
  /export const HOST_ACCESS_REVOKED_CODE = '([^']+)'/,
  'desktop HOST_ACCESS_REVOKED_CODE'
)
const desktopDeniedCode = extractOne(
  desktopUpstreamErrors,
  /export const HOST_ACCESS_DENIED_CODE = '([^']+)'/,
  'desktop HOST_ACCESS_DENIED_CODE'
)

// J1 (R1-L7): the service gate's refusal mark, as control-api writes it and as
// rpc-proxy reads it.
const gateRefusalHeaderSent = extractOne(
  controlApiGate,
  /export const INTERNAL_SERVICE_AUTH_REFUSAL_HEADER = '([^']+)'/,
  'control-api INTERNAL_SERVICE_AUTH_REFUSAL_HEADER'
)
const gateRefusalValueSent = extractOne(
  controlApiGate,
  /export const INTERNAL_SERVICE_CREDENTIAL_REJECTED = '([^']+)'/,
  'control-api INTERNAL_SERVICE_CREDENTIAL_REJECTED'
)
const gateRefusalHeaderRead = extractOne(
  rpcProxyRestService,
  /export const INTERNAL_SERVICE_AUTH_REFUSAL_HEADER = '([^']+)'/,
  'rpc-proxy INTERNAL_SERVICE_AUTH_REFUSAL_HEADER'
)
const gateRefusalValueRead = extractOne(
  rpcProxyRestService,
  /export const INTERNAL_SERVICE_CREDENTIAL_REJECTED = '([^']+)'/,
  'rpc-proxy INTERNAL_SERVICE_CREDENTIAL_REJECTED'
)

/** Index of one occurrence of `needle`; a miss means the source moved. */
function indexOfOne(source: string, needle: string, label: string): number {
  const index = source.indexOf(needle)
  if (index < 0 || source.indexOf(needle, index + 1) >= 0) {
    throw new Error(`Expected exactly one ${label} (${needle}) — re-derive the guard`)
  }
  return index
}

describe('R3-L9 Host-access denial contract across control-api, rpc-proxy and Desktop', () => {
  it('rpc-proxy reads the denial-reason header under the name control-api sends it', () => {
    const sent = extractOne(
      controlApiRoute,
      /export const HOST_ACCESS_DENIAL_REASON_HEADER = '([^']+)'/,
      'control-api HOST_ACCESS_DENIAL_REASON_HEADER'
    )
    const received = extractOne(
      rpcProxyRestService,
      /const reason = response\.headers\.get\('([^']+)'\)/,
      'rpc-proxy denial-reason header read'
    )

    expect(received).toBe(sent)
  })

  it('every revoking reason in rpc-proxy is a reason control-api can send', () => {
    // Witness: the parsed set is the running set.
    for (const reason of revokedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe('host_access_revoked')
    }
    for (const reason of revokedReasons) {
      expect(controlApiReasons).toContain(reason)
    }
    // And every other control-api reason is a plain denial.
    const deniedReasons = controlApiReasons.filter(r => !revokedReasons.includes(r))
    expect(deniedReasons.length).toBeGreaterThan(0)
    for (const reason of deniedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe('host_access_denied')
    }
  })

  it('Desktop matches exactly the codes rpc-proxy emits', () => {
    expect([...rpcProxyCodes].sort()).toEqual([desktopDeniedCode, desktopRevokedCode].sort())
    // The running mapping emits Desktop's literals for both outcomes.
    for (const reason of revokedReasons) {
      expect(hostAccessDenialCodeForReason(reason)).toBe(desktopRevokedCode)
    }
    expect(hostAccessDenialCodeForReason('a_reason_no_service_sends')).toBe(desktopDeniedCode)
  })
})

describe('J1 service-gate refusal contract between control-api and rpc-proxy', () => {
  it('rpc-proxy reads the refusal mark under the name and value control-api sends', () => {
    expect(gateRefusalHeaderRead).toBe(gateRefusalHeaderSent)
    expect(gateRefusalValueRead).toBe(gateRefusalValueSent)
    // The parsed literals are the running exports.
    expect(INTERNAL_SERVICE_AUTH_REFUSAL_HEADER).toBe(gateRefusalHeaderRead)
    expect(INTERNAL_SERVICE_CREDENTIAL_REJECTED).toBe(gateRefusalValueRead)
  })

  it('control-api mounts both service gates before the RPC access router', () => {
    const tokenGate = indexOfOne(controlApiApp, 'api.use(requireInternalToken)', 'token gate')
    const rpcServiceGate = indexOfOne(
      controlApiApp,
      "api.use('/rpc', requireInternalService('rpc-proxy'))",
      'rpc-proxy service gate'
    )
    const rpcAccessRouter = indexOfOne(controlApiApp, 'createRpcAccessRouter(', 'RPC access router')

    expect(tokenGate).toBeLessThan(rpcServiceGate)
    expect(rpcServiceGate).toBeLessThan(rpcAccessRouter)
  })
})

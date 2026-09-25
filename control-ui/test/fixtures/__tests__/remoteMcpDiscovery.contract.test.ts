import { describe, expect, it } from 'vitest'
import type { RemoteDetected, RemoteTransportProbe } from '../../../lib/remoteMcp.types'
import {
  CANVA_AS_JSON,
  CANVA_DETECTED,
  CANVA_PRM_JSON,
  DCR_CONFIDENTIAL_AS_JSON,
  DCR_CONFIDENTIAL_DETECTED,
  DCR_PUBLIC_AS_JSON,
  DCR_PUBLIC_DETECTED,
  type InitializeProbeObservation,
  LINEAR_AS_JSON,
  LINEAR_DETECTED,
  LINEAR_PRM_JSON,
  NOTION_AS_JSON,
  NOTION_DETECTED,
  NOTION_MCP_INITIALIZE,
  NOTION_PRM_JSON,
  NOTION_TRANSPORT_ALIVE,
  SENTRY_AS_JSON,
  SENTRY_DETECTED,
  SENTRY_PRM_JSON,
  VERCEL_MCP_INITIALIZE,
  VERCEL_ROOT_INITIALIZE,
  VERCEL_ROOT_PRM_JSON,
  VERCEL_TRANSPORT_DEAD,
} from '../remoteMcpDiscovery'

/**
 * Reproduces the producer's projection (control-api discovery.ts + remoteMcp.ts
 * route) from the verbatim raw probe bytes and asserts each hand-derived
 * `detected` fixture equals it. A fixture value that drifts from the real server
 * bytes fails here, so the fixtures cannot silently encode an invented shape.
 *
 * DRIFT LIMIT: projectDetected is a HAND MIRROR of the producer logic
 * (`discoverRemoteOAuth` + `selectRegistrationMode`/`deriveQuirks` in
 * control-api/src/oauth/discovery.ts, shaped into `detected` by the remoteMcp.ts
 * route). control-api is not importable from control-ui, so a change to that logic
 * does NOT fail this test on its own — it only catches fixture-vs-copy drift. Any
 * edit to the producer projection must be reflected here, or these fixtures certify
 * a stale shape. The producer carries the reverse pointer.
 */
function projectDetected(prmJson: string, asJson: string): RemoteDetected {
  const prm = JSON.parse(prmJson) as Record<string, unknown>
  const as = JSON.parse(asJson) as Record<string, unknown>

  const authMethods = (as.token_endpoint_auth_methods_supported as string[] | undefined) ?? []
  const hasRegistration = typeof as.registration_endpoint === 'string'
  // D-3, dry-run (no pre-registered client): cimd > dcr > manual.
  const registrationMode =
    as.client_id_metadata_document_supported === true && authMethods.includes('none')
      ? 'cimd'
      : hasRegistration
        ? 'dcr'
        : 'manual'

  const prmScopes = prm.scopes_supported as string[] | undefined
  const asScopes = as.scopes_supported as string[] | undefined
  const scopes = prmScopes ?? asScopes ?? []

  const bearerMethods = prm.bearer_methods_supported as string[] | undefined
  const bearerInBody = Array.isArray(bearerMethods)
    ? bearerMethods.includes('body') && !bearerMethods.includes('header')
    : false
  const grantTypes = as.grant_types_supported as string[] | undefined
  const supportsRefresh = grantTypes?.includes('refresh_token') ?? false

  const detected: RemoteDetected = {
    registrationMode: registrationMode as RemoteDetected['registrationMode'],
    endpoints: {
      authorization: as.authorization_endpoint as string,
      token: as.token_endpoint as string,
      ...(hasRegistration ? { registration: as.registration_endpoint as string } : {}),
    },
    resource: prm.resource as string,
    issuer: as.issuer as string,
    ...(as.authorization_response_iss_parameter_supported === true
      ? { issForCallback: as.issuer as string }
      : {}),
    scopes,
    quirks: { bearerInBody, supportsRefresh },
  }
  if (registrationMode === 'dcr') {
    detected.dcr = {
      available: true,
      clientMode: authMethods.includes('none') ? 'public' : 'confidential',
      supportsRefresh,
    }
  }
  return detected
}

describe('remote MCP `detected` fixtures match the real probe bytes', () => {
  const cases: Array<{ name: string; prm: string; as: string; fixture: RemoteDetected }> = [
    { name: 'notion', prm: NOTION_PRM_JSON, as: NOTION_AS_JSON, fixture: NOTION_DETECTED },
    { name: 'linear', prm: LINEAR_PRM_JSON, as: LINEAR_AS_JSON, fixture: LINEAR_DETECTED },
    { name: 'sentry', prm: SENTRY_PRM_JSON, as: SENTRY_AS_JSON, fixture: SENTRY_DETECTED },
    { name: 'canva', prm: CANVA_PRM_JSON, as: CANVA_AS_JSON, fixture: CANVA_DETECTED },
    {
      name: 'dcr-public',
      prm: NOTION_PRM_JSON,
      as: DCR_PUBLIC_AS_JSON,
      fixture: DCR_PUBLIC_DETECTED,
    },
    {
      name: 'dcr-confidential',
      prm: NOTION_PRM_JSON,
      as: DCR_CONFIDENTIAL_AS_JSON,
      fixture: DCR_CONFIDENTIAL_DETECTED,
    },
  ]

  for (const { name, prm, as, fixture } of cases) {
    it(`${name}: fixture equals the producer projection of the raw bytes`, () => {
      expect(fixture).toEqual(projectDetected(prm, as))
    })
  }

  it('the four CIMD pilots resolve to cimd and carry a registration endpoint', () => {
    for (const fixture of [NOTION_DETECTED, LINEAR_DETECTED, SENTRY_DETECTED, CANVA_DETECTED]) {
      expect(fixture.registrationMode).toBe('cimd')
      expect(fixture.endpoints.registration).toBeTruthy()
      expect(fixture.dcr).toBeUndefined()
    }
  })

  it('only sentry advertises issForCallback (RFC 9207)', () => {
    expect(SENTRY_DETECTED.issForCallback).toBe('https://mcp.sentry.dev')
    expect(NOTION_DETECTED.issForCallback).toBeUndefined()
    expect(LINEAR_DETECTED.issForCallback).toBeUndefined()
    expect(CANVA_DETECTED.issForCallback).toBeUndefined()
  })
})

/**
 * Reproduces the producer's MCP transport classifier + canonical-URL suggestion
 * (control-api `mcpTransportProbe.ts`, decision table in the mini-spec) from the
 * observed `initialize` statuses and the real root-PRM bytes, and asserts each
 * hand-derived RemoteTransportProbe fixture equals it. A drifted fixture fails.
 *
 * This is a local re-projection: control-ui cannot import control-api. The real
 * producer's output is anchored in control-api `test/routes.adminRemoteMcp.test.ts`
 * (it asserts these same literal shapes). If the classifier drifts, that test is
 * the one that catches it — treat this projection as a mirror, not the authority.
 */
function classifyInitialize(obs: InitializeProbeObservation): 'alive' | 'dead' | 'inconclusive' {
  const { httpStatus } = obs
  if (httpStatus === 200 || httpStatus === 202 || httpStatus === 401 || httpStatus === 403) {
    return 'alive'
  }
  if (httpStatus === 404 || httpStatus === 405) return 'dead'
  return 'inconclusive'
}

/** Trailing-slash-insensitive path, so `/mcp` differs from `/` but not from `/mcp/`. */
function trimmedPath(url: string): string {
  const { pathname } = new URL(url)
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function projectTransport(
  typed: InitializeProbeObservation,
  rootPrmJson?: string,
  candidate?: InitializeProbeObservation
): RemoteTransportProbe {
  const verdict = classifyInitialize(typed)
  if (verdict === 'alive') {
    return {
      status: 'alive',
      probedUrl: typed.url,
      httpStatus: typed.httpStatus,
      challenge: typed.wwwAuthenticate,
    }
  }
  if (verdict === 'inconclusive') {
    return {
      status: 'inconclusive',
      probedUrl: typed.url,
      reason: 'unexpected_status',
      httpStatus: typed.httpStatus,
      detail: `unexpected status ${typed.httpStatus}`,
    }
  }

  // dead — resolve a canonical suggestion (only when the typed path is not root
  // and a same-origin, different-path root `resource` probes alive).
  let suggestedBaseUrl: string | undefined
  const typedUrl = new URL(typed.url)
  if (typedUrl.pathname !== '/' && rootPrmJson && candidate) {
    const prm = JSON.parse(rootPrmJson) as { resource?: unknown }
    const resource = typeof prm.resource === 'string' ? prm.resource : undefined
    const candidateUrl =
      resource &&
      new URL(resource).origin === typedUrl.origin &&
      trimmedPath(resource) !== trimmedPath(typed.url)
        ? resource
        : `${typedUrl.origin}/`
    if (candidateUrl === candidate.url && classifyInitialize(candidate) === 'alive') {
      suggestedBaseUrl = candidate.url
    }
  }
  return {
    status: 'dead',
    probedUrl: typed.url,
    httpStatus: typed.httpStatus as 404 | 405,
    ...(suggestedBaseUrl ? { suggestedBaseUrl } : {}),
  }
}

describe('remote MCP `transport` fixtures match the real probe outputs', () => {
  it('vercel /mcp: 404 → dead, with the root resource as the verified suggestion', () => {
    expect(VERCEL_TRANSPORT_DEAD).toEqual(
      projectTransport(VERCEL_MCP_INITIALIZE, VERCEL_ROOT_PRM_JSON, VERCEL_ROOT_INITIALIZE)
    )
  })

  it('notion /mcp: 401 challenge → alive (the case the issue must not break)', () => {
    expect(NOTION_TRANSPORT_ALIVE).toEqual(projectTransport(NOTION_MCP_INITIALIZE))
  })
})

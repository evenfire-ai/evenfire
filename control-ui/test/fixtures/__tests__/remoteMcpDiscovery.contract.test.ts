import { describe, expect, it } from 'vitest'
import type { RemoteDetected } from '../../../lib/remoteMcp.types'
import {
  CANVA_AS_JSON,
  CANVA_DETECTED,
  CANVA_PRM_JSON,
  DCR_CONFIDENTIAL_AS_JSON,
  DCR_CONFIDENTIAL_DETECTED,
  DCR_PUBLIC_AS_JSON,
  DCR_PUBLIC_DETECTED,
  LINEAR_AS_JSON,
  LINEAR_DETECTED,
  LINEAR_PRM_JSON,
  NOTION_AS_JSON,
  NOTION_DETECTED,
  NOTION_PRM_JSON,
  SENTRY_AS_JSON,
  SENTRY_DETECTED,
  SENTRY_PRM_JSON,
} from '../remoteMcpDiscovery'

/**
 * Reproduces the producer's projection (control-api discovery.ts + remoteMcp.ts
 * route) from the verbatim raw probe bytes and asserts each hand-derived
 * `detected` fixture equals it. A fixture value that drifts from the real server
 * bytes fails here, so the fixtures cannot silently encode an invented shape.
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

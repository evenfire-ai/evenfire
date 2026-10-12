import { describe, expect, it } from 'vitest'
import type { RemoteTransportProbe } from '../../../lib/remoteMcp.types'
import {
  type InitializeProbeObservation,
  NOTION_MCP_INITIALIZE,
  NOTION_TRANSPORT_ALIVE,
  VERCEL_MCP_INITIALIZE,
  VERCEL_ROOT_INITIALIZE,
  VERCEL_ROOT_PRM_JSON,
  VERCEL_TRANSPORT_DEAD,
} from '../remoteMcpDiscovery'
import {
  ALL_DISCOVER_BODIES,
  ATLASSIAN_DISCOVER,
  LINEAR_DISCOVER,
  NOTION_DISCOVER,
  PRE_REGISTERED_PER_SERVER_DISCOVER,
} from '../remoteMcpWire'

/**
 * The `/discover` bodies are control-api's own responses (golden wire files captured
 * from the real router), so they are not re-projected here. What this block pins is
 * the part of that contract the wizard's decisions rest on; a golden that moves in a
 * way the wizard does not handle fails here, next to the fixture, rather than as a
 * confusing wizard test failure.
 */
describe('remote MCP `/discover` goldens carry the callback contract the wizard relies on', () => {
  it('the pilots resolve as the backend decides today', () => {
    expect(LINEAR_DISCOVER.detected.registrationMode).toBe('cimd')
    expect(LINEAR_DISCOVER.callback?.variant).toBe('shared')
    // Notion offers CIMD but not RFC 9207, so it can only install by DCR.
    expect(NOTION_DISCOVER.detected.registrationMode).toBe('dcr')
    expect(NOTION_DISCOVER.callback?.variant).toBe('per-server')
    expect(ATLASSIAN_DISCOVER.detected.registrationMode).toBe('dcr')
    expect(PRE_REGISTERED_PER_SERVER_DISCOVER.detected.registrationMode).toBe('manual')
  })

  for (const { name, body } of ALL_DISCOVER_BODIES) {
    it(`${name}: without RFC 9207 never CIMD, and the variant follows issForCallback`, () => {
      const hasIss = Boolean(body.detected.issForCallback)
      expect(body.callback?.variant).toBe(hasIss ? 'shared' : 'per-server')
      if (!hasIss) expect(body.detected.registrationMode).not.toBe('cimd')
    })

    it(`${name}: endpoint hosts are reported iff per-server, and match the endpoints`, () => {
      const hosts = body.detected.asEndpointHosts
      if (body.callback?.variant !== 'per-server') {
        expect(hosts).toBeUndefined()
        return
      }
      const { authorization, token, registration } = body.detected.endpoints
      expect(hosts).toEqual({
        authorization: new URL(authorization).host,
        token: new URL(token).host,
        ...(registration ? { registration: new URL(registration).host } : {}),
      })
    })

    it(`${name}: the redirect URI template carries the placeholders its mode needs`, () => {
      const callback = body.callback
      if (!callback?.configured) {
        expect(callback?.redirectUriTemplate).toBeUndefined()
        return
      }
      const template = callback.redirectUriTemplate ?? ''
      if (callback.variant === 'shared') {
        expect(template).not.toMatch(/\{/)
      } else if (body.detected.registrationMode === 'dcr') {
        expect(template).toMatch(/\/\{serverName\}\/\{installId\}$/)
      } else {
        expect(template).toMatch(/\/\{serverName\}$/)
      }
    })
  }
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

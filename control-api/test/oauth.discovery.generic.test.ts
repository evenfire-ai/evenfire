import { describe, expect, it, vi } from 'vitest'
import type { PinnedRawResponse, PinnedTransport } from '../src/http/pinnedFetch.js'
import {
  type DiscoveryDeps,
  buildGenericDiscoveryPrefill,
  discoverAuthorizationServerMetadata,
} from '../src/oauth/discovery.js'
import {
  CANVA_AS_JSON,
  LINEAR_AS_JSON,
  NOTION_AS_JSON,
  PILOTS,
  SENTRY_AS_JSON,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'

/**
 * S3-B4 / E-19.5 — generic AS discovery (issuer-first → PRM, DA-2). Fixtures are the
 * real 2026-09-20 probe bytes (T1): the four pilots expose RFC 8414 / OIDC AS
 * metadata, which is exactly the issuer-first shape. No S256 gate (inv.7); every URL
 * kernel-guarded before the fetch (inv.6).
 */
const PUBLIC_IP = ['93.184.216.34']
const publicDns = () => vi.fn(async () => PUBLIC_IP)
function deps(transport: PinnedTransport, resolveDns = publicDns()): DiscoveryDeps {
  return { transport, resolveDns }
}

/** Transport that serves ONE AS well-known URL, 404 elsewhere (issuer-first shape). */
function asOnlyTransport(asWellKnownUrl: string, json: string): PinnedTransport {
  return async ({ url }: { url: string }): Promise<PinnedRawResponse> => {
    if (url === asWellKnownUrl) {
      return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: json }
    }
    return { status: 404, headers: {}, bodyText: 'not found' }
  }
}

const AS_BY_PILOT: Record<'notion' | 'linear' | 'sentry' | 'canva', string> = {
  notion: NOTION_AS_JSON,
  linear: LINEAR_AS_JSON,
  sentry: SENTRY_AS_JSON,
  canva: CANVA_AS_JSON,
}

describe('discoverAuthorizationServerMetadata — issuer-first (T1 real fixtures)', () => {
  for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
    it(`${key}: resolves AS metadata directly from the issuer`, async () => {
      const as = JSON.parse(AS_BY_PILOT[key])
      // Issuer origin (path-less AS) → well-known oauth-authorization-server.
      const issuer: string = as.issuer
      const asWellKnown = `${issuer}/.well-known/oauth-authorization-server`
      const outcome = await discoverAuthorizationServerMetadata(
        issuer,
        deps(asOnlyTransport(asWellKnown, AS_BY_PILOT[key]))
      )
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.issuer).toBe(as.issuer)
      expect(outcome.result.endpoints.authorization).toBe(as.authorization_endpoint)
      expect(outcome.result.endpoints.token).toBe(as.token_endpoint)
      // Issuer-first carries no PRM / resource.
      expect(outcome.result.prm).toBeUndefined()
      expect(outcome.result.resource).toBeUndefined()
    })
  }

  it('projects the prefill wire deterministically (notion)', async () => {
    const asWellKnown = 'https://mcp.notion.com/.well-known/oauth-authorization-server'
    const outcome = await discoverAuthorizationServerMetadata(
      'https://mcp.notion.com',
      deps(asOnlyTransport(asWellKnown, NOTION_AS_JSON))
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const prefill = buildGenericDiscoveryPrefill(outcome.result)
    // Notion advertises S256 (+plain), refresh_token, and both basic+post → body.
    expect(prefill.suggested.usePkce).toBe(true)
    expect(prefill.suggested.supportsRefresh).toBe(true)
    expect(prefill.suggested.tokenAuthMethod).toBe('body')
    expect(prefill.capabilities.codeChallengeMethods).toContain('S256')
    expect(prefill.scopesSupported).toEqual(['default'])
    expect(prefill.resource).toBeUndefined()
  })

  // PRM fallback (RFC 9728 → 8414): a protected-resource URL, no AS at the issuer.
  it('falls back to PRM when the URL is a protected resource, carrying resource', async () => {
    const outcome = await discoverAuthorizationServerMetadata(
      PILOTS.notion.mcpUrl,
      deps(makeDiscoveryTransport(PILOTS.notion))
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.prm).toBeDefined()
    expect(outcome.result.resource).toBe('https://mcp.notion.com')
    const prefill = buildGenericDiscoveryPrefill(outcome.result)
    expect(prefill.resource).toBe('https://mcp.notion.com')
  })
})

describe('discoverAuthorizationServerMetadata — no S256 gate (inv.7)', () => {
  it('accepts an AS without code_challenge_methods_supported; usePkce suggested false', async () => {
    // Derived from the real Notion AS by documented subtraction (T1): drop the PKCE
    // advertisement. Discovery must NOT fail closed (unlike the remote lane).
    const as = JSON.parse(NOTION_AS_JSON) as Record<string, unknown>
    delete as.code_challenge_methods_supported
    const json = JSON.stringify(as)
    const asWellKnown = 'https://mcp.notion.com/.well-known/oauth-authorization-server'
    const outcome = await discoverAuthorizationServerMetadata(
      'https://mcp.notion.com',
      deps(asOnlyTransport(asWellKnown, json))
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const prefill = buildGenericDiscoveryPrefill(outcome.result)
    expect(prefill.suggested.usePkce).toBe(false)
    expect(prefill.capabilities.codeChallengeMethods).toEqual([])
  })
})

describe('discoverAuthorizationServerMetadata — kernel §4 (inv.6)', () => {
  it('never opens a socket to a kernel-rejected (internal) URL', async () => {
    const transport = vi.fn(async () => ({ status: 200, headers: {}, bodyText: '{}' }))
    const outcome = await discoverAuthorizationServerMetadata(
      'https://as.svc.cluster.local',
      deps(transport as unknown as PinnedTransport)
    )
    expect(outcome.ok).toBe(false)
    // Internal hostname is rejected pre-DNS, pre-connect: zero transport calls.
    expect(transport).toHaveBeenCalledTimes(0)
  })

  it('rejects an AS that advertises an internal authorization endpoint', async () => {
    // Real Notion AS with the authorize endpoint mutated to an internal host — the
    // metadata fetch succeeds, but the discovered endpoint fails the kernel.
    const as = JSON.parse(NOTION_AS_JSON) as Record<string, unknown>
    as.authorization_endpoint = 'https://authorize.svc.cluster.local/authorize'
    const json = JSON.stringify(as)
    const asWellKnown = 'https://mcp.notion.com/.well-known/oauth-authorization-server'
    const outcome = await discoverAuthorizationServerMetadata(
      'https://mcp.notion.com',
      deps(asOnlyTransport(asWellKnown, json))
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.kind).toBe('kernel_rejected')
  })
})

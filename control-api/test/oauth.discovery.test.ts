import { describe, expect, it, vi } from 'vitest'
import {
  type DiscoveryDeps,
  asMetadataUrls,
  discoverRemoteOAuth,
  parseResourceMetadataChallenge,
  wellKnownPrmUrls,
} from '../src/oauth/discovery.js'
import { PILOTS, makeDiscoveryFetch } from './fixtures/remoteOAuthDiscovery.js'

/**
 * Discovery client (spec 19 §4/§5 C1). Fixtures are the real 2026-09-20 probe
 * bytes (T1). `resolveDns` is injected so the kernel runs without a cluster.
 */
const PUBLIC_IP = ['93.184.216.34']
const publicDns = () => vi.fn(async () => PUBLIC_IP)

function deps(pilotFetch: typeof fetch, resolveDns = publicDns()): DiscoveryDeps {
  return { fetchFn: pilotFetch, resolveDns }
}

describe('discoverRemoteOAuth — 4 CIMD pilots (T1 real fixtures)', () => {
  for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
    const pilot = PILOTS[key]
    it(`${key}: resolves PRM→AS, selects CIMD, pins endpoints`, async () => {
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryFetch(pilot)))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const r = outcome.result
      // D-3: all 4 pilots resolve to CIMD (cimd_supported + `none`).
      expect(r.registrationMode).toBe('cimd')
      // RFC 8707: resource is the PRM resource verbatim.
      expect(r.resource).toBe(JSON.parse(pilot.prm.json).resource)
      // Endpoints pinned from the AS metadata.
      const as = JSON.parse(pilot.as.json)
      expect(r.endpoints.token).toBe(as.token_endpoint)
      expect(r.endpoints.authorization).toBe(as.authorization_endpoint)
      expect(r.issuer).toBe(as.issuer)
      // All 4 advertise refresh_token → supportsRefresh true; none is bearer-in-body.
      expect(r.quirks.supportsRefresh).toBe(true)
      expect(r.quirks.bearerInBody).toBe(false)
    })
  }

  it('sentry: exposes issForCallback (RFC 9207); others do not', async () => {
    const sentry = await discoverRemoteOAuth(
      PILOTS.sentry.mcpUrl,
      deps(makeDiscoveryFetch(PILOTS.sentry))
    )
    expect(sentry.ok && sentry.result.issForCallback).toBe('https://mcp.sentry.dev')

    const notion = await discoverRemoteOAuth(
      PILOTS.notion.mcpUrl,
      deps(makeDiscoveryFetch(PILOTS.notion))
    )
    expect(notion.ok && notion.result.issForCallback).toBeUndefined()
  })

  it('sentry: uses the WWW-Authenticate resource_metadata hint (path-suffixed PRM)', async () => {
    // Sentry root well-known 404s; discovery must follow the 401 hint.
    const outcome = await discoverRemoteOAuth(
      PILOTS.sentry.mcpUrl,
      deps(makeDiscoveryFetch(PILOTS.sentry))
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.prm.resource).toBe('https://mcp.sentry.dev/mcp')
  })
})

describe('discoverRemoteOAuth — kernel §4 before every fetch (invariant 2, T5)', () => {
  it('calls the kernel (resolveDns) before fetching each URL', async () => {
    const order: string[] = []
    const resolveDns = vi.fn(async (host: string) => {
      order.push(`dns:${host}`)
      return PUBLIC_IP
    })
    const base = makeDiscoveryFetch(PILOTS.notion)
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      order.push(`fetch:${typeof input === 'string' ? input : input.toString()}`)
      return base(input, init)
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth(PILOTS.notion.mcpUrl, { fetchFn, resolveDns })
    expect(outcome.ok).toBe(true)
    // Every fetch is immediately preceded by a DNS resolve of its host — no fetch
    // ever appears before its guarding resolve.
    order
      .filter(e => e.startsWith('fetch:'))
      .forEach(fetchEntry => {
        const host = new URL(fetchEntry.slice('fetch:'.length)).hostname
        const fetchIdx = order.indexOf(fetchEntry)
        const dnsIdx = order.lastIndexOf(`dns:${host}`, fetchIdx)
        expect(dnsIdx).toBeGreaterThanOrEqual(0)
        expect(dnsIdx).toBeLessThan(fetchIdx)
      })
  })

  it('rejects a PRM host resolving to a private IP WITHOUT fetching it', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const fetchFn = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', { fetchFn, resolveDns })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('skips a kernel-rejected WWW-Authenticate hint and never fetches it', async () => {
    // AS points resource_metadata at an internal host; kernel must drop it and
    // fall back to the well-known (public) candidate.
    const evilHint = 'Bearer resource_metadata="https://metadata.internal/.well-known/x"'
    const resolveDns = vi.fn(async (host: string) => {
      if (host === 'metadata.internal') return ['169.254.169.254']
      return PUBLIC_IP
    })
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401, headers: { 'www-authenticate': evilHint } })
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return new Response(PILOTS.notion.prm.json, { status: 200 })
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
        return new Response(PILOTS.notion.as.json, { status: 200 })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', { fetchFn, resolveDns })
    expect(outcome.ok).toBe(true)
    // The internal host was never fetched.
    const fetchedUrls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c =>
      String(c[0])
    )
    expect(fetchedUrls.some(u => u.includes('metadata.internal'))).toBe(false)
  })
})

describe('discoverRemoteOAuth — SSRF via redirects (H1: redirect:manual + re-validate)', () => {
  it('does NOT follow a 302 → IMDS from a well-known fetch (rejected by the kernel)', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401 })
      }
      // Every PRM well-known candidate 302s at the link-local IMDS address.
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', { fetchFn, resolveDns })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    const fetched = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c =>
      String(c[0])
    )
    expect(fetched.some(u => u.includes('169.254.169.254'))).toBe(false)
  })

  it('does NOT follow a 302 → internal .svc host (rejected by the kernel)', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401 })
      }
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://control-api.mcp-host.svc/.well-known/x' },
        })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', { fetchFn, resolveDns })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    const fetched = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c =>
      String(c[0])
    )
    expect(fetched.some(u => u.includes('.svc'))).toBe(false)
  })

  it('fails closed (redirect_blocked) when the hop count is exceeded', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401 })
      }
      // A public host that keeps redirecting to itself — never terminates.
      return new Response(null, {
        status: 302,
        headers: { location: 'https://loop.example.com/next' },
      })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', { fetchFn, resolveDns })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('redirect_blocked')
  })

  it('DOES follow a kernel-approved redirect to a public host', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401 })
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://mcp.notion.com/prm-moved' },
        })
      }
      if (url === 'https://mcp.notion.com/prm-moved') {
        return new Response(PILOTS.notion.prm.json, { status: 200 })
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
        return new Response(PILOTS.notion.as.json, { status: 200 })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', { fetchFn, resolveDns })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.resource).toBe('https://mcp.notion.com')
    const fetched = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c =>
      String(c[0])
    )
    expect(fetched).toContain('https://mcp.notion.com/prm-moved')
  })
})

describe('discoverRemoteOAuth — third-party metadata self-consistency (C2/C3)', () => {
  it('C2: rejects a PRM whose resource is cross-origin (RFC 9728 §3.3)', async () => {
    const evilPrm = { ...JSON.parse(PILOTS.notion.prm.json), resource: 'https://evil.example.com' }
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401 })
      }
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify(evilPrm), { status: 200 })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      fetchFn,
      resolveDns: publicDns(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('prm_resource_mismatch')
  })

  it('C2: accepts the real pilots (Notion origin-match, Linear exact)', async () => {
    for (const key of ['notion', 'linear'] as const) {
      const outcome = await discoverRemoteOAuth(
        PILOTS[key].mcpUrl,
        deps(makeDiscoveryFetch(PILOTS[key]))
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok)
        expect(outcome.result.resource).toBe(JSON.parse(PILOTS[key].prm.json).resource)
    }
  })

  it('C3: rejects AS metadata whose issuer != authorization server base (RFC 8414 §3.3)', async () => {
    const evilAs = { ...JSON.parse(PILOTS.notion.as.json), issuer: 'https://evil.example.com' }
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.notion.com/mcp' && (init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 401 })
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return new Response(PILOTS.notion.prm.json, { status: 200 })
      }
      // The evil issuer is served on BOTH AS-metadata candidates (oauth + OIDC),
      // so neither clears the RFC 8414 §3.3 check.
      if (
        url === 'https://mcp.notion.com/.well-known/oauth-authorization-server' ||
        url === 'https://mcp.notion.com/.well-known/openid-configuration'
      ) {
        return new Response(JSON.stringify(evilAs), { status: 200 })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      fetchFn,
      resolveDns: publicDns(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('issuer_mismatch')
  })

  it('C3: accepts the real pilots (issuer == authorization server base)', async () => {
    for (const key of ['notion', 'sentry'] as const) {
      const outcome = await discoverRemoteOAuth(
        PILOTS[key].mcpUrl,
        deps(makeDiscoveryFetch(PILOTS[key]))
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.result.issuer).toBe(JSON.parse(PILOTS[key].as.json).issuer)
    }
  })
})

describe('discoverRemoteOAuth — fail-closed without S256 (invariant 3, T5)', () => {
  it('refuses when code_challenge_methods_supported lacks S256', async () => {
    const noS256As = JSON.parse(PILOTS.notion.as.json)
    noS256As.code_challenge_methods_supported = ['plain']
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return new Response(PILOTS.notion.prm.json, { status: 200 })
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify(noS256As), { status: 200 })
      }
      if (url === 'https://mcp.notion.com/mcp') return new Response(null, { status: 401 })
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      fetchFn,
      resolveDns: vi.fn(async () => PUBLIC_IP),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('no_s256')
  })
})

describe('well-known URL construction (RFC 9728 §3.1 / RFC 8414)', () => {
  it('PRM: root-only for a resource without path', () => {
    expect(wellKnownPrmUrls(new URL('https://mcp.notion.com/'))).toEqual([
      'https://mcp.notion.com/.well-known/oauth-protected-resource',
    ])
  })
  it('PRM: path-suffixed then root for a resource with path', () => {
    expect(wellKnownPrmUrls(new URL('https://mcp.linear.app/mcp'))).toEqual([
      'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
      'https://mcp.linear.app/.well-known/oauth-protected-resource',
    ])
  })
  it('AS: oauth-authorization-server then openid-configuration at root', () => {
    expect(asMetadataUrls(new URL('https://mcp.sentry.dev'))).toEqual([
      'https://mcp.sentry.dev/.well-known/oauth-authorization-server',
      'https://mcp.sentry.dev/.well-known/openid-configuration',
    ])
  })
  it('AS with a path: oauth is path-inserted, OIDC is path-appended (RFC 8414 §3.1/§5)', () => {
    expect(asMetadataUrls(new URL('https://as.example.com/tenant1'))).toEqual([
      'https://as.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://as.example.com/tenant1/.well-known/openid-configuration',
    ])
  })
})

describe('parseResourceMetadataChallenge', () => {
  it('extracts resource_metadata from a real Sentry challenge', () => {
    expect(parseResourceMetadataChallenge(PILOTS.sentry.wwwAuthenticate)).toBe(
      'https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp'
    )
  })
  it('returns undefined when no header / no field', () => {
    expect(parseResourceMetadataChallenge(null)).toBeUndefined()
    expect(parseResourceMetadataChallenge('Bearer realm="x"')).toBeUndefined()
  })
})

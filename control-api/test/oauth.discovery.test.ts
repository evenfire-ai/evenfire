import { describe, expect, it, vi } from 'vitest'
import type { PinnedRawResponse, PinnedTransport } from '../src/http/pinnedFetch.js'
import {
  type DiscoveryDeps,
  asMetadataUrls,
  discoverRemoteOAuth,
  parseResourceMetadataChallenge,
  wellKnownPrmUrls,
} from '../src/oauth/discovery.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'

/**
 * Discovery client (spec 19 §4/§5 C1 + C1.5 H2 pin). Fixtures are the real
 * 2026-09-20 probe bytes (T1). Discovery fetches through the IP-pinned `node:https`
 * transport, injected here so the pin runs without a cluster; `resolveDns` is
 * injected so the kernel runs without real DNS.
 */
const PUBLIC_IP = ['93.184.216.34']
const publicDns = () => vi.fn(async () => PUBLIC_IP)

/** A transport built from an inline `(url) => {status, headers, bodyText}` responder. */
function transportOf(
  respond: (url: string) => Promise<PinnedRawResponse> | PinnedRawResponse
): PinnedTransport {
  return async ({ url }) => respond(url)
}

function deps(transport: PinnedTransport, resolveDns = publicDns()): DiscoveryDeps {
  return { transport, resolveDns }
}

describe('discoverRemoteOAuth — 4 CIMD pilots (T1 real fixtures)', () => {
  for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
    const pilot = PILOTS[key]
    it(`${key}: resolves PRM→AS, selects CIMD, pins endpoints`, async () => {
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryTransport(pilot)))
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
      deps(makeDiscoveryTransport(PILOTS.sentry))
    )
    expect(sentry.ok && sentry.result.issForCallback).toBe('https://mcp.sentry.dev')

    const notion = await discoverRemoteOAuth(
      PILOTS.notion.mcpUrl,
      deps(makeDiscoveryTransport(PILOTS.notion))
    )
    expect(notion.ok && notion.result.issForCallback).toBeUndefined()
  })

  it('sentry: uses the WWW-Authenticate resource_metadata hint (path-suffixed PRM)', async () => {
    // Sentry root well-known 404s; discovery must follow the 401 hint.
    const outcome = await discoverRemoteOAuth(
      PILOTS.sentry.mcpUrl,
      deps(makeDiscoveryTransport(PILOTS.sentry))
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.prm.resource).toBe('https://mcp.sentry.dev/mcp')
  })
})

describe('discoverRemoteOAuth — kernel §4 before every fetch (invariant 2, T5)', () => {
  it('resolves DNS (kernel) before fetching each URL', async () => {
    const order: string[] = []
    const resolveDns = vi.fn(async (host: string) => {
      order.push(`dns:${host}`)
      return PUBLIC_IP
    })
    const base = makeDiscoveryTransport(PILOTS.notion)
    const transport: PinnedTransport = async input => {
      order.push(`fetch:${input.url}`)
      return base(input)
    }
    const outcome = await discoverRemoteOAuth(PILOTS.notion.mcpUrl, { transport, resolveDns })
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
    const transport = vi.fn(
      async () => ({ status: 200, headers: {}, bodyText: '{}' }) as PinnedRawResponse
    )
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    expect(transport).not.toHaveBeenCalled()
  })

  it('skips a kernel-rejected WWW-Authenticate hint and never fetches it', async () => {
    // AS points resource_metadata at an internal host; kernel must drop it and
    // fall back to the well-known (public) candidate.
    const evilHint = 'Bearer resource_metadata="https://metadata.internal/.well-known/x"'
    const resolveDns = vi.fn(async (host: string) => {
      if (host === 'metadata.internal') return ['169.254.169.254']
      return PUBLIC_IP
    })
    const transport = vi.fn(async ({ url }: { url: string }): Promise<PinnedRawResponse> => {
      if (url === 'https://mcp.notion.com/mcp') {
        return { status: 401, headers: { 'www-authenticate': evilHint }, bodyText: '' }
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return { status: 200, headers: {}, bodyText: PILOTS.notion.prm.json }
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
        return { status: 200, headers: {}, bodyText: PILOTS.notion.as.json }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(true)
    // The internal host was never fetched.
    const fetchedUrls = transport.mock.calls.map(c => c[0].url)
    expect(fetchedUrls.some(u => u.includes('metadata.internal'))).toBe(false)
  })
})

describe('discoverRemoteOAuth — IP pin (H2: DNS-rebinding/TOCTOU, T3)', () => {
  it('connects the socket to the validated IP and never re-resolves (resolveDns once per hop)', async () => {
    // resolveDns returns a PUBLIC ip; the pin must connect to THAT ip. The transport
    // invokes the pinned lookup (as node:https would) and records the address it gets.
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const connectedIps: string[] = []
    let extraResolvesDuringConnect = 0
    const base = makeDiscoveryTransport(PILOTS.notion)
    const transport: PinnedTransport = async input => {
      // Simulate node:https connect: ask the (pinned) lookup for the address. The
      // lookup MUST be a pure closure over the validated IPs — it must NOT trigger
      // another resolveDns call (that second resolution is the rebinding window).
      const before = resolveDns.mock.calls.length
      await new Promise<void>(resolve => {
        input.lookup(new URL(input.url).hostname, { all: true }, (_err, addrs) => {
          const list = Array.isArray(addrs) ? addrs : [{ address: addrs as string }]
          list.forEach(a => connectedIps.push(a.address))
          resolve()
        })
      })
      extraResolvesDuringConnect += resolveDns.mock.calls.length - before
      return base(input)
    }
    const outcome = await discoverRemoteOAuth(PILOTS.notion.mcpUrl, { transport, resolveDns })
    expect(outcome.ok).toBe(true)
    // The socket connected to the validated public IP on every hop — no rebind.
    expect(connectedIps.length).toBeGreaterThan(0)
    connectedIps.forEach(ip => expect(ip).toBe(PUBLIC_IP[0]))
    // The pin re-used the validated addresses; the connect never re-resolved DNS.
    expect(extraResolvesDuringConnect).toBe(0)
  })

  it('T3: a rebinding decoy (public at validation, private at connect) cannot reach the private IP', async () => {
    // The rebind: validation resolves PUBLIC; a naive re-resolving HTTP client would
    // resolve PRIVATE at connect. The pin removes the second resolution, so the socket
    // stays on the validated PUBLIC ip. This test also runs against the PRE-FIX head
    // (which used a re-resolving `fetch`): there the vulnerable `fetchFn` seam records
    // the PRIVATE connect ip and the assertion fails — proving the fix.
    const PRIVATE_IP = '169.254.169.254'
    const validationDns = vi.fn(async () => PUBLIC_IP)
    const connectedIps: string[] = []
    const base = makeDiscoveryTransport(PILOTS.notion)

    // HEAD seam: pinned transport — invokes the pinned lookup, connects to the pin.
    const transport: PinnedTransport = async input => {
      await new Promise<void>(resolve => {
        input.lookup(new URL(input.url).hostname, { all: true }, (_err, addrs) => {
          const list = Array.isArray(addrs) ? addrs : [{ address: addrs as string }]
          list.forEach(a => connectedIps.push(a.address))
          resolve()
        })
      })
      return base(input)
    }

    // PRE-FIX seam: the old `fetchFn` re-resolved at connect. Model that vulnerable
    // client so the same test has teeth against the parent sha (see Repro-test note).
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      // Re-resolution at connect returns the rebind PRIVATE ip.
      connectedIps.push(PRIVATE_IP)
      const r = await base({
        url,
        method: (init?.method as 'GET') ?? 'GET',
        headers: {},
        lookup: (() => {}) as never,
        signal: AbortSignal.timeout(1000),
        maxBodyBytes: 1,
      })
      return new Response(r.bodyText || null, {
        status: r.status,
        headers: r.headers as Record<string, string>,
      })
    }) as unknown as typeof fetch

    // Spread avoids excess-property checking so the pre-fix `fetchFn` key rides along;
    // HEAD reads `transport`, the parent reads `fetchFn` — same file, both seams.
    const depsBoth = { transport, resolveDns: validationDns, fetchFn } as unknown as DiscoveryDeps
    await discoverRemoteOAuth(PILOTS.notion.mcpUrl, depsBoth)

    expect(connectedIps.length).toBeGreaterThan(0)
    // The connection never touched the private rebind ip.
    expect(connectedIps).not.toContain(PRIVATE_IP)
    connectedIps.forEach(ip => expect(ip).toBe(PUBLIC_IP[0]))
  })

  it('fails closed on a non-identity content-encoding (never mis-parses, T5)', async () => {
    // A hostile server returns gzip bytes despite Accept-Encoding: identity; discovery
    // must reject rather than JSON.parse compressed bytes.
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const transport = transportOf(url => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return {
          status: 200,
          headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
          bodyText: '\u001f\u008b garbage',
        }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('content_encoding_rejected')
  })
})

describe('discoverRemoteOAuth — SSRF via redirects (H1: manual redirect + re-validate + re-pin)', () => {
  it('does NOT follow a 302 → IMDS from a well-known fetch (rejected by the kernel)', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const transport = vi.fn(async ({ url }: { url: string }): Promise<PinnedRawResponse> => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      // Every PRM well-known candidate 302s at the link-local IMDS address.
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          bodyText: '',
        }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    const fetched = transport.mock.calls.map(c => c[0].url)
    expect(fetched.some(u => u.includes('169.254.169.254'))).toBe(false)
  })

  it('does NOT follow a 302 → internal .svc host (rejected by the kernel)', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const transport = vi.fn(async ({ url }: { url: string }): Promise<PinnedRawResponse> => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return {
          status: 302,
          headers: { location: 'http://control-api.mcp-host.svc/.well-known/x' },
          bodyText: '',
        }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('kernel_rejected')
    const fetched = transport.mock.calls.map(c => c[0].url)
    expect(fetched.some(u => u.includes('.svc'))).toBe(false)
  })

  it('fails closed (redirect_blocked) when the hop count is exceeded', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const transport = transportOf(url => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      // A public host that keeps redirecting to itself — never terminates.
      return { status: 302, headers: { location: 'https://loop.example.com/next' }, bodyText: '' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('redirect_blocked')
  })

  it('DOES follow a kernel-approved redirect to a public host (re-pinned per hop)', async () => {
    const resolveDns = vi.fn(async () => PUBLIC_IP)
    const transport = transportOf(url => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return {
          status: 302,
          headers: { location: 'https://mcp.notion.com/prm-moved' },
          bodyText: '',
        }
      }
      if (url === 'https://mcp.notion.com/prm-moved') {
        return { status: 200, headers: {}, bodyText: PILOTS.notion.prm.json }
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
        return { status: 200, headers: {}, bodyText: PILOTS.notion.as.json }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.resource).toBe('https://mcp.notion.com')
    // The redirect target's host was re-resolved (re-pinned) before the follow-up fetch.
    expect(resolveDns.mock.calls.length).toBeGreaterThan(0)
  })
})

describe('discoverRemoteOAuth — third-party metadata self-consistency (C2/C3)', () => {
  it('C2: rejects a PRM whose resource is cross-origin (RFC 9728 §3.3)', async () => {
    const evilPrm = { ...JSON.parse(PILOTS.notion.prm.json), resource: 'https://evil.example.com' }
    const transport = transportOf(url => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      if (url.startsWith('https://mcp.notion.com/.well-known/oauth-protected-resource')) {
        return { status: 200, headers: {}, bodyText: JSON.stringify(evilPrm) }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns: publicDns(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('prm_resource_mismatch')
  })

  it('C2: accepts the real pilots (Notion origin-match, Linear exact)', async () => {
    for (const key of ['notion', 'linear'] as const) {
      const outcome = await discoverRemoteOAuth(
        PILOTS[key].mcpUrl,
        deps(makeDiscoveryTransport(PILOTS[key]))
      )
      expect(outcome.ok).toBe(true)
      if (outcome.ok)
        expect(outcome.result.resource).toBe(JSON.parse(PILOTS[key].prm.json).resource)
    }
  })

  it('C3: rejects AS metadata whose issuer != authorization server base (RFC 8414 §3.3)', async () => {
    const evilAs = { ...JSON.parse(PILOTS.notion.as.json), issuer: 'https://evil.example.com' }
    const transport = transportOf(url => {
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return { status: 200, headers: {}, bodyText: PILOTS.notion.prm.json }
      }
      // The evil issuer is served on BOTH AS-metadata candidates (oauth + OIDC),
      // so neither clears the RFC 8414 §3.3 check.
      if (
        url === 'https://mcp.notion.com/.well-known/oauth-authorization-server' ||
        url === 'https://mcp.notion.com/.well-known/openid-configuration'
      ) {
        return { status: 200, headers: {}, bodyText: JSON.stringify(evilAs) }
      }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
      resolveDns: publicDns(),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('issuer_mismatch')
  })

  it('C3: accepts the real pilots (issuer == authorization server base)', async () => {
    for (const key of ['notion', 'sentry'] as const) {
      const outcome = await discoverRemoteOAuth(
        PILOTS[key].mcpUrl,
        deps(makeDiscoveryTransport(PILOTS[key]))
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
    const transport = transportOf(url => {
      if (url === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
        return { status: 200, headers: {}, bodyText: PILOTS.notion.prm.json }
      }
      if (url === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
        return { status: 200, headers: {}, bodyText: JSON.stringify(noS256As) }
      }
      if (url === 'https://mcp.notion.com/mcp') return { status: 401, headers: {}, bodyText: '' }
      return { status: 404, headers: {}, bodyText: 'nf' }
    })
    const outcome = await discoverRemoteOAuth('https://mcp.notion.com/mcp', {
      transport,
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

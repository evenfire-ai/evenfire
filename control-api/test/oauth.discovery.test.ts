import { describe, expect, it, vi } from 'vitest'
import type {
  PinnedRawResponse,
  PinnedTransport,
  PinnedTransportInput,
} from '../src/http/pinnedFetch.js'
import {
  type AuthorizationServerMetadata,
  type DiscoveryDeps,
  type ProtectedResourceMetadata,
  asMetadataUrls,
  defaultScopes,
  discoverRemoteOAuth,
  parseResourceMetadataChallenge,
  wellKnownPrmUrls,
} from '../src/oauth/discovery.js'
import {
  ENTRA_AGENT365_MAIL_PILOT,
  ENTRA_GRAPH_SCOPE_PILOT,
  ENTRA_NO_SCOPES_PILOT,
  ENTRA_SHAREPOINT_SCOPE_PILOT,
  ENTRA_TENANT_PRM_PILOT,
  ENTRA_UNKNOWN_GUID_PILOT,
  ENTRA_WORKIQ_PILOT,
  PILOTS,
  type PilotFixture,
  makeDiscoveryTransport,
  recordingTransport,
  workIqPilotWithPrm,
} from './fixtures/remoteOAuthDiscovery.js'

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

describe('discoverRemoteOAuth — 4 CIMD-capable pilots (T1 real fixtures)', () => {
  // All 4 advertise CIMD + `none`, but CIMD is only offered when the AS also returns
  // `iss` (RFC 9207): Linear and Sentry do; Notion and Canva do not and fall back to
  // their registration endpoint (DCR).
  const expectedMode = { notion: 'dcr', linear: 'cimd', sentry: 'cimd', canva: 'dcr' } as const
  for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
    const pilot = PILOTS[key]
    it(`${key}: resolves PRM→AS, selects ${expectedMode[key]}, pins endpoints`, async () => {
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryTransport(pilot)))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const r = outcome.result
      expect(r.registrationMode).toBe(expectedMode[key])
      expect(r.issForCallback !== undefined).toBe(expectedMode[key] === 'cimd')
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

  it('sentry and linear expose issForCallback (RFC 9207); notion does not', async () => {
    const sentry = await discoverRemoteOAuth(
      PILOTS.sentry.mcpUrl,
      deps(makeDiscoveryTransport(PILOTS.sentry))
    )
    expect(sentry.ok && sentry.result.issForCallback).toBe('https://mcp.sentry.dev')

    const linear = await discoverRemoteOAuth(
      PILOTS.linear.mcpUrl,
      deps(makeDiscoveryTransport(PILOTS.linear))
    )
    expect(linear.ok && linear.result.issForCallback).toBe('https://mcp.linear.app')

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

  // Table row 11: RFC 8414 §2 forbids query and fragment in an issuer, and userinfo is
  // no part of an identifier. URL origin+pathname ignore all three, so an issuer that
  // carries them must be compared as written, even when the `?` or `#` is empty.
  for (const issuer of [
    'https://mcp.notion.com?',
    'https://mcp.notion.com#',
    'https://mcp.notion.com/?q=1',
    'https://mcp.notion.com#f',
    'https://u:p@mcp.notion.com',
  ]) {
    it(`C3: rejects an issuer with query, fragment or userinfo (${issuer})`, async () => {
      const asJson = JSON.stringify({ ...JSON.parse(PILOTS.notion.as.json), issuer })
      const [oauthUrl, oidcUrl] = asMetadataUrls(new URL('https://mcp.notion.com'))
      const pilot = {
        ...PILOTS.notion,
        as: { url: oauthUrl, json: asJson },
        // Served on both AS-metadata candidates so neither clears the check.
        asExtra: [{ url: oidcUrl, status: 200, json: asJson }],
      }
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryTransport(pilot)))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.kind).toBe('issuer_mismatch')
    })
  }

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

describe('Entra pilot transport (asExtra + recordingTransport)', () => {
  it('serves each extra AS metadata URL with its captured status and records every request', async () => {
    const { transport, requestedUrls } = recordingTransport(
      makeDiscoveryTransport(ENTRA_WORKIQ_PILOT)
    )
    const get = (url: string) =>
      transport({ url, method: 'GET', headers: {} } as PinnedTransportInput)
    const rfc8414Url =
      'https://login.microsoftonline.com/.well-known/oauth-authorization-server/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'
    const [organizations, unknownTenant] = ENTRA_WORKIQ_PILOT.asExtra ?? []
    const ok = await get(organizations.url)
    const rejected = await get(unknownTenant.url)
    const unserved = await get(rfc8414Url)
    expect([ok.status, rejected.status, unserved.status]).toEqual([200, 400, 404])
    expect(JSON.parse(ok.bodyText).issuer).toBe('https://login.microsoftonline.com/{tenantid}/v2.0')
    expect(JSON.parse(rejected.bodyText).error).toBe('invalid_tenant')
    expect(requestedUrls).toEqual([organizations.url, unknownTenant.url, rfc8414Url])
  })
})

describe('discoverRemoteOAuth — Microsoft Entra tenant authority (tenant_required + override)', () => {
  const TENANT_AUTHORITY =
    'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'
  const ORGANIZATIONS = 'https://login.microsoftonline.com/organizations/v2.0'

  function hostsOf(urls: string[]): string[] {
    return urls.map(url => new URL(url).hostname)
  }

  for (const pilot of [ENTRA_WORKIQ_PILOT, ENTRA_AGENT365_MAIL_PILOT]) {
    it(`row 1 (${pilot.name}): the multi-tenant authority → tenant_required, nothing fetched from Entra`, async () => {
      const { transport, requestedUrls } = recordingTransport(makeDiscoveryTransport(pilot))
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(transport))
      expect(outcome).toEqual({
        ok: false,
        error: {
          kind: 'tenant_required',
          authorizationServer: ORGANIZATIONS,
          tenantAuthorityTemplate: 'https://login.microsoftonline.com/{tenantId}/v2.0',
          detail:
            'authorization server is the Microsoft Entra ID multi-tenant authority; name the tenant',
        },
      })
      expect(requestedUrls.length).toBeGreaterThan(0)
      expect(hostsOf(requestedUrls)).not.toContain('login.microsoftonline.com')
    })
  }

  const NOT_A_TENANT_AUTHORITY =
    'authorizationServer must be a Microsoft Entra ID tenant authority (https://login.microsoftonline.com/<tenant-id>/v2.0)'

  it('row 3: an upper-case tenant GUID is not a tenant authority → override rejected', async () => {
    const { transport, requestedUrls } = recordingTransport(
      makeDiscoveryTransport(ENTRA_WORKIQ_PILOT)
    )
    const outcome = await discoverRemoteOAuth(ENTRA_WORKIQ_PILOT.mcpUrl, deps(transport), {
      authorizationServer:
        'https://login.microsoftonline.com/72F988BF-86F1-41AF-91AB-2D7CD011DB47/v2.0',
    })
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'authorization_server_override_rejected', detail: NOT_A_TENANT_AUTHORITY },
    })
    expect(hostsOf(requestedUrls)).not.toContain('login.microsoftonline.com')
  })

  it('row 4: an unknown tenant → fetch_failed carrying the Entra 400 and its URL', async () => {
    const unknownTenant =
      'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0'
    const outcome = await discoverRemoteOAuth(
      ENTRA_WORKIQ_PILOT.mcpUrl,
      deps(makeDiscoveryTransport(ENTRA_WORKIQ_PILOT)),
      { authorizationServer: unknownTenant }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatchObject({
      kind: 'fetch_failed',
      status: 400,
      url: `${unknownTenant}/.well-known/openid-configuration`,
    })
  })

  it('row 5: an override on another host is rejected and that host is never fetched', async () => {
    const { transport, requestedUrls } = recordingTransport(
      makeDiscoveryTransport(ENTRA_WORKIQ_PILOT)
    )
    const outcome = await discoverRemoteOAuth(ENTRA_WORKIQ_PILOT.mcpUrl, deps(transport), {
      authorizationServer: 'https://evil.example/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
    })
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'authorization_server_override_rejected', detail: NOT_A_TENANT_AUTHORITY },
    })
    expect(hostsOf(requestedUrls)).not.toContain('evil.example')
    expect(hostsOf(requestedUrls)).not.toContain('login.microsoftonline.com')
  })

  it('row 6: the multi-tenant authority itself is not a tenant authority → override rejected', async () => {
    const outcome = await discoverRemoteOAuth(
      ENTRA_WORKIQ_PILOT.mcpUrl,
      deps(makeDiscoveryTransport(ENTRA_WORKIQ_PILOT)),
      { authorizationServer: ORGANIZATIONS }
    )
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'authorization_server_override_rejected', detail: NOT_A_TENANT_AUTHORITY },
    })
  })

  it('row 10: a resource that does not advertise Entra (Linear) rejects a tenant authority', async () => {
    const { transport, requestedUrls } = recordingTransport(makeDiscoveryTransport(PILOTS.linear))
    const outcome = await discoverRemoteOAuth(PILOTS.linear.mcpUrl, deps(transport), {
      authorizationServer: TENANT_AUTHORITY,
    })
    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: 'authorization_server_override_rejected',
        detail:
          "the protected resource's first authorization server is not the Microsoft Entra ID multi-tenant authority",
      },
    })
    expect(hostsOf(requestedUrls)).not.toContain('login.microsoftonline.com')
  })

  it('the multi-tenant authority listed after another authorization server does not license the override', async () => {
    const pilot = workIqPilotWithPrm('entra-organizations-second', prm => {
      prm.authorization_servers = ['https://other-as.example', ORGANIZATIONS]
    })
    const { transport, requestedUrls } = recordingTransport(makeDiscoveryTransport(pilot))
    const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(transport), {
      authorizationServer: TENANT_AUTHORITY,
    })
    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: 'authorization_server_override_rejected',
        detail:
          "the protected resource's first authorization server is not the Microsoft Entra ID multi-tenant authority",
      },
    })
    expect(hostsOf(requestedUrls)).not.toContain('login.microsoftonline.com')
  })

  it('a valid override fetches the tenant authority, not the advertised multi-tenant one', async () => {
    const { transport, requestedUrls } = recordingTransport(
      makeDiscoveryTransport(ENTRA_WORKIQ_PILOT)
    )
    await discoverRemoteOAuth(ENTRA_WORKIQ_PILOT.mcpUrl, deps(transport), {
      authorizationServer: TENANT_AUTHORITY,
    })
    const entraUrls = requestedUrls.filter(
      url => new URL(url).hostname === 'login.microsoftonline.com'
    )
    expect(entraUrls).toContain(`${TENANT_AUTHORITY}/.well-known/openid-configuration`)
    expect(entraUrls.some(url => url.includes('/organizations/'))).toBe(false)
  })
})

describe('discoverRemoteOAuth — entra-v2 profile (PKCE, refresh, scope audience)', () => {
  const TENANT_GUID = '72f988bf-86f1-41af-91ab-2d7cd011db47'
  const TENANT_AUTHORITY = `https://login.microsoftonline.com/${TENANT_GUID}/v2.0`

  async function discoverWithTenant(pilot: PilotFixture) {
    const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryTransport(pilot)), {
      authorizationServer: TENANT_AUTHORITY,
    })
    if (!outcome.ok) throw new Error(`discovery failed: ${outcome.error.kind}`)
    return outcome.result
  }

  it('row 2: Work IQ with the tenant authority → profile, manual registration, refresh, no iss', async () => {
    const r = await discoverWithTenant(ENTRA_WORKIQ_PILOT)
    expect(r.asProfile).toBe('entra-v2')
    expect(r.registrationMode).toBe('manual')
    expect(r.quirks).toEqual({ bearerInBody: false, supportsRefresh: true })
    expect(r.issuer).toBe(TENANT_AUTHORITY)
    expect(r.issForCallback).toBeUndefined()
    expect(r.resource).toBe('https://workiq.svc.cloud.microsoft/mcp')
    // The real Entra metadata advertises neither S256 nor refresh_token: the profile is
    // what lets discovery through the gate and what turns refresh on.
    expect(r.as.code_challenge_methods_supported).toBeUndefined()
    expect(r.as.grant_types_supported).toBeUndefined()
  })

  it('row 8: a PRM that already names the tenant authority → profile without an override', async () => {
    const outcome = await discoverRemoteOAuth(
      ENTRA_TENANT_PRM_PILOT.mcpUrl,
      deps(makeDiscoveryTransport(ENTRA_TENANT_PRM_PILOT))
    )
    expect(outcome.ok && outcome.result.asProfile).toBe('entra-v2')
  })

  it('row 13: Work IQ (GUID of the app known for its host) → no audience findings', async () => {
    const r = await discoverWithTenant(ENTRA_WORKIQ_PILOT)
    expect(r.scopeAudienceViolation).toBeUndefined()
    expect(r.unverifiedScopes).toBeUndefined()
    expect(r.scopeAudienceMissing).toBeUndefined()
  })

  it('Agent 365 Mail (URL-form scope on its host) → no audience findings', async () => {
    const r = await discoverWithTenant(ENTRA_AGENT365_MAIL_PILOT)
    expect(r.asProfile).toBe('entra-v2')
    expect(r.scopeAudienceViolation).toBeUndefined()
    expect(r.unverifiedScopes).toBeUndefined()
    expect(r.scopeAudienceMissing).toBeUndefined()
  })

  it('row 12: a Microsoft Graph URL scope → scopeAudienceViolation (warning, discovery still ok)', async () => {
    const r = await discoverWithTenant(ENTRA_GRAPH_SCOPE_PILOT)
    expect(r.scopeAudienceViolation).toBe('https://graph.microsoft.com/Mail.ReadWrite')
  })

  it('row 14: a GUID the platform cannot tie to the host → unverifiedScopes', async () => {
    const r = await discoverWithTenant(ENTRA_UNKNOWN_GUID_PILOT)
    expect(r.unverifiedScopes).toEqual(['11111111-2222-3333-4444-555555555555/Tools.Read'])
    expect(r.scopeAudienceViolation).toBeUndefined()
    expect(r.scopeAudienceMissing).toBeUndefined()
  })

  it('row 15: a SharePoint Online GUID scope → scopeAudienceViolation, never unverified', async () => {
    const r = await discoverWithTenant(ENTRA_SHAREPOINT_SCOPE_PILOT)
    expect(r.scopeAudienceViolation).toBe('00000003-0000-0ff1-ce00-000000000000/AllSites.Read')
    expect(r.unverifiedScopes).toBeUndefined()
  })

  it('row 16: the Agent 365 GUID advertised by the Work IQ host → scopeAudienceViolation, never unverified', async () => {
    const agent365Scope = '05879165-0320-489e-b644-f72b33f3edf0/McpServers.Mail.All'
    const pilot = workIqPilotWithPrm('entra-agent365-guid-on-workiq', prm => {
      prm.scopes_supported = [agent365Scope]
    })
    const r = await discoverWithTenant(pilot)
    expect(r.scopeAudienceViolation).toBe(agent365Scope)
    expect(r.unverifiedScopes).toBeUndefined()
  })

  it('row 17: no PRM scopes (sign-in scopes of the AS only) → scopeAudienceMissing', async () => {
    const r = await discoverWithTenant(ENTRA_NO_SCOPES_PILOT)
    expect(r.scopeAudienceMissing).toBe(true)
    expect(r.scopeAudienceViolation).toBeUndefined()
    expect(r.unverifiedScopes).toBeUndefined()
  })

  it('row 18: a Graph GUID smuggled as userinfo before the MCP host → scopeAudienceViolation', async () => {
    const smuggled =
      'api://00000003-0000-0000-c000-000000000000@workiq.svc.cloud.microsoft/Mail.Read'
    const pilot = workIqPilotWithPrm('entra-userinfo-scope', prm => {
      prm.scopes_supported = [smuggled]
    })
    const r = await discoverWithTenant(pilot)
    expect(r.scopeAudienceViolation).toBe(smuggled)
  })

  it('an empty advertised scope is reported as the violation (empty string, not dropped)', async () => {
    const pilot = workIqPilotWithPrm('entra-empty-scope', prm => {
      prm.scopes_supported = ['', 'https://graph.microsoft.com/x']
    })
    const r = await discoverWithTenant(pilot)
    expect(r.scopeAudienceViolation).toBe('')
    expect('scopeAudienceViolation' in r).toBe(true)
  })

  it('without a profile, no audience fields appear (Linear)', async () => {
    const outcome = await discoverRemoteOAuth(
      PILOTS.linear.mcpUrl,
      deps(makeDiscoveryTransport(PILOTS.linear))
    )
    if (!outcome.ok) throw new Error(outcome.error.kind)
    for (const key of [
      'asProfile',
      'scopeAudienceViolation',
      'unverifiedScopes',
      'scopeAudienceMissing',
    ]) {
      expect(key in outcome.result).toBe(false)
    }
  })

  // I3: the profile needs the exact lower-case tenant issuer. An upper-case GUID still
  // passes the issuer comparison (base and issuer agree) but is not the profile, so the
  // missing S256 advertisement is fatal again. Derived from the real tenant bytes with
  // only the GUID's case changed, everywhere it appears.
  it('I3: an upper-case tenant issuer is not the profile → no_s256', async () => {
    const upper = (json: string) => json.split(TENANT_GUID).join(TENANT_GUID.toUpperCase())
    const pilot: PilotFixture = {
      ...ENTRA_TENANT_PRM_PILOT,
      name: 'entra-upper-case-tenant',
      prm: { ...ENTRA_TENANT_PRM_PILOT.prm, json: upper(ENTRA_TENANT_PRM_PILOT.prm.json) },
      as: {
        url: upper(ENTRA_TENANT_PRM_PILOT.as.url),
        json: upper(ENTRA_TENANT_PRM_PILOT.as.json),
      },
      asExtra: [],
    }
    const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryTransport(pilot)))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.kind).toBe('no_s256')
  })

  // Row 11 with the profile in play: a decorated tenant issuer is still an issuer
  // mismatch, never a profile. Real tenant bytes with only `issuer` changed.
  for (const decorated of [`${TENANT_AUTHORITY}?`, `${TENANT_AUTHORITY}#`]) {
    it(`row 11: a decorated tenant issuer (${decorated}) → issuer_mismatch`, async () => {
      const as = JSON.parse(ENTRA_TENANT_PRM_PILOT.as.json) as Record<string, unknown>
      as.issuer = decorated
      const pilot: PilotFixture = {
        ...ENTRA_TENANT_PRM_PILOT,
        as: { ...ENTRA_TENANT_PRM_PILOT.as, json: JSON.stringify(as) },
      }
      const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(makeDiscoveryTransport(pilot)))
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.error.kind).toBe('issuer_mismatch')
    })
  }
})

describe('defaultScopes — untrusted scopes_supported', () => {
  // The metadata is third-party JSON, so these shapes are what a hostile or broken server
  // can send, typed loosely on purpose.
  const prm = (scopes: unknown) =>
    ({
      resource: 'https://mcp.example.com/mcp',
      scopes_supported: scopes,
    }) as unknown as ProtectedResourceMetadata
  const as = (scopes?: unknown) =>
    ({
      issuer: 'https://as.example.com',
      authorization_endpoint: 'https://as.example.com/authorize',
      token_endpoint: 'https://as.example.com/token',
      ...(scopes === undefined ? {} : { scopes_supported: scopes }),
    }) as unknown as AuthorizationServerMetadata

  it('a non-array PRM value is ignored and the AS list is used', () => {
    expect(defaultScopes(prm('a b'), as(['x']))).toEqual(['x'])
  })

  it('non-string entries are dropped', () => {
    expect(defaultScopes(prm(['a', 1, null]), as(['x']))).toEqual(['a'])
  })

  it('an empty PRM list is an answer: it does not fall back to the AS', () => {
    expect(defaultScopes(prm([]), as(['x']))).toEqual([])
  })

  it('neither side advertises scopes → []', () => {
    expect(defaultScopes(prm(undefined), as())).toEqual([])
  })
})

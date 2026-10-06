import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import {
  type AsEndpointSites,
  type DiscoveryDeps,
  checkAsEndpointsSameSite,
  discoverRemoteOAuth,
  registrableSite,
} from '../src/oauth/discovery.js'
import {
  ATLASSIAN_V2_AS_JSON,
  ATLASSIAN_V2_PILOT,
  DROPBOX_PILOT,
  PILOTS,
  type PilotFixture,
  VERCEL_PILOT,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'

/**
 * Without RFC 9207 the callback cannot tell which AS produced a code, so discovery
 * requires every AS endpoint to share the issuer's registrable domain (PSL, private
 * section included). With RFC 9207 the rule does not apply.
 *
 * The honest cases run on real probe bytes (Atlassian v2, Dropbox, Vercel — no 9207).
 * The hostile cases cannot be probed (no real AS serves them), so they are the real
 * Atlassian bytes with ONE documented field swapped, the way a malicious metadata
 * document would borrow an honest AS's endpoints.
 */

const PUBLIC_IP = ['93.184.216.34']

interface RecordedRequest {
  url: string
  method?: string
}

/** Wrap a fixture transport, recording every request that reaches the socket layer. */
function recording(base: PinnedTransport): {
  transport: PinnedTransport
  calls: RecordedRequest[]
} {
  const calls: RecordedRequest[] = []
  const transport: PinnedTransport = async input => {
    calls.push({ url: input.url, method: input.method })
    return base(input)
  }
  return { transport, calls }
}

function deps(transport: PinnedTransport): DiscoveryDeps {
  return { transport, resolveDns: vi.fn(async () => PUBLIC_IP) }
}

/** The real Atlassian v2 pilot with its AS metadata rewritten by `mutate`. */
function atlassianWith(mutate: (as: Record<string, unknown>) => void): PilotFixture {
  const as = JSON.parse(ATLASSIAN_V2_AS_JSON) as Record<string, unknown>
  mutate(as)
  return { ...ATLASSIAN_V2_PILOT, as: { ...ATLASSIAN_V2_PILOT.as, json: JSON.stringify(as) } }
}

async function discover(pilot: PilotFixture) {
  const { transport, calls } = recording(makeDiscoveryTransport(pilot))
  const outcome = await discoverRemoteOAuth(pilot.mcpUrl, deps(transport))
  return { outcome, calls }
}

describe('discovery same-site rule — real ASes without RFC 9207', () => {
  it('Atlassian v2 (CIMD + DCR, all on atlassian.com) → DCR, never CIMD', async () => {
    const { outcome } = await discover(ATLASSIAN_V2_PILOT)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.issForCallback).toBeUndefined()
    expect(outcome.result.registrationMode).toBe('dcr')
  })

  it('Vercel (token on api.vercel.com, issuer vercel.com) is one site → accepted', async () => {
    const { outcome } = await discover(VERCEL_PILOT)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.registrationMode).toBe('dcr')
  })

  it('Dropbox (token on api.dropboxapi.com, issuer www.dropbox.com) → as_endpoints_cross_site', async () => {
    const { outcome, calls } = await discover(DROPBOX_PILOT)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ kind: 'as_endpoints_cross_site', field: 'token' })
    }
    // Discovery never reaches the registration endpoint (nor POSTs anything).
    expect(calls.some(c => c.url === 'https://www.dropbox.com/oauth2/register')).toBe(false)
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })
})

describe('discovery same-site rule — mixed metadata (mix-up via a borrowed AS)', () => {
  it('authorize + registration on the honest AS, token on another site → rejected before any registration', async () => {
    const pilot = atlassianWith(as => {
      as.token_endpoint = 'https://attacker.example/oauth/token'
    })
    const { outcome, calls } = await discover(pilot)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ kind: 'as_endpoints_cross_site', field: 'token' })
    }
    expect(calls.some(c => c.url.includes('/dcr/register'))).toBe(false)
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })

  it('the same mixed metadata WITH RFC 9207 is not subject to the rule (unchanged behaviour)', async () => {
    const pilot = atlassianWith(as => {
      as.token_endpoint = 'https://attacker.example/oauth/token'
      as.authorization_response_iss_parameter_supported = true
    })
    const { outcome } = await discover(pilot)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.issForCallback).toBe(JSON.parse(ATLASSIAN_V2_AS_JSON).issuer)
      expect(outcome.result.endpoints.token).toBe('https://attacker.example/oauth/token')
    }
  })

  it('registration endpoint on another site → rejected', async () => {
    const { outcome } = await discover(
      atlassianWith(as => {
        as.registration_endpoint = 'https://attacker.example/register'
      })
    )
    expect(!outcome.ok && outcome.error).toMatchObject({
      kind: 'as_endpoints_cross_site',
      field: 'registration',
    })
  })

  // Nothing sends to the revocation endpoint and it is not pinned on the CR, so it is
  // not trusted with anything; an off-site or relative one must not block the install.
  for (const revocation of ['https://attacker.example/revoke', '/oauth/revoke']) {
    it(`revocation endpoint ${JSON.stringify(revocation)} → ignored, discovery succeeds`, async () => {
      const { outcome } = await discover(
        atlassianWith(as => {
          as.revocation_endpoint = revocation
        })
      )
      expect(outcome.ok).toBe(true)
    })
  }

  it('authorization endpoint on another site → rejected', async () => {
    const { outcome } = await discover(
      atlassianWith(as => {
        as.authorization_endpoint = 'https://attacker.example/authorize'
      })
    )
    expect(!outcome.ok && outcome.error).toMatchObject({
      kind: 'as_endpoints_cross_site',
      field: 'authorization',
    })
  })

  it('token `https://evil.com\\@auth.atlassian.com/…` (parser differential) → rejected', async () => {
    // WHATWG — and therefore the pinned socket — reads the host as `evil.com`. The
    // site must come from that same parse, never from a second parser over the raw URL.
    const { outcome } = await discover(
      atlassianWith(as => {
        as.token_endpoint = 'https://evil.com\\@auth.atlassian.com/oauth/token'
      })
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('as_endpoints_cross_site')
  })

  it('token endpoint with userinfo on the honest host → rejected', async () => {
    const { outcome } = await discover(
      atlassianWith(as => {
        as.token_endpoint = 'https://user:pass@auth.atlassian.com/oauth/token'
      })
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ kind: 'as_endpoints_cross_site', field: 'token' })
    }
  })
})

/** The endpoints of one AS, positionally: issuer, authorization, token, registration. */
function sites(
  issuer: string,
  authorization: string,
  token: string,
  registration?: string
): AsEndpointSites {
  return { issuer, authorization, token, ...(registration ? { registration } : {}) }
}

describe('registrableSite / checkAsEndpointsSameSite (PSL semantics)', () => {
  it('private PSL section: two github.io tenants are two sites', () => {
    expect(registrableSite('https://a.github.io/x')).toBe('a.github.io')
    expect(
      checkAsEndpointsSameSite(
        sites('https://a.github.io', 'https://a.github.io/authorize', 'https://b.github.io/token')
      )
    ).toMatchObject({ ok: false, field: 'token' })
  })

  it('subdomains of one registrable domain are one site (api.vercel.com ~ vercel.com)', () => {
    expect(
      checkAsEndpointsSameSite(
        sites(
          'https://vercel.com',
          'https://vercel.com/oauth/authorize',
          'https://api.vercel.com/login/oauth/token',
          'https://api.vercel.com/login/oauth/register'
        )
      )
    ).toEqual({ ok: true })
  })

  it('a host that is itself a public suffix has no site; null never equals null', () => {
    expect(registrableSite('https://github.io/token')).toBeNull()
    expect(
      checkAsEndpointsSameSite(
        sites('https://github.io', 'https://github.io/authorize', 'https://github.io/token')
      )
    ).toMatchObject({ ok: false, field: 'issuer' })
    expect(
      checkAsEndpointsSameSite(
        sites(
          'https://honest.example.com',
          'https://honest.example.com/authorize',
          'https://herokuapp.com/token'
        )
      )
    ).toMatchObject({ ok: false, field: 'token' })
  })

  it('the site is taken from the WHATWG host, the one the pinned socket connects to', () => {
    expect(registrableSite('https://evil.com\\@honest.com/token')).toBe('evil.com')
    // WHATWG decodes these hosts to `api.vercel.com`; `tldts` over the raw string does
    // not, so only the hostname-first parse yields the site the request really goes to.
    expect(registrableSite('https://api%2Evercel.com/token')).toBe('vercel.com')
    expect(registrableSite('https://api\u3002vercel.com/token')).toBe('vercel.com')
  })

  it('any userinfo, an IP literal or an unparsable URL has no site', () => {
    expect(registrableSite('https://user@honest.com/token')).toBeNull()
    expect(registrableSite('https://user:pw@honest.com/token')).toBeNull()
    expect(registrableSite('https://93.184.216.34/token')).toBeNull()
    expect(registrableSite('not a url')).toBeNull()
  })
})

describe('I3 — without RFC 9207 discovery never selects CIMD (T2, through discoverRemoteOAuth)', () => {
  // Arbitrary AS capabilities layered on the real Notion bytes. The `iss` flag is
  // fuzzed over non-boolean truthy values too: only a literal `true` is an advertisement.
  const issFlagArb = fc.constantFrom<unknown>(undefined, true, false, 'true', 1)
  const cimdFlagArb = fc.constantFrom<unknown>(undefined, true, false)
  const methodsArb = fc.subarray(['none', 'client_secret_basic', 'client_secret_post'])

  it('registrationMode is cimd only when the AS literally advertises iss === true', async () => {
    await fc.assert(
      fc.asyncProperty(
        issFlagArb,
        cimdFlagArb,
        methodsArb,
        fc.boolean(),
        async (issFlag, cimdFlag, methods, hasRegistration) => {
          const as = JSON.parse(PILOTS.notion.as.json) as Record<string, unknown>
          delete as.authorization_response_iss_parameter_supported
          delete as.client_id_metadata_document_supported
          if (issFlag !== undefined) as.authorization_response_iss_parameter_supported = issFlag
          if (cimdFlag !== undefined) as.client_id_metadata_document_supported = cimdFlag
          as.token_endpoint_auth_methods_supported = methods
          if (!hasRegistration) delete as.registration_endpoint
          const pilot: PilotFixture = {
            ...PILOTS.notion,
            as: { ...PILOTS.notion.as, json: JSON.stringify(as) },
          }
          const outcome = await discoverRemoteOAuth(
            pilot.mcpUrl,
            deps(makeDiscoveryTransport(pilot))
          )
          expect(outcome.ok).toBe(true)
          if (!outcome.ok) return
          const iss = issFlag === true
          expect(outcome.result.issForCallback !== undefined).toBe(iss)
          if (!iss) expect(outcome.result.registrationMode).not.toBe('cimd')
          const expectedCimd = iss && cimdFlag === true && methods.includes('none')
          expect(outcome.result.registrationMode === 'cimd').toBe(expectedCimd)
        }
      ),
      { numRuns: 300 }
    )
  })
})

// Guards the recording helper itself: a transport that never records would make the
// "no POST / no registration fetch" assertions above vacuous.
describe('recording transport sanity', () => {
  it('records the discovery GETs', async () => {
    const { calls } = await discover(ATLASSIAN_V2_PILOT)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(c => c.method !== 'POST')).toBe(true)
  })
})

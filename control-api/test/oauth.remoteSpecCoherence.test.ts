import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'
import { signOAuthState } from '../src/oauth/state.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { mintHccControlToken } from './fixtures/hccControlToken.js'
import {
  type InstalledMcpServer,
  WORKIQ_GUID_SCOPE,
  WORKIQ_URL_SCOPE,
  installWorkIqServer,
} from './fixtures/perServerInstall.js'
import {
  ATLASSIAN_V2_PILOT,
  DROPBOX_PILOT,
  PILOTS,
  type PilotFixture,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * Invariant 8 (R3-H8 / RP-R4-CUI1-01 / RP-R4-MED-01): a remote McpServer the CRD
 * now rejects — `public` with secret refs, or `bearerInBody: true` — can still
 * exist (written before the CRD was applied, or by a validation-bypassing write).
 * Consent, authorize-URL minting and token issuance must refuse it with the
 * specific `remote_oauth_spec_incoherent` error; revoke must keep working.
 *
 * T1: every CR is built by the real producers (`discoverRemoteOAuth` →
 * `buildRemoteOAuthSpec`). `bearerInBody: true` is what the builder emits for a
 * resource that only accepts the body, but the install route rejects it
 * (`400 bearer_in_body_unsupported`), so it only persists through a write that
 * bypasses the route (kubectl/GitOps). `public` + refs has NO producer at all: it
 * is the pre-registered-confidential output with `clientMode` flipped, i.e. the
 * in-place edit such a direct write would make.
 *
 * Errors are matched by `code`, not by class, so this file runs against the
 * parent sha (where the class does not exist) and fails there by assertion.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const MCP_NS = config.mcpServersNamespace
const CONTEXT = 'ctx-9'
const RUNTIME_HOST = 'agent-host'
// users.id is a UUID: the broker refuses any other end-user id.
const RUNTIME_USER = '3f9a1c2e-6b4d-4e8f-a1c3-5d7e9f0b2a46'
const PRE_REGISTERED_CLIENT_ID = 'client-abc'
const CIMD_SELF = 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'
const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

async function discover(pilot: PilotFixture): Promise<DiscoveryResult> {
  const outcome = await discoverRemoteOAuth(pilot.mcpUrl, {
    transport: makeDiscoveryTransport(pilot),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  return outcome.result
}

/** Sentry, but its protected resource only accepts the bearer in the body. */
function bodyOnlyPilot(): PilotFixture {
  const base = PILOTS.sentry
  const prm = { ...JSON.parse(base.prm.json), bearer_methods_supported: ['body'] }
  return { ...base, prm: { ...base.prm, json: JSON.stringify(prm) } }
}

/** Dropbox as if it advertised RFC 9207: the only way discovery accepts its cross-site AS. */
function dropboxWithRfc9207(): PilotFixture {
  const as = {
    ...JSON.parse(DROPBOX_PILOT.as.json),
    authorization_response_iss_parameter_supported: true,
  }
  return { ...DROPBOX_PILOT, as: { ...DROPBOX_PILOT.as, json: JSON.stringify(as) } }
}

let headerDiscovery: DiscoveryResult
let bodyDiscovery: DiscoveryResult
// Real Atlassian v2: CIMD + DCR, no RFC 9207, every endpoint on atlassian.com.
let perServerDiscovery: DiscoveryResult
let crossSiteDiscovery: DiscoveryResult
let notionDiscovery: DiscoveryResult
// Work IQ as the real install writes it (entra-v2 profile), once per scope form.
let workIqGuid: InstalledMcpServer
let workIqUrl: InstalledMcpServer

beforeAll(async () => {
  headerDiscovery = await discover(PILOTS.sentry)
  bodyDiscovery = await discover(bodyOnlyPilot())
  perServerDiscovery = await discover(ATLASSIAN_V2_PILOT)
  crossSiteDiscovery = await discover(dropboxWithRfc9207())
  notionDiscovery = await discover(PILOTS.notion)
  workIqGuid = await installWorkIqServer({ scopes: [WORKIQ_GUID_SCOPE] })
  workIqUrl = await installWorkIqServer({ scopes: [WORKIQ_URL_SCOPE] })
})

const EVIL_BASE_URL = 'https://evil.example/mcp'

/** The `spec.remote` the install wrote for Work IQ. */
function workIqRemote(): Record<string, unknown> {
  return { ...workIqGuid.spec.remote }
}

/** The installed Work IQ `spec.oauth` with its scopes rewritten by a direct write. */
function workIqWithScopes(scopes: string[]): Record<string, unknown> {
  return { ...workIqGuid.spec.oauth, scopes }
}

/** The installed Work IQ `spec.oauth` minus the profile, as an outdated CRD persists it. */
function workIqWithoutProfile(): Record<string, unknown> {
  const { asProfile: _pruned, ...oauth } = workIqGuid.spec.oauth
  return oauth
}

/** A Notion pre-registered CR with the profile stamped on it: no producer, a direct write. */
function profileOnNotionOAuth(): Record<string, unknown> {
  const oauth = buildRemoteOAuthSpec(notionDiscovery, {
    clientMode: 'confidential',
    grantScope: 'user',
    clientSecretName: 'srv-oauth-client',
    preRegisteredClientId: PRE_REGISTERED_CLIENT_ID,
  }) as unknown as Record<string, unknown>
  return { ...oauth, asProfile: 'entra-v2' }
}

function publicWithRefsOAuth(): Record<string, unknown> {
  const oauth = buildRemoteOAuthSpec(headerDiscovery, {
    clientMode: 'confidential',
    grantScope: 'user',
    clientSecretName: 'srv-oauth-client',
    preRegisteredClientId: PRE_REGISTERED_CLIENT_ID,
  }) as unknown as Record<string, unknown>
  return { ...oauth, clientMode: 'public' }
}

function bearerInBodyOAuth(): Record<string, unknown> {
  return buildRemoteOAuthSpec(bodyDiscovery, {
    clientMode: 'public',
    grantScope: 'user',
    cimdClientId: CIMD_SELF,
  }) as unknown as Record<string, unknown>
}

/**
 * The CIMD identity on a server whose AS returns no `iss`. The builder emits it for any
 * discovery result; only the install refuses it, so it persists through a direct write.
 */
function cimdWithoutIssuerBindingOAuth(): Record<string, unknown> {
  return buildRemoteOAuthSpec(perServerDiscovery, {
    clientMode: 'public',
    grantScope: 'user',
    cimdClientId: CIMD_SELF,
  }) as unknown as Record<string, unknown>
}

/**
 * Dropbox's real endpoints (token on dropboxapi.com, issuer on dropbox.com) pinned on a
 * per-server CR. Discovery only accepts them with RFC 9207, so the per-server shape is
 * that output without `issForCallback` — the edit a direct write would make.
 */
function crossSitePerServerOAuth(): Record<string, unknown> {
  const oauth = buildRemoteOAuthSpec(crossSiteDiscovery, {
    clientMode: 'public',
    grantScope: 'user',
    dynamicClientId: 'dyn-dropbox-public',
  }) as unknown as Record<string, unknown>
  delete oauth.issForCallback
  return oauth
}

/** The Atlassian per-server DCR shape, coherent until a test edits it. */
function perServerDcrOAuth(): Record<string, unknown> {
  return buildRemoteOAuthSpec(perServerDiscovery, {
    clientMode: 'public',
    grantScope: 'user',
    dynamicClientId: 'dyn-atlassian-public',
  }) as unknown as Record<string, unknown>
}

/** A per-server CR written without `issuer`: no site to anchor the endpoints to. */
function perServerWithoutIssuerOAuth(): Record<string, unknown> {
  const oauth = perServerDcrOAuth()
  delete oauth.issuer
  return oauth
}

/** A per-server CR whose registration endpoint was moved off the issuer's site. */
function crossSiteRegistrationOAuth(): Record<string, unknown> {
  return {
    ...perServerDcrOAuth(),
    registrationEndpoint: 'https://register.example.net/oauth/register',
  }
}

/** `spec.remote` of a case: `undefined` omits the block; a function builds it. */
type RemoteOf = (() => Record<string, unknown>) | undefined

const INCOHERENT: ReadonlyArray<{
  label: string
  oauth: () => Record<string, unknown>
  remote?: RemoteOf
  reason: string
  consentOnly: boolean
}> = [
  // CRD mirrors: refused in consent and token issuance alike.
  {
    label: 'public + secret refs',
    oauth: publicWithRefsOAuth,
    reason: 'public_client_with_secret_refs',
    consentOnly: false,
  },
  {
    label: 'bearerInBody: true',
    oauth: bearerInBodyOAuth,
    reason: 'bearer_in_body',
    consentOnly: false,
  },
  // Per-server callback rules: refused at consent only; a grant already obtained is
  // sealed to the CR's uid and refreshes against the token endpoint that issued it.
  {
    label: 'CIMD client without RFC 9207',
    oauth: cimdWithoutIssuerBindingOAuth,
    reason: 'cimd_without_issuer_binding',
    consentOnly: true,
  },
  {
    label: 'per-server AS endpoints off the issuer site',
    oauth: crossSitePerServerOAuth,
    reason: 'as_endpoints_cross_site',
    consentOnly: true,
  },
  {
    label: 'per-server CR without an issuer',
    oauth: perServerWithoutIssuerOAuth,
    reason: 'as_endpoints_cross_site',
    consentOnly: true,
  },
  {
    label: 'per-server registration endpoint off the issuer site',
    oauth: crossSiteRegistrationOAuth,
    reason: 'as_endpoints_cross_site',
    consentOnly: true,
  },
  // AS-PROFILE-ISSUER mirror: a profile only on the Entra tenant issuer it comes from.
  {
    label: 'asProfile entra-v2 on the Notion issuer',
    oauth: profileOnNotionOAuth,
    remote: () => ({ baseUrl: PILOTS.notion.mcpUrl }),
    reason: 'as_profile_issuer_mismatch',
    consentOnly: false,
  },
  {
    label: 'unknown asProfile on the Entra issuer',
    oauth: () => ({ ...workIqGuid.spec.oauth, asProfile: 'other' }),
    remote: workIqRemote,
    reason: 'as_profile_issuer_mismatch',
    consentOnly: false,
  },
  {
    // What an apiserver with a CRD older than the field leaves of a real Work IQ install.
    label: 'Entra tenant issuer without asProfile (pruned by an outdated CRD)',
    oauth: workIqWithoutProfile,
    remote: workIqRemote,
    reason: 'as_profile_issuer_mismatch',
    consentOnly: false,
  },
  // Hard audience rules of the profile, against the base URL in force.
  {
    label: 'entra-v2 with the Microsoft Graph GUID scope',
    oauth: () => workIqWithScopes(['00000003-0000-0000-c000-000000000000/Mail.Read']),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    // The server's own scope satisfies the resource-scope rule, so only the audience
    // violation catches a Graph scope added next to it.
    label: 'entra-v2 with the Work IQ scope plus a Microsoft Graph GUID scope',
    oauth: () =>
      workIqWithScopes([WORKIQ_GUID_SCOPE, '00000003-0000-0000-c000-000000000000/Mail.Read']),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    // A CR written while Azure SQL was still an unknown GUID must stop resolving once it is
    // blocked; the server's own scope next to it does not save it.
    label: 'entra-v2 with the Work IQ scope plus an Azure SQL Database GUID scope',
    oauth: () =>
      workIqWithScopes([
        WORKIQ_GUID_SCOPE,
        '022907d3-0f1b-48f7-badc-1ba6abab6d66/user_impersonation',
      ]),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    label: 'entra-v2 with a Microsoft Graph URL scope',
    oauth: () => workIqWithScopes(['https://graph.microsoft.com/x']),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    label: 'entra-v2 with an unprefixed scope (read as Graph)',
    oauth: () => workIqWithScopes(['Mail.Read']),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    label: 'entra-v2 with sign-in scopes only (a Graph token)',
    oauth: () => workIqWithScopes(['offline_access']),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    // profileScopeViolation reports an empty scope as '', so a truthiness test misses it.
    label: 'entra-v2 with an empty scope ahead of a Graph URL scope',
    oauth: () => workIqWithScopes(['', 'https://graph.microsoft.com/x']),
    remote: workIqRemote,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    // Same, with the server's own scope after it: only a `!== null` test catches this one,
    // since the resource-scope rule is satisfied.
    label: 'entra-v2 with an empty scope ahead of the server URL scope',
    oauth: () => ({ ...workIqUrl.spec.oauth, scopes: ['', WORKIQ_URL_SCOPE] }),
    remote: () => ({ ...workIqUrl.spec.remote }),
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    label: 'entra-v2 URL-form scope after baseUrl moved to another host',
    oauth: () => ({ ...workIqUrl.spec.oauth }),
    remote: () => ({ ...workIqUrl.spec.remote, baseUrl: EVIL_BASE_URL }),
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    // The Work IQ app GUID is tied to its own host, so an edited base URL cannot carry its
    // tokens elsewhere even though a GUID scope names no host.
    label: 'entra-v2 GUID-form scope of a known API after baseUrl moved to another host',
    oauth: () => ({ ...workIqGuid.spec.oauth }),
    remote: () => ({ ...workIqGuid.spec.remote, baseUrl: EVIL_BASE_URL }),
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    label: 'entra-v2 without spec.remote',
    oauth: () => ({ ...workIqGuid.spec.oauth }),
    remote: undefined,
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
  {
    label: 'entra-v2 with an unparseable baseUrl',
    oauth: () => ({ ...workIqGuid.spec.oauth }),
    remote: () => ({ ...workIqGuid.spec.remote, baseUrl: 'not a url' }),
    reason: 'scope_audience_mismatch',
    consentOnly: false,
  },
]

function crFrom(
  name: string,
  oauth: Record<string, unknown>,
  remote?: Record<string, unknown>
): McpServerOAuthSpecInput & {
  metadata: { name: string }
  spec: Record<string, unknown>
} {
  return {
    metadata: { name },
    spec: { contextRef: CONTEXT, auth: { type: 'oauth' }, oauth, ...(remote ? { remote } : {}) },
  }
}

/** The CR of an INCOHERENT case. */
function caseCr(name: string, c: (typeof INCOHERENT)[number]) {
  return crFrom(name, c.oauth(), c.remote?.())
}

function thrownBy(fn: () => unknown): { code?: unknown; reason?: unknown } | undefined {
  try {
    fn()
  } catch (err) {
    return err as { code?: unknown; reason?: unknown }
  }
  return undefined
}

describe('resolver mirror of the remote CRD coherence rules', () => {
  it('the bearer-in-body producer really emits bearerInBody: true', () => {
    expect(bearerInBodyOAuth().bearerInBody).toBe(true)
  })

  it('the per-server fixtures really are per-server (no issForCallback) and cross-site', () => {
    expect(cimdWithoutIssuerBindingOAuth().issForCallback).toBeUndefined()
    const crossSite = crossSitePerServerOAuth()
    expect(crossSite.issForCallback).toBeUndefined()
    expect(new URL(crossSite.tokenEndpoint as string).hostname).toBe('api.dropboxapi.com')
    expect(new URL(crossSite.issuer as string).hostname).toMatch(/dropbox\.com$/)
    // The edits below are the only incoherence in their shapes: the base is coherent.
    const base = perServerDcrOAuth()
    expect(base.issForCallback).toBeUndefined()
    expect(resolveServerOAuthSubject(crFrom('srv', base), 'consent')?.decl.id).toBe(base.id)
    expect(typeof base.registrationEndpoint).toBe('string')
  })

  for (const c of INCOHERENT) {
    it(`${c.label}: resolveServerOAuthSubject(consent) throws remote_oauth_spec_incoherent`, () => {
      const err = thrownBy(() => resolveServerOAuthSubject(caseCr('srv', c), 'consent'))
      expect(err?.code).toBe('remote_oauth_spec_incoherent')
      expect(err?.reason).toBe(c.reason)
    })

    if (c.consentOnly) {
      it(`${c.label}: resolveServerOAuthSubject(token) still resolves the subject`, () => {
        const r = resolveServerOAuthSubject(caseCr('srv', c), 'token')
        expect(r?.decl.id).toBe(c.oauth().id)
        expect(r?.decl.remote?.tokenEndpoint).toBe(c.oauth().tokenEndpoint)
      })

      it(`${c.label}: the refresh reader (normalizeMcpServerOwnerDecl) keeps accepting it`, () => {
        const decl = normalizeMcpServerOwnerDecl(caseCr('srv', c) as never)?.spec?.oauthClients?.[0]
        expect(decl?.remote?.tokenEndpoint).toBe(c.oauth().tokenEndpoint)
      })
    } else {
      it(`${c.label}: resolveServerOAuthSubject(token) throws too`, () => {
        const err = thrownBy(() => resolveServerOAuthSubject(caseCr('srv', c), 'token'))
        expect(err?.reason).toBe(c.reason)
      })

      it(`${c.label}: the refresh reader (normalizeMcpServerOwnerDecl) refuses it too`, () => {
        const err = thrownBy(() => normalizeMcpServerOwnerDecl(caseCr('srv', c) as never))
        expect(err?.code).toBe('remote_oauth_spec_incoherent')
      })
    }

    it(`${c.label}: resolveServerOAuth still yields the grant coordinate (revoke, sweep)`, () => {
      const r = resolveServerOAuth(caseCr('srv', c))
      expect(r?.oauthClientId).toBe(c.oauth().id)
      expect(r?.grantScope).toBe('user')
      expect(r?.contextRef).toBe(CONTEXT)
    })
  }

  it('coherent remote shapes still resolve (pre-registered confidential, CIMD public)', () => {
    const preRegistered = buildRemoteOAuthSpec(headerDiscovery, {
      clientMode: 'confidential',
      grantScope: 'user',
      clientSecretName: 'srv-oauth-client',
      preRegisteredClientId: PRE_REGISTERED_CLIENT_ID,
    }) as unknown as Record<string, unknown>
    expect(
      resolveServerOAuthSubject(crFrom('a', preRegistered), 'consent')?.decl.secretSource?.kind
    ).toBe('k8s-secret')
    const cimd = buildRemoteOAuthSpec(headerDiscovery, {
      clientMode: 'public',
      grantScope: 'user',
      cimdClientId: CIMD_SELF,
    }) as unknown as Record<string, unknown>
    expect(resolveServerOAuthSubject(crFrom('b', cimd), 'consent')?.decl.secretSource?.kind).toBe(
      'public'
    )
    // Per-server DCR on a same-site AS without RFC 9207 (what an Atlassian install writes).
    const perServerDcr = buildRemoteOAuthSpec(perServerDiscovery, {
      clientMode: 'public',
      grantScope: 'user',
      dynamicClientId: 'dyn-atlassian-public',
    }) as unknown as Record<string, unknown>
    expect(perServerDcr.issForCallback).toBeUndefined()
    const resolved = resolveServerOAuthSubject(crFrom('c', perServerDcr), 'consent')
    expect(resolved?.decl.secretSource?.kind).toBe('public')
    // The pinned issuer rides the routing: the per-server callback checks a present `iss`.
    expect(resolved?.decl.remote?.issuer).toBe(perServerDiscovery.issuer)
    // A per-server server whose client is pre-registered keeps resolving too.
    const perServerPreRegistered = buildRemoteOAuthSpec(perServerDiscovery, {
      clientMode: 'confidential',
      grantScope: 'user',
      clientSecretName: 'srv-oauth-client',
      preRegisteredClientId: PRE_REGISTERED_CLIENT_ID,
    }) as unknown as Record<string, unknown>
    expect(
      resolveServerOAuthSubject(crFrom('d', perServerPreRegistered), 'consent')?.decl.secretSource
        ?.kind
    ).toBe('k8s-secret')
  })
})

describe('entra-v2 runtime audience: what stays coherent', () => {
  const PHASES = ['consent', 'token'] as const
  const AUDIENCE_BREAKERS = [
    ['00000003-0000-0000-c000-000000000000/Mail.Read'],
    ['https://graph.microsoft.com/x'],
    ['Mail.Read'],
    ['offline_access'],
  ]

  for (const phase of PHASES) {
    it(`${phase}: both installed Work IQ CRs resolve as written`, () => {
      for (const cr of [workIqGuid, workIqUrl]) {
        expect(resolveServerOAuthSubject(cr, phase)?.decl.remote?.asProfile).toBe('entra-v2')
      }
    })

    it(`${phase}: an unknown GUID scope is coherent (writing the CR is the confirmation)`, () => {
      const cr = crFrom(
        'srv',
        workIqWithScopes(['11111111-2222-3333-4444-555555555555/Tools.Read']),
        workIqRemote()
      )
      expect(resolveServerOAuthSubject(cr, phase)?.decl.id).toBe(workIqGuid.spec.oauth.id)
    })

    it(`${phase}: without a profile the same scopes are coherent (I6)`, () => {
      const preRegistered = buildRemoteOAuthSpec(headerDiscovery, {
        clientMode: 'confidential',
        grantScope: 'user',
        clientSecretName: 'srv-oauth-client',
        preRegisteredClientId: PRE_REGISTERED_CLIENT_ID,
      }) as unknown as Record<string, unknown>
      expect(preRegistered.asProfile).toBeUndefined()
      for (const scopes of [...AUDIENCE_BREAKERS, ['', 'https://graph.microsoft.com/x']]) {
        const cr = crFrom('srv', { ...preRegistered, scopes })
        expect(resolveServerOAuthSubject(cr, phase)?.decl.scopes).toEqual(scopes)
      }
    })
  }
})

describe('routes refuse an incoherent remote server with 409 remote_oauth_spec_incoherent', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    membership(mockPoolQuery, { contexts: { 'user-1': [CONTEXT] } }, sql =>
      Promise.resolve({
        rows: [],
        rowCount: typeof sql === 'string' && sql.includes('DELETE FROM oauth_grants') ? 1 : 0,
      })
    )
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  async function seed(
    name: string,
    oauth: Record<string, unknown>,
    remote?: Record<string, unknown>
  ): Promise<string> {
    const created = (await gateway.createResource(
      'mcpservers',
      crFrom(name, oauth, remote),
      MCP_NS
    )) as {
      metadata: { uid: string }
    }
    // The server is enabled in CONTEXT's allowlist (written by the real
    // allowlist writer): a per-user server's connect gate is membership in a
    // Context that allowlists it, so the member reaches the coherence check.
    await seedAllowlistedContext(gateway, CONTEXT, [name], MCP_NS)
    gateway.seedSecret('srv-oauth-client', MCP_NS, {
      data: {
        client_id: Buffer.from(PRE_REGISTERED_CLIENT_ID).toString('base64'),
        client_secret: Buffer.from('pre-registered-secret').toString('base64'),
      },
    })
    return created.metadata.uid
  }

  for (const c of INCOHERENT) {
    it(`${c.label}: POST /internal/mcp-oauth/authorize-url → 409, no URL minted`, async () => {
      await seed('srv', c.oauth(), c.remote?.())
      const res = await request(app)
        .post('/api/v1/internal/mcp-oauth/authorize-url')
        .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'srv', userId: 'user-1' })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'remote_oauth_spec_incoherent', reason: c.reason })
    })

    it(`${c.label}: authorize-url for a non-member → 403, configuration not disclosed`, async () => {
      await seed('srv', c.oauth(), c.remote?.())
      membership(mockPoolQuery, { contexts: { 'user-2': ['ctx-other'] } })
      const res = await request(app)
        .post('/api/v1/internal/mcp-oauth/authorize-url')
        .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'srv', userId: 'user-2' })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'context_membership_denied' })
    })

    it(`${c.label}: POST /mcp-oauth/user-token → ${c.consentOnly ? '200, the stored token is served' : '409 even with a fresh stored token'}`, async () => {
      const oauth = c.oauth()
      const uid = await seed('srv', oauth, c.remote?.())
      // The runtime caller is a live Host of CONTEXT, through whose allowlist the
      // server is reached, and the end user enters that Host.
      await seedAgentHost(gateway, RUNTIME_HOST, CONTEXT)
      const token = await mintHccControlToken(app, gateway, RUNTIME_HOST)
      membership(mockPoolQuery, { agents: { [RUNTIME_USER]: [RUNTIME_HOST] } }, sql => {
        const text = typeof sql === 'string' ? sql : ''
        if (text.includes('FROM oauth_grants')) {
          return Promise.resolve({
            rows: [
              {
                owner_kind: 'mcpserver',
                recipe_namespace: MCP_NS,
                recipe_name: 'srv',
                user_id: RUNTIME_USER,
                context_id: null,
                bootstrapped_by_user_id: null,
                oauth_client_id: oauth.id,
                grant_kind: 'user',
                provider: 'remote',
                access_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'LIVE-ACCESS'),
                refresh_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'LIVE-REFRESH'),
                access_token_expires_at: new Date(Date.now() + 3600_000),
                updated_at: new Date(),
                background: false,
                cr_uid: uid,
              },
            ],
            rowCount: 1,
          })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })
      const res = await request(app)
        .post('/api/v1/mcp-oauth/user-token')
        .set('Authorization', `Bearer ${token}`)
        .send({ mcpServerName: 'srv', userId: RUNTIME_USER })
      if (c.consentOnly) {
        expect(res.status).toBe(200)
        expect(JSON.stringify(res.body)).toContain('LIVE-ACCESS')
      } else {
        expect(res.status).toBe(409)
        expect(res.body).toEqual({ error: 'remote_oauth_spec_incoherent', reason: c.reason })
        expect(JSON.stringify(res.body)).not.toContain('LIVE-ACCESS')
      }
    })

    it(`${c.label}: GET /oauth-callback/remote → 409, nothing persisted`, async () => {
      const oauth = c.oauth()
      await seed('srv', oauth, c.remote?.())
      const state = signOAuthState(config.oauthStateHmacSecret, {
        subjectKind: 'mcp',
        mcpServerName: 'srv',
        userId: 'user-1',
        oauthClientId: oauth.id,
        grantKind: 'user',
        background: false,
      } as Parameters<typeof signOAuthState>[1])
      const res = await request(app)
        .get('/api/v1/oauth-callback/remote')
        .query({ code: 'AUTH_CODE', state, iss: oauth.issForCallback })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'remote_oauth_spec_incoherent', reason: c.reason })
      const grantWrites = mockPoolQuery.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' && /INSERT INTO oauth_grants|UPDATE oauth_grants/.test(sql)
      )
      expect(grantWrites).toHaveLength(0)
    })

    // The per-server route reads the same subject: the incoherence is refused before any
    // binding check or exchange, whichever remote callback the AS used.
    it(`${c.label}: GET /oauth-callback/remote/srv → 409, nothing persisted`, async () => {
      const oauth = c.oauth()
      await seed('srv', oauth, c.remote?.())
      const state = signOAuthState(config.oauthStateHmacSecret, {
        subjectKind: 'mcp',
        mcpServerName: 'srv',
        userId: 'user-1',
        oauthClientId: oauth.id,
        grantKind: 'user',
        background: false,
      } as Parameters<typeof signOAuthState>[1])
      const res = await request(app)
        .get('/api/v1/oauth-callback/remote/srv')
        .query({ code: 'AUTH_CODE', state })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'remote_oauth_spec_incoherent', reason: c.reason })
      const grantWrites = mockPoolQuery.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' && /INSERT INTO oauth_grants|UPDATE oauth_grants/.test(sql)
      )
      expect(grantWrites).toHaveLength(0)
    })

    it(`${c.label}: DELETE /internal/mcp-oauth/grant still revokes (204)`, async () => {
      await seed('srv', c.oauth(), c.remote?.())
      const res = await request(app)
        .delete('/api/v1/internal/mcp-oauth/grant')
        .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'srv', userId: 'user-1' })
      expect(res.status).toBe(204)
      const deletes = mockPoolQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM oauth_grants')
      )
      expect(deletes).toHaveLength(1)
    })
  }
})

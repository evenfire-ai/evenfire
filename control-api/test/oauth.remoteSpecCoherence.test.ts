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
import { issueMcpHostControlJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import {
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

let headerDiscovery: DiscoveryResult
let bodyDiscovery: DiscoveryResult

beforeAll(async () => {
  headerDiscovery = await discover(PILOTS.sentry)
  bodyDiscovery = await discover(bodyOnlyPilot())
})

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

const INCOHERENT = [
  {
    label: 'public + secret refs',
    oauth: publicWithRefsOAuth,
    reason: 'public_client_with_secret_refs',
  },
  { label: 'bearerInBody: true', oauth: bearerInBodyOAuth, reason: 'bearer_in_body' },
] as const

function crFrom(
  name: string,
  oauth: Record<string, unknown>
): McpServerOAuthSpecInput & {
  metadata: { name: string }
  spec: Record<string, unknown>
} {
  return { metadata: { name }, spec: { contextRef: CONTEXT, auth: { type: 'oauth' }, oauth } }
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

  for (const c of INCOHERENT) {
    it(`${c.label}: resolveServerOAuthSubject throws remote_oauth_spec_incoherent`, () => {
      const err = thrownBy(() => resolveServerOAuthSubject(crFrom('srv', c.oauth())))
      expect(err?.code).toBe('remote_oauth_spec_incoherent')
      expect(err?.reason).toBe(c.reason)
    })

    it(`${c.label}: the refresh reader (normalizeMcpServerOwnerDecl) refuses it too`, () => {
      const err = thrownBy(() => normalizeMcpServerOwnerDecl(crFrom('srv', c.oauth()) as never))
      expect(err?.code).toBe('remote_oauth_spec_incoherent')
    })

    it(`${c.label}: resolveServerOAuth still yields the grant coordinate (revoke, sweep)`, () => {
      const r = resolveServerOAuth(crFrom('srv', c.oauth()))
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
    expect(resolveServerOAuthSubject(crFrom('a', preRegistered))?.decl.secretSource?.kind).toBe(
      'k8s-secret'
    )
    const cimd = buildRemoteOAuthSpec(headerDiscovery, {
      clientMode: 'public',
      grantScope: 'user',
      cimdClientId: CIMD_SELF,
    }) as unknown as Record<string, unknown>
    expect(resolveServerOAuthSubject(crFrom('b', cimd))?.decl.secretSource?.kind).toBe('public')
  })
})

describe('routes refuse an incoherent remote server with 409 remote_oauth_spec_incoherent', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockImplementation((sql: unknown) => {
      const text = typeof sql === 'string' ? sql : ''
      if (text.includes('FROM user_contexts')) {
        return Promise.resolve({ rows: [{ context_id: CONTEXT }], rowCount: 1 })
      }
      if (text.includes('DELETE FROM oauth_grants')) {
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  async function seed(name: string, oauth: Record<string, unknown>): Promise<string> {
    const created = (await gateway.createResource('mcpservers', crFrom(name, oauth), MCP_NS)) as {
      metadata: { uid: string }
    }
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
      await seed('srv', c.oauth())
      const res = await request(app)
        .post('/api/v1/internal/mcp-oauth/authorize-url')
        .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'srv', userId: 'user-1' })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'remote_oauth_spec_incoherent', reason: c.reason })
    })

    it(`${c.label}: authorize-url for a non-member → 403, configuration not disclosed`, async () => {
      await seed('srv', c.oauth())
      mockPoolQuery.mockImplementation((sql: unknown) => {
        const text = typeof sql === 'string' ? sql : ''
        if (text.includes('FROM user_contexts')) {
          return Promise.resolve({ rows: [{ context_id: 'ctx-other' }], rowCount: 1 })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })
      const res = await request(app)
        .post('/api/v1/internal/mcp-oauth/authorize-url')
        .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
        .set('x-service-token', 'rpc-proxy')
        .send({ mcpServerName: 'srv', userId: 'user-2' })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'context_membership_denied' })
    })

    it(`${c.label}: POST /mcp-oauth/user-token → 409 even with a fresh stored token`, async () => {
      const oauth = c.oauth()
      const uid = await seed('srv', oauth)
      mockPoolQuery.mockImplementation((sql: unknown) => {
        const text = typeof sql === 'string' ? sql : ''
        if (text.includes('FROM oauth_grants')) {
          return Promise.resolve({
            rows: [
              {
                owner_kind: 'mcpserver',
                recipe_namespace: MCP_NS,
                recipe_name: 'srv',
                user_id: 'user-1',
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
      const token = issueMcpHostControlJwt('mcp-host', 'standalone', ['mcp-host/standalone'], {
        scopes: ['oauth:user-token'],
      }).token
      const res = await request(app)
        .post('/api/v1/mcp-oauth/user-token')
        .set('Authorization', `Bearer ${token}`)
        .send({ mcpServerName: 'srv', userId: 'user-1' })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'remote_oauth_spec_incoherent', reason: c.reason })
      expect(JSON.stringify(res.body)).not.toContain('LIVE-ACCESS')
    })

    it(`${c.label}: GET /oauth-callback/remote → 409, nothing persisted`, async () => {
      const oauth = c.oauth()
      await seed('srv', oauth)
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

    it(`${c.label}: DELETE /internal/mcp-oauth/grant still revokes (204)`, async () => {
      await seed('srv', c.oauth())
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

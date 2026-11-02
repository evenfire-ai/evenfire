import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import { registry } from '../src/observability/metrics.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { attachServerToContext } from '../src/services/contextAllowlist.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { verifyMcpHostControlJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import {
  mintHccControlToken,
  signInternalControlJwt,
  signLegacyControlToken,
} from './fixtures/hccControlToken.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'
import { captureRequestLogs } from './helpers/requestLogCapture.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
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
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

function seedOauthServer(
  gateway: MockGateway,
  opts: { name: string; grantScope?: 'user' | 'context'; contextRef?: string; enabled?: boolean }
): void {
  void gateway.createResource(
    'mcpservers',
    {
      metadata: { name: opts.name },
      spec: {
        ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
        // A stored CR may still carry the legacy field; the broker ignores it.
        contextRef: opts.contextRef ?? 'ctx-9',
        auth: { type: 'oauth' },
        oauth: {
          id: 'google-drive',
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
          ...(opts.grantScope ? { grantScope: opts.grantScope } : {}),
        },
      },
    },
    MCP_NS
  )
}

// The uid the gateway assigned to the seeded CR — the installation identity the
// grant readers are fenced by. Read back from the producer, never invented.
async function liveUid(gateway: MockGateway, name: string): Promise<string> {
  const cr = (await gateway.getResource('mcpservers', name, MCP_NS)) as {
    metadata: { uid: string }
  }
  return cr.metadata.uid
}

function nonExpiredUserGrantRow(userId: string, expiresAt: Date) {
  return {
    owner_kind: 'mcpserver',
    recipe_namespace: MCP_NS,
    recipe_name: 'gdrive',
    user_id: userId,
    context_id: null,
    bootstrapped_by_user_id: null,
    oauth_client_id: 'google-drive',
    grant_kind: 'user',
    provider: 'google',
    access_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'GDRIVE-ACCESS'),
    refresh_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'GDRIVE-REFRESH'),
    access_token_expires_at: expiresAt,
    updated_at: new Date(),
    background: false,
  }
}

function sharedGrantRow(contextId: string, expiresAt: Date) {
  return {
    ...nonExpiredUserGrantRow('', expiresAt),
    grant_kind: 'shared',
    user_id: null,
    context_id: contextId,
    bootstrapped_by_user_id: USER_1,
  }
}

const HOST = 'agent-host'
const HOST_CONTEXT = 'ctx-9'
// users.id is a UUID; the broker refuses anything else before querying.
const USER_1 = '0b4f3c1e-8a52-4e0f-9b7d-2d6c9e1a7f10'
const USER_NO_ACCESS = '7d2e4a90-3c1b-4f6e-8d5a-1b9c0e2f4a63'
const USER_2 = 'c3a91f2e-5b7d-4e08-a6c4-9f1e2d3b4a50'

const grantQueries = () =>
  mockPoolQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
  )

async function deniedCount(
  reason: string,
  route: 'user_token' | 'grants_exists' = 'user_token'
): Promise<number> {
  // Read by name so a build without the counter reports 0 instead of throwing.
  const metric = registry.getSingleMetric('mcp_oauth_broker_denied_total')
  if (!metric) return 0
  const { values } = await metric.get()
  return values.find(v => v.labels.reason === reason && v.labels.route === route)?.value ?? 0
}

describe('routes/mcp-oauth — POST /mcp-oauth/user-token (U1)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let token: string
  let grantRows: unknown[]
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  // The DB answers by SQL, not by call position: the Host-entry read goes
  // through the shared membership stand-in (USER_1 enters HOST), grant reads
  // return `grantRows`.
  function serveDb(opts: { accessError?: Error } = {}): void {
    membership(mockPoolQuery, { agents: { [USER_1]: [HOST] } }, sql => {
      const text = typeof sql === 'string' ? sql : ''
      if (text.includes('FROM oauth_grants')) {
        return Promise.resolve({ rows: grantRows, rowCount: grantRows.length })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    if (opts.accessError) {
      const answer = mockPoolQuery.getMockImplementation()!
      mockPoolQuery.mockImplementation((sql: unknown, values: unknown) =>
        typeof sql === 'string' && sql.includes('lifecycle_state') && sql.includes('team_agents')
          ? Promise.reject(opts.accessError)
          : answer(sql, values)
      )
    }
  }

  const post = (body: Record<string, unknown>, bearer: string = token) =>
    request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body)

  beforeEach(async () => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    grantRows = []
    serveDb()
    // These specs assert the broker's live behavior, so run them with the
    // kill-switch ON. The flag defaults OFF (fail-closed); the OFF→404 spec
    // below flips it back to exercise the disabled path.
    config.mcpOauthBrokerEnabled = true
    await seedAgentHost(gateway, HOST, HOST_CONTEXT)
    await seedAllowlistedContext(gateway, HOST_CONTEXT, ['gdrive', 'plain', 'no-ctx'])
    token = await mintHccControlToken(app, gateway, HOST)
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  // ── R0: gates that precede the binding, unchanged ─────────────────────────

  it('401 without a control JWT', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const res = await request(app)
      .post('/api/v1/mcp-oauth/user-token')
      .send({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(401)
  })

  it('isolates the rate-limit bucket per standalone host (no sub collapse)', async () => {
    // Every standalone 1st-party host shares sub=<hostsNamespace>/standalone, so
    // keying the limiter by sub would drop all of them in one bucket. The bucket
    // key must be the verified per-host principal (hostRefs[0]) instead.
    seedOauthServer(gateway, { name: 'gdrive' })
    await seedAgentHost(gateway, 'host-a', HOST_CONTEXT)
    await seedAgentHost(gateway, 'host-b', HOST_CONTEXT)
    const tokenA = await mintHccControlToken(app, gateway, 'host-a')
    const tokenB = await mintHccControlToken(app, gateway, 'host-b')
    vi.mocked(checkAndIncrement).mockClear()

    await post({ mcpServerName: 'gdrive', userId: USER_1 }, tokenA)
    await post({ mcpServerName: 'gdrive', userId: USER_1 }, tokenB)

    const keys = vi.mocked(checkAndIncrement).mock.calls.map(call => call[0])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe('mcp-oauth:mcp-host/host/host-a')
    expect(keys[1]).toBe('mcp-oauth:mcp-host/host/host-b')
  })

  it('403 with a valid control JWT that lacks the oauth:user-token scope', async () => {
    seedOauthServer(gateway, { name: 'gdrive' })
    const noScope = await mintHccControlToken(app, gateway, HOST, [])
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, noScope)
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"insufficient_scope"}')
  })

  // ── Rule 1a: caller lineage ───────────────────────────────────────────────

  it('R1a: a workflow-recipe control token carrying the scope → 403 host_not_bound (I-4)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    const wrc = signLegacyControlToken({
      recipeNamespace: config.sandboxNamespace,
      recipeName: 'recipe-x',
      hostRefs: [`${config.sandboxNamespace}/recipe-x`],
    })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, wrc)
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
    expect(grantQueries()).toHaveLength(0)
  })

  it('R1a: the real issuer no longer gives a workflow-recipe control token the scope', async () => {
    const res = await request(app)
      .post(`/api/v1/auth/mcp-host/${config.sandboxNamespace}/recipe-x/tokens`)
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ includeMcpHostControlToken: true, workflowControlScopes: ['oauth:user-token'] })
    expect(res.status).toBe(200)
    const claims = verifyMcpHostControlJwt(res.body.mcpHostControlToken)
    expect(claims?.scopes).not.toContain('oauth:user-token')
  })

  it.each([
    ['the reserved name standalone', { hostRefs: ['standalone'] }],
    ['a namespaced hostRef', { hostRefs: ['ns/agent-host'] }],
    ['two hostRefs', { hostRefs: ['agent-host', 'other-host'] }],
    ['a recipe name other than standalone', { recipeName: 'other', hostRefs: ['agent-host'] }],
    ['another namespace', { recipeNamespace: 'elsewhere', hostRefs: ['agent-host'] }],
  ])('R1a: an HCC-like token with %s → 403 host_not_bound', async (_label, shape) => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const forged = signLegacyControlToken({
      recipeNamespace: config.hostsNamespace,
      recipeName: 'standalone',
      host_uid: 'uid-anything',
      ...shape,
    } as Parameters<typeof signLegacyControlToken>[0])
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, forged)
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
  })

  // ── Rule 1b: host_uid present ─────────────────────────────────────────────

  it('R1b: an HCC token without host_uid → 401 with the requireControlCaller body', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    const legacy = signLegacyControlToken({
      recipeNamespace: config.hostsNamespace,
      recipeName: 'standalone',
      hostRefs: [HOST],
    })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, legacy)
    expect(res.status).toBe(401)
    expect(res.text).toBe('{"error":"Unauthorized"}')
    expect(grantQueries()).toHaveLength(0)
  })

  it('400 invalid_request for a malformed (non-k8s) server name, before any getResource', async () => {
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({ mcpServerName: 'Foo/Bar', userId: USER_1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
    expect(reads).not.toHaveBeenCalled()
  })

  // ── Rule 2: live Host with the token's uid ────────────────────────────────

  it('R2a: Host deleted after issuance → 403 host_not_bound', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    await gateway.deleteResource('hosts', HOST, config.hostsNamespace)
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
    expect(grantQueries()).toHaveLength(0)
  })

  it('R2a: Host being deleted → 403 host_not_bound', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    gateway.markDeleting('hosts', HOST, config.hostsNamespace)
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
  })

  it('R2b: Host recreated under the same name (new uid) → 403 host_not_bound (I-8)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    await gateway.deleteResource('hosts', HOST, config.hostsNamespace)
    await seedAgentHost(gateway, HOST, HOST_CONTEXT)
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
    expect(grantQueries()).toHaveLength(0)
  })

  it('R2c: a draining Host still obtains its token', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    const host = (await gateway.getResource('hosts', HOST, config.hostsNamespace)) as {
      status?: Record<string, unknown>
    }
    host.status = { lifecycle: { state: 'draining' } }
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('GDRIVE-ACCESS')
  })

  it.each([
    ['an apiserver outage', { statusCode: 503 }],
    ['an RBAC refusal', { statusCode: 403, body: { message: 'hosts is forbidden' } }],
  ])('R2d: %s reading the Host → 503 fixed body, no grant read', async (_label, err) => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    gateway.failGetResource('hosts', err)
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(503)
    expect(res.text).toBe('{"error":"host_state_unavailable"}')
    expect(grantQueries()).toHaveLength(0)
  })

  // ── Rule 3: the Host's Context ────────────────────────────────────────────

  it('R3: the Host Context does not exist → 403 host_not_bound', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    await gateway.deleteResource('contexts', HOST_CONTEXT, config.contextsNamespace)
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
  })

  it('R3: the Host Context is being deleted → 403 host_not_bound', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    gateway.markDeleting('contexts', HOST_CONTEXT, config.contextsNamespace)
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
  })

  it.each([
    ['empty', ''],
    ['not a k8s name', 'Bad/Name'],
  ])('R3: host.spec.contextRef %s → 403 without reading contexts', async (_label, ref) => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    await seedAgentHost(gateway, 'odd-host', ref)
    const odd = await mintHccControlToken(app, gateway, 'odd-host')
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, odd)
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
    expect(reads.mock.calls.some(([plural]) => plural === 'contexts')).toBe(false)
  })

  it('R3: the Context is read from contextsNamespace, not the mcp-servers namespace', async () => {
    const originalContextsNamespace = config.contextsNamespace
    config.contextsNamespace = 'contexts-elsewhere'
    try {
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
      grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
      await seedAgentHost(gateway, 'split-host', 'ctx-split')
      // Only the contexts namespace holds this Context.
      await seedAllowlistedContext(gateway, 'ctx-split', ['gdrive'], config.contextsNamespace)
      const split = await mintHccControlToken(app, gateway, 'split-host')
      mockPoolQuery.mockReset()
      membership(mockPoolQuery, { agents: { [USER_1]: ['split-host'] } }, sql =>
        Promise.resolve(
          typeof sql === 'string' && sql.includes('FROM oauth_grants')
            ? { rows: grantRows, rowCount: grantRows.length }
            : { rows: [], rowCount: 0 }
        )
      )
      const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, split)
      expect(res.status).toBe(200)
      expect(res.body.token).toBe('GDRIVE-ACCESS')
    } finally {
      config.contextsNamespace = originalContextsNamespace
    }
  })

  it('R3: a Context object whose name differs from host.spec.contextRef → 403 host_not_bound', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    // Stub: the apiserver answers the Context read with another object.
    const read = gateway.getResource.bind(gateway)
    vi.spyOn(gateway, 'getResource').mockImplementation(async (plural, name, ns) => {
      const row = (await read(plural, name, ns)) as { metadata: Record<string, unknown> }
      return plural === 'contexts'
        ? { ...row, metadata: { ...row.metadata, name: 'ctx-other' } }
        : row
    })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
    expect(grantQueries()).toHaveLength(0)
  })

  it('R3: a transient error reading the Context → 503', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    gateway.failGetResource('contexts', { statusCode: 500 })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(503)
    expect(res.text).toBe('{"error":"host_state_unavailable"}')
  })

  it('R3b: spec.contextId differing from the Context name is served and only logged at debug', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    await seedAgentHost(gateway, 'renamed-host', 'ctx-renamed')
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'ctx-renamed' }, spec: { contextId: 'legacy-id', mcpServers: [] } },
      config.contextsNamespace
    )
    await attachServerToContext(
      gateway as never,
      { name: 'ctx-renamed', namespace: config.contextsNamespace },
      'gdrive'
    )
    const renamed = await mintHccControlToken(app, gateway, 'renamed-host')
    mockPoolQuery.mockReset()
    membership(mockPoolQuery, { agents: { [USER_1]: ['renamed-host'] } }, sql =>
      Promise.resolve(
        typeof sql === 'string' && sql.includes('FROM oauth_grants')
          ? { rows: grantRows, rowCount: grantRows.length }
          : { rows: [], rowCount: 0 }
      )
    )
    const logs = captureRequestLogs()
    try {
      const res = await post({ mcpServerName: 'gdrive', userId: USER_1 }, renamed)
      expect(res.status).toBe(200)
      expect(logs.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'context_id_mismatch', host: 'renamed-host' }),
        expect.any(String)
      )
      expect(logs.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'context_id_mismatch' }),
        expect.anything()
      )
    } finally {
      logs.restore()
    }
  })

  // ── Rule 4: allowlist, then the CR ────────────────────────────────────────

  it('R4: missing, outside the allowlist, being deleted and disabled all answer the same 404 (I-2, I-5)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'foreign', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'leaving', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'off', grantScope: 'user', enabled: false })
    for (const name of ['ghost', 'leaving', 'off']) {
      await attachServerToContext(
        gateway as never,
        { name: HOST_CONTEXT, namespace: config.contextsNamespace },
        name
      )
    }
    gateway.markDeleting('mcpservers', 'leaving', MCP_NS)
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]

    for (const name of ['ghost', 'foreign', 'leaving', 'off']) {
      const res = await post({ mcpServerName: name, userId: USER_1 })
      expect(res.status, name).toBe(404)
      expect(res.text, name).toBe('{"error":"server_not_found"}')
    }
    expect(grantQueries()).toHaveLength(0)
  })

  it('R4b: the allowlist match is exact, like host-context-controller (no trim)', async () => {
    seedOauthServer(gateway, { name: 'drive', grantScope: 'user' })
    await attachServerToContext(
      gateway as never,
      { name: HOST_CONTEXT, namespace: config.contextsNamespace },
      ' drive '
    )
    const res = await post({ mcpServerName: 'drive', userId: USER_1 })
    expect(res.status).toBe(404)
    expect(res.text).toBe('{"error":"server_not_found"}')
  })

  it('R4c: a server outside the allowlist is never read from the apiserver', async () => {
    seedOauthServer(gateway, { name: 'foreign', grantScope: 'user' })
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({ mcpServerName: 'foreign', userId: USER_1 })
    expect(res.status).toBe(404)
    expect(reads.mock.calls.some(([plural]) => plural === 'mcpservers')).toBe(false)
  })

  it('R4: a transient error reading an allowlisted server → 503', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    gateway.failGetResource('mcpservers', { statusCode: 500 })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(503)
    expect(res.text).toBe('{"error":"host_state_unavailable"}')
  })

  // ── Rule 5 ────────────────────────────────────────────────────────────────

  it('R5: 400 not_oauth_server for a non-oauth server of the own Context', async () => {
    void gateway.createResource(
      'mcpservers',
      { metadata: { name: 'plain' }, spec: { auth: { type: 'none' } } },
      MCP_NS
    )
    const res = await post({ mcpServerName: 'plain', userId: USER_1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not_oauth_server')
  })

  // ── Rule 6: context-scope key is the Host Context ───────────────────────────────────────────

  it('context flavor: key uses the Host Context, not the body; user_id NULL', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: HOST_CONTEXT })
    grantRows = [sharedGrantRow(HOST_CONTEXT, new Date(Date.now() + 3600_000))]

    const res = await post({ mcpServerName: 'gdrive', userId: USER_NO_ACCESS })

    expect(res.status).toBe(200)
    const grantQuery = grantQueries().find(([sql]) => String(sql).includes("grant_kind = 'shared'"))
    expect(grantQuery?.[1]).toEqual([
      'mcpserver',
      MCP_NS,
      'gdrive',
      HOST_CONTEXT,
      'google-drive',
      await liveUid(gateway, 'gdrive'),
      // Baked CR: the reader key carries its provider for unsealed legacy rows.
      'google',
    ])
  })

  it.each([
    ['still names another Context', 'ctx-A'],
    ['names no Context', undefined],
  ])(
    'R6: a context server whose stored CR %s is keyed by the Host Context only (I-1)',
    async (_label, legacyContextRef) => {
      void gateway.createResource(
        'mcpservers',
        {
          metadata: { name: 'gdrive' },
          spec: {
            ...(legacyContextRef !== undefined ? { contextRef: legacyContextRef } : {}),
            auth: { type: 'oauth' },
            oauth: {
              id: 'google-drive',
              provider: 'google',
              clientIdRef: { name: 'google-creds', key: 'client-id' },
              clientSecretRef: { name: 'google-creds', key: 'client-secret' },
              grantScope: 'context',
            },
          },
        },
        MCP_NS
      )
      grantRows = [sharedGrantRow(HOST_CONTEXT, new Date(Date.now() + 3600_000))]

      const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })

      expect(res.status).toBe(200)
      const contexts = grantQueries().map(([, values]) => (values as unknown[])[3])
      expect(contexts).toEqual([HOST_CONTEXT])
    }
  )

  it('R6: an incoherent remote context server outside the Host Context allowlist → 404, not a 409', async () => {
    // Derived from the real producer: the builder's confidential output with
    // clientMode flipped to public, an in-place edit the coherence check refuses.
    const outcome = await discoverRemoteOAuth(PILOTS.sentry.mcpUrl, {
      transport: makeDiscoveryTransport(PILOTS.sentry),
      resolveDns: async () => ['93.184.216.34'],
    })
    if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
    const incoherentOauth = {
      ...(buildRemoteOAuthSpec(outcome.result, {
        clientMode: 'confidential',
        grantScope: 'context',
        clientSecretName: 'gdrive-oauth-client',
        preRegisteredClientId: 'client-abc',
      }) as unknown as Record<string, unknown>),
      clientMode: 'public',
    }
    const seed = (name: string) =>
      gateway.createResource(
        'mcpservers',
        {
          metadata: { name },
          spec: { auth: { type: 'oauth' }, oauth: incoherentOauth },
        },
        MCP_NS
      )

    // Control: enabled in the Host Context, the same spec is refused as incoherent.
    await seed('gdrive')
    const own = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(own.status).toBe(409)
    expect(own.body.error).toBe('remote_oauth_spec_incoherent')

    // `foreign` is not in the Host Context allowlist.
    await seed('foreign')
    const secretReads = vi.spyOn(gateway, 'getSecret')

    const res = await post({ mcpServerName: 'foreign', userId: USER_1 })

    expect(res.status).toBe(404)
    expect(res.text).toBe('{"error":"server_not_found"}')
    expect(grantQueries()).toHaveLength(0)
    expect(secretReads).not.toHaveBeenCalled()
  })

  it('R6b: a body contextId is ignored — a foreign value neither denies nor redirects the key', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: HOST_CONTEXT })
    grantRows = [sharedGrantRow(HOST_CONTEXT, new Date(Date.now() + 3600_000))]
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1, contextId: 'ctx-B' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('GDRIVE-ACCESS')
    const keys = grantQueries().map(([, values]) => (values as unknown[])[3])
    expect(keys).toEqual([HOST_CONTEXT])
  })

  it('context flavor: 404 no_grant when no shared grant exists for the Host Context', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: HOST_CONTEXT })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'no_grant' })
  })

  // ── Rule 7: the end user enters this Host ─────────────────────────────────

  it('200 {token,expiresAt} for a per-user grant, keyed by (mcpserver owner, userId)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const future = new Date(Date.now() + 3600_000)
    grantRows = [nonExpiredUserGrantRow(USER_1, future)]

    const res = await post({ mcpServerName: 'gdrive', userId: USER_1, contextId: HOST_CONTEXT })

    expect(res.status).toBe(200)
    expect(res.body.token).toBe('GDRIVE-ACCESS')
    expect(res.body.expiresAt).toBe(future.toISOString())
    const grantQuery = grantQueries().find(([sql]) => String(sql).includes("grant_kind = 'user'"))
    expect(grantQuery?.[1]).toEqual([
      'mcpserver',
      MCP_NS,
      'gdrive',
      USER_1,
      'google-drive',
      await liveUid(gateway, 'gdrive'),
      // Baked CR: the reader key carries its provider for unsealed legacy rows.
      'google',
    ])
  })

  it('404 no_grant when the user enters the Host but never connected', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'no_grant' })
  })

  it('R7: a user who cannot enter the Host gets no_grant without any grant read (I-3)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_NO_ACCESS, new Date(Date.now() + 3600_000))]
    const res = await post({ mcpServerName: 'gdrive', userId: USER_NO_ACCESS })
    expect(res.status).toBe(404)
    expect(res.text).toBe('{"error":"no_grant"}')
    expect(grantQueries()).toHaveLength(0)
  })

  it('R7: 400 invalid_request for a user server without userId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const res = await post({ mcpServerName: 'gdrive' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('R7f: a DB error reading Host access → 503 fixed body, no grant read', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]
    serveDb({ accessError: new Error('connection terminated') })
    const before = await deniedCount('unavailable')
    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })
    expect(res.status).toBe(503)
    expect(res.text).toBe('{"error":"host_state_unavailable"}')
    expect(grantQueries()).toHaveLength(0)
    expect(await deniedCount('unavailable')).toBe(before + 1)
  })

  it('logs the denial with server and Host, never the userId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const logs = captureRequestLogs()
    try {
      await post({ mcpServerName: 'gdrive', userId: USER_NO_ACCESS })
    } finally {
      logs.restore()
    }
    const denial = logs.warn.mock.calls.find(
      ([fields]) => (fields as { event?: string }).event === 'mcp_oauth_broker_denied'
    )
    expect(denial?.[0]).toMatchObject({ reason: 'no_grant', host: HOST, mcpServerName: 'gdrive' })
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(USER_NO_ACCESS)
  })

  it('no_grant by Host access logs at warn; a non-UUID channel sender only at debug', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const before = await deniedCount('no_grant')
    const logs = captureRequestLogs()
    try {
      const entitledLooking = await post({ mcpServerName: 'gdrive', userId: USER_NO_ACCESS })
      const channelSender = await post({ mcpServerName: 'gdrive', userId: 'U024BE7LH' })
      expect(entitledLooking.text).toBe('{"error":"no_grant"}')
      expect(channelSender.text).toBe('{"error":"no_grant"}')
    } finally {
      logs.restore()
    }
    const denials = (calls: unknown[][]) =>
      calls
        .map(([fields]) => fields as { event?: string; reason?: string; cause?: string })
        .filter(fields => fields.event === 'mcp_oauth_broker_denied')
    expect(denials(logs.warn.mock.calls)).toEqual([
      expect.objectContaining({ reason: 'no_grant', cause: 'no_host_access' }),
    ])
    expect(denials(logs.debug.mock.calls)).toEqual([
      expect.objectContaining({ reason: 'no_grant', cause: 'non_uuid_user_id' }),
    ])
    expect(await deniedCount('no_grant')).toBe(before + 2)
  })

  // Finding R1-H1: the broker is gated behind a kill-switch that defaults OFF,
  // so it cannot serve provider tokens in production until the U4 mcp-host
  // runtime lands. When disabled, a fully well-formed AND authorized request —
  // valid control JWT, correct scope, seeded server, a grant row that would
  // otherwise resolve to a 200 token — must observe 404 not_found (the endpoint
  // looks absent), and grant resolution must never run (no oauth_grants query).
  describe('kill-switch (mcpOauthBrokerEnabled)', () => {
    it('OFF (default): a well-formed authorized request returns 404 not_found and never resolves a grant', async () => {
      config.mcpOauthBrokerEnabled = false
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
      grantRows = [nonExpiredUserGrantRow(USER_1, new Date(Date.now() + 3600_000))]

      const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('not_found')
      expect(res.body.token).toBeUndefined()
      expect(grantQueries()).toHaveLength(0)
    })

    it('ON: the same request resolves normally (behavior unchanged)', async () => {
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
      const future = new Date(Date.now() + 3600_000)
      grantRows = [nonExpiredUserGrantRow(USER_1, future)]

      const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })

      expect(res.status).toBe(200)
      expect(res.body.token).toBe('GDRIVE-ACCESS')
      expect(res.body.expiresAt).toBe(future.toISOString())
    })
  })
})

// Hot-revocation poll-sweep endpoint (mini-spec 13 §4.1), bound to the calling
// Host like user-token. mcp-host keeps every partition on any non-200, and
// evicts only on a strict `exists:false`, so definitive denials travel as 200 +
// false and anything transient as 200 + true. The T1 derivation of `exists`
// from the real store producers lives in
// routes.mcpOauth.grantsExists.realPostgres.integration.test.ts.
describe('routes/mcp-oauth — POST /mcp-oauth/grants/exists (Host binding)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  let token: string
  // Grants present in the store, as `<server>|<userId or contextId>`.
  let granted: Set<string>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  // Answers by SQL: the Host-entry read through the shared membership stand-in
  // (USER_1 and USER_2 enter HOST), grant reads from `granted`.
  function serveDb(opts: { accessError?: Error } = {}): void {
    membership(mockPoolQuery, { agents: { [USER_1]: [HOST], [USER_2]: [HOST] } }, (sql, values) => {
      const text = typeof sql === 'string' ? sql : ''
      if (text.includes('FROM oauth_grants')) {
        const v = values as unknown[]
        return Promise.resolve(
          granted.has(`${String(v[2])}|${String(v[3])}`)
            ? { rows: [{ exists: 1 }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
        )
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    if (opts.accessError) {
      const answer = mockPoolQuery.getMockImplementation()!
      mockPoolQuery.mockImplementation((sql: unknown, values: unknown) =>
        isAccessSql(sql) ? Promise.reject(opts.accessError) : answer(sql, values)
      )
    }
  }

  const isAccessSql = (sql: unknown) =>
    typeof sql === 'string' && sql.includes('lifecycle_state') && sql.includes('team_agents')
  const accessQueries = () => mockPoolQuery.mock.calls.filter(([sql]) => isAccessSql(sql))

  const post = (body: unknown, bearer: string | null = token) => {
    const req = request(app).post('/api/v1/mcp-oauth/grants/exists')
    if (bearer) req.set('Authorization', `Bearer ${bearer}`)
    return req.send(body as object)
  }

  function seedContextServer(name: string, contextRef: string | undefined): void {
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name },
        spec: {
          ...(contextRef !== undefined ? { contextRef } : {}),
          auth: { type: 'oauth' },
          oauth: {
            id: 'google-drive',
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            grantScope: 'context',
          },
        },
      },
      MCP_NS
    )
  }

  const allow = (name: string) =>
    attachServerToContext(
      gateway as never,
      { name: HOST_CONTEXT, namespace: config.contextsNamespace },
      name
    )

  beforeEach(async () => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    granted = new Set()
    serveDb()
    config.mcpOauthBrokerEnabled = true
    await seedAgentHost(gateway, HOST, HOST_CONTEXT)
    await seedAllowlistedContext(
      gateway,
      HOST_CONTEXT,
      ['gdrive', 'gdrive-2', 'plain', 'ghost', 'team', 'team-foreign', 'team-noctx'],
      config.contextsNamespace
    )
    token = await mintHccControlToken(app, gateway, HOST)
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  // ── Gates before the binding ──────────────────────────────────────────────

  it('401 without a control JWT (same gate as user-token)', async () => {
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] }, null)
    expect(res.status).toBe(401)
  })

  it('403 insufficient_scope with a valid control JWT that lacks oauth:user-token', async () => {
    const noScope = await mintHccControlToken(app, gateway, HOST, [])
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] }, noScope)
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"insufficient_scope"}')
  })

  it('R1a: a workflow-recipe control token carrying the scope → 403 host_not_bound', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    granted.add(`gdrive|${USER_1}`)
    const wrc = signLegacyControlToken({
      recipeNamespace: config.sandboxNamespace,
      recipeName: 'recipe-x',
      hostRefs: [`${config.sandboxNamespace}/recipe-x`],
    })
    const before = await deniedCount('lineage', 'grants_exists')
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] }, wrc)
    expect(res.status).toBe(403)
    expect(res.text).toBe('{"error":"host_not_bound"}')
    expect(grantQueries()).toHaveLength(0)
    expect(await deniedCount('lineage', 'grants_exists')).toBe(before + 1)
  })

  it('R1b: an HCC token without host_uid → 401 with the requireControlCaller body, no read', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    granted.add(`gdrive|${USER_1}`)
    const legacy = signLegacyControlToken({
      recipeNamespace: config.hostsNamespace,
      recipeName: 'standalone',
      hostRefs: [HOST],
    })
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] }, legacy)
    expect(res.status).toBe(401)
    expect(res.text).toBe('{"error":"Unauthorized"}')
    expect(reads).not.toHaveBeenCalled()
    expect(grantQueries()).toHaveLength(0)
  })

  it('400 invalid_request when queries is not an array', async () => {
    const res = await post({ queries: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('400 batch_too_large when queries exceeds the cap', async () => {
    const queries = Array.from({ length: 1001 }, (_, i) => ({
      mcpServerName: `srv-${i}`,
      userId: USER_1,
    }))
    const res = await post({ queries })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('batch_too_large')
  })

  it('GE5: an empty batch answers without reading Host, Context or any server', async () => {
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({ queries: [] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ results: [] })
    expect(reads).not.toHaveBeenCalled()
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ── Batch level: the Host binding ─────────────────────────────────────────

  const batch = [
    { mcpServerName: 'gdrive', userId: USER_1 },
    { mcpServerName: 'team', contextId: HOST_CONTEXT },
    { mcpServerName: 'ghost', userId: USER_1 },
  ]

  it.each<[string, () => Promise<void> | void]>([
    ['the Host was deleted', () => gateway.deleteResource('hosts', HOST, config.hostsNamespace)],
    ['the Host is being deleted', () => gateway.markDeleting('hosts', HOST, config.hostsNamespace)],
    [
      'the Host was recreated under the same name (new uid)',
      async () => {
        await gateway.deleteResource('hosts', HOST, config.hostsNamespace)
        await seedAgentHost(gateway, HOST, HOST_CONTEXT)
      },
    ],
    [
      'the Host Context does not exist',
      () => gateway.deleteResource('contexts', HOST_CONTEXT, config.contextsNamespace),
    ],
    [
      'the Host Context is being deleted',
      () => gateway.markDeleting('contexts', HOST_CONTEXT, config.contextsNamespace),
    ],
  ])('GE1: %s → 200 with every entry exists:false, logged once', async (_label, unbind) => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    seedContextServer('team', HOST_CONTEXT)
    granted.add(`gdrive|${USER_1}`).add(`team|${HOST_CONTEXT}`)
    await unbind()
    const before = await deniedCount('host_not_bound', 'grants_exists')
    const logs = captureRequestLogs()
    let res: request.Response
    try {
      res = await post({ queries: batch })
    } finally {
      logs.restore()
    }
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual(batch.map(q => ({ ...q, exists: false })))
    expect(grantQueries()).toHaveLength(0)
    expect(accessQueries()).toHaveLength(0)
    expect(await deniedCount('host_not_bound', 'grants_exists')).toBe(before + 1)
    const batchDenials = logs.warn.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === 'broker_batch_denied'
    )
    expect(batchDenials).toHaveLength(1)
    expect(batchDenials[0][0]).toMatchObject({ host: HOST, entries: batch.length })
  })

  it.each<[string, 'hosts' | 'contexts']>([
    ['reading the Host', 'hosts'],
    ['reading the Context', 'contexts'],
  ])('GE2: a transient error %s → 200 with every entry exists:true (I-7)', async (_l, plural) => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    seedContextServer('team', HOST_CONTEXT)
    // No grant anywhere: only the fail-open rule can answer true.
    gateway.failGetResource(plural, { statusCode: 503 })
    const before = await deniedCount('unavailable', 'grants_exists')
    const res = await post({ queries: batch })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual(batch.map(q => ({ ...q, exists: true })))
    expect(grantQueries()).toHaveLength(0)
    expect(await deniedCount('unavailable', 'grants_exists')).toBe(before + 1)
  })

  // ── Entry level ───────────────────────────────────────────────────────────

  it('S05-D10: outside the allowlist → false without reading the server; in it but missing → true', async () => {
    seedOauthServer(gateway, { name: 'foreign', grantScope: 'user' })
    granted.add(`foreign|${USER_1}`)
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({
      queries: [
        { mcpServerName: 'foreign', userId: USER_1 },
        { mcpServerName: 'ghost', userId: USER_1 },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { mcpServerName: 'foreign', userId: USER_1, exists: false },
      { mcpServerName: 'ghost', userId: USER_1, exists: true },
    ])
    expect(reads.mock.calls.some(([p, n]) => p === 'mcpservers' && n === 'foreign')).toBe(false)
    expect(grantQueries()).toHaveLength(0)
  })

  it('the allowlist match is exact, like host-context-controller (no trim)', async () => {
    seedOauthServer(gateway, { name: 'drive', grantScope: 'user' })
    await allow(' drive ')
    granted.add(`drive|${USER_1}`)
    const res = await post({ queries: [{ mcpServerName: 'drive', userId: USER_1 }] })
    expect(res.body.results).toEqual([{ mcpServerName: 'drive', userId: USER_1, exists: false }])
  })

  it('an allowlisted server being deleted or disabled → false although the grant exists', async () => {
    seedOauthServer(gateway, { name: 'leaving', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'off', grantScope: 'user', enabled: false })
    await allow('leaving')
    await allow('off')
    gateway.markDeleting('mcpservers', 'leaving', MCP_NS)
    granted.add(`leaving|${USER_1}`).add(`off|${USER_1}`)
    const res = await post({
      queries: [
        { mcpServerName: 'leaving', userId: USER_1 },
        { mcpServerName: 'off', userId: USER_1 },
      ],
    })
    expect(res.body.results).toEqual([
      { mcpServerName: 'leaving', userId: USER_1, exists: false },
      { mcpServerName: 'off', userId: USER_1, exists: false },
    ])
    expect(grantQueries()).toHaveLength(0)
  })

  it('GE2: a transient error reading an allowlisted server → true, without a grant', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    gateway.failGetResource('mcpservers', { statusCode: 500 })
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] })
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', userId: USER_1, exists: true }])
  })

  it('a non-oauth allowlisted server → true (no not_oauth_server rule here)', async () => {
    void gateway.createResource(
      'mcpservers',
      { metadata: { name: 'plain' }, spec: { auth: { type: 'none' } } },
      MCP_NS
    )
    const res = await post({ queries: [{ mcpServerName: 'plain', userId: USER_1 }] })
    expect(res.body.results).toEqual([{ mcpServerName: 'plain', userId: USER_1, exists: true }])
    expect(grantQueries()).toHaveLength(0)
  })

  it('a server that declares spec.oauth but is not auth.type oauth → true, no grant read', async () => {
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'plain' },
        spec: {
          contextRef: HOST_CONTEXT,
          auth: { type: 'none' },
          oauth: {
            id: 'google-drive',
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            grantScope: 'user',
          },
        },
      },
      MCP_NS
    )
    granted.add(`plain|${USER_1}`)
    const res = await post({ queries: [{ mcpServerName: 'plain', userId: USER_1 }] })
    expect(res.body.results).toEqual([{ mcpServerName: 'plain', userId: USER_1, exists: true }])
    expect(grantQueries()).toHaveLength(0)
  })

  it.each<[string, 'mcp_server' | 'user_access']>([
    ['reading the server', 'mcp_server'],
    ['reading Host access', 'user_access'],
  ])(
    'a transient error %s is logged and counted once, with every entry it covers',
    async (_l, stage) => {
      seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
      if (stage === 'mcp_server') gateway.failGetResource('mcpservers', { statusCode: 500 })
      else serveDb({ accessError: new Error('connection terminated') })
      const before = await deniedCount('unavailable', 'grants_exists')
      const queries = [
        { mcpServerName: 'gdrive', userId: USER_1 },
        { mcpServerName: 'gdrive', userId: USER_2 },
        { mcpServerName: 'gdrive', userId: USER_1 },
      ]
      const logs = captureRequestLogs()
      let res: request.Response
      try {
        res = await post({ queries })
      } finally {
        logs.restore()
      }
      expect(res.body.results).toEqual(queries.map(q => ({ ...q, exists: true })))
      expect(await deniedCount('unavailable', 'grants_exists')).toBe(before + 1)
      // The aggregated denial is the only warning, and it carries the cause.
      expect(logs.warn.mock.calls).toHaveLength(1)
      expect(logs.warn.mock.calls[0][0]).toMatchObject({
        event: 'mcp_oauth_broker_denied',
        reason: 'unavailable',
        mcpServerName: 'gdrive',
        entries: queries.length,
        stage,
        err: expect.anything(),
      })
    }
  )

  it('R6: a grant of another Context never answers for the Host Context (I-1)', async () => {
    // Stored CRs that still name a Context, or none: neither changes the key.
    seedContextServer('team-foreign', 'ctx-A')
    seedContextServer('team-noctx', undefined)
    granted.add('team-foreign|ctx-A')
    granted.add('team-noctx|ctx-A')
    const res = await post({
      queries: [{ mcpServerName: 'team-foreign' }, { mcpServerName: 'team-noctx' }],
    })
    expect(res.body.results).toEqual([
      { mcpServerName: 'team-foreign', exists: false },
      { mcpServerName: 'team-noctx', exists: false },
    ])
    expect(grantQueries().map(([, values]) => (values as unknown[])[3])).toEqual([
      HOST_CONTEXT,
      HOST_CONTEXT,
    ])
  })

  it('R6b: a context server of the Host Context keys by that Context, ignoring the body contextId', async () => {
    seedContextServer('team', HOST_CONTEXT)
    granted.add(`team|${HOST_CONTEXT}`)
    const res = await post({
      queries: [{ mcpServerName: 'team', userId: USER_1, contextId: 'ctx-foreign' }],
    })
    expect(res.body.results).toEqual([
      { mcpServerName: 'team', userId: USER_1, contextId: 'ctx-foreign', exists: true },
    ])
    expect(grantQueries()[0]?.[1]).toEqual([
      'mcpserver',
      MCP_NS,
      'team',
      HOST_CONTEXT,
      'google-drive',
      await liveUid(gateway, 'team'),
      'google',
    ])
  })

  it('a per-user server without userId → true', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const res = await post({ queries: [{ mcpServerName: 'gdrive' }] })
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', exists: true }])
  })

  it('R7e: a userId that is not a canonical UUID → false, without querying access or grants', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    granted.add('gdrive|U024BE7LH').add(`gdrive|{${USER_1}}`)
    const res = await post({
      queries: [
        { mcpServerName: 'gdrive', userId: 'U024BE7LH' },
        { mcpServerName: 'gdrive', userId: `{${USER_1}}` },
      ],
    })
    expect(res.body.results).toEqual([
      { mcpServerName: 'gdrive', userId: 'U024BE7LH', exists: false },
      { mcpServerName: 'gdrive', userId: `{${USER_1}}`, exists: false },
    ])
    expect(accessQueries()).toHaveLength(0)
    expect(grantQueries()).toHaveLength(0)
  })

  it('R7: a user who cannot enter the Host → false although the grant exists (I-3)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    granted.add(`gdrive|${USER_NO_ACCESS}`)
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_NO_ACCESS }] })
    expect(res.body.results).toEqual([
      { mcpServerName: 'gdrive', userId: USER_NO_ACCESS, exists: false },
    ])
    expect(grantQueries()).toHaveLength(0)
  })

  it('R7f: a DB error reading Host access → true, without a grant (I-7)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    serveDb({ accessError: new Error('connection terminated') })
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', userId: USER_1, exists: true }])
    expect(grantQueries()).toHaveLength(0)
  })

  it('authorized: the real grant lookup decides, keyed by (server owner, userId)', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    granted.add(`gdrive|${USER_1}`)
    const res = await post({
      queries: [
        { mcpServerName: 'gdrive', userId: USER_1 },
        { mcpServerName: 'gdrive', userId: USER_2 },
      ],
    })
    expect(res.body.results).toEqual([
      { mcpServerName: 'gdrive', userId: USER_1, exists: true },
      { mcpServerName: 'gdrive', userId: USER_2, exists: false },
    ])
    expect(grantQueries().map(([, values]) => values)).toEqual([
      [
        'mcpserver',
        MCP_NS,
        'gdrive',
        USER_1,
        'google-drive',
        await liveUid(gateway, 'gdrive'),
        'google',
      ],
      [
        'mcpserver',
        MCP_NS,
        'gdrive',
        USER_2,
        'google-drive',
        await liveUid(gateway, 'gdrive'),
        'google',
      ],
    ])
  })

  it('GE5: Host and Context once per batch, each server once, Host access once per userId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'gdrive-2', grantScope: 'user' })
    seedContextServer('team', HOST_CONTEXT)
    granted.add(`gdrive|${USER_1}`).add(`gdrive-2|${USER_2}`)
    const reads = vi.spyOn(gateway, 'getResource')
    const res = await post({
      queries: [
        { mcpServerName: 'gdrive', userId: USER_1 },
        { mcpServerName: 'gdrive', userId: USER_2 },
        { mcpServerName: 'gdrive-2', userId: USER_1 },
        { mcpServerName: 'gdrive-2', userId: USER_2 },
        { mcpServerName: 'team' },
        { mcpServerName: 'ghost', userId: USER_1 },
        { mcpServerName: 'ghost', userId: USER_2 },
      ],
    })
    expect(res.body.results.map((r: { exists: boolean }) => r.exists)).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
      true,
    ])
    const count = (plural: string, name?: string) =>
      reads.mock.calls.filter(([p, n]) => p === plural && (name === undefined || n === name)).length
    expect(count('hosts')).toBe(1)
    expect(count('contexts')).toBe(1)
    expect(count('mcpservers', 'gdrive')).toBe(1)
    expect(count('mcpservers', 'gdrive-2')).toBe(1)
    expect(count('mcpservers', 'ghost')).toBe(1)
    expect(accessQueries().map(([, values]) => values)).toEqual([
      [USER_1, HOST],
      [USER_2, HOST],
    ])
  })

  it('logs and counts once per (reason, server), never per entry, and never the userId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'foreign', grantScope: 'user' })
    const beforeNotFound = await deniedCount('server_not_found', 'grants_exists')
    const beforeNoGrant = await deniedCount('no_grant', 'grants_exists')
    const logs = captureRequestLogs()
    try {
      const res = await post({
        queries: [
          { mcpServerName: 'foreign', userId: USER_1 },
          { mcpServerName: 'foreign', userId: USER_2 },
          { mcpServerName: 'foreign', userId: USER_NO_ACCESS },
          { mcpServerName: 'gdrive', userId: USER_NO_ACCESS },
          { mcpServerName: 'gdrive', userId: 'U024BE7LH' },
          { mcpServerName: 'gdrive', userId: 'W0B2C3D4E' },
        ],
      })
      expect(res.body.results.every((r: { exists: boolean }) => !r.exists)).toBe(true)
    } finally {
      logs.restore()
    }
    expect(await deniedCount('server_not_found', 'grants_exists')).toBe(beforeNotFound + 1)
    expect(await deniedCount('no_grant', 'grants_exists')).toBe(beforeNoGrant + 1)
    const denials = [...logs.warn.mock.calls, ...logs.debug.mock.calls]
      .map(([fields]) => fields as { event?: string; reason?: string; mcpServerName?: string })
      .filter(fields => fields.event === 'mcp_oauth_broker_denied')
    expect(denials).toEqual([
      expect.objectContaining({
        reason: 'server_not_found',
        route: 'grants_exists',
        host: HOST,
        mcpServerName: 'foreign',
        entries: 3,
      }),
      expect.objectContaining({
        reason: 'no_grant',
        route: 'grants_exists',
        host: HOST,
        mcpServerName: 'gdrive',
        entries: 3,
      }),
    ])
    const everything = JSON.stringify([
      logs.warn.mock.calls,
      logs.debug.mock.calls,
      logs.info.mock.calls,
    ])
    for (const id of [USER_1, USER_2, USER_NO_ACCESS, 'U024BE7LH', 'W0B2C3D4E']) {
      expect(everything).not.toContain(id)
    }
  })

  it('channel senders (non-UUID) are logged at debug; only an entitled-looking id warns', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    seedOauthServer(gateway, { name: 'gdrive-2', grantScope: 'user' })
    const logs = captureRequestLogs()
    try {
      await post({
        queries: [
          { mcpServerName: 'gdrive', userId: 'U024BE7LH' },
          { mcpServerName: 'gdrive-2', userId: USER_NO_ACCESS },
        ],
      })
    } finally {
      logs.restore()
    }
    const denials = (calls: unknown[][]) =>
      calls
        .map(([fields]) => fields as { event?: string; mcpServerName?: string })
        .filter(fields => fields.event === 'mcp_oauth_broker_denied')
        .map(fields => fields.mcpServerName)
    expect(denials(logs.debug.mock.calls)).toEqual(['gdrive'])
    expect(denials(logs.warn.mock.calls)).toEqual(['gdrive-2'])
  })

  it('keeps results 1:1 with queries, fail-open placeholder for malformed entries', async () => {
    const queries = [
      { mcpServerName: 'Foo/Bar', userId: USER_1 },
      { mcpServerName: 'ghost', userId: USER_2 },
      { userId: USER_1 },
    ]
    const res = await post({ queries })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { mcpServerName: 'Foo/Bar', userId: USER_1, exists: true },
      { mcpServerName: 'ghost', userId: USER_2, exists: true },
      { mcpServerName: '', userId: USER_1, exists: true },
    ])
  })

  it('429 Too Many Requests when the shared broker rate limit is exceeded', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      backendAvailable: true,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 61,
    })
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    expect(grantQueries()).toHaveLength(0)
  })

  it('404 not_found when the broker kill-switch is OFF', async () => {
    config.mcpOauthBrokerEnabled = false
    const res = await post({ queries: [{ mcpServerName: 'gdrive', userId: USER_1 }] })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})

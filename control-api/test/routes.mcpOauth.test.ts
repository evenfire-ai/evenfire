import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import { registry } from '../src/observability/metrics.js'
import { attachServerToContext } from '../src/services/contextAllowlist.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import {
  issueMcpHostControlJwt,
  verifyMcpHostControlJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import {
  mintHccControlToken,
  signInternalControlJwt,
  signLegacyControlToken,
} from './fixtures/hccControlToken.js'
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
        // contextRef is CRD-required + singular — the AUTHORITATIVE Context.
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

// Control JWT for the grants/exists suite below, from the real minter (T1).
// Only an HCC-lineage control token may carry oauth:user-token.
function controlToken(scopes: Array<'oauth:user-token'> = ['oauth:user-token']): string {
  return issueMcpHostControlJwt('mcp-host', 'standalone', ['agent-host'], {
    scopes,
    hccCredential: { hostUid: 'uid-agent-host' },
  }).token
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

const grantQueries = () =>
  mockPoolQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
  )

async function deniedCount(reason: string): Promise<number> {
  // Read by name so a build without the counter reports 0 instead of throwing.
  const metric = registry.getSingleMetric('mcp_oauth_broker_denied_total')
  if (!metric) return 0
  const { values } = await metric.get()
  return values.find(v => v.labels.reason === reason && v.labels.route === 'user_token')?.value ?? 0
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

  it('R3b: spec.contextId differing from the Context name is served and only logged', async () => {
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
      expect(logs.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'context_id_mismatch', host: 'renamed-host' }),
        expect.any(String)
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

  // ── Rule 6: context-scope owner ───────────────────────────────────────────

  it('context flavor: key uses the Host Context (= owner), not the body; user_id NULL', async () => {
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

  it('R6: a context server owned by another Context → 404 server_not_found + metric, no grant read (I-1)', async () => {
    // Before the binding, this request handed ctx-A's shared token to any Host.
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'context', contextRef: 'ctx-A' })
    grantRows = [sharedGrantRow('ctx-A', new Date(Date.now() + 3600_000))]
    const before = await deniedCount('context_ref_mismatch')

    const res = await post({ mcpServerName: 'gdrive', userId: USER_1 })

    expect(res.status).toBe(404)
    expect(res.text).toBe('{"error":"server_not_found"}')
    expect(grantQueries()).toHaveLength(0)
    expect(await deniedCount('context_ref_mismatch')).toBe(before + 1)
  })

  it('R6: a context server without contextRef → the same 404, no grant read', async () => {
    void gateway.createResource(
      'mcpservers',
      {
        metadata: { name: 'no-ctx' },
        spec: {
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
    const res = await post({ mcpServerName: 'no-ctx', userId: USER_1 })
    expect(res.status).toBe(404)
    expect(res.text).toBe('{"error":"server_not_found"}')
    expect(grantQueries()).toHaveLength(0)
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

// Hot-revocation poll-sweep endpoint (mini-spec 13 §4.1). Gate + validation +
// fail-open behaviors are asserted here at the HTTP layer; the AUTHORITATIVE
// T1 derivation of `exists` from the real store producers lives in
// routes.mcpOauth.grantsExists.realPostgres.integration.test.ts.
describe('routes/mcp-oauth — POST /mcp-oauth/grants/exists (mini-spec 13)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>
  const originalBrokerEnabled = config.mcpOauthBrokerEnabled

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    // Default: SELECT 1 finds no row → oauthGrantExists = false (no grant).
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    config.mcpOauthBrokerEnabled = true
  })

  afterEach(() => {
    config.mcpOauthBrokerEnabled = originalBrokerEnabled
  })

  const post = (token: string | null, body: unknown) => {
    const req = request(app).post('/api/v1/mcp-oauth/grants/exists')
    if (token) req.set('Authorization', `Bearer ${token}`)
    return req.send(body as object)
  }

  it('401 without a control JWT (same gate as user-token)', async () => {
    const res = await post(null, { queries: [{ mcpServerName: 'gdrive', userId: 'u1' }] })
    expect(res.status).toBe(401)
  })

  // Case (d): the SAME scope as user-token (oauth:user-token) — no new scope.
  it('403 insufficient_scope with a valid control JWT that lacks oauth:user-token', async () => {
    const res = await post(controlToken([]), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('insufficient_scope')
  })

  it('400 invalid_request when queries is not an array', async () => {
    const res = await post(controlToken(), { queries: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('400 batch_too_large when queries exceeds the cap', async () => {
    const queries = Array.from({ length: 1001 }, (_, i) => ({
      mcpServerName: `srv-${i}`,
      userId: 'u1',
    }))
    const res = await post(controlToken(), { queries })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('batch_too_large')
  })

  // Fail-open (§4.2): an unknown server (getResource 404) and a non-oauth server
  // are ambiguous/transient — never a spurious `exists:false` that would evict.
  it('200: unknown and non-oauth servers fail OPEN (exists:true), keyed by name', async () => {
    void gateway.createResource(
      'mcpservers',
      { metadata: { name: 'plain' }, spec: { auth: { type: 'none' } } },
      MCP_NS
    )
    const res = await post(controlToken(), {
      queries: [
        { mcpServerName: 'ghost', userId: 'u1' },
        { mcpServerName: 'plain', userId: 'u1' },
      ],
    })
    expect(res.status).toBe(200)
    // Each result echoes the query's coordinates (correlation by tuple).
    expect(res.body.results).toEqual([
      { mcpServerName: 'ghost', userId: 'u1', exists: true },
      { mcpServerName: 'plain', userId: 'u1', exists: true },
    ])
    // Fail-open cases never touch the grants table.
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantQuery).toBeUndefined()
  })

  // A definitive `exists:false` only when oauthGrantExists says so (SELECT 1
  // returns 0 rows), and the lookup is keyed by (mcpserver owner, userId).
  it('200: a per-user server with no grant reports exists:false (definitive), keyed by userId', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'nobody' }],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', userId: 'nobody', exists: false }])
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'user'")
    )
    expect(grantQuery?.[1]).toEqual([
      'mcpserver',
      MCP_NS,
      'gdrive',
      'nobody',
      'google-drive',
      await liveUid(gateway, 'gdrive'),
      // Baked CR: the reader key carries its provider for unsealed legacy rows.
      'google',
    ])
  })

  it('200: reports exists:true when the SELECT 1 finds a row', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ mcpServerName: 'gdrive', userId: 'u1', exists: true }])
  })

  // FIX A core: two per-user partitions of the SAME server (different userId)
  // must be distinguishable in ONE batch response — correlation by (server,
  // userId) tuple, not by array position. alice has a grant, bob does not.
  it('200: distinguishes two userIds on the same server within one batch', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    // First SELECT 1 (alice) finds a row; the default empty result covers bob.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
    const res = await post(controlToken(), {
      queries: [
        { mcpServerName: 'gdrive', userId: 'alice' },
        { mcpServerName: 'gdrive', userId: 'bob' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { mcpServerName: 'gdrive', userId: 'alice', exists: true },
      { mcpServerName: 'gdrive', userId: 'bob', exists: false },
    ])
  })

  // Should-fix #1 (efficiency, mini-spec 13): within ONE batch the CR of a
  // shared server is read from the apiserver ONCE, not once per entry. N per-user
  // partitions of the SAME server → a single getResource('mcpservers', 'gdrive'),
  // yet still N grant SELECTs (one per userId). The per-entry response is
  // IDENTICAL to the un-deduped semantics — only the apiserver fan-out drops.
  it('200: dedups the getResource read across N entries of the same server', async () => {
    seedOauthServer(gateway, { name: 'gdrive', grantScope: 'user' })
    const getResourceSpy = vi.spyOn(gateway, 'getResource')
    // alice has a grant (first SELECT 1 finds a row); bob and carol do not.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 })
    const res = await post(controlToken(), {
      queries: [
        { mcpServerName: 'gdrive', userId: 'alice' },
        { mcpServerName: 'gdrive', userId: 'bob' },
        { mcpServerName: 'gdrive', userId: 'carol' },
      ],
    })
    expect(res.status).toBe(200)
    // Per-entry booleans + order unchanged vs. the one-read-per-entry version.
    expect(res.body.results).toEqual([
      { mcpServerName: 'gdrive', userId: 'alice', exists: true },
      { mcpServerName: 'gdrive', userId: 'bob', exists: false },
      { mcpServerName: 'gdrive', userId: 'carol', exists: false },
    ])
    // The shared server CR is read from the apiserver EXACTLY ONCE for the batch.
    const gdriveReads = getResourceSpy.mock.calls.filter(
      ([plural, name]) => plural === 'mcpservers' && name === 'gdrive'
    )
    expect(gdriveReads).toHaveLength(1)
    // Yet every entry still ran its own SELECT 1 (one grant lookup per userId).
    const grantSelects = mockPoolQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantSelects).toHaveLength(3)
    // …and each SELECT carries its own entry's userId, in order (userId is the
    // 4th bind param: [ownerKind, ns, name, userId, clientId]).
    expect(grantSelects.map(call => (call[1] as unknown[])[3])).toEqual(['alice', 'bob', 'carol'])
  })

  // Context flavor: keyed by the server's AUTHORITATIVE spec.contextRef, NEVER
  // the body contextId (no body-trust). The SELECT 1 coordinate proves it; the
  // lying body contextId is only echoed back, never used to key.
  it('200: context server keys the lookup by spec.contextRef, ignoring a lying body contextId', async () => {
    seedOauthServer(gateway, { name: 'team', grantScope: 'context', contextRef: 'ctx-real' })
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'team', userId: 'u1', contextId: 'ctx-foreign' }],
    })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { mcpServerName: 'team', userId: 'u1', contextId: 'ctx-foreign', exists: false },
    ])
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM oauth_grants') &&
        sql.includes("grant_kind = 'shared'")
    )
    // contextId coordinate is the authoritative ctx-real, NOT the body ctx-foreign.
    expect(grantQuery?.[1]).toEqual([
      'mcpserver',
      MCP_NS,
      'team',
      'ctx-real',
      'google-drive',
      await liveUid(gateway, 'team'),
      // Baked CR: the reader key carries its provider for unsealed legacy rows.
      'google',
    ])
  })

  // FIX A: a malformed entry must NOT be dropped (that breaks positional/tuple
  // correlation) — it yields a fail-open placeholder in its OWN slot, echoing
  // whatever coordinates it carried. results stays 1:1 with queries.
  it('200: keeps results 1:1 with queries, fail-open placeholder for malformed entries', async () => {
    const queries = [
      { mcpServerName: 'Foo/Bar', userId: 'u1' }, // invalid k8s name → placeholder, name echoed as-is
      { mcpServerName: 'ghost', userId: 'u2' }, // unknown server → fail-open true
      { userId: 'u3' }, // no mcpServerName → placeholder, name echoes ''
    ]
    const res = await post(controlToken(), { queries })
    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(queries.length)
    expect(res.body.results).toEqual([
      { mcpServerName: 'Foo/Bar', userId: 'u1', exists: true },
      { mcpServerName: 'ghost', userId: 'u2', exists: true },
      { mcpServerName: '', userId: 'u3', exists: true },
    ])
  })

  // FIX B: the endpoint mirrors user-token's rate limiter (same mcp_oauth_broker
  // bucket, keyed by caller). When the bucket is exhausted the middleware short-
  // circuits with 429 BEFORE the handler runs (no grant lookup).
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
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('Too Many Requests')
    // Denied before the handler — no grants lookup ran.
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM oauth_grants')
    )
    expect(grantQuery).toBeUndefined()
  })

  // Kill-switch parity with user-token: OFF (default) → the endpoint looks absent.
  it('404 not_found when the broker kill-switch is OFF', async () => {
    config.mcpOauthBrokerEnabled = false
    const res = await post(controlToken(), {
      queries: [{ mcpServerName: 'gdrive', userId: 'u1' }],
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})

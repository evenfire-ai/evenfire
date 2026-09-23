import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import {
  GrokSubscriptionConnectionKeyConflictError,
  GrokSubscriptionFingerprintConflictError,
  GrokSubscriptionInvalidConnectionKeyError,
  GrokSubscriptionStaleRevisionError,
} from '../src/services/grokSubscriptionConnection.js'
import {
  type GrokOAuthErrorCode,
  GrokSubscriptionOAuthError,
} from '../src/services/grokSubscriptionOAuth.js'
import { K8sConflictError } from '../src/services/resourceService.js'

type GrokOAuthModule = typeof import('../src/services/grokSubscriptionOAuth.js')
type GrokCatalogModule = typeof import('../src/services/grokSubscriptionCatalog.js')

const grokOAuth = vi.hoisted(() => ({
  getGrokSubscriptionConnection: vi.fn(),
  startGrokDeviceConnect: vi.fn(),
  pollGrokDevice: vi.fn(),
  refreshGrokSubscriptionConnection: vi.fn(),
  revokeGrokSubscription: vi.fn(),
  runGrokCatalogSync: vi.fn(),
}))

const grokCatalog = vi.hoisted(() => ({
  listOfferedGrokModelsForAssignment: vi.fn(),
  listGrokCatalogModels: vi.fn(),
  setGrokCatalogModelEnabled: vi.fn(),
}))

const codexOAuth = vi.hoisted(() => ({
  startCodexDeviceConnect: vi.fn(),
  revokeCodexSubscription: vi.fn(),
}))

vi.mock('../src/services/grokSubscriptionOAuth.js', async () => {
  const actual = await vi.importActual<GrokOAuthModule>('../src/services/grokSubscriptionOAuth.js')
  return { ...actual, ...grokOAuth }
})

vi.mock('../src/services/grokSubscriptionCatalog.js', async () => {
  const actual = await vi.importActual<GrokCatalogModule>(
    '../src/services/grokSubscriptionCatalog.js'
  )
  return { ...actual, ...grokCatalog }
})

vi.mock('../src/services/codexSubscriptionOAuth.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionOAuth.js')
  return { ...actual, ...codexOAuth }
})

vi.mock('../src/db.js', () => {
  const query = vi.fn()
  return {
    pool: { query },
    withTransaction: async <T>(work: (tx: { query: typeof query }) => Promise<T>) =>
      work({ query }),
  }
})

vi.mock('../src/routes/admin/hostSpecValidation.js', async () => {
  const actual = await vi.importActual('../src/routes/admin/hostSpecValidation.js')
  return {
    ...actual,
    validateHostSpec: vi.fn().mockResolvedValue(null),
  }
})

const actualOAuth = await vi.importActual<GrokOAuthModule>(
  '../src/services/grokSubscriptionOAuth.js'
)
const actualCatalog = await vi.importActual<GrokCatalogModule>(
  '../src/services/grokSubscriptionCatalog.js'
)
const { pool } = await import('../src/db.js')
const { config } = await import('../src/config.js')
const { createAdminCodexSubscriptionRouter } =
  await import('../src/routes/admin/codexSubscription.js')
const { createCodexCatalogTransportFromEnv } =
  await import('../src/services/codexSubscriptionCatalog.js')

const GROK = '/admin/llm/providers/grok-subscription'

type Gateway = {
  listResource: ReturnType<typeof vi.fn>
  getResource: ReturnType<typeof vi.fn>
  updateResource: ReturnType<typeof vi.fn>
  llmAllowedModelsConfigMap: () => { materialize: () => Promise<void> }
}

function makeGateway(materialize: () => Promise<void> = async () => {}): Gateway {
  return {
    listResource: vi.fn().mockResolvedValue([]),
    getResource: vi.fn(),
    updateResource: vi.fn().mockResolvedValue({}),
    llmAllowedModelsConfigMap: () => ({ materialize }),
  }
}

function makeApp(gateway?: Gateway) {
  const app = express()
  app.use(express.json())
  app.use((req: Request & { adminAuth?: { sub: string } }, _res: Response, next: NextFunction) => {
    req.adminAuth = { sub: 'admin-1' }
    next()
  })
  app.use(
    createAdminCodexSubscriptionRouter(createCodexCatalogTransportFromEnv(), gateway as never)
  )
  return app
}

function grokRow(connectionKey: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `id-${connectionKey}`,
    connection_key: connectionKey,
    display_name: connectionKey,
    default_model: null,
    created_by: null,
    status: 'connected',
    credential_revision: 2,
    catalog_revision: 1,
    account_fingerprint: 'fp-grok',
    catalog_status: 'ready',
    catalog_synced_at: null,
    last_refresh_at: null,
    last_auth_at: null,
    refresh_lock_token: null,
    refresh_lock_expires_at: null,
    revoked_at: null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

function safeConnection(connectionKey: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `id-${connectionKey}`,
    connectionKey,
    displayName: connectionKey,
    defaultModel: null,
    status: 'connected',
    credentialRevision: 2,
    catalogRevision: 1,
    catalogStatus: 'ready',
    revokedAt: null,
    ...overrides,
  }
}

/** Route pool.query by SQL fragment; unmatched statements return no rows. */
function routeSql(routes: Array<[string, (values?: unknown[]) => unknown]>) {
  vi.mocked(pool.query).mockImplementation((async (sql: unknown, values?: unknown[]) => {
    const text = String(sql)
    for (const [fragment, handler] of routes) {
      if (text.includes(fragment)) return handler(values)
    }
    return { rows: [], rowCount: 0 }
  }) as never)
}

function assertNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body)
  expect(serialized).not.toMatch(/Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret/i)
  expect(serialized).not.toMatch(/device_code|deviceCode|cookie|authorization/i)
}

describe('admin Grok subscription routes', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    config.grokSubscriptionEnabled = true
    config.codexSubscriptionEnabled = true
    vi.mocked(pool.query).mockReset()
    vi.mocked(pool.query).mockResolvedValue({ rows: [], rowCount: 0 } as never)
    for (const [name, fn] of Object.entries(grokOAuth)) {
      fn.mockReset().mockImplementation(actualOAuth[name as keyof typeof grokOAuth] as never)
    }
    for (const [name, fn] of Object.entries(grokCatalog)) {
      fn.mockReset().mockImplementation(actualCatalog[name as keyof typeof grokCatalog] as never)
    }
    for (const fn of Object.values(codexOAuth)) fn.mockReset()
    fetchSpy = vi.fn(async () => {
      throw new Error('unexpected upstream fetch')
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  describe('feature flag and provider isolation', () => {
    const grokRoutes: Array<['get' | 'post' | 'patch', string]> = [
      ['get', `${GROK}/connections`],
      ['post', `${GROK}/connections`],
      ['get', `${GROK}/connections/team-grok`],
      ['patch', `${GROK}/connections/team-grok`],
      ['post', `${GROK}/connections/team-grok/device/start`],
      ['get', `${GROK}/connections/team-grok/device/poll?state=s`],
      ['post', `${GROK}/connections/team-grok/refresh`],
      ['post', `${GROK}/connections/team-grok/catalog/sync`],
      ['post', `${GROK}/connections/team-grok/revoke`],
      ['get', `${GROK}/connections/team-grok/models`],
      ['patch', `${GROK}/connections/team-grok/models/grok-4.6`],
      ['get', `${GROK}/assignable-hosts`],
      ['post', `${GROK}/connections/team-grok/hosts/chat/bind`],
      ['post', `${GROK}/connections/team-grok/hosts/chat/unbind`],
    ]

    it.each(grokRoutes)(
      'returns 404 disabled for %s %s while the Grok flag is off',
      async (method, path) => {
        config.grokSubscriptionEnabled = false
        const gateway = makeGateway()
        const res = await request(makeApp(gateway))[method](path).send({ enabled: true })
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ error: 'disabled' })
        expect(pool.query).not.toHaveBeenCalled()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(gateway.getResource).not.toHaveBeenCalled()
        expect(gateway.updateResource).not.toHaveBeenCalled()
      }
    )

    it('keeps Codex routes reachable when only the Grok flag is off', async () => {
      config.grokSubscriptionEnabled = false
      codexOAuth.revokeCodexSubscription.mockResolvedValue({
        connectionKey: 'team-plus',
        status: 'revoked',
      })
      const res = await request(makeApp()).post(
        '/admin/llm/providers/codex-subscription/connections/team-plus/revoke'
      )
      expect(res.status).toBe(200)
      expect(grokOAuth.revokeGrokSubscription).not.toHaveBeenCalled()
    })

    it.each([
      ['post', `${GROK}/device/start`],
      ['get', `${GROK}/device/poll`],
      ['post', `${GROK}/refresh`],
      ['post', `${GROK}/catalog/sync`],
      ['post', `${GROK}/revoke`],
    ] as const)('rejects the un-keyed Codex alias %s %s for Grok', async (method, path) => {
      const res = await request(makeApp())[method](path)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'not_found' })
      expect(grokOAuth.startGrokDeviceConnect).not.toHaveBeenCalled()
      expect(grokOAuth.revokeGrokSubscription).not.toHaveBeenCalled()
      expect(codexOAuth.startCodexDeviceConnect).not.toHaveBeenCalled()
      expect(codexOAuth.revokeCodexSubscription).not.toHaveBeenCalled()
    })

    it('never routes a keyed Grok device start through the Codex service', async () => {
      grokOAuth.startGrokDeviceConnect.mockResolvedValue({
        userCode: 'GROK-CODE',
        verificationUri: 'https://accounts.x.ai/device',
        verificationUriComplete: null,
        intervalSeconds: 5,
        expiresAt: new Date('2026-09-17T12:00:00.000Z'),
        state: 'state-1',
        intent: 'connect',
      })
      const res = await request(makeApp())
        .post(`${GROK}/connections/team-grok/device/start`)
        .send({ intent: 'reconnect' })
      expect(res.status).toBe(200)
      expect(res.body.userCode).toBe('GROK-CODE')
      expect(grokOAuth.startGrokDeviceConnect).toHaveBeenCalledWith(
        expect.objectContaining({ connectionKey: 'team-grok', enabled: true }),
        'reconnect'
      )
      expect(codexOAuth.startCodexDeviceConnect).not.toHaveBeenCalled()
      assertNoLeak(res.body)
    })
  })

  describe('error to HTTP mapping', () => {
    const oauthCodes: Array<[GrokOAuthErrorCode, number]> = [
      ['disabled', 404],
      ['not_connected', 404],
      ['no_grant', 404],
      ['replacement_required', 409],
      ['fingerprint_in_use', 409],
      ['connection_mismatch', 409],
      ['refresh_in_flight', 409],
      ['stale_revision', 409],
      ['state_replayed', 400],
      ['state_expired', 400],
      ['state_cancelled', 400],
      ['provider_unavailable', 400],
      ['invalid_callback', 400],
      ['reauth_required', 400],
    ]

    it.each(oauthCodes)('maps GrokSubscriptionOAuthError %s to %i', async (code, status) => {
      grokOAuth.startGrokDeviceConnect.mockRejectedValue(
        new GrokSubscriptionOAuthError(code, 'raw upstream detail refresh-secret')
      )
      const res = await request(makeApp())
        .post(`${GROK}/connections/team-grok/device/start`)
        .send({ intent: 'connect' })
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      assertNoLeak(res.body)
    })

    it.each([
      [new GrokSubscriptionConnectionKeyConflictError(), 409, 'connection_key_taken'],
      [new GrokSubscriptionFingerprintConflictError(), 409, 'fingerprint_in_use'],
      [new GrokSubscriptionStaleRevisionError(), 409, 'stale_revision'],
      [new GrokSubscriptionInvalidConnectionKeyError('Bad Key'), 400, 'invalid_connection_key'],
    ] as const)('maps connection-layer %s without a 500', async (err, status, error) => {
      grokOAuth.pollGrokDevice.mockRejectedValue(err)
      const res = await request(makeApp()).get(`${GROK}/connections/team-grok/device/poll?state=s`)
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error })
    })

    it('maps a connection key conflict on create to 409 connection_key_taken', async () => {
      routeSql([
        [
          'INSERT INTO grok_subscription_connections',
          () => {
            throw Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint: 'grok_subscription_connections_key_unique',
            })
          },
        ],
      ])
      const res = await request(makeApp())
        .post(`${GROK}/connections`)
        .send({ connectionKey: 'revoked-grok', displayName: 'Again' })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'connection_key_taken' })
    })

    it('rejects a malformed or reserved key before any service call', async () => {
      for (const key of ['Bad%20Key', 'unassigned', 'deployment-default']) {
        const res = await request(makeApp())
          .post(`${GROK}/connections/${key}/device/start`)
          .send({ intent: 'connect' })
        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'invalid_connection_key' })
      }
      expect(pool.query).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('device flow on a revoked key', () => {
    function revokedTombstone() {
      routeSql([
        [
          'FROM grok_subscription_connections',
          () => ({
            rows: [
              grokRow('team-grok', {
                status: 'revoked',
                revoked_at: new Date('2026-09-10T00:00:00.000Z'),
              }),
            ],
            rowCount: 1,
          }),
        ],
      ])
    }

    it('refuses to start a device flow on a revoked key without calling xAI', async () => {
      revokedTombstone()
      const res = await request(makeApp())
        .post(`${GROK}/connections/team-grok/device/start`)
        .send({ intent: 'reconnect' })
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'not_connected' })
      expect(fetchSpy).not.toHaveBeenCalled()
      const writes = vi
        .mocked(pool.query)
        .mock.calls.filter(([sql]) => /INSERT|UPDATE/.test(String(sql)))
      expect(writes).toEqual([])
    })

    it('refuses to poll a device flow on a revoked key without calling xAI', async () => {
      revokedTombstone()
      const materialize = vi.fn(async () => {})
      const res = await request(makeApp(makeGateway(materialize))).get(
        `${GROK}/connections/team-grok/device/poll?state=pending-state`
      )
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'not_connected' })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(grokOAuth.runGrokCatalogSync).not.toHaveBeenCalled()
      expect(materialize).not.toHaveBeenCalled()
    })
  })

  describe('device poll', () => {
    it('syncs the catalog and publishes the allowlist once connected', async () => {
      const materialize = vi.fn(async () => {})
      grokOAuth.pollGrokDevice.mockResolvedValue({
        status: 'connected',
        connection: safeConnection('team-grok', { catalogStatus: 'never_synced' }),
      })
      grokOAuth.runGrokCatalogSync.mockResolvedValue({
        ok: true,
        catalogStatus: 'ready',
        connection: safeConnection('team-grok'),
      })
      grokOAuth.getGrokSubscriptionConnection.mockResolvedValue(
        safeConnection('team-grok', { catalogRevision: 2 })
      )
      const res = await request(makeApp(makeGateway(materialize))).get(
        `${GROK}/connections/team-grok/device/poll?state=s`
      )
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('connected')
      expect(res.body.connection.catalogRevision).toBe(2)
      expect(grokOAuth.runGrokCatalogSync).toHaveBeenCalledWith(
        expect.objectContaining({ connectionKey: 'team-grok' }),
        'team-grok',
        expect.anything()
      )
      expect(materialize).toHaveBeenCalledTimes(1)
      assertNoLeak(res.body)
    })

    it('overlays the failed catalog status and still publishes after connect', async () => {
      const materialize = vi.fn(async () => {})
      grokOAuth.pollGrokDevice.mockResolvedValue({
        status: 'connected',
        connection: safeConnection('team-grok', { catalogStatus: 'never_synced' }),
      })
      grokOAuth.runGrokCatalogSync.mockResolvedValue({
        ok: false,
        catalogStatus: 'unavailable',
      })
      const res = await request(makeApp(makeGateway(materialize))).get(
        `${GROK}/connections/team-grok/device/poll?state=s`
      )
      expect(res.status).toBe(200)
      expect(res.body.connection.catalogStatus).toBe('unavailable')
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    it('returns 503 when a connected poll cannot publish the allowlist', async () => {
      grokOAuth.pollGrokDevice.mockResolvedValue({
        status: 'connected',
        connection: safeConnection('team-grok'),
      })
      grokOAuth.runGrokCatalogSync.mockResolvedValue({ ok: false, catalogStatus: 'unavailable' })
      const res = await request(
        makeApp(
          makeGateway(async () => {
            throw new Error('apiserver down')
          })
        )
      ).get(`${GROK}/connections/team-grok/device/poll?state=s`)
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('configmap_write_failed')
    })

    it('neither syncs nor publishes while pending or slow_down', async () => {
      const materialize = vi.fn(async () => {})
      for (const status of ['pending', 'slow_down'] as const) {
        grokOAuth.pollGrokDevice.mockResolvedValueOnce({
          status,
          intervalSeconds: 10,
          state: { intent: 'connect' },
        })
        const res = await request(makeApp(makeGateway(materialize))).get(
          `${GROK}/connections/team-grok/device/poll?state=s`
        )
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ status, intervalSeconds: 10 })
      }
      expect(grokOAuth.runGrokCatalogSync).not.toHaveBeenCalled()
      expect(materialize).not.toHaveBeenCalled()
    })
  })

  describe('refresh and keyed revoke', () => {
    it('refreshes the keyed grant and publishes the allowlist', async () => {
      const materialize = vi.fn(async () => {})
      grokOAuth.refreshGrokSubscriptionConnection.mockResolvedValue(
        safeConnection('team-grok', { credentialRevision: 3 })
      )
      const res = await request(makeApp(makeGateway(materialize))).post(
        `${GROK}/connections/team-grok/refresh`
      )
      expect(res.status).toBe(200)
      expect(res.body.credentialRevision).toBe(3)
      expect(grokOAuth.refreshGrokSubscriptionConnection).toHaveBeenCalledWith(
        expect.objectContaining({ connectionKey: 'team-grok' })
      )
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    it('does not publish when refresh is rejected', async () => {
      const materialize = vi.fn(async () => {})
      grokOAuth.refreshGrokSubscriptionConnection.mockRejectedValue(
        new GrokSubscriptionOAuthError('reauth_required', 'refresh token was rejected')
      )
      const res = await request(makeApp(makeGateway(materialize))).post(
        `${GROK}/connections/team-grok/refresh`
      )
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'reauth_required' })
      expect(materialize).not.toHaveBeenCalled()
    })

    it('revokes only the addressed key, reports Grok Hosts, and publishes', async () => {
      const materialize = vi.fn(async () => {})
      const gateway = makeGateway(materialize)
      gateway.listResource.mockResolvedValue([
        {
          metadata: { name: 'grok-host' },
          spec: { model: { provider: 'grok-subscription', connectionRef: 'team-grok' } },
        },
        {
          metadata: { name: 'codex-host' },
          spec: { model: { provider: 'codex-subscription', connectionRef: 'team-grok' } },
        },
      ])
      grokOAuth.revokeGrokSubscription.mockResolvedValue(
        safeConnection('team-grok', { status: 'revoked', revokedAt: new Date() })
      )
      const res = await request(makeApp(gateway)).post(`${GROK}/connections/team-grok/revoke`)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('revoked')
      expect(res.body.assignedHosts).toEqual([{ name: 'grok-host' }])
      expect(grokOAuth.revokeGrokSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ connectionKey: 'team-grok' })
      )
      expect(codexOAuth.revokeCodexSubscription).not.toHaveBeenCalled()
      expect(gateway.updateResource).not.toHaveBeenCalled()
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    it('returns 503 when revoke cannot publish the allowlist', async () => {
      grokOAuth.revokeGrokSubscription.mockResolvedValue(
        safeConnection('team-grok', { status: 'revoked' })
      )
      const res = await request(
        makeApp(
          makeGateway(async () => {
            throw new Error('apiserver down')
          })
        )
      ).post(`${GROK}/connections/team-grok/revoke`)
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('configmap_write_failed')
    })
  })

  describe('catalog sync', () => {
    it('publishes after a ready sync', async () => {
      const materialize = vi.fn(async () => {})
      grokOAuth.runGrokCatalogSync.mockResolvedValue({
        ok: true,
        catalogStatus: 'ready',
        connection: safeConnection('team-grok'),
      })
      const res = await request(makeApp(makeGateway(materialize))).post(
        `${GROK}/connections/team-grok/catalog/sync`
      )
      expect(res.status).toBe(200)
      expect(res.body.outcome).toBe('ready')
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    // `catalogStatus: 'never_synced'` WITHOUT `persisted` is the service's own
    // signal that nothing at all was written for the connection: no grant, a
    // lost revision fence, a held refresh lock, an OAuth error raised before
    // anything touched the row. There is no new state for the ConfigMap to
    // carry, so the endpoint must not write one. `never_synced` on its own does
    // NOT mean this — see the persisted case below.
    it.each([
      [{ reason: 'no_grant' }, 404, { error: 'no_grant' }],
      [{ reason: 'disabled' }, 404, { error: 'disabled' }],
      [{ reason: 'stale_revision' }, 409, { error: 'stale_revision' }],
      [{ reason: 'refresh_in_flight' }, 409, { error: 'refresh_in_flight' }],
      [{ reason: 'reauth_required' }, 400, { error: 'reauth_required' }],
      [{ reason: 'provider_unavailable' }, 400, { error: 'provider_unavailable' }],
    ])(
      'maps a sync that recorded nothing %j to %i without publishing',
      async (failure, status, body) => {
        const materialize = vi.fn(async () => {})
        grokOAuth.runGrokCatalogSync.mockResolvedValue({
          ok: false,
          catalogStatus: 'never_synced',
          ...failure,
        })
        const res = await request(makeApp(makeGateway(materialize))).post(
          `${GROK}/connections/team-grok/catalog/sync`
        )
        expect(res.status).toBe(status)
        expect(res.body).toEqual(body)
        // Liveness witness: the sync really ran and really failed with this
        // reason, so the absent publish is the rule and not an unreached path.
        expect(grokOAuth.runGrokCatalogSync).toHaveBeenCalledTimes(1)
        expect(materialize).not.toHaveBeenCalled()
      }
    )

    // The write landed and the sync still reports `never_synced`.
    // `markGrokRefreshSubjectMismatch` sets `status = 'reauth_required'` and
    // THEN throws, so the catalog was never synced while the CONNECTION row
    // changed. `llmAllowedModelsConfigMap` maps that status into the ConfigMap,
    // so the publish is owed before the 400 — and it is owed HERE, because no
    // later reconciliation repairs it: the cron skips a row that is no longer
    // `connected`.
    it('publishes a persisted status before the error response', async () => {
      const materialize = vi.fn(async () => {})
      grokOAuth.runGrokCatalogSync.mockResolvedValue({
        ok: false,
        catalogStatus: 'never_synced',
        reason: 'reauth_required',
        persisted: true,
      })
      const res = await request(makeApp(makeGateway(materialize))).post(
        `${GROK}/connections/team-grok/catalog/sync`
      )
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'reauth_required' })
      // Liveness witness: the sync ran and failed with this reason, so the
      // publish below is the rule under test and not an unreached path.
      expect(grokOAuth.runGrokCatalogSync).toHaveBeenCalledTimes(1)
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    // A non-ready catalogStatus means the OPPOSITE: the sync reached xAI, the
    // answer was refused or unavailable, and the connection row now carries
    // that outcome. mcp-host and HCC never read Postgres, so withholding the
    // publish leaves the runtime serving a grant the control plane already
    // knows is broken. The Codex branch of this same handler publishes before
    // its 503 for exactly this reason.
    it.each([
      [
        { reason: 'catalog_sync_failed', catalogStatus: 'unavailable' },
        { error: 'catalog_sync_failed', outcome: 'unavailable' },
      ],
      [
        { catalogStatus: 'auth-rejected' },
        { error: 'catalog_sync_failed', outcome: 'auth-rejected' },
      ],
    ])('publishes the recorded non-ready outcome %j and answers 503', async (failure, body) => {
      const materialize = vi.fn(async () => {})
      grokOAuth.runGrokCatalogSync.mockResolvedValue({ ok: false, ...failure })
      const res = await request(makeApp(makeGateway(materialize))).post(
        `${GROK}/connections/team-grok/catalog/sync`
      )
      expect(res.status).toBe(503)
      expect(res.body).toEqual(body)
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    it('answers 503 configmap_write_failed when the recorded outcome cannot be published', async () => {
      grokOAuth.runGrokCatalogSync.mockResolvedValue({
        ok: false,
        catalogStatus: 'auth-rejected',
      })
      const res = await request(
        makeApp(
          makeGateway(async () => {
            throw new Error('apiserver down')
          })
        )
      ).post(`${GROK}/connections/team-grok/catalog/sync`)
      expect(res.status).toBe(503)
      // The ConfigMap failure wins over the catalog outcome: the operator must
      // know the runtime snapshot is stale, which is the actionable half.
      expect(res.body.error).toBe('configmap_write_failed')
    })
  })

  describe('connections list and read', () => {
    it('omits archived ~revoked~ tombstones but keeps the terminal tombstone marked revoked', async () => {
      routeSql([
        [
          'FROM grok_subscription_connections',
          () => ({
            rows: [
              grokRow('team-grok'),
              grokRow('old-grok', {
                status: 'revoked',
                revoked_at: new Date('2026-09-10T00:00:00.000Z'),
              }),
              grokRow('old-grok~revoked~99999999-9999-4999-8999-999999999999', {
                id: '99999999-9999-4999-8999-999999999999',
                status: 'revoked',
                revoked_at: new Date('2026-09-09T00:00:00.000Z'),
              }),
            ],
            rowCount: 3,
          }),
        ],
      ])
      const gateway = makeGateway()
      const res = await request(makeApp(gateway)).get(`${GROK}/connections`)
      expect(res.status).toBe(200)
      const keys = res.body.connections.map((row: { connectionKey: string }) => row.connectionKey)
      expect(keys).toEqual(['team-grok', 'old-grok'])
      expect(JSON.stringify(res.body)).not.toContain('~revoked~')
      expect(res.body.connections[1]).toMatchObject({ status: 'revoked' })
      expect(res.body.connections[1].revokedAt).toBeTruthy()
    })

    it('refuses to address an archived tombstone key directly', async () => {
      const res = await request(makeApp()).get(
        `${GROK}/connections/${encodeURIComponent('old-grok~revoked~99999999-9999-4999-8999-999999999999')}`
      )
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_connection_key' })
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('lists catalog models for a live grant and 409s for a disconnected key', async () => {
      grokCatalog.listGrokCatalogModels.mockResolvedValue([
        { model: 'grok-4.6', enabled: true, stale: false },
      ])
      grokOAuth.getGrokSubscriptionConnection.mockResolvedValueOnce(safeConnection('team-grok'))
      const listed = await request(makeApp()).get(`${GROK}/connections/team-grok/models`)
      expect(listed.status).toBe(200)
      expect(listed.body.models).toEqual([{ model: 'grok-4.6', enabled: true, stale: false }])
      expect(grokCatalog.listGrokCatalogModels).toHaveBeenCalledWith(
        expect.anything(),
        'id-team-grok'
      )

      grokOAuth.getGrokSubscriptionConnection.mockResolvedValueOnce({
        connectionKey: 'team-grok',
        status: 'disconnected',
      })
      const missing = await request(makeApp()).get(`${GROK}/connections/team-grok/models`)
      expect(missing.status).toBe(409)
      expect(missing.body).toEqual({ error: 'not_connected' })
    })
  })

  describe('model toggle', () => {
    it('toggles a model on a live grant and publishes the allowlist', async () => {
      const materialize = vi.fn(async () => {})
      routeSql([['FROM grok_subscription_connections', () => ({ rows: [grokRow('team-grok')] })]])
      grokCatalog.setGrokCatalogModelEnabled.mockResolvedValue([
        { model: 'grok-4.6', enabled: false, stale: false },
      ])
      const res = await request(makeApp(makeGateway(materialize)))
        .patch(`${GROK}/connections/team-grok/models/grok-4.6`)
        .send({ enabled: false })
      expect(res.status).toBe(200)
      expect(res.body.models).toEqual([{ model: 'grok-4.6', enabled: false, stale: false }])
      expect(grokCatalog.setGrokCatalogModelEnabled).toHaveBeenCalledWith(
        expect.anything(),
        'id-team-grok',
        'grok-4.6',
        false
      )
      expect(materialize).toHaveBeenCalledTimes(1)
    })

    it('returns 404 no_grant for a revoked grant without touching the catalog', async () => {
      // Live-only getter: a revoked key has no row.
      routeSql([])
      const materialize = vi.fn(async () => {})
      const res = await request(makeApp(makeGateway(materialize)))
        .patch(`${GROK}/connections/team-grok/models/grok-4.6`)
        .send({ enabled: true })
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'no_grant' })
      expect(grokCatalog.setGrokCatalogModelEnabled).not.toHaveBeenCalled()
      expect(materialize).not.toHaveBeenCalled()
    })

    it('rejects a non-boolean enabled and an unknown model', async () => {
      const bad = await request(makeApp())
        .patch(`${GROK}/connections/team-grok/models/grok-4.6`)
        .send({ enabled: 'yes' })
      expect(bad.status).toBe(400)
      expect(bad.body).toEqual({ error: 'invalid_enabled' })

      routeSql([['FROM grok_subscription_connections', () => ({ rows: [grokRow('team-grok')] })]])
      grokCatalog.setGrokCatalogModelEnabled.mockResolvedValue(null)
      const unknown = await request(makeApp())
        .patch(`${GROK}/connections/team-grok/models/grok-9`)
        .send({ enabled: true })
      expect(unknown.status).toBe(404)
      expect(unknown.body).toEqual({ error: 'model_not_found' })
    })
  })

  describe('metadata PATCH', () => {
    it('updates displayName and an offered defaultModel', async () => {
      grokCatalog.listOfferedGrokModelsForAssignment.mockResolvedValue([
        'grok-4.6',
        'grok-4.6-mini',
      ])
      routeSql([
        [
          'UPDATE grok_subscription_connections',
          () => ({
            rows: [grokRow('team-grok', { display_name: 'Team', default_model: 'grok-4.6-mini' })],
          }),
        ],
      ])
      const res = await request(makeApp())
        .patch(`${GROK}/connections/team-grok`)
        .send({ displayName: 'Team', defaultModel: 'grok-4.6-mini' })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ displayName: 'Team', defaultModel: 'grok-4.6-mini' })
      expect(grokCatalog.listOfferedGrokModelsForAssignment).toHaveBeenCalledWith(
        expect.anything(),
        'team-grok'
      )
    })

    it.each([
      [{}, 400, { error: 'empty_patch' }],
      [{ displayName: 'x'.repeat(65) }, 400, { error: 'display_name_too_long' }],
      [{ defaultModel: 'grok-9' }, 422, { error: 'default_model_not_offered' }],
    ])('rejects %j with %i', async (patch, status, body) => {
      grokCatalog.listOfferedGrokModelsForAssignment.mockResolvedValue(['grok-4.6'])
      const res = await request(makeApp()).patch(`${GROK}/connections/team-grok`).send(patch)
      expect(res.status).toBe(status)
      expect(res.body).toEqual(body)
      const writes = vi
        .mocked(pool.query)
        .mock.calls.filter(([sql]) => String(sql).includes('UPDATE'))
      expect(writes).toEqual([])
    })

    it('returns 404 no_grant for a revoked tombstone', async () => {
      routeSql([])
      const res = await request(makeApp())
        .patch(`${GROK}/connections/team-grok`)
        .send({ displayName: 'Tomb' })
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'no_grant' })
    })
  })

  describe('bind and unbind', () => {
    it('binds an unassigned Grok host with the grant default model', async () => {
      const gateway = makeGateway()
      gateway.getResource.mockResolvedValue({
        metadata: { name: 'chat', resourceVersion: '7' },
        spec: { model: { provider: 'grok-subscription', connectionRef: 'unassigned' } },
      })
      grokCatalog.listOfferedGrokModelsForAssignment.mockResolvedValue([
        'grok-4.6',
        'grok-4.6-mini',
      ])
      routeSql([
        [
          'FROM grok_subscription_connections',
          () => ({ rows: [grokRow('team-grok', { default_model: 'grok-4.6-mini' })] }),
        ],
      ])
      const res = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/bind`
      )
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ host: 'chat', connectionRef: 'team-grok', model: 'grok-4.6-mini' })
      expect(gateway.updateResource).toHaveBeenCalledWith(
        'hosts',
        'chat',
        {
          metadata: { resourceVersion: '7' },
          spec: {
            model: {
              provider: 'grok-subscription',
              connectionRef: 'team-grok',
              name: 'grok-4.6-mini',
            },
          },
        },
        expect.any(String)
      )
    })

    it('converts a Codex host to Grok on bind', async () => {
      const gateway = makeGateway()
      gateway.getResource.mockResolvedValue({
        metadata: { name: 'chat' },
        spec: {
          model: { provider: 'codex-subscription', connectionRef: 'team-plus', name: 'gpt-5.1' },
        },
      })
      grokCatalog.listOfferedGrokModelsForAssignment.mockResolvedValue(['grok-4.6'])
      routeSql([['FROM grok_subscription_connections', () => ({ rows: [grokRow('team-grok')] })]])
      const res = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/bind`
      )
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ host: 'chat', connectionRef: 'team-grok', model: 'grok-4.6' })
      const written = gateway.updateResource.mock.calls[0]?.[2] as {
        spec: { model: Record<string, unknown> }
      }
      expect(written.spec.model).toEqual({
        provider: 'grok-subscription',
        connectionRef: 'team-grok',
        name: 'grok-4.6',
      })
    })

    it('refuses to bind a grant whose catalog offers no models', async () => {
      const gateway = makeGateway()
      gateway.getResource.mockResolvedValue({
        metadata: { name: 'chat' },
        spec: { model: { provider: 'grok-subscription', connectionRef: 'unassigned' } },
      })
      grokCatalog.listOfferedGrokModelsForAssignment.mockResolvedValue([])
      const res = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/bind`
      )
      expect(res.status).toBe(422)
      expect(res.body.error).toBe('catalog_not_ready')
      expect(gateway.updateResource).not.toHaveBeenCalled()
    })

    it('maps a Host write conflict to 409 resource_changed', async () => {
      const gateway = makeGateway()
      gateway.getResource.mockResolvedValue({
        metadata: { name: 'chat' },
        spec: { model: { provider: 'grok-subscription', connectionRef: 'unassigned' } },
      })
      gateway.updateResource.mockRejectedValue(new K8sConflictError('changed'))
      grokCatalog.listOfferedGrokModelsForAssignment.mockResolvedValue(['grok-4.6'])
      routeSql([['FROM grok_subscription_connections', () => ({ rows: [grokRow('team-grok')] })]])
      const res = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/bind`
      )
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'conflict', reason: 'resource_changed' })
    })

    it('unbinds a Grok host to unassigned without revoking', async () => {
      const gateway = makeGateway()
      gateway.getResource.mockResolvedValue({
        metadata: { name: 'chat' },
        spec: {
          model: { provider: 'grok-subscription', connectionRef: 'team-grok', name: 'grok-4.6' },
        },
      })
      const res = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/unbind`
      )
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ host: 'chat', connectionRef: 'unassigned', model: 'grok-4.6' })
      expect(grokOAuth.revokeGrokSubscription).not.toHaveBeenCalled()
      const written = gateway.updateResource.mock.calls[0]?.[2] as {
        spec: { model: Record<string, unknown> }
      }
      expect(written.spec.model).toMatchObject({
        provider: 'grok-subscription',
        connectionRef: 'unassigned',
      })
    })

    it.each([
      [
        'a Codex host bound to the same key',
        { provider: 'codex-subscription', connectionRef: 'team-grok' },
        409,
        { error: 'not_grok_host' },
      ],
      [
        'a static-provider host',
        { provider: 'openai', name: 'gpt-5.4' },
        409,
        { error: 'not_grok_host' },
      ],
      [
        'a Grok host bound to another grant',
        { provider: 'grok-subscription', connectionRef: 'other-grok' },
        409,
        { error: 'connection_mismatch' },
      ],
    ])('refuses to unbind %s', async (_label, model, status, body) => {
      const gateway = makeGateway()
      gateway.getResource.mockResolvedValue({ metadata: { name: 'chat' }, spec: { model } })
      const res = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/unbind`
      )
      expect(res.status).toBe(status)
      expect(res.body).toEqual(body)
      expect(gateway.updateResource).not.toHaveBeenCalled()
    })

    it('maps a missing Host to 404 and an invalid key to 400', async () => {
      const gateway = makeGateway()
      gateway.getResource.mockRejectedValue(Object.assign(new Error('gone'), { httpStatus: 404 }))
      const missing = await request(makeApp(gateway)).post(
        `${GROK}/connections/team-grok/hosts/chat/bind`
      )
      expect(missing.status).toBe(404)
      expect(missing.body).toEqual({ error: 'host_not_found' })

      const invalid = await request(makeApp(gateway)).post(
        `${GROK}/connections/unassigned/hosts/chat/bind`
      )
      expect(invalid.status).toBe(400)
      expect(invalid.body).toEqual({ error: 'invalid_connection_key' })
    })
  })
})

/**
 * T1 for the subscription catalog reconciliation cron.
 *
 * The unit suite proves the tick's decision table against doubles. This one
 * proves the half the doubles cannot: that a tick driven through the real
 * broker port lands rows in `grok_catalog_models`, rebuilds the
 * `grok-subscription` union in `llm_allowed_models`, stale-flags a model that
 * vanished upstream, and stays idempotent across identical ticks.
 *
 * Everything below the xAI network boundary is real — OAuth refresh-token
 * rotation, secret encryption, the revision-fenced outcome write, the
 * transaction and the union rebuild. Only two things are doubled, and both are
 * systems outside this process: xAI's HTTP endpoints (`GrokCatalogTransport`
 * for the models call, `fetchFn` for the token call) and the Kubernetes
 * ConfigMap writer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type GrokCatalogTransport,
  type GrokTransactionRunner,
} from '../src/services/grokSubscriptionCatalog.js'
import {
  createNamedGrokSubscriptionConnection,
  getSafeGrokSubscriptionConnection,
  listLiveGrokSubscriptionConnections,
} from '../src/services/grokSubscriptionConnection.js'
import {
  GROK_OAUTH_DEVICE_URL,
  GROK_OAUTH_REVOKE_URL,
  GROK_OAUTH_TOKEN_URL,
  type GrokOAuthDeps,
  pollGrokDevice,
  runGrokCatalogSync,
  startGrokDeviceConnect,
} from '../src/services/grokSubscriptionOAuth.js'
import type { AllowedModelsConfigMapMaterializer } from '../src/services/llmAllowedModelsConfigMap.js'
import {
  type SubscriptionBrokerPort,
  filterAddressableGrokConnections,
  reconcileSubscriptionCatalogs,
} from '../src/services/subscriptionCatalogSyncCron.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function idTokenFor(subject: string): string {
  return `hdr.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.sig`
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/**
 * The xAI account behind every exchange in this suite. One subject for the
 * device grant and for every later refresh, because they are one account: the
 * refresh recomputes the fingerprint and compares it with the one the grant
 * stored, so a subject that varied per exchange would read as an account swap
 * and flip the connection to `reauth_required` before the catalog is touched.
 */
const GRANT_SUBJECT = 'subject-cron-grok'

/**
 * Simulated xAI device-authorization provider. The cron's tick finds an
 * access token past its expiry and rotates the refresh token through this
 * before it may read the catalog, so the rotation path is exercised, not
 * bypassed.
 */
function simulatedGrokProvider(): typeof fetch {
  let issued = 0
  return (async (url: string | URL) => {
    const target = String(url)
    if (target === GROK_OAUTH_DEVICE_URL) {
      issued += 1
      return jsonResponse(200, {
        device_code: `device-code-${issued}-${randomBytes(4).toString('hex')}`,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/activate',
        expires_in: 900,
        interval: 5,
      })
    }
    if (target === GROK_OAUTH_TOKEN_URL) {
      return jsonResponse(200, {
        access_token: `access-${randomBytes(4).toString('hex')}`,
        refresh_token: `refresh-${randomBytes(4).toString('hex')}`,
        expires_in: 3600,
        id_token: idTokenFor(GRANT_SUBJECT),
      })
    }
    if (target === GROK_OAUTH_REVOKE_URL) return jsonResponse(200, {})
    return jsonResponse(404, {})
  }) as typeof fetch
}

function readyTransport(models: Array<{ model: string; contextWindowTokens?: number }>): {
  transport: GrokCatalogTransport
  calls: number[]
} {
  const calls: number[] = []
  return {
    calls,
    transport: {
      listModels: async () => {
        calls.push(models.length)
        return { outcome: 'ready', models }
      },
    },
  }
}

type AllowedModelRow = {
  model: string
  enabled: boolean
  stale: boolean
  source: string
  vendor: string | null
  context_window_tokens: number | null
}

describeRealPostgres('Subscription catalog sync cron on real PostgreSQL', () => {
  const database = `subscription_catalog_cron_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? `postgresql://postgres@${['127', '0', '0', '1'].join('.')}/postgres`,
    database
  )
  let adminPool: Pool
  let pool: Pool

  const poolTransaction: GrokTransactionRunner = async work => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  function oauthDeps(connectionKey: string, db: DbClient = pool): GrokOAuthDeps {
    return {
      db,
      encryptionKey: KEY,
      fetchFn: simulatedGrokProvider(),
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
      enabled: true,
      connectionKey,
      withTransaction: poolTransaction,
    }
  }

  /**
   * The production Grok port, rebuilt over this suite's pool. Every collaborator
   * except the transport is the one `createSubscriptionBrokerPorts` wires.
   */
  function grokPort(
    transport: GrokCatalogTransport,
    syncedKeys: string[] = []
  ): SubscriptionBrokerPort {
    return {
      broker: 'grok-subscription',
      enabled: true,
      listConnections: async () =>
        filterAddressableGrokConnections(await listLiveGrokSubscriptionConnections(pool)),
      syncCatalog: key => {
        syncedKeys.push(key)
        return runGrokCatalogSync(oauthDeps(key), key, transport)
      },
    }
  }

  function recordingMaterializer(): {
    materializer: AllowedModelsConfigMapMaterializer
    calls: number[]
  } {
    const calls: number[] = []
    return {
      calls,
      materializer: {
        materialize: async () => {
          calls.push(Date.now())
        },
      },
    }
  }

  async function allowedModels(): Promise<AllowedModelRow[]> {
    const result = await pool.query<AllowedModelRow>(
      `SELECT model, enabled, stale, source, vendor, context_window_tokens
         FROM llm_allowed_models
        WHERE provider = 'grok-subscription'
        ORDER BY model ASC`
    )
    return result.rows
  }

  async function catalogModels(
    connectionId: string
  ): Promise<Array<{ model: string; stale: boolean; enabled: boolean }>> {
    const result = await pool.query<{ model: string; stale: boolean; enabled: boolean }>(
      `SELECT model, stale, enabled
         FROM grok_catalog_models
        WHERE connection_id = $1
        ORDER BY model ASC`,
      [connectionId]
    )
    return result.rows
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (adminPool) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
        .catch(() => undefined)
      await adminPool.end()
    }
  })

  it('a tick writes the broker catalog and rebuilds the grok-subscription allowlist', async () => {
    const key = 'cron-grok-primary'
    // The grant is created through the device flow the operator uses, not by
    // writing credential rows: that is what leaves a fingerprint the cron's
    // own refresh can match, and it is the state a real tick finds.
    const started = await startGrokDeviceConnect(oauthDeps(key), 'connect')
    const polled = await pollGrokDevice(oauthDeps(key), started.state)
    expect(polled.status).toBe('connected')
    const created = await getSafeGrokSubscriptionConnection(pool, key)
    expect(created).toMatchObject({ status: 'connected', catalogStatus: 'never_synced' })
    const { transport, calls } = readyTransport([
      { model: 'grok-4-fast-reasoning', contextWindowTokens: 2_000_000 },
      { model: 'grok-4' },
    ])
    const { materializer, calls: published } = recordingMaterializer()

    const result = await reconcileSubscriptionCatalogs({
      brokers: [grokPort(transport)],
      materializer,
    })

    expect(result).toEqual({
      synced: 1,
      degraded: 0,
      raced: 0,
      failed: 0,
      skipped: 0,
      published: 'published',
    })
    expect(calls).toEqual([2])
    expect(published).toHaveLength(1)
    expect(await catalogModels(created!.id)).toEqual([
      { model: 'grok-4', stale: false, enabled: true },
      { model: 'grok-4-fast-reasoning', stale: false, enabled: true },
    ])
    expect(await allowedModels()).toEqual([
      {
        model: 'grok-4',
        enabled: true,
        stale: false,
        source: 'discovery',
        vendor: 'xAI',
        context_window_tokens: null,
      },
      {
        model: 'grok-4-fast-reasoning',
        enabled: true,
        stale: false,
        source: 'discovery',
        vendor: 'xAI',
        context_window_tokens: 2_000_000,
      },
    ])
  })

  it('an identical second tick records a fresh outcome without duplicating rows', async () => {
    const key = 'cron-grok-primary'
    const before = await getSafeGrokSubscriptionConnection(pool, key)
    expect(before).toMatchObject({ catalogStatus: 'ready' })
    const { transport } = readyTransport([
      { model: 'grok-4-fast-reasoning', contextWindowTokens: 2_000_000 },
      { model: 'grok-4' },
    ])
    const { materializer } = recordingMaterializer()

    const result = await reconcileSubscriptionCatalogs({
      brokers: [grokPort(transport)],
      materializer,
    })

    expect(result).toMatchObject({ synced: 1, failed: 0, published: 'published' })
    // Liveness witness: the tick really re-ran the fenced write. Without it,
    // "the rows did not change" would also hold for a tick that did nothing.
    const after = await getSafeGrokSubscriptionConnection(pool, key)
    expect(after?.catalogRevision).toBe((before?.catalogRevision ?? 0) + 1)
    expect((await allowedModels()).map(row => row.model)).toEqual([
      'grok-4',
      'grok-4-fast-reasoning',
    ])
  })

  it('a model that vanished upstream is stale-flagged in the catalog and disabled in the union', async () => {
    const key = 'cron-grok-primary'
    const connection = await getSafeGrokSubscriptionConnection(pool, key)
    expect(connection).not.toBeNull()
    const { transport, calls } = readyTransport([{ model: 'grok-4' }])
    const { materializer } = recordingMaterializer()

    const result = await reconcileSubscriptionCatalogs({
      brokers: [grokPort(transport)],
      materializer,
    })

    expect(result).toMatchObject({ synced: 1, failed: 0 })
    expect(calls).toEqual([1])
    expect(await catalogModels(connection!.id)).toEqual([
      { model: 'grok-4', stale: false, enabled: true },
      { model: 'grok-4-fast-reasoning', stale: true, enabled: true },
    ])
    expect(await allowedModels()).toEqual([
      expect.objectContaining({ model: 'grok-4', enabled: true, stale: false }),
      expect.objectContaining({ model: 'grok-4-fast-reasoning', enabled: false, stale: true }),
    ])
  })

  it('a grant that is not connected is skipped and never reaches the broker', async () => {
    const idle = 'cron-grok-idle'
    await createNamedGrokSubscriptionConnection(pool, {
      connectionKey: idle,
      displayName: 'idle',
    })
    const { transport } = readyTransport([{ model: 'grok-4' }])
    const syncedKeys: string[] = []
    const { materializer } = recordingMaterializer()

    const result = await reconcileSubscriptionCatalogs({
      brokers: [grokPort(transport, syncedKeys)],
      materializer,
    })

    // The negative claim is `idle` never being synced. Its witness is the
    // connected grant in the same listing that WAS synced: a port that
    // returned nothing at all would satisfy the exclusion for free.
    expect(syncedKeys).toEqual(['cron-grok-primary'])
    expect(result).toMatchObject({ synced: 1, skipped: 1, failed: 0 })
    expect(await getSafeGrokSubscriptionConnection(pool, idle)).toMatchObject({
      status: 'disconnected',
      catalogStatus: 'never_synced',
    })
  })
})

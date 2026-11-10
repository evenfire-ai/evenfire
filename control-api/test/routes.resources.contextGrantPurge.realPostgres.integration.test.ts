/**
 * The admin Context routes purge the shared OAuth grants a write leaves
 * without an enabling Context: a PUT keeps only the servers of the allowlist
 * the apiserver PERSISTED, a DELETE and a POST keep none (a create means any
 * row under that name belongs to an earlier Context of the same name).
 *
 * The apiserver is the real producer of what the route inspects: the real
 * ResourceService over a `customApi` that behaves like an apiserver (404 on a
 * missing object, 409 on a duplicate create, optional pruning of
 * `spec.displayName` like an outdated CRD, optional normalization of the
 * allowlist). Grant rows are written by the store's own writers into a real
 * Postgres, and the route's pool is routed to that database.
 *
 *   CONTROL_API_REAL_PG_ADMIN_URL=postgres://<user>:<pass>@<host>:5432 npm test -- \
 *     test/routes.resources.contextGrantPurge.realPostgres.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { initDb } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { bootstrapSharedOAuthGrant, upsertOAuthGrant } from '../src/oauth/store.js'
import { adminResourcesLogger, createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { ResourceService } from '../src/services/resourceService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const testDb = vi.hoisted(() => ({
  pool: undefined as import('pg').Pool | undefined,
  failPurges: 0,
  purgeStatements: 0,
}))

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  const current = () => {
    if (!testDb.pool) throw new Error('test pool not initialised')
    return testDb.pool
  }
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => {
        if (/DELETE FROM oauth_grants[\s\S]*= ANY\(/.test(text)) {
          testDb.purgeStatements += 1
          if (testDb.failPurges > 0) {
            testDb.failPurges -= 1
            return Promise.reject(new Error('injected purge failure'))
          }
        }
        return current().query(text, values)
      },
      connect: () => current().connect(),
    },
    withTransaction: (work: Parameters<typeof actual.withTransaction>[0]) =>
      actual.withTransaction(work, current()),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const NS = config.mcpServersNamespace
const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const S1 = 'srv-one'
const S2 = 'srv-two'
const DROPPED = 'srv-normalized-away'

type Stored = Record<string, unknown> & {
  metadata: Record<string, unknown> & { name: string }
  spec: Record<string, unknown>
}

function k8sError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code, statusCode: code })
}

/**
 * The real ResourceService over an apiserver-like `customApi`. `pruneDisplayName`
 * models an outdated Context CRD; `dropServer` models an apiserver (or admission
 * webhook) that normalizes the allowlist it stores, so what persisted differs
 * from what the request carried.
 */
function apiserverGateway(opts: { pruneDisplayName?: boolean; dropServer?: string } = {}) {
  const ctxNs = config.contextsNamespace
  let rv = 0
  let uidSeq = 0
  const store = new Map<string, Stored>()
  const key = (namespace: string, name: string) => `${namespace}/${name}`
  const persist = (body: Stored): Stored => {
    const spec = { ...body.spec }
    if (opts.pruneDisplayName) delete spec.displayName
    if (opts.dropServer && Array.isArray(spec.mcpServers)) {
      spec.mcpServers = (spec.mcpServers as unknown[]).filter(s => s !== opts.dropServer)
    }
    return { ...body, spec }
  }
  const customApi = {
    getNamespacedCustomObject: vi.fn(
      async ({ namespace, name }: { namespace: string; name: string }) => {
        const obj = store.get(key(namespace, name))
        if (!obj) throw k8sError(`contexts "${name}" not found`, 404)
        return obj
      }
    ),
    replaceNamespacedCustomObject: vi.fn(
      async ({ namespace, name, body }: { namespace: string; name: string; body: Stored }) => {
        const existing = store.get(key(namespace, name))
        if (!existing) throw k8sError(`contexts "${name}" not found`, 404)
        const sentRv = (body.metadata as { resourceVersion?: string }).resourceVersion
        if (sentRv && sentRv !== existing.metadata.resourceVersion) {
          throw k8sError('the object has been modified', 409)
        }
        const stored = persist(body)
        stored.metadata = {
          ...stored.metadata,
          name,
          namespace,
          uid: existing.metadata.uid,
          resourceVersion: String(++rv),
        }
        store.set(key(namespace, name), stored)
        return stored
      }
    ),
    createNamespacedCustomObject: vi.fn(
      async ({ namespace, body }: { namespace: string; body: Stored }) => {
        const k = key(namespace, body.metadata.name)
        if (store.has(k)) throw k8sError(`contexts "${body.metadata.name}" already exists`, 409)
        const stored = persist(body)
        stored.metadata = {
          ...stored.metadata,
          namespace,
          uid: `uid-${++uidSeq}`,
          resourceVersion: String(++rv),
        }
        store.set(k, stored)
        return stored
      }
    ),
    deleteNamespacedCustomObject: vi.fn(
      async ({ namespace, name }: { namespace: string; name: string }) => {
        if (!store.delete(key(namespace, name))) throw k8sError(`contexts "${name}" not found`, 404)
        return { status: 'Success' }
      }
    ),
    listNamespacedCustomObject: vi.fn(async ({ namespace }: { namespace: string }) => ({
      items: [...store.entries()].filter(([k]) => k.startsWith(`${namespace}/`)).map(([, v]) => v),
    })),
  } as unknown as ConstructorParameters<typeof ResourceService>[0]
  const svc = new ResourceService(customApi, ctxNs, { contexts: ctxNs })
  const gateway = {
    getResource: svc.getResource.bind(svc),
    updateResource: svc.updateResource.bind(svc),
    createResource: svc.createResource.bind(svc),
    deleteResource: svc.deleteResource.bind(svc),
    listResource: svc.listResource.bind(svc),
    deleteSecret: vi.fn(),
    getSecret: vi.fn(),
  }
  return { gateway, store }
}

function makeApp(gateway: ReturnType<typeof apiserverGateway>['gateway']): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  app.use(clerumErrorHandler)
  return app
}

describeRealPostgres('admin Context routes purge orphaned shared grants (real Postgres)', () => {
  const database = `control_api_ctx_route_purge_${randomUUID().replace(/-/g, '')}`
  let adminPool: Pool
  let dbPool: Pool
  let db: DbClient
  const originalContextsNamespace = config.contextsNamespace

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => dbPool.connect() })
    db = { query: (text, values) => dbPool.query(text, values) }
    testDb.pool = dbPool
  })

  afterAll(async () => {
    try {
      testDb.pool = undefined
      if (dbPool) await endPoolAndWaitForClients(dbPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  beforeEach(async () => {
    await dbPool.query('DELETE FROM oauth_grants')
    testDb.failPurges = 0
    testDb.purgeStatements = 0
  })

  afterEach(() => {
    config.contextsNamespace = originalContextsNamespace
    vi.restoreAllMocks()
  })

  // ── rows, written by the store's own writers ───────────────────────────────

  async function seedShared(server: string, context: string, namespace = NS): Promise<void> {
    await bootstrapSharedOAuthGrant(db, KEY, {
      ownerKind: 'mcpserver',
      recipeNamespace: namespace,
      recipeName: server,
      contextId: context,
      oauthClientId: `${server}-client`,
      bootstrappedByUserId: randomUUID(),
      provider: 'google',
      accessToken: `AT-${server}-${context}`,
      crUid: `uid-${server}`,
    })
  }

  async function seedUserGrant(
    server: string,
    ownerKind: 'mcpserver' | 'recipe',
    namespace = NS
  ): Promise<void> {
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind,
      recipeNamespace: namespace,
      recipeName: server,
      userId: randomUUID(),
      oauthClientId: `${server}-client`,
      provider: 'google',
      accessToken: `AT-user-${server}`,
    })
  }

  async function grants(): Promise<string[]> {
    const res = await dbPool.query(
      `SELECT owner_kind, grant_kind, recipe_namespace, recipe_name, COALESCE(context_id, '-') AS ctx
         FROM oauth_grants`
    )
    return (
      res.rows as Array<{
        owner_kind: string
        grant_kind: string
        recipe_namespace: string
        recipe_name: string
        ctx: string
      }>
    )
      .map(r => `${r.owner_kind}/${r.grant_kind}/${r.recipe_namespace}/${r.recipe_name}/${r.ctx}`)
      .sort()
  }

  const shared = (server: string, context: string, namespace = NS) =>
    `mcpserver/shared/${namespace}/${server}/${context}`

  async function createContext(
    gateway: ReturnType<typeof apiserverGateway>['gateway'],
    name: string,
    servers: string[]
  ): Promise<void> {
    await gateway.createResource(
      'contexts',
      { metadata: { name }, spec: { contextId: name, mcpServers: servers } },
      config.contextsNamespace
    )
  }

  async function putAllowlist(
    app: express.Express,
    gateway: ReturnType<typeof apiserverGateway>['gateway'],
    name: string,
    servers: string[],
    extra: Record<string, unknown> = {}
  ) {
    const current = (await gateway.getResource('contexts', name, config.contextsNamespace)) as {
      metadata: { resourceVersion: string }
      spec: Record<string, unknown>
    }
    return request(app)
      .put(`/admin/contexts/${name}`)
      .send({
        metadata: { resourceVersion: current.metadata.resourceVersion },
        spec: { ...current.spec, mcpServers: servers, ...extra },
      })
  }

  // ── PUT ────────────────────────────────────────────────────────────────────

  it('PUT removes only the shared rows of that Context whose server left the persisted allowlist', async () => {
    const { gateway } = apiserverGateway()
    const app = makeApp(gateway)
    await createContext(gateway, 'c1', [S1, S2])
    await createContext(gateway, 'c2', [S2])
    await seedShared(S1, 'c1')
    await seedShared(S2, 'c1')
    await seedShared(S2, 'c2')
    await seedShared(S2, 'c1', 'other-ns')
    await seedUserGrant(S2, 'mcpserver')
    await seedUserGrant(S2, 'recipe')
    const before = await grants()

    const res = await putAllowlist(app, gateway, 'c1', [S1])

    expect(res.status, res.text).toBe(200)
    expect(await grants()).toEqual(before.filter(g => g !== shared(S2, 'c1')))
    expect(testDb.purgeStatements).toBe(1)
  })

  it('PUT keeps what the apiserver persisted, not what the request carried', async () => {
    const { gateway } = apiserverGateway({ dropServer: DROPPED })
    const app = makeApp(gateway)
    await createContext(gateway, 'c1', [S1])
    await seedShared(S1, 'c1')
    await seedShared(DROPPED, 'c1')

    const res = await putAllowlist(app, gateway, 'c1', [S1, DROPPED])

    expect(res.status, res.text).toBe(200)
    expect(res.body.spec.mcpServers).toEqual([S1])
    expect(await grants()).toEqual([shared(S1, 'c1')])
  })

  it('PUT whose displayName the apiserver pruned answers 409 and has already purged', async () => {
    const { gateway } = apiserverGateway({ pruneDisplayName: true })
    const app = makeApp(gateway)
    await createContext(gateway, 'c1', [S1, S2])
    await seedShared(S2, 'c1')

    const res = await putAllowlist(app, gateway, 'c1', [S1], { displayName: 'Sales' })

    expect(res.status, res.text).toBe(409)
    expect(res.body.code).toBe('context_crd_outdated')
    expect(await grants()).toEqual([])
  })

  it('PUT that the apiserver refuses (stale resourceVersion) purges nothing', async () => {
    const { gateway } = apiserverGateway()
    const app = makeApp(gateway)
    await createContext(gateway, 'c1', [S1, S2])
    await seedShared(S2, 'c1')

    const res = await request(app)
      .put('/admin/contexts/c1')
      .send({ metadata: { resourceVersion: 'stale' }, spec: { contextId: 'c1', mcpServers: [] } })

    expect(res.status).toBe(409)
    expect(await grants()).toEqual([shared(S2, 'c1')])
    expect(testDb.purgeStatements).toBe(0)
  })

  // ── DELETE ─────────────────────────────────────────────────────────────────

  it('DELETE removes every shared row of that Context and nothing else', async () => {
    const { gateway } = apiserverGateway()
    const app = makeApp(gateway)
    await createContext(gateway, 'c1', [S1, S2])
    await createContext(gateway, 'c2', [S1])
    await seedShared(S1, 'c1')
    await seedShared(S2, 'c1')
    await seedShared(S1, 'c2')
    await seedUserGrant(S1, 'mcpserver')

    const res = await request(app).delete('/admin/contexts/c1')

    expect(res.status, res.text).toBe(200)
    expect(await grants()).toEqual([shared(S1, 'c2'), `mcpserver/user/${NS}/${S1}/-`].sort())
    expect(testDb.purgeStatements).toBe(1)
  })

  it('DELETE of a Context that is already gone answers 404 and runs no purge', async () => {
    const { gateway } = apiserverGateway()
    const app = makeApp(gateway)
    await seedShared(S1, 'c1')

    const res = await request(app).delete('/admin/contexts/c1')

    expect(res.status).toBe(404)
    expect(await grants()).toEqual([shared(S1, 'c1')])
    expect(testDb.purgeStatements).toBe(0)
  })

  // ── POST ───────────────────────────────────────────────────────────────────

  it('POST removes the rows left by an earlier Context of the same name, even for servers it enables', async () => {
    const { gateway } = apiserverGateway()
    const app = makeApp(gateway)
    await seedShared(S1, 'c1')
    await seedShared(S1, 'c2')

    const res = await request(app)
      .post('/admin/contexts')
      .send({ metadata: { name: 'c1' }, spec: { contextId: 'c1', mcpServers: [S1] } })

    expect(res.status, res.text).toBe(201)
    expect(await grants()).toEqual([shared(S1, 'c2')])
    expect(testDb.purgeStatements).toBe(1)
  })

  it('POST whose displayName the apiserver pruned answers 409 and has already purged', async () => {
    const { gateway, store } = apiserverGateway({ pruneDisplayName: true })
    const app = makeApp(gateway)
    await seedShared(S1, 'c1')

    const res = await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'c1' },
        spec: { contextId: 'c1', mcpServers: [S1], displayName: 'Sales' },
      })

    expect(res.status, res.text).toBe(409)
    expect(res.body.code).toBe('context_crd_outdated')
    expect(store.size).toBe(0)
    expect(await grants()).toEqual([])
  })

  it('POST of a name that already exists answers 409 and runs no purge', async () => {
    const { gateway } = apiserverGateway()
    const app = makeApp(gateway)
    await createContext(gateway, 'c1', [S1])
    await seedShared(S1, 'c1')

    const res = await request(app)
      .post('/admin/contexts')
      .send({ metadata: { name: 'c1' }, spec: { contextId: 'c1', mcpServers: [S1] } })

    expect(res.status).toBe(409)
    expect(await grants()).toEqual([shared(S1, 'c1')])
    expect(testDb.purgeStatements).toBe(0)
  })

  // ── namespace of the rows ──────────────────────────────────────────────────

  describe('with the contexts namespace apart from the mcp-servers namespace', () => {
    beforeEach(() => {
      config.contextsNamespace = 'contexts-apart'
    })

    it('PUT purges the rows, which live under the mcp-servers namespace', async () => {
      const { gateway } = apiserverGateway()
      const app = makeApp(gateway)
      await createContext(gateway, 'c1', [S1, S2])
      await seedShared(S2, 'c1')

      expect((await putAllowlist(app, gateway, 'c1', [S1])).status).toBe(200)
      expect(await grants()).toEqual([])
    })

    it('DELETE purges the rows, which live under the mcp-servers namespace', async () => {
      const { gateway } = apiserverGateway()
      const app = makeApp(gateway)
      await createContext(gateway, 'c1', [S1])
      await seedShared(S1, 'c1')

      expect((await request(app).delete('/admin/contexts/c1')).status).toBe(200)
      expect(await grants()).toEqual([])
    })

    it('POST purges the rows, which live under the mcp-servers namespace', async () => {
      const { gateway } = apiserverGateway()
      const app = makeApp(gateway)
      await seedShared(S1, 'c1')

      const res = await request(app)
        .post('/admin/contexts')
        .send({ metadata: { name: 'c1' }, spec: { contextId: 'c1', mcpServers: [S1] } })

      expect(res.status, res.text).toBe(201)
      expect(await grants()).toEqual([])
    })
  })

  // ── a failed purge never changes the answer ────────────────────────────────

  describe('a purge that fails is logged and leaves the response as it was', () => {
    it('PUT still answers 200', async () => {
      const { gateway } = apiserverGateway()
      const app = makeApp(gateway)
      await createContext(gateway, 'c1', [S1, S2])
      await seedShared(S2, 'c1')
      testDb.failPurges = 1
      const warn = vi.spyOn(adminResourcesLogger, 'warn')

      const res = await putAllowlist(app, gateway, 'c1', [S1])

      expect(res.status).toBe(200)
      expect(res.body.spec.mcpServers).toEqual([S1])
      expect(await grants()).toEqual([shared(S2, 'c1')])
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), context: 'c1' }),
        'shared_grant_purge_failed'
      )
    })

    it('PUT with a pruned displayName still answers 409', async () => {
      const { gateway } = apiserverGateway({ pruneDisplayName: true })
      const app = makeApp(gateway)
      await createContext(gateway, 'c1', [S1])
      testDb.failPurges = 1

      const res = await putAllowlist(app, gateway, 'c1', [S1], { displayName: 'Sales' })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('context_crd_outdated')
    })

    it('DELETE still answers 200', async () => {
      const { gateway } = apiserverGateway()
      const app = makeApp(gateway)
      await createContext(gateway, 'c1', [S1])
      await seedShared(S1, 'c1')
      testDb.failPurges = 1
      const warn = vi.spyOn(adminResourcesLogger, 'warn')

      expect((await request(app).delete('/admin/contexts/c1')).status).toBe(200)
      expect(await grants()).toEqual([shared(S1, 'c1')])
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'c1' }),
        'shared_grant_purge_failed'
      )
    })

    it('POST still answers 201', async () => {
      const { gateway } = apiserverGateway()
      const app = makeApp(gateway)
      await seedShared(S1, 'c1')
      testDb.failPurges = 1
      const warn = vi.spyOn(adminResourcesLogger, 'warn')

      const res = await request(app)
        .post('/admin/contexts')
        .send({ metadata: { name: 'c1' }, spec: { contextId: 'c1', mcpServers: [S1] } })

      expect(res.status).toBe(201)
      expect(await grants()).toEqual([shared(S1, 'c1')])
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'c1' }),
        'shared_grant_purge_failed'
      )
    })
  })
})

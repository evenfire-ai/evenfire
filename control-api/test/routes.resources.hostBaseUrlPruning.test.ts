import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { ResourceService } from '../src/services/resourceService.js'

// Fase 3-B — deploy-order guard against silent pruning of the additive Host
// `baseURL` fields (spec.model.baseURL, spec.llmPolicy.fallbacks[i].baseURL for
// provider 'openai-compatible'). An OUTDATED Host CRD does not know `baseURL`,
// so the apiserver prunes it before persisting and returns success — the local
// endpoint is lost with no error. The guard converts that into a loud 409
// `host_crd_outdated`.

// Host create/update wrap validation + the K8s write in a carrier transaction
// holding a per-model-name advisory lock (R1-H3 fase 1). Keep db.js real; stub
// only the transaction runner + lock / idle-timeout guards so these route tests
// need no live Postgres.
vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
      work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    advisoryLockModelName: async () => {},
    advisoryLockModelNames: async () => {},
    boundCarrierTransactionIdleTimeout: async () => {},
  }
})

const llm = vi.hoisted(() => ({ isModelAllowed: vi.fn() }))
vi.mock('../src/services/llmAllowedModels.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/llmAllowedModels.js')>(
    '../src/services/llmAllowedModels.js'
  )
  return { ...actual, isModelAllowed: llm.isModelAllowed }
})

const HOSTS_NS = config.hostsNamespace
const LOCAL_URL = 'http://192.168.1.50:8000/v1'
const LOCAL_FB_URL = 'http://192.168.1.60:8000/v1'

// The productor real is the K8s apiserver: on a create/replace it returns the
// object AFTER pruning unknown fields. We reproduce that behaviour at the
// apiserver boundary (customApi.{create,replace}NamespacedCustomObject) through
// the REAL ResourceService — NOT a hand-written fixture — so the object the
// route inspects is exactly the shape an outdated CRD would emit: a persisted
// Host whose `baseURL`(s) were silently dropped even though the request carried
// them. Mirrors the R1-M6 context displayName pruning test (T1).
function realServiceGateway(opts: { prune: boolean }): {
  gateway: {
    getResource: ResourceService['getResource']
    updateResource: ResourceService['updateResource']
    createResource: ResourceService['createResource']
    deleteResource: ResourceService['deleteResource']
    listResource: ResourceService['listResource']
    getSecret: ReturnType<typeof vi.fn>
    deleteSecret: ReturnType<typeof vi.fn>
  }
  store: Map<string, Record<string, unknown>>
} {
  const ns = HOSTS_NS
  let rv = 0
  const store = new Map<string, Record<string, unknown>>()

  // Simulate the apiserver of an OUTDATED CRD: it does not know `baseURL` at any
  // spec location, so it prunes it (from spec.model AND every fallback) before
  // persisting — exactly what a fully outdated CRD does.
  const persistWithPruning = (body: Record<string, unknown>): Record<string, unknown> => {
    if (!opts.prune) return body
    const spec = { ...(body.spec as Record<string, unknown> | undefined) }
    if (spec.model && typeof spec.model === 'object') {
      const model = { ...(spec.model as Record<string, unknown>) }
      delete model.baseURL
      spec.model = model
    }
    const llmPolicy = spec.llmPolicy as Record<string, unknown> | undefined
    if (llmPolicy && Array.isArray(llmPolicy.fallbacks)) {
      spec.llmPolicy = {
        ...llmPolicy,
        fallbacks: llmPolicy.fallbacks.map(fb => {
          if (!fb || typeof fb !== 'object') return fb
          const copy = { ...(fb as Record<string, unknown>) }
          delete copy.baseURL
          return copy
        }),
      }
    }
    return { ...body, spec }
  }

  const getNamespacedCustomObject = vi.fn(async ({ name }: { name: string }) => {
    const obj = store.get(name)
    if (!obj) {
      const err = new Error(`hosts/${name} not found`) as Error & { code: number }
      err.code = 404
      throw err
    }
    return obj
  })
  const replaceNamespacedCustomObject = vi.fn(
    async ({ name, body }: { name: string; body: Record<string, unknown> }) => {
      const persisted = persistWithPruning(body)
      const stored = {
        ...persisted,
        metadata: {
          ...(persisted.metadata as Record<string, unknown>),
          resourceVersion: String(++rv),
        },
      }
      store.set(name, stored)
      return stored
    }
  )
  const createNamespacedCustomObject = vi.fn(
    async ({ body }: { body: Record<string, unknown> & { metadata: { name: string } } }) => {
      const persisted = persistWithPruning(body)
      const stored = {
        ...persisted,
        metadata: {
          ...(persisted.metadata as Record<string, unknown>),
          resourceVersion: String(++rv),
        },
      }
      store.set(body.metadata.name, stored)
      return stored
    }
  )
  const deleteNamespacedCustomObject = vi.fn(async ({ name }: { name: string }) => {
    const existed = store.delete(name)
    return { deleted: existed }
  })
  const listNamespacedCustomObject = vi.fn(async () => ({ items: Array.from(store.values()) }))

  const customApi = {
    getNamespacedCustomObject,
    replaceNamespacedCustomObject,
    createNamespacedCustomObject,
    deleteNamespacedCustomObject,
    listNamespacedCustomObject,
  } as unknown as ConstructorParameters<typeof ResourceService>[0]
  const svc = new ResourceService(customApi, ns, { hosts: ns })
  // getSecret is only consulted by validateHostSecretRef when spec.secretRef is a
  // non-empty string. These specs carry no secretRef, so a no-op spy suffices.
  const getSecret = vi.fn(async () => null)
  const deleteSecret = vi.fn(async () => ({ deleted: true }))
  const gateway = {
    getResource: svc.getResource.bind(svc),
    updateResource: svc.updateResource.bind(svc),
    createResource: svc.createResource.bind(svc),
    deleteResource: svc.deleteResource.bind(svc),
    listResource: svc.listResource.bind(svc),
    getSecret,
    deleteSecret,
  }
  return { gateway, store }
}

function makeApp(gateway: ReturnType<typeof realServiceGateway>['gateway']): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return app
}

beforeEach(() => {
  // Every (provider, model) pair is allowed so validation passes and the write
  // reaches the read-after-write guard under test.
  llm.isModelAllowed.mockReset()
  llm.isModelAllowed.mockResolvedValue(true)
})

describe('routes/resources — Host baseURL deploy-order guard (fase 3-B)', () => {
  it('accepts a create whose spec.model.baseURL round-trips (201)', async () => {
    const { gateway } = realServiceGateway({ prune: false })
    const res = await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'h-local' },
        spec: { model: { provider: 'openai-compatible', name: 'local-model', baseURL: LOCAL_URL } },
      })
      .expect(201)
    expect(res.body.spec.model.baseURL).toBe(LOCAL_URL)
  })

  it('rejects a create whose spec.model.baseURL the apiserver pruned (409) and rolls back the orphan', async () => {
    const { gateway, store } = realServiceGateway({ prune: true })
    const res = await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'h-local' },
        spec: { model: { provider: 'openai-compatible', name: 'local-model', baseURL: LOCAL_URL } },
      })
      .expect(409)
    // Observable result (T4): machine-readable error code + field, not a silent 201.
    expect(res.body.code).toBe('host_crd_outdated')
    expect(res.body.error).toContain('spec.model.baseURL')
    // Orphan rolled back so a retry (after the CRD is applied) does not collide
    // with AlreadyExists.
    expect(store.has('h-local')).toBe(false)
  })

  it('rejects a create whose fallback baseURL the apiserver pruned (409, fallback location)', async () => {
    const { gateway } = realServiceGateway({ prune: true })
    const res = await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'h-fb' },
        // Primary is a cloud provider (no baseURL); only the fallback is a local
        // openai-compatible endpoint, so the pruned field is the fallback's.
        spec: {
          model: { provider: 'claude', name: 'claude-sonnet' },
          llmPolicy: {
            fallbacks: [
              { provider: 'openai-compatible', model: 'local-fb', baseURL: LOCAL_FB_URL },
            ],
          },
        },
      })
      .expect(409)
    expect(res.body.code).toBe('host_crd_outdated')
    expect(res.body.error).toContain('spec.llmPolicy.fallbacks[0].baseURL')
  })

  it('accepts a create with no openai-compatible target even against a pruning apiserver (201, no false positive)', async () => {
    const { gateway } = realServiceGateway({ prune: true })
    await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'h-cloud' },
        spec: { model: { provider: 'claude', name: 'claude-sonnet' } },
      })
      .expect(201)
  })

  it('accepts an update whose spec.model.baseURL round-trips (200)', async () => {
    const { gateway } = realServiceGateway({ prune: false })
    await gateway.createResource(
      'hosts',
      {
        metadata: { name: 'h-local' },
        spec: { model: { provider: 'claude', name: 'claude-sonnet' } },
      },
      HOSTS_NS
    )
    const res = await request(makeApp(gateway))
      .put('/admin/hosts/h-local')
      .send({
        spec: { model: { provider: 'openai-compatible', name: 'local-model', baseURL: LOCAL_URL } },
      })
      .expect(200)
    expect(res.body.spec.model.baseURL).toBe(LOCAL_URL)
  })

  it('rejects an update whose spec.model.baseURL the apiserver pruned (409)', async () => {
    const { gateway } = realServiceGateway({ prune: true })
    // Seed a host without baseURL so the guard fires on the PUT that adds it.
    await gateway.createResource(
      'hosts',
      {
        metadata: { name: 'h-local' },
        spec: { model: { provider: 'claude', name: 'claude-sonnet' } },
      },
      HOSTS_NS
    )
    const res = await request(makeApp(gateway))
      .put('/admin/hosts/h-local')
      .send({
        spec: { model: { provider: 'openai-compatible', name: 'local-model', baseURL: LOCAL_URL } },
      })
      .expect(409)
    expect(res.body.code).toBe('host_crd_outdated')
    expect(res.body.error).toContain('spec.model.baseURL')
  })
})

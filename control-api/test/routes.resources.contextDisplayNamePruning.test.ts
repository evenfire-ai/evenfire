import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { ResourceService } from '../src/services/resourceService.js'

// R1-M6 — deploy-order guard against silent pruning of the additive context
// `spec.displayName` field (PR #304).
//
// The productor real is the K8s apiserver: on a create/replace it returns the
// object AFTER pruning unknown fields. We reproduce that behaviour at the
// apiserver boundary (customApi.{create,replace}NamespacedCustomObject) through
// the REAL ResourceService — NOT with a hand-written fixture — so the object the
// route inspects is exactly the shape an outdated CRD would emit: a persisted
// context whose `spec.displayName` was silently dropped even though the request
// carried it.
//
// This mirrors the N1 test's real-service-against-a-customApi-spy pattern.
function realServiceGateway(opts: { pruneDisplayName: boolean }): {
  gateway: {
    getResource: ResourceService['getResource']
    updateResource: ResourceService['updateResource']
    createResource: ResourceService['createResource']
    deleteResource: ResourceService['deleteResource']
    listResource: ResourceService['listResource']
    deleteSecret: ReturnType<typeof vi.fn>
  }
  store: Map<string, Record<string, unknown>>
  deleteNamespacedCustomObject: ReturnType<typeof vi.fn>
  deleteSecret: ReturnType<typeof vi.fn>
} {
  const ns = config.contextsNamespace
  let rv = 0
  const store = new Map<string, Record<string, unknown>>()

  // Simulate the apiserver of an OUTDATED CRD: it does not know
  // `spec.displayName`, so it prunes it before persisting.
  const persistWithPruning = (body: Record<string, unknown>): Record<string, unknown> => {
    if (!opts.pruneDisplayName) return body
    const spec = { ...(body.spec as Record<string, unknown>) }
    delete spec.displayName
    return { ...body, spec }
  }

  const getNamespacedCustomObject = vi.fn(async ({ name }: { name: string }) => {
    const obj = store.get(name)
    if (!obj) {
      const err = new Error(`contexts/${name} not found`) as Error & { code: number }
      err.code = 404
      throw err
    }
    return obj
  })
  const replaceNamespacedCustomObject = vi.fn(
    async ({ name, body }: { name: string; body: Record<string, unknown> }) => {
      const persisted = persistWithPruning(body)
      const existing = store.get(name)
      const existingMetadata = existing?.metadata as Record<string, unknown> | undefined
      const stored = {
        ...persisted,
        metadata: {
          ...(persisted.metadata as Record<string, unknown>),
          uid: existingMetadata?.uid ?? `uid-${name}`,
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
          uid: `uid-${body.metadata.name}`,
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
  // ResourceService.listResource unwraps `.items` from the list response, so the
  // spy must return the store contents under that key.
  const listNamespacedCustomObject = vi.fn(async () => ({
    items: Array.from(store.values()),
  }))

  const customApi = {
    getNamespacedCustomObject,
    replaceNamespacedCustomObject,
    createNamespacedCustomObject,
    deleteNamespacedCustomObject,
    listNamespacedCustomObject,
  } as unknown as ConstructorParameters<typeof ResourceService>[0]
  const svc = new ResourceService(customApi, ns, { contexts: ns })
  // deleteSecret lives on K8sGateway (not ResourceService); the mcp-server DELETE
  // handler invokes it for the `<name>-credentials` secret. It is orthogonal to
  // the allowlist-pruning path under test, so a no-op spy suffices.
  const deleteSecret = vi.fn(async () => ({ deleted: true }))
  const gateway = {
    getResource: svc.getResource.bind(svc),
    updateResource: svc.updateResource.bind(svc),
    createResource: svc.createResource.bind(svc),
    deleteResource: svc.deleteResource.bind(svc),
    listResource: svc.listResource.bind(svc),
    deleteSecret,
  }
  return { gateway, store, deleteNamespacedCustomObject, deleteSecret }
}

function makeApp(gateway: ReturnType<typeof realServiceGateway>['gateway']): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return app
}

describe('routes/resources — context spec.displayName deploy-order guard (R1-M6)', () => {
  it('rejects a create whose spec.displayName the apiserver pruned (409) and rolls back the orphan', async () => {
    const { gateway, store } = realServiceGateway({ pruneDisplayName: true })
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'ctx-display' },
        spec: { contextId: 'ctx-display', mcpServers: [], displayName: 'My Context' },
      })
      .expect(409)

    // Observable result (T4): the operator gets a machine-readable error, not a
    // 200 with the display name silently gone.
    expect(res.body.code).toBe('context_crd_outdated')
    expect(res.body.error).toContain('spec.displayName')
    // The orphan context (created before the guard fired) was rolled back, so a
    // retry after the CRD is applied does not collide with AlreadyExists.
    expect(store.has('ctx-display')).toBe(false)
  })

  it('accepts a create whose spec.displayName round-trips (201)', async () => {
    const { gateway } = realServiceGateway({ pruneDisplayName: false })
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'ctx-display' },
        spec: { contextId: 'ctx-display', mcpServers: [], displayName: 'My Context' },
      })
      .expect(201)

    expect(res.body.spec.displayName).toBe('My Context')
  })

  it('rejects an update whose spec.displayName the apiserver pruned (409)', async () => {
    const { gateway } = realServiceGateway({ pruneDisplayName: true })
    // Seed a context WITHOUT displayName so the create itself does not trip the
    // guard; the loss happens on the subsequent PUT that adds displayName.
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'ctx-display' }, spec: { contextId: 'ctx-display', mcpServers: [] } },
      config.contextsNamespace
    )
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/contexts/ctx-display')
      .send({ spec: { contextId: 'ctx-display', mcpServers: [], displayName: 'My Context' } })
      .expect(409)

    expect(res.body.code).toBe('context_crd_outdated')
    expect(res.body.error).toContain('spec.displayName')
  })

  it('accepts an update whose spec.displayName round-trips (200)', async () => {
    const { gateway } = realServiceGateway({ pruneDisplayName: false })
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'ctx-display' }, spec: { contextId: 'ctx-display', mcpServers: [] } },
      config.contextsNamespace
    )
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/contexts/ctx-display')
      .send({ spec: { contextId: 'ctx-display', mcpServers: [], displayName: 'My Context' } })
      .expect(200)

    expect(res.body.spec.displayName).toBe('My Context')
  })

  it('does not fire when the request omits spec.displayName (200, no false positive)', async () => {
    const { gateway } = realServiceGateway({ pruneDisplayName: true })
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'ctx-nodisplay' }, spec: { contextId: 'ctx-nodisplay', mcpServers: [] } },
      config.contextsNamespace
    )
    const app = makeApp(gateway)

    await request(app)
      .put('/admin/contexts/ctx-nodisplay')
      .send({ spec: { contextId: 'ctx-nodisplay', mcpServers: ['a'] } })
      .expect(200)
  })

  it('deleting an McpServer preserves spec.displayName on referencing contexts (R4-B2)', async () => {
    // CRD is up to date (displayName round-trips): the loss under test is NOT
    // apiserver pruning but the DELETE handler rebuilding the context spec by
    // hand and dropping every field it does not enumerate.
    const { gateway, store } = realServiceGateway({ pruneDisplayName: false })
    await gateway.createResource(
      'contexts',
      {
        metadata: { name: 'ctx-keep' },
        spec: {
          contextId: 'ctx-keep',
          mcpServers: ['srv-target', 'srv-other'],
          displayName: 'Keep Me',
        },
      },
      config.contextsNamespace
    )
    const app = makeApp(gateway)

    await request(app).delete('/admin/mcp-servers/srv-target').expect(200)

    // Observable result (T4): re-read the persisted context and assert the whole
    // relevant spec — displayName survived, and only the deleted server was
    // pruned from the allowlist.
    const ctx = (await gateway.getResource('contexts', 'ctx-keep', config.contextsNamespace)) as {
      spec: { displayName?: string; mcpServers?: string[] }
    }
    expect(ctx.spec.displayName).toBe('Keep Me')
    expect(ctx.spec.mcpServers).toEqual(['srv-other'])
    expect(store.get('ctx-keep')).toBeDefined()
  })
})

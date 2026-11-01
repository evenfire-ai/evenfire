import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// The Context routes purge shared grants after a write; nothing to purge here.
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }
})

const { config } = await import('../src/config.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')
const { ResourceService } = await import('../src/services/resourceService.js')

/**
 * A Context's `spec.contextId` is either absent or its own `metadata.name`:
 * memberships, Hosts and shared grants all identify a Context by name, so an
 * alias that differs would make the same Context answer to two identifiers.
 * The rule applies on create and, on update, only when the value changes, so a
 * Context written outside control-api with an alias stays editable (removing a
 * server from it must always be possible).
 *
 * Real ResourceService over an apiserver-like `customApi`, so "no write" is the
 * apiserver never being called.
 */
function apiserver() {
  const ns = config.contextsNamespace
  let rv = 0
  const store = new Map<string, Record<string, unknown>>()
  const customApi = {
    getNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
      const obj = store.get(name)
      if (!obj) throw Object.assign(new Error(`contexts "${name}" not found`), { code: 404 })
      return obj
    }),
    replaceNamespacedCustomObject: vi.fn(
      async ({ name, body }: { name: string; body: Record<string, unknown> }) => {
        const existing = store.get(name) as { metadata: Record<string, unknown> }
        const stored = {
          ...body,
          metadata: {
            ...(body.metadata as Record<string, unknown>),
            name,
            uid: existing.metadata.uid,
            resourceVersion: String(++rv),
          },
        }
        store.set(name, stored)
        return stored
      }
    ),
    createNamespacedCustomObject: vi.fn(
      async ({ body }: { body: Record<string, unknown> & { metadata: { name: string } } }) => {
        const stored = {
          ...body,
          metadata: {
            ...body.metadata,
            uid: `uid-${body.metadata.name}`,
            resourceVersion: String(++rv),
          },
        }
        store.set(body.metadata.name, stored)
        return stored
      }
    ),
    deleteNamespacedCustomObject: vi.fn(),
    listNamespacedCustomObject: vi.fn(async () => ({ items: [...store.values()] })),
  }
  const svc = new ResourceService(
    customApi as unknown as ConstructorParameters<typeof ResourceService>[0],
    ns,
    { contexts: ns }
  )
  const gateway = {
    getResource: svc.getResource.bind(svc),
    updateResource: svc.updateResource.bind(svc),
    createResource: svc.createResource.bind(svc),
    deleteResource: svc.deleteResource.bind(svc),
    listResource: svc.listResource.bind(svc),
  }
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return { app, gateway, store, customApi }
}

describe('admin Contexts — spec.contextId is absent or equal to metadata.name', () => {
  it('POST with an alias that differs from the name: 422 on spec.contextId, nothing written', async () => {
    const { app, customApi } = apiserver()

    const res = await request(app)
      .post('/admin/contexts')
      .send({ metadata: { name: 'sales' }, spec: { contextId: 'sales-scope', mcpServers: [] } })

    expect(res.status).toBe(422)
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'spec.contextId' })])
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it.each([
    ['equal to the name', { contextId: 'sales' }],
    ['absent', {}],
  ])('POST with spec.contextId %s: 201', async (_label, alias) => {
    const { app } = apiserver()

    const res = await request(app)
      .post('/admin/contexts')
      .send({ metadata: { name: 'sales' }, spec: { ...alias, mcpServers: [] } })

    expect(res.status, res.text).toBe(201)
  })

  it('PUT that changes the alias to a value other than the name: 422, nothing written', async () => {
    const { app, gateway, customApi } = apiserver()
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'sales' }, spec: { contextId: 'sales', mcpServers: ['drive'] } },
      config.contextsNamespace
    )

    const res = await request(app)
      .put('/admin/contexts/sales')
      .send({ spec: { contextId: 'marketing', mcpServers: ['drive'] } })

    expect(res.status).toBe(422)
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'spec.contextId' })])
    expect(customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('PUT of a Context written elsewhere with an alias, resending that alias and removing a server: 200', async () => {
    const { app, gateway, store } = apiserver()
    // The collision only a writer outside control-api can create: the alias is
    // another Context's name.
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'b' }, spec: { contextId: 'a', mcpServers: ['drive', 'mail'] } },
      config.contextsNamespace
    )

    const res = await request(app)
      .put('/admin/contexts/b')
      .send({ spec: { contextId: 'a', mcpServers: ['mail'] } })

    expect(res.status, res.text).toBe(200)
    expect((store.get('b') as { spec: Record<string, unknown> }).spec).toEqual({
      contextId: 'a',
      mcpServers: ['mail'],
    })
  })

  it('PUT that corrects an external alias to the name: 200', async () => {
    const { app, gateway } = apiserver()
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'b' }, spec: { contextId: 'a', mcpServers: [] } },
      config.contextsNamespace
    )

    const res = await request(app)
      .put('/admin/contexts/b')
      .send({ spec: { contextId: 'b', mcpServers: [] } })

    expect(res.status, res.text).toBe(200)
    expect(res.body.spec.contextId).toBe('b')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { fakeCustomObjectsApiserver } from './fixtures/fakeCustomObjectsApiserver.js'

// The Context routes purge shared grants after a write; nothing to purge here.
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }
})

const { config } = await import('../src/config.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')

/**
 * A Context write may not ADD to `spec.mcpServers` a name with no live McpServer.
 * Added means present in the request and absent from the Context as currently
 * stored; a name already there (left by an earlier writer) is not checked, so the
 * Context stays editable. The real ResourceService runs over an in-memory
 * apiserver, so "no write" is the apiserver never receiving a create or replace.
 */
// Contexts and McpServers in different namespaces, so reading a server in the
// Contexts' namespace finds nothing and shows up as a failure.
const CTX_NS = 'contexts-under-test'
const MCP_NS = config.mcpServersNamespace
let previousContextsNamespace = ''
beforeEach(() => {
  previousContextsNamespace = config.contextsNamespace
  config.contextsNamespace = CTX_NS
})
afterEach(() => {
  config.contextsNamespace = previousContextsNamespace
})

function setup() {
  const api = fakeCustomObjectsApiserver({
    namespaces: { contexts: CTX_NS, mcpservers: MCP_NS },
  })
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(api.gateway as never))
  return { ...api, app }
}

type Api = ReturnType<typeof setup>

async function seedServer(api: Api, name: string): Promise<void> {
  await api.gateway.createResource('mcpservers', { metadata: { name }, spec: {} }, MCP_NS)
}

async function seedContext(api: Api, name: string, mcpServers: string[]) {
  return (await api.gateway.createResource(
    'contexts',
    { metadata: { name }, spec: { contextId: name, mcpServers } },
    CTX_NS
  )) as { metadata: { resourceVersion: string }; spec: Record<string, unknown> }
}

function allowlistOf(api: Api, name: string): unknown {
  return (api.peek('contexts', CTX_NS, name)?.spec as { mcpServers?: unknown } | undefined)
    ?.mcpServers
}

function put(api: Api, name: string, mcpServers: string[], resourceVersion?: string) {
  return request(api.app)
    .put(`/admin/contexts/${name}`)
    .send({
      ...(resourceVersion ? { metadata: { resourceVersion } } : {}),
      spec: { contextId: name, mcpServers },
    })
}

function post(api: Api, name: string, mcpServers: string[]) {
  return request(api.app)
    .post('/admin/contexts')
    .send({ metadata: { name }, spec: { contextId: name, mcpServers } })
}

describe('Context writes refuse an added server with no live McpServer', () => {
  it('PUT that adds a name with no McpServer answers 422 and writes nothing', async () => {
    const api = setup()
    await seedServer(api, 'live')
    const ctx = await seedContext(api, 'ctx', ['live'])
    api.customApi.replaceNamespacedCustomObject.mockClear()

    const res = await put(api, 'ctx', ['live', 'ghost'], ctx.metadata.resourceVersion)

    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: 'unknown_mcp_server', mcpServers: ['ghost'] })
    expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
    expect(allowlistOf(api, 'ctx')).toEqual(['live'])
  })

  it('PUT keeping a name already in the Context passes even with no McpServer behind it', async () => {
    const api = setup()
    await seedServer(api, 'live')
    const ctx = await seedContext(api, 'ctx', ['dangling'])

    const res = await put(api, 'ctx', ['dangling', 'live'], ctx.metadata.resourceVersion)

    expect(res.status).toBe(200)
    expect(allowlistOf(api, 'ctx')).toEqual(['dangling', 'live'])
  })

  it('PUT reports only the missing names among several added, sorted', async () => {
    const api = setup()
    await seedServer(api, 'live-a')
    await seedServer(api, 'live-b')
    const ctx = await seedContext(api, 'ctx', [])

    const res = await put(
      api,
      'ctx',
      ['zeta', 'live-a', 'alpha', 'live-b'],
      ctx.metadata.resourceVersion
    )

    expect(res.status).toBe(422)
    expect(res.body.mcpServers).toEqual(['alpha', 'zeta'])
    expect(allowlistOf(api, 'ctx')).toEqual([])
  })

  it('POST with a name that has no McpServer answers 422 and creates nothing', async () => {
    const api = setup()

    const res = await post(api, 'ctx-new', ['ghost'])

    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: 'unknown_mcp_server', mcpServers: ['ghost'] })
    expect(api.customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
    expect(api.peek('contexts', CTX_NS, 'ctx-new')).toBeUndefined()
  })

  it('POST naming a live McpServer creates the Context', async () => {
    const api = setup()
    await seedServer(api, 'live')

    const res = await post(api, 'ctx-new', ['live'])

    expect(res.status).toBe(201)
    expect(allowlistOf(api, 'ctx-new')).toEqual(['live'])
  })

  it('an McpServer being deleted still counts as live', async () => {
    const api = setup()
    await seedServer(api, 'leaving')
    api.markDeleting('mcpservers', MCP_NS, 'leaving')
    const ctx = await seedContext(api, 'ctx', [])

    const res = await put(api, 'ctx', ['leaving'], ctx.metadata.resourceVersion)

    expect(res.status).toBe(200)
    expect(allowlistOf(api, 'ctx')).toEqual(['leaving'])
  })

  it('a read that returns no uid does not prove a live McpServer', async () => {
    const api = setup()
    await seedServer(api, 'no-uid')
    delete api.store.get(`mcpservers/${MCP_NS}/no-uid`)!.metadata.uid
    const ctx = await seedContext(api, 'ctx', [])

    const res = await put(api, 'ctx', ['no-uid'], ctx.metadata.resourceVersion)

    expect(res.status).toBe(422)
    expect(res.body.mcpServers).toEqual(['no-uid'])
  })

  it.each(['PUT', 'POST'] as const)(
    '%s fails closed when the McpServer read errors with anything but 404',
    async verb => {
      const api = setup()
      await seedServer(api, 'live')
      const ctx = verb === 'PUT' ? await seedContext(api, 'ctx', []) : undefined
      api.customApi.createNamespacedCustomObject.mockClear()
      const realGet = api.customApi.getNamespacedCustomObject.getMockImplementation()!
      api.customApi.getNamespacedCustomObject.mockImplementation(async args => {
        if (args.plural === 'mcpservers') {
          throw Object.assign(new Error('etcdserver: request timed out'), { code: 503 })
        }
        return realGet(args)
      })

      const res =
        verb === 'PUT'
          ? await put(api, 'ctx', ['live'], ctx!.metadata.resourceVersion)
          : await post(api, 'ctx-new', ['live'])

      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
      expect(api.customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
    }
  )

  it('PUT to a Context that does not exist counts every name as added (422, not 404)', async () => {
    const api = setup()
    await seedServer(api, 'live')

    const res = await put(api, 'missing', ['live', 'ghost'])

    expect(res.status).toBe(422)
    expect(res.body.mcpServers).toEqual(['ghost'])
    expect(api.peek('contexts', CTX_NS, 'missing')).toBeUndefined()
  })

  it('refuses more added names than it will verify, without reading any McpServer', async () => {
    const api = setup()
    const ctx = await seedContext(api, 'ctx', [])
    api.customApi.getNamespacedCustomObject.mockClear()
    const names = Array.from({ length: 257 }, (_, i) => `srv-${String(i).padStart(3, '0')}`)

    const res = await put(api, 'ctx', names, ctx.metadata.resourceVersion)

    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: 'too_many_mcp_servers', limit: 256 })
    const serverReads = api.customApi.getNamespacedCustomObject.mock.calls.filter(
      ([args]) => args.plural === 'mcpservers'
    )
    expect(serverReads).toHaveLength(0)
    expect(allowlistOf(api, 'ctx')).toEqual([])
  })

  it('stops reading McpServers once one read fails', async () => {
    const api = setup()
    const ctx = await seedContext(api, 'ctx', [])
    const names = Array.from({ length: 10 }, (_, i) => `srv-${i}`)
    const realGet = api.customApi.getNamespacedCustomObject.getMockImplementation()!
    api.customApi.getNamespacedCustomObject.mockImplementation(async args => {
      if (args.plural === 'mcpservers' && args.name === 'srv-0') {
        throw Object.assign(new Error('etcdserver: request timed out'), { code: 503 })
      }
      return realGet(args)
    })
    api.customApi.getNamespacedCustomObject.mockClear()

    const res = await put(api, 'ctx', names, ctx.metadata.resourceVersion)
    // Let any worker still running after the response finish before counting.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(res.status).toBeGreaterThanOrEqual(500)
    const serverReads = api.customApi.getNamespacedCustomObject.mock.calls.filter(
      ([args]) => args.plural === 'mcpservers'
    )
    // The reads already in flight when the first one failed, and no more.
    expect(serverReads).toHaveLength(4)
  })
})

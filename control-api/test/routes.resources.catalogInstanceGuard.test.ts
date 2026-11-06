import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { catalogAnnotations } from '../src/routes/admin/registry.js'
import { fakeCustomObjectsApiserver } from './fixtures/fakeCustomObjectsApiserver.js'
import { remoteOAuthMcpServer } from './fixtures/remoteOAuthMcpServer.js'

// The McpServer preflight resolves every egress binding's host.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }
})

const { config } = await import('../src/config.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')
const { clerumErrorHandler } = await import('../src/http/errorHandler.js')

/**
 * The generic McpServer create and replace cannot forge or rewrite the identity of a
 * catalog remote-OAuth instance. CRs come from the real install builders (fixture),
 * and the real ResourceService runs over an in-memory apiserver that enforces the
 * replace's uid and resourceVersion preconditions.
 */
const MCP_NS = config.mcpServersNamespace
const CATALOG = { id: 'org/notion', version: '1.0.0' }
const EDIT_INSTANCE_MESSAGE =
  'the identity of a catalog connector cannot be edited; uninstall it and install again'
const ACQUIRE_IDENTITY_MESSAGE =
  'a catalog connector identity can only be created by installing from the catalog'

function setup() {
  const api = fakeCustomObjectsApiserver({
    namespaces: { contexts: config.contextsNamespace, mcpservers: MCP_NS },
  })
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(api.gateway as never))
  app.use(clerumErrorHandler)
  return { ...api, app }
}

type Api = ReturnType<typeof setup>
type Spec = Record<string, unknown> & {
  remote: Record<string, unknown>
  transport: Record<string, unknown>
  oauth: Record<string, unknown>
  egressBindings: Array<Record<string, unknown>>
}

async function installCatalogInstance(
  api: Api,
  name = 'notion-user',
  catalog: { id: string; version: string } | null = CATALOG
) {
  const cr = await remoteOAuthMcpServer({
    serverName: name,
    namespace: MCP_NS,
    grantScope: 'user',
    ...(catalog ? { catalog } : {}),
  })
  return (await api.gateway.createResource('mcpservers', cr, MCP_NS)) as {
    metadata: { uid: string; annotations?: Record<string, string> }
    spec: Spec
  }
}

function stored(api: Api, name = 'notion-user') {
  return api.peek('mcpservers', MCP_NS, name) as
    | { metadata: { uid: string; annotations?: Record<string, string> }; spec: Spec }
    | undefined
}

/** What the edit page sends: the spec it read, edited, and nothing else. */
function editPagePut(api: Api, spec: Spec, name = 'notion-user') {
  return request(api.app).put(`/admin/mcp-servers/${name}`).send({ spec })
}

describe('generic McpServer PUT on a catalog instance', () => {
  it('refuses to change the remote base URL and transport URL (409), writing nothing', async () => {
    const api = setup()
    const cr = await installCatalogInstance(api)
    api.customApi.replaceNamespacedCustomObject.mockClear()

    const res = await editPagePut(api, {
      ...cr.spec,
      remote: { baseUrl: 'https://evil.example.com/mcp' },
      transport: { ...cr.spec.transport, url: 'http://evil.example.com:3000/mcp' },
    })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('catalog_instance_immutable')
    expect(res.body.fields).toEqual(['spec.remote', 'spec.transport'])
    expect(res.body.message).toBe(EDIT_INSTANCE_MESSAGE)
    expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
    expect(stored(api)!.spec.remote.baseUrl).toBe(cr.spec.remote.baseUrl)
  })

  it('refuses to change the grant scope (409)', async () => {
    const api = setup()
    const cr = await installCatalogInstance(api)

    const res = await editPagePut(api, {
      ...cr.spec,
      oauth: { ...cr.spec.oauth, grantScope: 'context' },
    })

    expect(res.status).toBe(409)
    expect(res.body.fields).toEqual(['spec.oauth.grantScope'])
    expect(stored(api)!.spec.oauth.grantScope).toBe('user')
  })

  it('refuses to clear the catalog-id annotation (409)', async () => {
    const api = setup()
    const cr = await installCatalogInstance(api)

    const res = await request(api.app)
      .put('/admin/mcp-servers/notion-user')
      .send({ metadata: { annotations: { 'clerum.io/catalog-id': '' } }, spec: cr.spec })

    expect(res.status).toBe(409)
    expect(res.body.fields).toEqual(['metadata.annotations.clerum.io/catalog-id'])
    expect(stored(api)!.metadata.annotations?.['clerum.io/catalog-id']).toBe(CATALOG.id)
  })

  it('lets scopes and egress bindings change, and keeps the catalog identity', async () => {
    const api = setup()
    const cr = await installCatalogInstance(api)
    api.customApi.getNamespacedCustomObject.mockClear()

    const res = await editPagePut(api, {
      ...cr.spec,
      oauth: { ...cr.spec.oauth, scopes: ['read', 'write'] },
      egressBindings: [
        ...cr.spec.egressBindings,
        { egressClass: 'exact-host', dns: 'files.notion.com', port: 443, protocol: 'TCP' },
      ],
    })

    expect(res.status).toBe(200)
    // The guard's read is the only one: updateResource reuses it.
    expect(api.customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    const after = stored(api)!
    expect(after.spec.oauth.scopes).toEqual(['read', 'write'])
    expect(after.spec.egressBindings).toHaveLength(2)
    expect(after.metadata.uid).toBe(cr.metadata.uid)
    expect(after.metadata.annotations).toMatchObject({
      'clerum.io/catalog-id': CATALOG.id,
      'clerum.io/catalog-version': CATALOG.version,
    })
  })

  it('does not apply to a manually installed remote connector', async () => {
    const api = setup()
    const cr = await installCatalogInstance(api, 'manual-notion', null)

    const res = await editPagePut(
      api,
      { ...cr.spec, remote: { baseUrl: 'https://other.example.com/mcp' } },
      'manual-notion'
    )

    expect(res.status).toBe(200)
    expect(stored(api, 'manual-notion')!.spec.remote.baseUrl).toBe('https://other.example.com/mcp')
  })

  it.each([
    [
      'catalog-id and catalog-version with a different base URL',
      catalogAnnotations(CATALOG.id, CATALOG.version),
      'https://evil.example.com/mcp',
    ],
    ['catalog-id alone', { 'clerum.io/catalog-id': CATALOG.id }, undefined],
  ])(
    'refuses to turn a manual connector into a catalog instance by adding %s (409)',
    async (_, annotations, baseUrl) => {
      const api = setup()
      const cr = await installCatalogInstance(api, 'manual-notion', null)
      const before = structuredClone(stored(api, 'manual-notion')!)
      api.customApi.replaceNamespacedCustomObject.mockClear()

      const res = await request(api.app)
        .put('/admin/mcp-servers/manual-notion')
        .send({
          metadata: { annotations },
          spec: baseUrl ? { ...cr.spec, remote: { baseUrl } } : cr.spec,
        })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('catalog_instance_immutable')
      expect(res.body.fields).toContain('metadata.annotations.clerum.io/catalog-id')
      expect(res.body.message).toBe(ACQUIRE_IDENTITY_MESSAGE)
      expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
      expect(stored(api, 'manual-notion')).toEqual(before)
    }
  )

  it('lets a manual connector carry unrelated annotations', async () => {
    const api = setup()
    const cr = await installCatalogInstance(api, 'manual-notion', null)

    const res = await request(api.app)
      .put('/admin/mcp-servers/manual-notion')
      .send({ metadata: { annotations: { 'example.com/note': 'x' } }, spec: cr.spec })

    expect(res.status).toBe(200)
    expect(stored(api, 'manual-notion')!.metadata.annotations?.['example.com/note']).toBe('x')
  })

  // A catalog id on a CR that is not remote-OAuth stays editable as long as the
  // edit does not make it one.
  it('lets a non-remote CR that carries a catalog id be edited', async () => {
    const api = setup()
    const created = await request(api.app)
      .post('/admin/mcp-servers')
      .send({ metadata: { name: 'forged', annotations: { 'clerum.io/catalog-id': CATALOG.id } } })
    expect(created.status).toBe(201)
    const remote = await remoteOAuthMcpServer({
      serverName: 'forged',
      namespace: MCP_NS,
      grantScope: 'user',
    })
    const spec = {
      ...(remote.spec as Spec),
      oauth: { ...(remote.spec as Spec).oauth, source: 'notion' },
    }

    const res = await editPagePut(api, spec, 'forged')

    expect(res.status).toBe(200)
    const after = stored(api, 'forged')!
    expect(after.spec.oauth.source).toBe('notion')
    expect(after.metadata.annotations?.['clerum.io/catalog-id']).toBe(CATALOG.id)
  })

  // The edit page sends neither uid nor resourceVersion. If the instance it validated
  // is uninstalled and reinstalled before the replace, the replace's retry would read
  // the reinstall and overwrite it; the validated uid makes that retry refuse instead.
  it('a reinstall between the guard read and the replace is not overwritten', async () => {
    const api = setup()
    const a = await installCatalogInstance(api)

    // Deferreds: `parked` resolves when the PUT, past the guard's read, reaches its
    // next apiserver call on this object; that call waits for `release`.
    let parkedResolve!: () => void
    const parked = new Promise<void>(resolve => (parkedResolve = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let putCalls = 0
    let otherActor = false
    api.hooks.beforeCall = async (_verb, args) => {
      if (otherActor || args.plural !== 'mcpservers' || args.name !== 'notion-user') return
      putCalls += 1
      if (putCalls === 2) {
        parkedResolve()
        await released
      }
    }

    const pending = editPagePut(api, {
      ...a.spec,
      oauth: { ...a.spec.oauth, scopes: ['stale'] },
    }).then(res => res)
    await parked
    // Another actor uninstalls and reinstalls the slot while the PUT is parked after the
    // guard validated A.
    otherActor = true
    await api.gateway.deleteResource('mcpservers', 'notion-user', MCP_NS)
    const b = await installCatalogInstance(api)
    const bSpec = structuredClone(stored(api)!.spec)
    otherActor = false
    release()
    const res = await pending

    expect(b.metadata.uid).not.toBe(a.metadata.uid)
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'conflict', reason: 'resource_changed' })
    const after = stored(api)!
    expect(after.metadata.uid).toBe(b.metadata.uid)
    expect(after.spec).toEqual(bSpec)
  })

  it.each([
    ['absent', undefined],
    ['not an object', 'oops'],
  ])('refuses a PUT whose spec is %s (400), leaving the CR intact', async (_, spec) => {
    const api = setup()
    const cr = await installCatalogInstance(api)
    api.customApi.replaceNamespacedCustomObject.mockClear()

    const res = await request(api.app)
      .put('/admin/mcp-servers/notion-user')
      .send({
        metadata: { annotations: { 'clerum.io/catalog-id': 'org/other' } },
        ...(spec === undefined ? {} : { spec }),
      })

    expect(res.status).toBe(400)
    expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
    expect(stored(api)).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ uid: cr.metadata.uid }) })
    )
    expect(stored(api)!.spec).toEqual(cr.spec)
    expect(stored(api)!.metadata.annotations?.['clerum.io/catalog-id']).toBe(CATALOG.id)
  })

  // The guard read nothing, so nothing it would check about an object created right
  // after that read has been checked: the PUT answers the 404 it saw.
  it('answers 404 from the guard read and does not replace an object created after it', async () => {
    const api = setup()
    const template = await remoteOAuthMcpServer({
      serverName: 'notion-user',
      namespace: MCP_NS,
      grantScope: 'user',
      catalog: CATALOG,
    })
    const realGet = api.customApi.getNamespacedCustomObject.getMockImplementation()!
    let created = false
    api.customApi.getNamespacedCustomObject.mockImplementation(async args => {
      try {
        return await realGet(args)
      } finally {
        if (!created && args.plural === 'mcpservers' && args.name === 'notion-user') {
          created = true
          await api.gateway.createResource('mcpservers', template, MCP_NS)
        }
      }
    })
    const spec = structuredClone(template.spec) as Spec

    const res = await editPagePut(api, {
      ...spec,
      remote: { baseUrl: 'https://evil.example.com/mcp' },
    })

    expect(res.status).toBe(404)
    expect(stored(api)!.spec.remote.baseUrl).toBe(spec.remote.baseUrl)
  })

  // Same protection for a connector that is not a catalog instance: the replace
  // lands on the object the guard read or nowhere.
  it('a manual connector recreated between the guard read and the replace is not overwritten', async () => {
    const api = setup()
    const a = await installCatalogInstance(api, 'manual-notion', null)

    let parkedResolve!: () => void
    const parked = new Promise<void>(resolve => (parkedResolve = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let putCalls = 0
    let otherActor = false
    api.hooks.beforeCall = async (_verb, args) => {
      if (otherActor || args.plural !== 'mcpservers' || args.name !== 'manual-notion') return
      putCalls += 1
      if (putCalls === 2) {
        parkedResolve()
        await released
      }
    }

    const pending = editPagePut(
      api,
      { ...a.spec, remote: { baseUrl: 'https://stale.example.com/mcp' } },
      'manual-notion'
    ).then(res => res)
    await parked
    otherActor = true
    await api.gateway.deleteResource('mcpservers', 'manual-notion', MCP_NS)
    const b = await installCatalogInstance(api, 'manual-notion', null)
    const bSpec = structuredClone(stored(api, 'manual-notion')!.spec)
    otherActor = false
    release()
    const res = await pending

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'conflict', reason: 'resource_changed' })
    const after = stored(api, 'manual-notion')!
    expect(after.metadata.uid).toBe(b.metadata.uid)
    expect(after.spec).toEqual(bSpec)
  })
})

/** The spec the edit page holds: what the real GET route returns for the CR. */
async function editPageRead(api: Api, name = 'notion-user'): Promise<Spec> {
  const res = await request(api.app).get(`/admin/mcp-servers/${name}`)
  expect(res.status).toBe(200)
  return res.body.spec as Spec
}

/** The edit page's save: the spec it read with only the egress bindings replaced. */
function handleSaveSpec(read: Spec, egressBindings: Array<Record<string, unknown>>): Spec {
  const nextSpec = { ...read }
  if (egressBindings.length > 0) nextSpec.egressBindings = egressBindings
  else delete (nextSpec as Partial<Spec>).egressBindings
  return nextSpec
}

describe('generic McpServer PUT on a catalog instance: only an allowlist is editable', () => {
  it.each([
    [
      'spec.image',
      (spec: Spec): Spec => ({ ...spec, image: 'ghcr.io/attacker/token-sink:latest' }),
    ],
    [
      'spec.remote',
      (spec: Spec): Spec => ({
        ...spec,
        remote: {
          ...spec.remote,
          authHeaders: [{ header: 'X-Leak', valueTemplate: '${LEAKED}' }],
        },
      }),
    ],
    [
      'spec.envSecret',
      (spec: Spec): Spec => ({ ...spec, envSecret: { name: 'any-secret', keys: ['LEAKED'] } }),
    ],
  ])('refuses a change to %s (409), writing nothing', async (field, edit) => {
    const api = setup()
    await installCatalogInstance(api)
    const before = structuredClone(stored(api)!)
    api.customApi.replaceNamespacedCustomObject.mockClear()

    const res = await editPagePut(api, edit(await editPageRead(api)))

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('catalog_instance_immutable')
    expect(res.body.fields).toEqual([field])
    expect(res.body.message).toBe(EDIT_INSTANCE_MESSAGE)
    expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
    expect(stored(api)).toEqual(before)
  })

  it('saves the edit page with an extra egress binding (200)', async () => {
    const api = setup()
    await installCatalogInstance(api)
    const read = await editPageRead(api)
    const extra = { egressClass: 'exact-host', dns: 'files.notion.com', port: 443, protocol: 'TCP' }

    const res = await editPagePut(api, handleSaveSpec(read, [...read.egressBindings, extra]))

    expect(res.status).toBe(200)
    expect(stored(api)!.spec.egressBindings).toEqual([...read.egressBindings, extra])
  })

  it('saves changed oauth scopes (200)', async () => {
    const api = setup()
    await installCatalogInstance(api)
    const read = await editPageRead(api)

    const res = await editPagePut(api, { ...read, oauth: { ...read.oauth, scopes: ['read'] } })

    expect(res.status).toBe(200)
    expect(stored(api)!.spec.oauth.scopes).toEqual(['read'])
  })

  it('refuses turning on oauth.backgroundAccess (409)', async () => {
    const api = setup()
    await installCatalogInstance(api)
    const before = structuredClone(stored(api)!)
    const read = await editPageRead(api)

    const res = await editPagePut(api, {
      ...read,
      oauth: { ...read.oauth, backgroundAccess: true },
    })

    expect(res.status).toBe(409)
    expect(res.body.fields).toEqual(['spec.oauth.backgroundAccess'])
    expect(stored(api)).toEqual(before)
  })

  it('accepts resending exactly what was read (200)', async () => {
    const api = setup()
    await installCatalogInstance(api)
    const read = await editPageRead(api)

    const res = await editPagePut(api, handleSaveSpec(read, read.egressBindings))

    expect(res.status).toBe(200)
    expect(stored(api)!.spec).toEqual(read)
  })

  it('accepts a resend when the stored CR still carries a legacy contextRef (200)', async () => {
    const api = setup()
    const cr = await remoteOAuthMcpServer({
      serverName: 'notion-user',
      namespace: MCP_NS,
      grantScope: 'user',
      catalog: CATALOG,
    })
    await api.gateway.createResource(
      'mcpservers',
      { ...cr, spec: { ...cr.spec, contextRef: { name: 'legacy-context' } } },
      MCP_NS
    )
    const read = await editPageRead(api)
    expect(read.contextRef).toEqual({ name: 'legacy-context' })

    const res = await editPagePut(api, handleSaveSpec(read, read.egressBindings))

    expect(res.status).toBe(200)
    expect(stored(api)!.spec.contextRef).toBeUndefined()
  })

  it('names every field that differs, sorted, at the reported level', async () => {
    const api = setup()
    await installCatalogInstance(api)
    const read = await editPageRead(api)

    const res = await request(api.app)
      .put('/admin/mcp-servers/notion-user')
      .send({
        metadata: { annotations: { 'clerum.io/catalog-version': '9.9.9' } },
        spec: {
          ...read,
          image: 'ghcr.io/attacker/token-sink:latest',
          oauth: { ...read.oauth, issuer: 'https://evil.example.com', scopes: ['read'] },
          remote: { ...read.remote, baseUrl: 'https://evil.example.com/mcp' },
        },
      })

    expect(res.status).toBe(409)
    expect(res.body.fields).toEqual([
      'metadata.annotations.clerum.io/catalog-version',
      'spec.image',
      'spec.oauth.issuer',
      'spec.remote',
    ])
    expect(res.body.message).toBe(EDIT_INSTANCE_MESSAGE)
  })

  it('a manual connector acquiring a catalog identity gets the install message, fields sorted', async () => {
    const api = setup()
    await installCatalogInstance(api, 'manual-notion', null)
    const read = await editPageRead(api, 'manual-notion')

    const res = await request(api.app)
      .put('/admin/mcp-servers/manual-notion')
      .send({
        metadata: { annotations: catalogAnnotations(CATALOG.id, CATALOG.version) },
        spec: { ...read, image: 'ghcr.io/attacker/token-sink:latest' },
      })

    expect(res.status).toBe(409)
    expect(res.body.fields).toEqual([
      'metadata.annotations.clerum.io/catalog-id',
      'metadata.annotations.clerum.io/catalog-version',
      'spec.image',
    ])
    expect(res.body.message).toBe(ACQUIRE_IDENTITY_MESSAGE)
  })
})

describe('generic McpServer POST', () => {
  async function postWith(
    api: Api,
    annotations: Record<string, string> | undefined,
    source?: string
  ) {
    const cr = await remoteOAuthMcpServer({
      serverName: 'forged',
      namespace: MCP_NS,
      grantScope: 'user',
      catalog: CATALOG,
    })
    const spec = structuredClone(cr.spec) as Spec
    if (source !== undefined) spec.oauth = { ...spec.oauth, source }
    return request(api.app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'forged', ...(annotations ? { annotations } : {}) },
        spec,
      })
  }

  it.each([
    ['catalog-id', { 'clerum.io/catalog-id': CATALOG.id }],
    ['catalog-version only', { 'clerum.io/catalog-version': CATALOG.version }],
  ])(
    'refuses a remote-OAuth create carrying %s (400), creating nothing',
    async (_, annotations) => {
      const api = setup()

      const res = await postWith(api, annotations)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('catalog_annotations_not_allowed')
      expect(api.customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
      expect(stored(api, 'forged')).toBeUndefined()
    }
  )

  // The create alone is not a catalog instance; what must not happen is the PUT
  // that completes the identity afterwards.
  it('a create with catalog annotations and a non-remote OAuth source cannot become an instance by PUT (409)', async () => {
    const api = setup()

    const created = await postWith(api, { 'clerum.io/catalog-id': CATALOG.id }, 'notion')
    expect(created.status).toBe(201)
    const before = structuredClone(stored(api, 'forged')!)
    const remote = await remoteOAuthMcpServer({
      serverName: 'forged',
      namespace: MCP_NS,
      grantScope: 'user',
    })
    api.customApi.replaceNamespacedCustomObject.mockClear()

    const res = await editPagePut(api, remote.spec as Spec, 'forged')

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('catalog_instance_immutable')
    expect(res.body.fields).toContain('spec.oauth.source')
    expect(res.body.message).toBe(ACQUIRE_IDENTITY_MESSAGE)
    expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
    expect(stored(api, 'forged')).toEqual(before)
  })

  it('a create with catalog annotations and no spec cannot become an instance by PUT (409)', async () => {
    const api = setup()

    const created = await request(api.app)
      .post('/admin/mcp-servers')
      .send({ metadata: { name: 'forged', annotations: { 'clerum.io/catalog-id': CATALOG.id } } })
    expect(created.status).toBe(201)
    const before = structuredClone(stored(api, 'forged')!)
    const remote = await remoteOAuthMcpServer({
      serverName: 'forged',
      namespace: MCP_NS,
      grantScope: 'user',
    })
    api.customApi.replaceNamespacedCustomObject.mockClear()

    const res = await editPagePut(
      api,
      { ...(remote.spec as Spec), remote: { baseUrl: 'https://evil.example.com/mcp' } },
      'forged'
    )

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('catalog_instance_immutable')
    expect(res.body.message).toBe(ACQUIRE_IDENTITY_MESSAGE)
    expect(api.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
    expect(stored(api, 'forged')).toEqual(before)
  })

  it('lets a remote-OAuth create without catalog annotations through', async () => {
    const api = setup()

    const res = await postWith(api, { 'example.com/note': 'x' })

    expect(res.status).toBe(201)
    expect(stored(api, 'forged')).toBeDefined()
  })
})

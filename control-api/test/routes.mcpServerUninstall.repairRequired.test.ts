import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { MockGateway } from './mockGateway.js'

/**
 * Generic McpServer uninstall (`DELETE /admin/mcp-servers/:name`): every cleanup runs
 * before the CR delete, so a failed step answers 503 repair_required naming the step,
 * leaves the CR in place, and the same DELETE completes the job (R3-H7).
 *
 * Observed on a stateful MockGateway (T4: what survives, not which calls were made).
 * The OAuth teardown's DB is a benign empty stub; the grants path against a real
 * Postgres lives in routes.mcpServerUninstall.repairRequired.realPostgres.
 */

const dbMock = vi.hoisted(() => ({
  query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 })),
}))
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: dbMock.query } }
})

const { config } = await import('../src/config.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')
const { clerumErrorHandler } = await import('../src/http/errorHandler.js')

const NS = config.mcpServersNamespace
const SERVER = 'srv'
const CREDENTIALS = `${SERVER}-credentials`

let prevContextsNs = ''
beforeEach(() => {
  prevContextsNs = config.contextsNamespace
  config.contextsNamespace = 'contexts-ns'
  dbMock.query.mockClear()
})
afterEach(() => {
  config.contextsNamespace = prevContextsNs
  vi.restoreAllMocks()
})

async function setup() {
  const gw = new MockGateway(NS)
  await gw.createResource('mcpservers', { metadata: { name: SERVER }, spec: {} }, NS)
  await gw.createResource(
    'contexts',
    { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a', mcpServers: [SERVER, 'b'] } },
    'contexts-ns'
  )
  gw.seedSecret(CREDENTIALS, NS, { stringData: { TOKEN: 'x' } })
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gw as unknown as K8sGateway))
  return { gw, app }
}

async function allowlist(gw: MockGateway): Promise<string[]> {
  const ctx = (await gw.getResource('contexts', 'ctx-a', 'contexts-ns')) as {
    spec: { mcpServers?: string[] }
  }
  return ctx.spec.mcpServers ?? []
}

const grantsPurges = () =>
  dbMock.query.mock.calls.filter(([text]) => /DELETE\s+FROM\s+oauth_grants/i.test(text)).length

const conflict = () =>
  Object.assign(new Error('the object has been modified'), { statusCode: 409, code: 409 })
const serverError = () =>
  Object.assign(new Error('etcd unavailable'), { statusCode: 500, code: 500 })

describe('DELETE /admin/mcp-servers/:name — cleanup before delete, 503 repair_required', () => {
  it('a Context strip failure stops before any OAuth, Secret or CR change', async () => {
    const { gw, app } = await setup()
    vi.spyOn(gw, 'updateResource').mockRejectedValue(serverError())

    const res = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      error: 'mcp_server_uninstall_incomplete',
      outcome: 'repair_required',
      pending: ['contexts'],
      deleted: [],
    })
    await expect(gw.getResource('mcpservers', SERVER, NS)).resolves.toBeTruthy()
    await expect(gw.getSecret(CREDENTIALS, NS)).resolves.toBeTruthy()
    expect(grantsPurges()).toBe(0)
  })

  it('retries a Context 409 a bounded number of times, then reports contexts pending', async () => {
    const { gw, app } = await setup()
    const update = vi.spyOn(gw, 'updateResource').mockRejectedValue(conflict())

    const res = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(res.status).toBe(503)
    expect(res.body.pending).toEqual(['contexts'])
    expect(update).toHaveBeenCalledTimes(3)
    await expect(gw.getResource('mcpservers', SERVER, NS)).resolves.toBeTruthy()
  })

  it('absorbs a Context 409 from a concurrent status write and completes', async () => {
    const { gw, app } = await setup()
    const realUpdate = MockGateway.prototype.updateResource
    let first = true
    vi.spyOn(gw, 'updateResource').mockImplementation(async (plural, name, body, ns) => {
      if (first && plural === 'contexts') {
        first = false
        throw conflict()
      }
      return realUpdate.call(gw, plural, name, body, ns)
    })

    const res = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(res.status).toBe(200)
    expect(await allowlist(gw)).toEqual(['b'])
  })

  it('a Secret delete failure keeps the CR and names secrets; the retry completes', async () => {
    const { gw, app } = await setup()
    const secretDelete = vi.spyOn(gw, 'deleteSecret').mockRejectedValueOnce(serverError())

    const first = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(first.status).toBe(503)
    expect(first.body.pending).toEqual(['secrets'])
    expect(first.body.deleted).toEqual(['Context/ctx-a (removed from allowlist)'])
    await expect(gw.getResource('mcpservers', SERVER, NS)).resolves.toBeTruthy()
    await expect(gw.getSecret(CREDENTIALS, NS)).resolves.toBeTruthy()

    secretDelete.mockRestore()
    const retry = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(retry.status).toBe(200)
    await expect(gw.getResource('mcpservers', SERVER, NS)).rejects.toThrow()
    await expect(gw.getSecret(CREDENTIALS, NS)).rejects.toThrow()
    expect(await allowlist(gw)).toEqual(['b'])
  })

  it('an unreadable Secret stops the uninstall before any mutation', async () => {
    const { gw, app } = await setup()
    vi.spyOn(gw, 'getSecret').mockRejectedValueOnce(serverError())

    const res = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(res.status).toBe(503)
    expect(res.body.pending).toEqual(['secrets'])
    expect(await allowlist(gw)).toEqual([SERVER, 'b'])
    await expect(gw.getResource('mcpservers', SERVER, NS)).resolves.toBeTruthy()
    expect(grantsPurges()).toBe(0)
  })

  it('a CR delete failure reports mcp_server with every dependency already cleaned', async () => {
    const { gw, app } = await setup()
    vi.spyOn(gw, 'deleteResource').mockRejectedValueOnce(serverError())

    const res = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(res.status).toBe(503)
    expect(res.body.pending).toEqual(['mcp_server'])
    expect(res.body.deleted).toEqual([
      'Context/ctx-a (removed from allowlist)',
      `Secret/${CREDENTIALS}`,
    ])
    await expect(gw.getResource('mcpservers', SERVER, NS)).resolves.toBeTruthy()
    await expect(gw.getSecret(CREDENTIALS, NS)).rejects.toThrow()
  })
})

describe('DELETE /admin/mcp-servers/:name — a missing CR touches nothing (R3-H5a)', () => {
  // A reinstall recreates the CR (and its Secrets, which a pre-registered install writes
  // before the CR) right after the uninstall's read found nothing. A name-addressed
  // cleanup at that point would tear down the NEW installation.
  it('answers 404 and leaves a CR, Secrets and allowlist recreated after the read intact', async () => {
    const gw = new MockGateway(NS)
    await gw.createResource(
      'contexts',
      { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a', mcpServers: [SERVER] } },
      'contexts-ns'
    )
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gw as unknown as K8sGateway))
    app.use(clerumErrorHandler)

    let recreatedUid: string | undefined
    const realGet = MockGateway.prototype.getResource
    vi.spyOn(gw, 'getResource').mockImplementation(async (plural, name, ns) => {
      try {
        return await realGet.call(gw, plural, name, ns)
      } catch (err) {
        if (plural === 'mcpservers' && name === SERVER && recreatedUid === undefined) {
          gw.seedSecret(CREDENTIALS, NS, { stringData: { TOKEN: 'new' } })
          gw.seedSecret(`${SERVER}-oauth-client`, NS, {
            labels: { 'clerum.io/managed-by': 'control-api' },
            stringData: { client_id: 'id', client_secret: 'sec' },
          })
          const cr = (await gw.createResource(
            'mcpservers',
            { metadata: { name: SERVER }, spec: { image: 'reinstall' } },
            NS
          )) as { metadata: { uid: string } }
          recreatedUid = cr.metadata.uid
        }
        throw err
      }
    })

    const res = await request(app).delete(`/admin/mcp-servers/${SERVER}`)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: `mcpservers/${SERVER} not found` })
    await expect(realGet.call(gw, 'mcpservers', SERVER, NS)).resolves.toMatchObject({
      metadata: { uid: recreatedUid },
    })
    await expect(gw.getSecret(CREDENTIALS, NS)).resolves.toBeTruthy()
    await expect(gw.getSecret(`${SERVER}-oauth-client`, NS)).resolves.toBeTruthy()
    expect(await allowlist(gw)).toEqual([SERVER])
    expect(grantsPurges()).toBe(0)
  })
})

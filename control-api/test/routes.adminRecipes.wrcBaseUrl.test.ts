import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express, Response as ExpressResponse, NextFunction, Request } from 'express'
import http from 'node:http'
import request from 'supertest'
import { MockGateway } from './mockGateway.js'

const MCP_NS = 'mcp-server'
const SANDBOX_NS = 'sandbox-recipes'

function startTestServer(app: Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0)
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

function closeTestServer(server: http.Server | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve()
      return
    }
    server.close(err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

describe('routes/admin/recipes WRC base URL config', () => {
  const fetchMock = vi.fn<typeof fetch>()
  let previousWrcUrl: string | undefined

  beforeEach(() => {
    // Isolate module-cache reset from the large admin recipes HTTP suite.
    previousWrcUrl = process.env.CONTROL_API_WORKFLOW_RECIPES_URL
    process.env.CONTROL_API_WORKFLOW_RECIPES_URL = 'http://fake-wrc:9999'
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousWrcUrl === undefined) delete process.env.CONTROL_API_WORKFLOW_RECIPES_URL
    else process.env.CONTROL_API_WORKFLOW_RECIPES_URL = previousWrcUrl
    vi.resetModules()
  })

  it('ignores CONTROL_API_WORKFLOW_RECIPES_URL and uses the internal WRC service URL', async () => {
    vi.resetModules()
    const { createAdminRecipesRouter } = await import('../src/routes/admin/recipes.js')

    const gateway = new MockGateway(MCP_NS)
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r2' }, spec: {} },
      SANDBOX_NS
    )

    const app = express()
    app.use(express.json())
    app.use(
      (
        req: Request & {
          adminAuth?: { sub: string; role: string; jti: string; exp: number; typ: 'user' }
        },
        _res: ExpressResponse,
        next: NextFunction
      ) => {
        req.adminAuth = { sub: 'admin-bob', role: 'admin', jti: 'j', exp: 9999999999, typ: 'user' }
        next()
      }
    )
    app.use(createAdminRecipesRouter(gateway as never))

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from('hi').buffer,
    } as unknown as Response)

    const server = await startTestServer(app)
    try {
      await request(server).get('/admin/recipes/r2/artifacts/a.txt/download').expect(200)
    } finally {
      await closeTestServer(server)
    }

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/r2/artifacts/a.txt'
    )
  })
})

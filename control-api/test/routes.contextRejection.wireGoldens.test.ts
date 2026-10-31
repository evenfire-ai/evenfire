import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * Golden wire bodies of the Context writes refused for the connectors they add,
 * consumed verbatim by control-ui (control-ui/test/fixtures/contextMcpServerRejection.ts).
 * control-ui cannot import control-api, so instead of retyping the 422 bodies there,
 * each golden is what the real resources router answers over an in-memory apiserver.
 *
 * A producer change fails the equality below and forces the golden to move. To
 * regenerate after an intended change:
 * `UPDATE_WIRE_GOLDENS=1 npx vitest run <this file>`, then review the JSON diff.
 */

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const WIRE_DIR = new URL('./fixtures/wire/', import.meta.url)

type WireCapture = { status: number; body: unknown }

function golden(name: string, actual: WireCapture): WireCapture {
  const file = new URL(`contextRejection.${name}.json`, WIRE_DIR)
  if (UPDATE) {
    mkdirSync(WIRE_DIR, { recursive: true })
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as WireCapture
}

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
  )) as { metadata: { resourceVersion: string } }
}

describe('context rejection wire goldens', () => {
  it('unknownMcpServer: a PUT that adds a connector with no McpServer → 422', async () => {
    const api = setup()
    await seedServer(api, 'live')
    const ctx = await seedContext(api, 'agent-ctx', ['live'])
    const res = await request(api.app)
      .put('/admin/contexts/agent-ctx')
      .send({
        metadata: { resourceVersion: ctx.metadata.resourceVersion },
        spec: { contextId: 'agent-ctx', mcpServers: ['live', 'mcp-vanished'] },
      })
    const actual: WireCapture = { status: res.status, body: res.body }
    // Captured before the checks, so a regeneration records even a changed shape.
    const expected = golden('unknownMcpServer', actual)
    expect(actual.status).toBe(422)
    expect(actual.body).toMatchObject({ error: 'unknown_mcp_server', mcpServers: ['mcp-vanished'] })
    expect(actual).toEqual(expected)
  })

  it('unknownMcpServers: a create naming two missing connectors → 422 listing both', async () => {
    const api = setup()
    const res = await request(api.app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'new-agent-ctx' },
        spec: { contextId: 'new-agent-ctx', mcpServers: ['mcp-gone-b', 'mcp-gone-a'] },
      })
    const actual: WireCapture = { status: res.status, body: res.body }
    // Captured before the checks, so a regeneration records even a changed shape.
    const expected = golden('unknownMcpServers', actual)
    expect(actual.status).toBe(422)
    expect(actual).toEqual(expected)
  })

  it('tooManyMcpServers: a write adding more names than the per-write cap → 422', async () => {
    const api = setup()
    const ctx = await seedContext(api, 'agent-ctx', [])
    const names = Array.from({ length: 257 }, (_, index) => `mcp-${index}`)
    const res = await request(api.app)
      .put('/admin/contexts/agent-ctx')
      .send({
        metadata: { resourceVersion: ctx.metadata.resourceVersion },
        spec: { contextId: 'agent-ctx', mcpServers: names },
      })
    const actual: WireCapture = { status: res.status, body: res.body }
    // Captured before the checks, so a regeneration records even a changed shape.
    const expected = golden('tooManyMcpServers', actual)
    expect(actual.status).toBe(422)
    expect(actual.body).toMatchObject({ error: 'too_many_mcp_servers' })
    expect(actual).toEqual(expected)
  })
})

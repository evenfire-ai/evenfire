// Regenerate after an intended contract change: `UPDATE_WIRE_GOLDENS=1 npx vitest run test/contracts.llmModelsSetupEnsure.wire.test.ts`, then review the JSON diff.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

/**
 * The admin llm-models wire contract that minikube setup consumes from shell
 * (scripts/e2e/llm-model-ensure.sh): its hermetic test serves these responses
 * from a curl stub instead of hand-written JSON. Every body is what the real
 * routes and services answer; only Postgres, the admin session and the
 * ConfigMap writer are stand-ins, fed rows in the shape Postgres returns.
 */

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const DIR = new URL('./fixtures/wire/', import.meta.url)
const FILE = new URL('llmModelsSetupEnsure.wire.json', DIR)

const mockPoolQuery = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
    work({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
  advisoryLockModelName: async () => {},
  advisoryLockModelNames: async () => {},
  boundCarrierTransactionIdleTimeout: async () => {},
}))

const ADMIN_ID = '00000000-0000-4000-8000-000000000001'

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: () => ({
    sub: ADMIN_ID,
    typ: 'user',
    role: 'admin',
    jti: 'admin-jti',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: async () => ({
    id: ADMIN_ID,
    username: 'admin',
    email: 'admin@example.com',
    passwordHash: 'hash',
    sessionVersion: 0,
    role: 'admin',
    status: 'active',
    failedAttempts: 0,
    lockedUntil: null,
  }),
  isAdminTokenRevoked: async () => false,
}))

const AT = new Date('2026-11-01T00:00:00.000Z')

// Rows as Postgres returns them for MODEL_COLUMNS.
const ENABLED_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  vendor: null,
  display_name: null,
  context_window_tokens: null,
  enabled: true,
  source: 'discovery',
  discovered_at: AT,
  last_seen_at: AT,
  stale: false,
  image_input: null,
  created_at: AT,
  updated_at: AT,
}
const DISABLED_ROW = {
  ...ENABLED_ROW,
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'zai',
  model: 'glm-4.7',
  enabled: false,
}
const MANUAL_ROW = {
  ...ENABLED_ROW,
  id: '33333333-3333-4333-8333-333333333333',
  provider: 'zai',
  model: 'glm-5.1',
  source: 'manual',
  discovered_at: null,
  last_seen_at: null,
}

type Wire = { status: number; body: unknown }

function authed(gateway: MockGateway) {
  const agent = request(createApp(gateway as never))
  const cookie = 'control_ui_admin_session=admin-token'
  return {
    get: (path: string) => agent.get(path).set('Cookie', cookie),
    post: (path: string, body: object) => agent.post(path).set('Cookie', cookie).send(body),
    put: (path: string, body: object) => agent.put(path).set('Cookie', cookie).send(body),
  }
}

function wire(res: { status: number; body: unknown }): Wire {
  return { status: res.status, body: res.body }
}

async function buildContract(): Promise<Record<string, Wire>> {
  const ok = new MockGateway('mcp-server')
  ok.setLlmAllowedModelsConfigMapMaterialize(async () => {})
  const failing = new MockGateway('mcp-server')
  failing.setLlmAllowedModelsConfigMapMaterialize(async () => {
    throw new Error('apiserver unavailable')
  })
  const api = authed(ok)
  const contract: Record<string, Wire> = {}

  mockPoolQuery.mockResolvedValueOnce({ rows: [ENABLED_ROW, DISABLED_ROW], rowCount: 2 })
  contract.list = wire(await api.get('/api/v1/admin/llm-models'))

  mockPoolQuery
    .mockResolvedValueOnce({ rows: [MANUAL_ROW], rowCount: 1 }) // INSERT … RETURNING
    .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
  contract.create = wire(
    await api.post('/api/v1/admin/llm-models', { provider: 'zai', model: 'glm-5.1', enabled: true })
  )

  mockPoolQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
  contract.create_conflict = wire(
    await api.post('/api/v1/admin/llm-models', { provider: 'zai', model: 'glm-5.1', enabled: true })
  )

  mockPoolQuery
    .mockResolvedValueOnce({ rows: [MANUAL_ROW], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
  contract.create_configmap_write_failed = wire(
    await authed(failing).post('/api/v1/admin/llm-models', {
      provider: 'zai',
      model: 'glm-5.1',
      enabled: true,
    })
  )

  mockPoolQuery
    .mockResolvedValueOnce({ rows: [DISABLED_ROW], rowCount: 1 }) // route read
    .mockResolvedValueOnce({ rows: [DISABLED_ROW], rowCount: 1 }) // locked read
    .mockResolvedValueOnce({ rows: [{ ...DISABLED_ROW, enabled: true }], rowCount: 1 }) // UPDATE
    .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
  contract.enable = wire(
    await api.put(`/api/v1/admin/llm-models/${DISABLED_ROW.id}`, { enabled: true })
  )

  return contract
}

describe('admin llm-models wire contract read by minikube setup', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })
  afterEach(() => vi.clearAllMocks())

  it('carries the fields and codes the shell ensure reads', async () => {
    const c = await buildContract()
    expect(c.list.status).toBe(200)
    const rows = (c.list.body as { rows: Record<string, unknown>[] }).rows
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(typeof row.id).toBe('string')
      expect(typeof row.provider).toBe('string')
      expect(typeof row.model).toBe('string')
      expect(typeof row.enabled).toBe('boolean')
    }
    expect(rows[1]?.enabled).toBe(false)
    expect(c.create.status).toBe(201)
    expect(c.create_conflict).toMatchObject({ status: 409, body: { error: 'conflict' } })
    expect(c.create_configmap_write_failed).toMatchObject({
      status: 503,
      body: { error: 'configmap_write_failed' },
    })
    expect(c.enable).toMatchObject({ status: 200, body: { enabled: true } })
  })

  it('matches the committed fixture', async () => {
    const actual = JSON.parse(JSON.stringify(await buildContract())) as unknown
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(FILE, `${JSON.stringify(actual, null, 2)}\n`)
    }
    const committed = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    expect(actual).toEqual(committed)
  })
})

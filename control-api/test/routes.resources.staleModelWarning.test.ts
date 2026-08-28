import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { MockGateway } from './mockGateway.js'

// Fase 6 — soft quarantine of `stale` models, OPERATOR PATH ONLY. Route-level
// proof (T4: assert the HTTP body) that a NEW assignment of an enabled-but-stale
// model answers 200/201 with an additive `warnings` array — NEVER a 422/409 — and
// that a live reference is not revalidated, that a non-stale model warns nothing,
// and that a write that fails to persist surfaces no warning.

// R1-H3 fase 1: Host create/update wrap validation + the K8s write in a carrier
// transaction holding a per-model-name advisory lock. Keep db.js real; stub only
// the transaction runner + lock / idle-timeout guards so these route tests need no
// live Postgres (serialization is covered by the real-Postgres race test).
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

const llm = vi.hoisted(() => ({
  isModelAllowed: vi.fn(),
  getModelAllowlistState: vi.fn(),
}))
vi.mock('../src/services/llmAllowedModels.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/llmAllowedModels.js')>(
    '../src/services/llmAllowedModels.js'
  )
  return {
    ...actual,
    isModelAllowed: llm.isModelAllowed,
    getModelAllowlistState: llm.getModelAllowlistState,
  }
})

const HOSTS_NS = config.hostsNamespace

function buildApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return app
}

// `M` is the enabled-but-stale model; everything else is enabled and fresh.
beforeEach(() => {
  llm.isModelAllowed.mockReset()
  llm.getModelAllowlistState.mockReset()
  llm.isModelAllowed.mockResolvedValue(true) // all models enabled by default
  llm.getModelAllowlistState.mockImplementation((_p: string, m: string) =>
    Promise.resolve({ enabled: true, stale: m === 'M' })
  )
})

const staleSpec = { model: { provider: 'claude', name: 'M' } }
const freshSpec = { model: { provider: 'claude', name: 'OTHER' } }

describe('Host stale soft-quarantine warnings (Fase 6)', () => {
  it('CREATE with an enabled+stale model → 201 + warnings, never 422', async () => {
    const gateway = new MockGateway(HOSTS_NS)
    const res = await request(buildApp(gateway))
      .post('/admin/hosts')
      .send({ metadata: { name: 'h1' }, spec: staleSpec })

    expect(res.status).toBe(201)
    expect(res.body.warnings).toEqual([
      { code: 'stale_model_assigned', provider: 'claude', model: 'M', field: 'spec.model.name' },
    ])
  })

  it('EDIT introducing a stale model (new pair) → 200 + warnings', async () => {
    const gateway = new MockGateway(HOSTS_NS)
    // Stored default is a fresh model; the edit switches it to the stale M.
    await gateway.createResource('hosts', { metadata: { name: 'h1' }, spec: freshSpec }, HOSTS_NS)

    const res = await request(buildApp(gateway)).put('/admin/hosts/h1').send({ spec: staleSpec })

    expect(res.status).toBe(200)
    expect(res.body.warnings).toEqual([
      { code: 'stale_model_assigned', provider: 'claude', model: 'M', field: 'spec.model.name' },
    ])
  })

  it('EDIT keeping an EXISTING stale reference → 200 + NO warnings (not revalidated)', async () => {
    const gateway = new MockGateway(HOSTS_NS)
    // The stale M was already the stored default — a live reference.
    await gateway.createResource('hosts', { metadata: { name: 'h1' }, spec: staleSpec }, HOSTS_NS)

    const res = await request(buildApp(gateway)).put('/admin/hosts/h1').send({ spec: staleSpec })

    expect(res.status).toBe(200)
    expect(res.body.warnings).toBeUndefined()
  })

  it('EDIT to an enabled non-stale model → 200 + NO warnings', async () => {
    const gateway = new MockGateway(HOSTS_NS)
    await gateway.createResource('hosts', { metadata: { name: 'h1' }, spec: staleSpec }, HOSTS_NS)

    const res = await request(buildApp(gateway)).put('/admin/hosts/h1').send({ spec: freshSpec })

    expect(res.status).toBe(200)
    expect(res.body.warnings).toBeUndefined()
  })

  // R1-B1: the stale-warning lookup (getModelAllowlistState) is an EXTRA query,
  // separate from the isModelAllowed gate. It ONLY feeds the additive warning, so
  // a failure on it must NEVER block a valid write — the PR invariant is "additive,
  // never blocks (never 422/409/500)". Before the fix the rejection propagated
  // through validateHostSpec → asyncHandler → HTTP 500, ahead of createResource /
  // updateResource. Assert the OBSERVABLE result (T4): the Host still persists.
  it('CREATE persists (201) when the stale-warning lookup rejects (best-effort, no 500)', async () => {
    llm.getModelAllowlistState.mockRejectedValue(new Error('db connection reset'))
    const gateway = new MockGateway(HOSTS_NS)

    const res = await request(buildApp(gateway))
      .post('/admin/hosts')
      .send({ metadata: { name: 'h1' }, spec: staleSpec })

    expect(res.status).toBe(201)
    // The CR actually landed with the requested spec — not just a non-500 status.
    expect((res.body as { metadata: { name: string } }).metadata.name).toBe('h1')
    expect((res.body as { spec: typeof staleSpec }).spec.model.name).toBe('M')
    const stored = (await gateway.getResource('hosts', 'h1', HOSTS_NS)) as {
      spec: typeof staleSpec
    }
    expect(stored.spec.model.name).toBe('M')
    // Best-effort degrade: no warning surfaced, but the write is not blocked.
    expect(res.body.warnings).toBeUndefined()
  })

  it('EDIT persists (200) when the stale-warning lookup rejects (best-effort, no 500)', async () => {
    llm.getModelAllowlistState.mockRejectedValue(new Error('db connection reset'))
    const gateway = new MockGateway(HOSTS_NS)
    // Stored default is a fresh model; the edit switches it to a new pair, which
    // is exactly the path that triggers the (now-guarded) warning lookup.
    await gateway.createResource('hosts', { metadata: { name: 'h1' }, spec: freshSpec }, HOSTS_NS)

    const res = await request(buildApp(gateway)).put('/admin/hosts/h1').send({ spec: staleSpec })

    expect(res.status).toBe(200)
    expect((res.body as { spec: typeof staleSpec }).spec.model.name).toBe('M')
    const stored = (await gateway.getResource('hosts', 'h1', HOSTS_NS)) as {
      spec: typeof staleSpec
    }
    expect(stored.spec.model.name).toBe('M')
    expect(res.body.warnings).toBeUndefined()
  })

  it('does NOT surface a warning when the write fails to persist (updateResource throws)', async () => {
    class ThrowingGateway extends MockGateway {
      override async updateResource(): Promise<unknown> {
        throw new Error('k8s write failed')
      }
    }
    const gateway = new ThrowingGateway(HOSTS_NS)
    await gateway.createResource('hosts', { metadata: { name: 'h1' }, spec: freshSpec }, HOSTS_NS)

    const res = await request(buildApp(gateway)).put('/admin/hosts/h1').send({ spec: staleSpec })

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.body.warnings).toBeUndefined()
  })
})

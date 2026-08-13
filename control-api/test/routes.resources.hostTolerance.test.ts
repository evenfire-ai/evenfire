import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { MockGateway } from './mockGateway.js'

// Route-level proof (mini-spec 01) that the Pieza D audit event is emitted ONLY
// after the Host CR persists — never on a rejected or failed write. isModelAllowed
// is mocked to disable the model; the logger is mocked to observe emission.

const llm = vi.hoisted(() => ({ isModelAllowed: vi.fn() }))
vi.mock('../src/services/llmAllowedModels.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/llmAllowedModels.js')>(
    '../src/services/llmAllowedModels.js'
  )
  return { ...actual, isModelAllowed: llm.isModelAllowed }
})

const log = vi.hoisted(() => {
  const warn = vi.fn()
  const stub = () => ({
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => stub(),
  })
  return { warn, rootLogger: stub() }
})
vi.mock('../src/observability/logger.js', () => ({ rootLogger: log.rootLogger }))

const HOSTS_NS = config.hostsNamespace
const disabledModelSpec = { model: { provider: 'claude', name: 'M' } }

function buildApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return app
}

beforeEach(() => {
  log.warn.mockReset()
  // M is disabled globally; everything else is enabled.
  llm.isModelAllowed.mockImplementation((_p: string, m: string) => Promise.resolve(m !== 'M'))
})

describe('Host tolerance audit — emit only after persist (mini-spec 01)', () => {
  it('emits host_spec_incoherence_tolerated after a successful update', async () => {
    const gateway = new MockGateway(HOSTS_NS)
    // Seed the trapped Host directly (its default M is now disabled).
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'h1' }, spec: disabledModelSpec },
      HOSTS_NS
    )

    const res = await request(buildApp(gateway))
      .put('/admin/hosts/h1')
      .send({ spec: disabledModelSpec })

    expect(res.status).toBe(200)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'host_spec_incoherence_tolerated',
        gate: 'primary',
        provider: 'claude',
        model: 'M',
        name: 'h1',
      }),
      expect.any(String)
    )
  })

  it('does NOT emit when the CR fails to persist (updateResource throws)', async () => {
    class ThrowingGateway extends MockGateway {
      override async updateResource(): Promise<unknown> {
        throw new Error('k8s write failed')
      }
    }
    const gateway = new ThrowingGateway(HOSTS_NS)
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'h1' }, spec: disabledModelSpec },
      HOSTS_NS
    )

    const res = await request(buildApp(gateway))
      .put('/admin/hosts/h1')
      .send({ spec: disabledModelSpec })

    expect(res.status).toBeGreaterThanOrEqual(500)
    // Validation tolerated M, but the write did not persist → no audit record.
    expect(log.warn).not.toHaveBeenCalled()
  })
})

// Characterization of the two-tier role model at the write gate. NOT a bug repro:
// the behavior pinned here is the CONSCIOUS design the owner accepted for R1-H2.
// The two-tier model (primary strict vs any = fallback ∪ subset ∪ primary) only
// guards the ACTIVE `primary` slot; a disabled model that was a subset-only entry
// may be promoted to a fallback because it stays disabled in runtime (never enters
// the LLM allowlist ConfigMap) and never becomes the active default. This test
// exists so a later review round does not re-file that promotion as a
// "no-worsening violation" — the PR body wording ("keeps or degrades its role")
// was corrected separately; the intent lives here as an executable invariant.
describe('R1-H2 — intentional two-tier tolerance (characterization, not a bug)', () => {
  it('tolerates subset→fallback promotion of a disabled model — intentional two-tier design, not a bug (R1-H2)', async () => {
    const gateway = new MockGateway(HOSTS_NS)
    // Stored fixture derived from the real producer (MockGateway.createResource →
    // getResource, T1) — NOT hand-built: primary A (enabled), subset [A, M] with M
    // disabled globally by the beforeEach allowlist stub.
    await gateway.createResource(
      'hosts',
      {
        metadata: { name: 'h1' },
        spec: {
          model: { provider: 'claude', name: 'A' },
          allowedModels: [
            { provider: 'claude', model: 'A' },
            { provider: 'claude', model: 'M' },
          ],
        },
      },
      HOSTS_NS
    )

    // Incoming write moves the disabled M from subset-only into a fallback slot
    // (subset→fallback promotion), keeping A as the active primary and not shrinking
    // coverage. The active `primary` slot stays A (enabled), so the strict primary
    // gate is untouched; M is promoted only among the NON-active roles.
    const res = await request(buildApp(gateway))
      .put('/admin/hosts/h1')
      .send({
        spec: {
          model: { provider: 'claude', name: 'A' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'M' }] },
          allowedModels: [
            { provider: 'claude', model: 'A' },
            { provider: 'claude', model: 'M' },
          ],
        },
      })

    // Observable result (T4): the write is TOLERATED — 200, and the persisted CR
    // audits M at the fallback gate. This is the intentional two-tier behavior: M
    // remains disabled in runtime (out of the ConfigMap), so promoting it to a
    // non-active fallback is pure non-worsening, not a role elevation.
    expect(res.status).toBe(200)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'host_spec_incoherence_tolerated',
        gate: 'fallback',
        provider: 'claude',
        model: 'M',
        name: 'h1',
      }),
      expect.any(String)
    )
  })
})

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

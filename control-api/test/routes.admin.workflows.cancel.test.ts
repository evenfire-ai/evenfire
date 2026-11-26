import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createWorkflowsAdminRouter } from '../src/routes/admin/workflows/index.js'
import { WorkflowRunCancelError } from '../src/services/workflows/workflowRunCancelService.js'
import { MockGateway } from './mockGateway.js'

// Operator cancel route (X3): authentication, the admin trigger budget, and the
// mapping of path and service errors. The cancel service is mocked here; its
// statements are covered by workflowRunCancel.realPostgres.integration.test.ts.

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())
const mockVerifyAdminToken = vi.hoisted(() => vi.fn())
const mockIsAdminTokenRevoked = vi.hoisted(() => vi.fn())
const mockFindAdminById = vi.hoisted(() => vi.fn())
const mockCancelAsOperator = vi.hoisted(() => vi.fn())

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))
vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (token: string) => mockVerifyAdminToken(token),
}))
vi.mock('../src/services/adminAuthService.js', () => ({
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
  findAdminById: (...args: unknown[]) => mockFindAdminById(...args),
}))
vi.mock('../src/services/workflows/workflowRunCancelService.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/workflows/workflowRunCancelService.js')>()
  return {
    ...actual,
    cancelWorkflowRunAsOperator: (...args: unknown[]) => mockCancelAsOperator(...args),
  }
})

const NS = config.sandboxNamespace
const RECIPE = 'cancel-recipe'
const RUN_ID = '0b9d6c52-4b1e-4d3a-9f3e-2a7c1e5d8f10'
const OPERATOR_ID = 'admin-operator-1'
// Synthetic credentials: the token verifier is mocked, so these strings only
// select a branch of the mock.
const VALID_TOKEN = 'fixture-admin-session-valid'
const REVOKED_TOKEN = 'fixture-admin-session-revoked'
const GARBAGE_TOKEN = 'fixture-admin-session-garbage'

function cancelPath(ns = NS, name = RECIPE, runId = RUN_ID): string {
  return `/admin/workflows/${ns}/${name}/runs/${runId}/cancel`
}

function storedRun(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    recipe_namespace: NS,
    recipe_name: RECIPE,
    phase: 'Canceled',
    approval_request_id: null,
    created_at: new Date('2026-11-26T10:00:00.000Z'),
    started_at: null,
    completed_at: new Date('2026-11-26T10:01:00.000Z'),
    failure_reason: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    cancel_requested_at: new Date('2026-11-26T10:01:00.000Z'),
    canceled_by: `operator:${OPERATOR_ID}`,
    actor_type: 'scheduled',
    actor_id: null,
    team_id: null,
    ...overrides,
  }
}

function claimsFor(token: string) {
  if (token === VALID_TOKEN) {
    return { sub: OPERATOR_ID, typ: 'user', role: 'admin', jti: 'jti-valid', sessionVersion: 0 }
  }
  if (token === REVOKED_TOKEN) {
    return { sub: OPERATOR_ID, typ: 'user', role: 'admin', jti: 'jti-revoked', sessionVersion: 0 }
  }
  return null
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use(createWorkflowsAdminRouter(new MockGateway() as never))
  return app
}

function countRequests() {
  const counts = new Map<string, number>()
  mockCheckAndIncrement.mockReset()
  mockCheckAndIncrement.mockImplementation(async (key: string, limit: number) => {
    const windowStartMs = Math.floor(Date.now() / 60_000) * 60_000
    const identity = `${key}|${windowStartMs}`
    const count = (counts.get(identity) ?? 0) + 1
    counts.set(identity, count)
    return {
      allowed: count <= limit,
      backendAvailable: true,
      remaining: Math.max(0, limit - count),
      resetMs: windowStartMs + 60_000,
      windowStartMs,
      count,
    }
  })
  return counts
}

describe('POST /admin/workflows/:ns/:name/runs/:runId/cancel', () => {
  beforeEach(() => {
    // The limiter counts per wall-clock minute: freeze Date mid-window so a
    // loop cannot cross a minute boundary before the expected 429.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_030_000)
    countRequests()
    mockVerifyAdminToken.mockReset()
    mockVerifyAdminToken.mockImplementation((token: string) => claimsFor(token))
    mockIsAdminTokenRevoked.mockReset()
    mockIsAdminTokenRevoked.mockImplementation(async (jti: string) => jti === 'jti-revoked')
    mockFindAdminById.mockReset()
    mockFindAdminById.mockResolvedValue({ id: OPERATOR_ID, status: 'active', sessionVersion: 0 })
    mockCancelAsOperator.mockReset()
    mockCancelAsOperator.mockResolvedValue(storedRun())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a request without an admin session', async () => {
    const app = buildApp()

    const none = await request(app).post(cancelPath())
    expect(none.status).toBe(401)
    expect(none.body).toEqual({ error: 'Unauthorized' })

    const garbage = await request(app)
      .post(cancelPath())
      .set('Authorization', `Bearer ${GARBAGE_TOKEN}`)
    expect(garbage.status).toBe(401)
    expect(garbage.body).toEqual({ error: 'Unauthorized' })

    const revoked = await request(app)
      .post(cancelPath())
      .set('Cookie', `control_ui_admin_session=${REVOKED_TOKEN}`)
    expect(revoked.status).toBe(401)
    expect(revoked.body).toEqual({ error: 'Unauthorized' })
    // The revoked session was verified and then refused by the revocation read.
    expect(mockIsAdminTokenRevoked).toHaveBeenCalledWith('jti-revoked')

    expect(mockCancelAsOperator).not.toHaveBeenCalled()

    // Liveness witness: the same request with a valid session reaches the
    // service once, with the operator id of the session.
    const valid = await request(app)
      .post(cancelPath())
      .set('Cookie', `control_ui_admin_session=${VALID_TOKEN}`)
    expect(valid.status).toBe(200)
    expect(mockCancelAsOperator).toHaveBeenCalledTimes(1)
    expect(mockCancelAsOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        recipeNamespace: NS,
        recipeName: RECIPE,
        operatorId: OPERATOR_ID,
      })
    )
    expect(valid.body).toMatchObject({
      id: RUN_ID,
      source: 'live',
      phase: 'Canceled',
      canceledBy: `operator:${OPERATOR_ID}`,
    })
  })

  it('limits operator cancels with the admin trigger budget', async () => {
    const app = buildApp()
    const verifiedLimit = config.adminWorkflowTriggerPerMin
    expect(verifiedLimit).toBe(50)

    for (let i = 1; i <= verifiedLimit; i++) {
      const res = await request(app)
        .post(cancelPath())
        .set('Cookie', `control_ui_admin_session=${VALID_TOKEN}`)
      expect(res.status, `verified request ${i}`).not.toBe(429)
    }
    const overVerified = await request(app)
      .post(cancelPath())
      .set('Cookie', `control_ui_admin_session=${VALID_TOKEN}`)
    expect(overVerified.status).toBe(429)
    expect(mockCancelAsOperator).toHaveBeenCalledTimes(verifiedLimit)

    // The bucket is the admin trigger's: the same session's trigger is limited too.
    const trigger = await request(app)
      .post(`/admin/workflows/${NS}/${RECIPE}/trigger`)
      .set('Cookie', `control_ui_admin_session=${VALID_TOKEN}`)
      .send({})
    expect(trigger.status).toBe(429)
    const verifiedKeys = mockCheckAndIncrement.mock.calls
      .map(call => String(call[0]))
      .filter(key => key.startsWith('workflow_trigger_admin:') && !key.includes(':ip:'))
    expect(new Set(verifiedKeys).size).toBe(1)

    // An unverified credential gets the source-IP budget of 10.
    for (let i = 1; i <= 10; i++) {
      const res = await request(app)
        .post(cancelPath())
        .set('Authorization', `Bearer ${GARBAGE_TOKEN}`)
      expect(res.status, `unverified request ${i}`).not.toBe(429)
      expect(res.status).toBe(401)
    }
    const overUnverified = await request(app)
      .post(cancelPath())
      .set('Authorization', `Bearer ${GARBAGE_TOKEN}`)
    expect(overUnverified.status).toBe(429)
  })

  it('maps namespace, run id and service errors', async () => {
    const app = buildApp()
    const auth = (req: request.Test) => req.set('Cookie', `control_ui_admin_session=${VALID_TOKEN}`)

    const badNamespace = await auth(request(app).post(cancelPath('kube-system')))
    expect(badNamespace.status).toBe(404)
    expect(badNamespace.body).toEqual({ error: `Recipe kube-system/${RECIPE} not found` })

    const badRunId = await auth(request(app).post(cancelPath(NS, RECIPE, 'not-a-uuid')))
    expect(badRunId.status).toBe(400)
    expect(badRunId.body).toEqual({ error: 'Invalid workflow run id' })
    expect(mockCancelAsOperator).not.toHaveBeenCalled()

    // A run id the route pattern accepts (uppercase) reaches the service,
    // whose canonical check answers 404.
    mockCancelAsOperator.mockRejectedValueOnce(
      new WorkflowRunCancelError(404, 'workflow_run_not_found')
    )
    const upper = await auth(request(app).post(cancelPath(NS, RECIPE, RUN_ID.toUpperCase())))
    expect(upper.status).toBe(404)
    expect(upper.body).toEqual({ error: 'workflow_run_not_found' })
    expect(mockCancelAsOperator).toHaveBeenCalledTimes(1)
    expect(mockCancelAsOperator.mock.calls[0][0]).toMatchObject({ runId: RUN_ID.toUpperCase() })

    mockCancelAsOperator.mockRejectedValueOnce(
      new WorkflowRunCancelError(409, 'workflow_run_not_cancellable')
    )
    const terminal = await auth(request(app).post(cancelPath()))
    expect(terminal.status).toBe(409)
    expect(terminal.body).toEqual({ error: 'workflow_run_not_cancellable' })
    expect(mockCancelAsOperator).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { createExternalUserApprovalDecisionsRouter } from '../src/routes/external/decisions.routes.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'

const approvalId = '66666666-6666-4666-8666-666666666666'
const userId = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  sessionContract: 'v2' as 'v1' | 'v2',
  requireWorkflowActionAuthority: vi.fn(),
  requireCurrentWorkflowApprovalAuthority: vi.fn(),
  recordDecision: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  config: {
    approvalRlExternalClientIpPerMin: 1000,
    approvalRlExternalEdgePerMin: 1000,
    approvalRlExternalPerMin: 1000,
  },
}))

const passThrough = vi.hoisted(() => (_req: unknown, _res: unknown, next: () => void) => next())

vi.mock('../src/middleware/externalClientIdentity.js', () => ({
  createExternalClientRateLimiters: () => [],
}))
vi.mock('../src/middleware/mcpHostHttpMetrics.js', () => ({
  mcpHostHttpMetrics: () => passThrough,
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware: () => passThrough,
}))
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: Record<string, unknown>,
    _res: unknown,
    next: () => void
  ) => {
    req.externalAuth = { userId }
    req.externalSessionAuthentication = {
      authorityContext:
        mocks.sessionContract === 'v2'
          ? { contract: 'v2', userId, sid: 'sid-1', sessionVersion: 1 }
          : { contract: 'v1', userId },
    }
    next()
  },
}))
vi.mock('../src/middleware/approvalDecisionAccess.js', () => ({
  requireApprovalDecisionAccess:
    () => (req: Record<string, unknown>, _res: unknown, next: () => void) => {
      req.approval = { id: approvalId, target_team_id: null }
      next()
    },
}))
vi.mock('../src/services/userApprovalRequestService.js', () => {
  class ApprovalConsumeError extends Error {}
  class ApprovalTriggerRunIdempotencyConflictError extends Error {}
  class WorkflowApprovalAuthorityRequiredError extends Error {}
  class WorkflowApprovalAuthorityStaleError extends Error {}
  return {
    ApprovalConsumeError,
    ApprovalTriggerRunIdempotencyConflictError,
    WorkflowApprovalAuthorityRequiredError,
    WorkflowApprovalAuthorityStaleError,
    listPendingApprovalsForUser: vi.fn(),
    recordDecision: (...args: unknown[]) => mocks.recordDecision(...args),
  }
})
vi.mock('../src/services/workflows/workflowAuthorityBindingService.js', () => ({
  WorkflowAuthorityError: class WorkflowAuthorityError extends Error {},
  requireWorkflowActionAuthority: (...args: unknown[]) =>
    mocks.requireWorkflowActionAuthority(...args),
  requireCurrentWorkflowApprovalAuthority: (...args: unknown[]) =>
    mocks.requireCurrentWorkflowApprovalAuthority(...args),
}))
vi.mock('../src/services/workflows/workflowRunReadService.js', () => ({
  mapDbRun: (row: unknown) => row,
}))

const v2Authority = {
  bindingHash: 'binding-hash',
  binding: { operationId: 'workflow.approval.decide' },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalUserApprovalDecisionsRouter({} as never))
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: String(error) })
  })
  return app
}

describe('external approval decisions: action budget ownership (T-W2)', () => {
  let createBudget: ReturnType<typeof vi.spyOn>
  let closeBudget: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mocks.requireWorkflowActionAuthority.mockReset()
    mocks.requireCurrentWorkflowApprovalAuthority.mockReset()
    mocks.recordDecision.mockReset()
    createBudget = vi.spyOn(AccessExecutionBudget, 'create')
    closeBudget = vi.spyOn(AccessExecutionBudget.prototype, 'close')
  })

  afterEach(() => {
    createBudget.mockRestore()
    closeBudget.mockRestore()
  })

  it('creates and closes one action budget for the V2 in-transaction decision check', async () => {
    mocks.sessionContract = 'v2'
    mocks.requireWorkflowActionAuthority.mockResolvedValue(v2Authority)
    const budgetStateDuringCheck: unknown[] = []
    mocks.requireCurrentWorkflowApprovalAuthority.mockImplementation(
      async (input: { budget: AccessExecutionBudget }) => {
        budgetStateDuringCheck.push(input.budget, input.budget.signal.aborted)
        return v2Authority
      }
    )
    mocks.recordDecision.mockImplementation(async (...args: unknown[]) => {
      const reauthorize = args[7] as {
        validateCurrentInTransaction: (db: unknown) => Promise<unknown>
      }
      await reauthorize.validateCurrentInTransaction({ query: vi.fn() })
      return { ok: true }
    })

    const response = await request(makeApp())
      .post(`/external/workflow-approvals/${approvalId}/decide`)
      .send({ decision: 'approve' })

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    // No request-scoped budget is attached by middleware any more.
    const [routeInput] = mocks.requireWorkflowActionAuthority.mock.calls[0] as [
      { req: { accessExecutionBudget?: unknown } },
    ]
    expect(routeInput.req.accessExecutionBudget).toBeUndefined()
    // Witness and X5/M2: the in-transaction check ran once with its own budget,
    // live during the check and closed afterwards.
    expect(mocks.requireCurrentWorkflowApprovalAuthority).toHaveBeenCalledTimes(1)
    expect(createBudget).toHaveBeenCalledTimes(1)
    expect(createBudget).toHaveBeenCalledWith('action')
    const budget = createBudget.mock.results[0]?.value
    expect(budgetStateDuringCheck).toEqual([budget, false])
    expect(closeBudget).toHaveBeenCalledTimes(1)
    expect(closeBudget.mock.contexts[0]).toBe(budget)
  })

  it('allocates no budget for a V1 decision', async () => {
    mocks.sessionContract = 'v1'
    mocks.requireWorkflowActionAuthority.mockResolvedValue(null)
    mocks.recordDecision.mockResolvedValue({ ok: true })

    const response = await request(makeApp())
      .post(`/external/workflow-approvals/${approvalId}/decide`)
      .send({ decision: 'deny' })

    // Witness: the V1 handler answered and recorded the decision.
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(mocks.recordDecision).toHaveBeenCalledTimes(1)
    expect(mocks.recordDecision.mock.calls[0]).toHaveLength(5)
    const [routeInput] = mocks.requireWorkflowActionAuthority.mock.calls[0] as [
      { req: { accessExecutionBudget?: unknown } },
    ]
    expect(routeInput.req.accessExecutionBudget).toBeUndefined()
    expect(createBudget).toHaveBeenCalledTimes(0)
    expect(mocks.requireCurrentWorkflowApprovalAuthority).toHaveBeenCalledTimes(0)
  })
})

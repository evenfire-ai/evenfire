import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { DatabaseError } from 'pg'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { rootLogger } from '../src/observability/logger.js'
import {
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../src/services/access/accessExecutionBudget.js'

const policy = vi.hoisted(() => ({ resolveEffectiveUserAccessPolicy: vi.fn() }))
const admission = vi.hoisted(() => ({ admitHostRpc: vi.fn() }))
const checkpoint = vi.hoisted(() => ({
  parseActionAuthorityCheckpointRequest: vi.fn(),
  checkpointActionAuthority: vi.fn(),
}))
const revalidation = vi.hoisted(() => ({ revalidateWorkflowTriggerCheckpoint: vi.fn() }))
const hostMessage = vi.hoisted(() => ({ admitHostMessage: vi.fn() }))
const receipt = vi.hoisted(() => ({ issueHostMessageAdmissionReceipt: vi.fn() }))
const caller = vi.hoisted(() => ({
  identity: { service: 'rpc-proxy', trustPlane: 'internal_service_token' } as Record<
    string,
    unknown
  >,
}))

vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => policy)
vi.mock('../src/services/hostRpcAdmission.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  admitHostRpc: admission.admitHostRpc,
}))
vi.mock('../src/services/hostMessageAdmission.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  admitHostMessage: hostMessage.admitHostMessage,
}))
vi.mock('../src/utils/auth/hostMessageAdmissionReceipt.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  issueHostMessageAdmissionReceipt: receipt.issueHostMessageAdmissionReceipt,
}))
vi.mock('../src/services/access/actionAuthorityCheckpoint.js', () => checkpoint)
vi.mock('../src/services/workflows/workflowTriggerCheckpointRevalidation.js', () => revalidation)
vi.mock('../src/middleware/actionCheckpointCaller.js', () => ({
  requireActionCheckpointCaller: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.actionCheckpointCaller = caller.identity as never
    next()
  },
}))

const { createInternalActionAuthorityCheckpointRouter } =
  await import('../src/routes/internal/actionAuthorityCheckpoint.js')
const { HostMessageAdmissionReceiptBindingError } =
  await import('../src/utils/auth/hostMessageAdmissionReceipt.js')
const { AuthorityDependencyUnavailableError } =
  await import('../src/services/access/authorityDependency.js')

const AUTHORITY_UNAVAILABLE = {
  version: 2,
  status: 'authority_unavailable',
  code: 'authority_unavailable',
  retryable: true,
}
const SUBJECT = '10000000-0000-4000-8000-000000000001'

function parsed(operationId: 'host.status.read' | 'workflow.trigger') {
  return {
    version: 2,
    principal: { sub: SUBJECT, sid: '20000000-0000-4000-8000-000000000002', sessionVersion: 1 },
    operationId,
    resource: { type: operationId === 'workflow.trigger' ? 'workflow_recipe' : 'host' },
    target: {},
  }
}

function app() {
  const server = express()
  server.use(express.json())
  server.use(createInternalActionAuthorityCheckpointRouter({} as never))
  server.use(clerumErrorHandler)
  return server
}

function postCheckpoint() {
  return request(app()).post('/internal/action-authority/checkpoint').send({})
}

describe('internal action-authority checkpoint: one action budget (C12 P4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    caller.identity = { service: 'rpc-proxy', trustPlane: 'internal_service_token' }
    policy.resolveEffectiveUserAccessPolicy.mockResolvedValue({ actionContextV2: true })
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(parsed('host.status.read'))
    admission.admitHostRpc.mockResolvedValue({ status: 'allowed', check: {} })
    checkpoint.checkpointActionAuthority.mockResolvedValue({ version: 2, status: 'allowed' })
  })

  it('answers 503 authority_unavailable when an admission outlives the action deadline', async () => {
    admission.admitHostRpc.mockReturnValue(new Promise(() => undefined))
    const startedAt = performance.now()

    const response = await postCheckpoint()

    const elapsedMs = performance.now() - startedAt
    expect(response.status).toBe(503)
    expect(response.body).toEqual(AUTHORITY_UNAVAILABLE)
    // The request ends by the 2 s action deadline, not by the admission.
    expect(elapsedMs).toBeGreaterThanOrEqual(1_900)
    expect(elapsedMs).toBeLessThan(3_000)
    // Witness: the admission was entered once, and the policy read ran under
    // the request budget before it.
    expect(admission.admitHostRpc).toHaveBeenCalledExactlyOnceWith(SUBJECT)
    expect(policy.resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(1)
    const [{ budget }] = policy.resolveEffectiveUserAccessPolicy.mock.calls[0] as [
      { budget: AccessExecutionBudget },
    ]
    expect(budget).toBeInstanceOf(AccessExecutionBudget)
    expect(checkpoint.checkpointActionAuthority).not.toHaveBeenCalled()
  })

  it('runs the policy read, the admission and the checkpoint under the same request budget', async () => {
    const response = await postCheckpoint()

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(admission.admitHostRpc).toHaveBeenCalledTimes(1)
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(1)
    const [{ budget: policyBudget }] = policy.resolveEffectiveUserAccessPolicy.mock.calls[0] as [
      { budget: AccessExecutionBudget },
    ]
    const [{ budget: checkpointBudget }] = checkpoint.checkpointActionAuthority.mock.calls[0] as [
      { budget: AccessExecutionBudget },
    ]
    expect(checkpointBudget).toBeInstanceOf(AccessExecutionBudget)
    expect(checkpointBudget).toBe(policyBudget)
    // The request middleware owns the budget and closes it with the response.
    await vi.waitFor(() => expect(checkpointBudget.signal.reason).toBe('closed'))
  })

  it('answers 503 authority_unavailable when the policy read outlives the action deadline', async () => {
    policy.resolveEffectiveUserAccessPolicy.mockImplementation(
      ({ budget }: { budget: AccessExecutionBudget }) =>
        budget.untilDeadline(new Promise(() => undefined))
    )

    const response = await postCheckpoint()

    expect(response.status).toBe(503)
    expect(response.body).toEqual(AUTHORITY_UNAVAILABLE)
    // Witness: the read was entered with the request budget.
    expect(policy.resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(1)
    expect(checkpoint.parseActionAuthorityCheckpointRequest).not.toHaveBeenCalled()
    expect(admission.admitHostRpc).not.toHaveBeenCalled()
  })

  it('passes any other policy read failure to the error handler', async () => {
    const error = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined as never)
    try {
      policy.resolveEffectiveUserAccessPolicy.mockRejectedValue(new TypeError('policy defect'))

      const response = await postCheckpoint()

      expect(response.status).toBe(500)
      expect(policy.resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'unhandled_error' }),
        'unhandled error'
      )
      expect(admission.admitHostRpc).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})

describe('internal action-authority checkpoint: workflow revalidation failures (C12 Q7)', () => {
  let loggedError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    caller.identity = { service: 'workflow-recipes', trustPlane: 'internal_control_jwt' }
    policy.resolveEffectiveUserAccessPolicy.mockResolvedValue({ actionContextV2: true })
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue(parsed('workflow.trigger'))
    loggedError = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    loggedError.mockRestore()
  })

  it('logs a defect and answers 500 instead of a retryable 503', async () => {
    revalidation.revalidateWorkflowTriggerCheckpoint.mockRejectedValue(
      new TypeError('revalidation defect')
    )

    const response = await postCheckpoint()

    expect(response.status).toBe(500)
    expect(response.body).not.toMatchObject({ retryable: true })
    // Witness: the revalidation ran, and the error handler logged the defect.
    expect(revalidation.revalidateWorkflowTriggerCheckpoint).toHaveBeenCalledTimes(1)
    expect(loggedError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unhandled_error' }),
      'unhandled error'
    )
  })

  it('logs a non-availability database error and answers 500', async () => {
    const constraint = new DatabaseError('duplicate key', 0, 'error')
    constraint.code = '23505'
    revalidation.revalidateWorkflowTriggerCheckpoint.mockRejectedValue(constraint)

    const response = await postCheckpoint()

    expect(response.status).toBe(500)
    expect(revalidation.revalidateWorkflowTriggerCheckpoint).toHaveBeenCalledTimes(1)
    expect(loggedError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unhandled_error' }),
      'unhandled error'
    )
  })

  it.each([
    ['the request budget ended', () => new AccessExecutionCancelledError('deadline')],
    [
      'a classified database outage escaped',
      () => new AuthorityDependencyUnavailableError('database', new Error('terminated')),
    ],
    [
      'the database is shutting down',
      () => Object.assign(new DatabaseError('terminating', 0, 'error'), { code: '57P01' }),
    ],
    [
      'the database connection was reset',
      () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    ],
  ])('answers the retryable 503 when %s', async (_label, failure) => {
    revalidation.revalidateWorkflowTriggerCheckpoint.mockRejectedValue(failure())

    const response = await postCheckpoint()

    expect(response.status).toBe(503)
    expect(response.body).toEqual(AUTHORITY_UNAVAILABLE)
    expect(revalidation.revalidateWorkflowTriggerCheckpoint).toHaveBeenCalledTimes(1)
    expect(loggedError).not.toHaveBeenCalled()
  })

  it('passes the request budget to the revalidation', async () => {
    revalidation.revalidateWorkflowTriggerCheckpoint.mockResolvedValue({
      version: 2,
      status: 'denied',
      code: 'forbidden',
    })

    const response = await postCheckpoint()

    expect(response.status).toBe(403)
    const [{ budget }] = revalidation.revalidateWorkflowTriggerCheckpoint.mock.calls[0] as [
      { budget: AccessExecutionBudget },
    ]
    const [{ budget: policyBudget }] = policy.resolveEffectiveUserAccessPolicy.mock.calls[0] as [
      { budget: AccessExecutionBudget },
    ]
    expect(budget).toBeInstanceOf(AccessExecutionBudget)
    expect(budget).toBe(policyBudget)
  })
})

describe('internal action-authority checkpoint: host-message receipt failures (C12 Q7)', () => {
  let loggedError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    caller.identity = { service: 'rpc-proxy', trustPlane: 'internal_service_token' }
    policy.resolveEffectiveUserAccessPolicy.mockResolvedValue({ actionContextV2: true })
    checkpoint.parseActionAuthorityCheckpointRequest.mockReturnValue({
      ...parsed('host.status.read'),
      operationId: 'chat.message.invoke',
      hostMessageAdmission: {
        sendNonce: '50000000-0000-4000-8000-000000000005',
        delegationExpiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    })
    hostMessage.admitHostMessage.mockResolvedValue({ status: 'allowed', check: {} })
    checkpoint.checkpointActionAuthority.mockResolvedValue({ version: 2, status: 'allowed' })
    loggedError = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    loggedError.mockRestore()
  })

  it('answers the receipt with an allowed checkpoint', async () => {
    receipt.issueHostMessageAdmissionReceipt.mockReturnValue('receipt-token')

    const response = await postCheckpoint()

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ hostMessageAdmissionReceipt: 'receipt-token' })
    expect(hostMessage.admitHostMessage).toHaveBeenCalledExactlyOnceWith(SUBJECT)
  })

  it('answers 400 invalid_binding when the binding cannot carry a receipt', async () => {
    receipt.issueHostMessageAdmissionReceipt.mockImplementation(() => {
      throw new HostMessageAdmissionReceiptBindingError()
    })

    const response = await postCheckpoint()

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      version: 2,
      status: 'invalid_binding',
      code: 'invalid_binding',
    })
    // Witness: the checkpoint allowed it and the issuer ran.
    expect(checkpoint.checkpointActionAuthority).toHaveBeenCalledTimes(1)
    expect(receipt.issueHostMessageAdmissionReceipt).toHaveBeenCalledTimes(1)
    expect(loggedError).not.toHaveBeenCalled()
  })

  it('logs a signing defect and answers 500 instead of a retryable 503', async () => {
    receipt.issueHostMessageAdmissionReceipt.mockImplementation(() => {
      throw new Error('secretOrPrivateKey must be an asymmetric key when using RS256')
    })

    const response = await postCheckpoint()

    expect(response.status).toBe(500)
    expect(response.body).not.toMatchObject({ retryable: true })
    expect(receipt.issueHostMessageAdmissionReceipt).toHaveBeenCalledTimes(1)
    expect(loggedError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unhandled_error' }),
      'unhandled error'
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { gateStep } from '../../../workflow/userApprovalRequester'
import type { WorkflowCallerContext } from '../workflowShared'
import { workflowTriggerApprovalExecutionId } from '../workflowTriggerApprovalIdentity'
import { WorkflowTriggerTool } from '../workflowTriggerTool'

vi.mock('../../../workflow/userApprovalRequester', () => ({
  gateStep: vi.fn(),
}))

const mockedGateStep = vi.mocked(gateStep)

function jwtWithSub(sub: string): string {
  const [recipeNamespace, recipeName] = sub.split('/')
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ sub, recipeNamespace, recipeName, hostRefs: [sub] })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

function env() {
  const workflowControlToken = jwtWithSub('sandbox-recipes/source-recipe')
  const values: Record<string, string> = {
    MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
    MCP_HOST_WORKFLOW_CONTROL_TOKEN: workflowControlToken,
    MCP_HOST_RUNTIME_ACCESS_TOKEN: workflowControlToken,
    MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
  }
  return (key: string): string | undefined => values[key]
}

const context: WorkflowCallerContext = {
  targetUserId: '00000000-0000-4000-8000-000000000001',
  conversationId: 'telegram:tg-chat-1:123456',
  originChannelType: 'telegram',
  providerUserId: '123456',
  providerWorkspaceId: null,
  providerChannelId: 'tg-chat-1',
  providerEventId: 'telegram:tg-chat-1:42',
  sourceMessageId: 'telegram:tg-chat-1:42',
  sourceMessageContent: 'Run due diligence with depth full',
}

describe('WorkflowTriggerTool approval idempotency', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('uses one pre-approval idempotency key for the typed approval intent and trigger retry', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    const inputs = { depth: 'full' }
    const approvalExecutionId = workflowTriggerApprovalExecutionId({
      caller: 'sandbox-recipes/source-recipe',
      namespace: 'sandbox-recipes',
      name: 'due-diligence',
      targetUserId: context.targetUserId,
      inputs,
      workflowCallerContext: context,
    })
    expect(approvalExecutionId).toBeDefined()
    const runIdempotencyKey = `workflow-trigger-${createHash('sha256')
      .update(approvalExecutionId!)
      .digest('hex')}`
    mockedGateStep.mockResolvedValueOnce({ approvalRequestId, status: 'approved' })
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: { kind: 'user', label: 'Personal', userId: context.targetUserId },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'run-1', phase: 'Pending' }),
      } as Response)

    const tool = new WorkflowTriggerTool({ getEnv: env(), workflowCallerContext: context })
    const result = await tool.execute({ name: 'due-diligence', inputs })

    expect(result.is_error).toBe(false)
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: approvalExecutionId,
        idempotencyKeyOverride: runIdempotencyKey,
        workflowTriggerRunIntent: {
          inputs,
          intermediateParameters: null,
          outputOverrides: null,
        },
      }),
      expect.any(Object)
    )
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(init.headers).toEqual(
      expect.objectContaining({
        'Idempotency-Key': runIdempotencyKey,
      })
    )
  })

  it('rejects model-supplied idempotencyKey in authenticated chat before approval', async () => {
    const tool = new WorkflowTriggerTool({ getEnv: env(), workflowCallerContext: context })
    const result = await tool.execute({
      name: 'due-diligence',
      idempotencyKey: 'caller-controlled',
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('idempotencyKey is derived by the runtime')
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

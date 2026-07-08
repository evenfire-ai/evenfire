import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gateStep } from '../../../workflow/userApprovalRequester'
import { WorkflowTriggerTool } from '../workflowTriggerTool'

vi.mock('../../../workflow/userApprovalRequester', () => ({
  gateStep: vi.fn(),
}))

const mockedGateStep = vi.mocked(gateStep)

function jwtWithSub(sub: string): string {
  const [recipeNamespace, recipeName] = sub.split('/')
  return jwtWithClaims({ sub, recipeNamespace, recipeName, hostRefs: [sub] })
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.sig`
}

function env() {
  const workflowControlToken = jwtWithSub('sandbox-recipes/source-recipe')
  const values: Record<string, string> = {
    MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
    MCP_HOST_WORKFLOW_CONTROL_TOKEN: workflowControlToken,
    MCP_HOST_RUNTIME_ACCESS_TOKEN: workflowControlToken,
    MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE: 'sandbox-recipes',
    CLERUM_WORKFLOW_APPROVAL_RECIPE: 'source-recipe',
  }
  return (key: string): string | undefined => values[key]
}

describe('workflow_trigger effective target resolution', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('ignores workflow-name-derived target labels when the effective target is already unique', async () => {
    const teamId = '00000000-0000-4000-8000-0000000000aa'
    const recipeName = 'e2e-risk-review-palmera-team-abcd1234'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000789',
      status: 'approved',
    })
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: { kind: 'team', label: 'Treasury', teamId },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'run-1', phase: 'Pending' }),
      } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
        sourceMessageContent: `Trigger the workflow recipe named ${recipeName} with marker alpha`,
      },
    }).execute({
      name: recipeName,
      targetLabel: 'palmera-team',
      inputs: { marker: 'alpha' },
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName,
      conversationId: 'thread-1',
    })
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { teamId },
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName,
        },
      }),
      expect.any(Object)
    )
  })

  it('uses a user-supplied target label only after base resolution is ambiguous', async () => {
    const teamId = '00000000-0000-4000-8000-0000000000aa'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000789',
      status: 'approved',
    })
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ambiguous',
          targets: [
            { kind: 'user', label: 'Personal' },
            { kind: 'team', label: 'Treasury' },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: { kind: 'team', label: 'Treasury', teamId },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'run-1', phase: 'Pending' }),
      } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
        sourceMessageContent: 'Trigger the workflow recipe named risk-review for team Treasury',
      },
    }).execute({
      name: 'risk-review',
      targetLabel: 'Treasury',
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).not.toHaveProperty(
      'targetLabel'
    )
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual(
      expect.objectContaining({ targetLabel: 'Treasury' })
    )
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({ target: { teamId } }),
      expect.any(Object)
    )
  })

  it('uses the current user named recipe when the model proposes a stale workflow name', async () => {
    const teamId = '00000000-0000-4000-8000-0000000000aa'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000789',
      status: 'approved',
    })
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: { kind: 'team', label: 'Treasury', teamId },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'run-1', phase: 'Pending' }),
      } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
        sourceMessageContent:
          'Trigger the workflow recipe named shared-risk-review for team Treasury',
      },
    }).execute({
      name: 'palmera-team-review',
      targetLabel: 'Treasury',
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual(
      expect.objectContaining({ recipeName: 'shared-risk-review' })
    )
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/workflows/sandbox-recipes/shared-risk-review/trigger'
    )
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'shared-risk-review',
        },
      }),
      expect.any(Object)
    )
  })
})

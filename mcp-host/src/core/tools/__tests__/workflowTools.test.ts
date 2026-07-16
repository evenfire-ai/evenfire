import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { gateStep } from '../../../workflow/userApprovalRequester'
import {
  WorkflowHealthTool,
  WorkflowListTool,
  WorkflowResultTool,
  WorkflowStatusTool,
  WorkflowTriggerTool,
  createWorkflowTools,
} from '../workflow'

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

function env(overrides: Record<string, string> = {}) {
  const workflowControlToken = jwtWithSub('sandbox-recipes/source-recipe')
  const values: Record<string, string> = {
    MCP_HOST_GATEWAY_URL: 'http://gateway:8092',
    MCP_HOST_WORKFLOW_CONTROL_TOKEN: workflowControlToken,
    MCP_HOST_RUNTIME_ACCESS_TOKEN: workflowControlToken,
    MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
    CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE: 'sandbox-recipes',
    CLERUM_WORKFLOW_APPROVAL_RECIPE: 'source-recipe',
    ...overrides,
  }
  return (key: string): string | undefined => values[key]
}

function workflowResultDownloadResponse(content: unknown, overrides: Record<string, unknown> = {}) {
  const artifactName =
    typeof overrides.artifactName === 'string' ? overrides.artifactName : 'seed-result.json'
  const contentType =
    typeof overrides.contentType === 'string' ? overrides.contentType : 'application/json'
  const serialized = typeof content === 'string' ? content : JSON.stringify(content)
  const body = Buffer.from(serialized, 'utf8')
  const filename = typeof overrides.filename === 'string' ? overrides.filename : artifactName
  return {
    ok: overrides.ok !== false,
    status: typeof overrides.status === 'number' ? overrides.status : 200,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase()
        if (key === 'content-type') return contentType
        if (key === 'content-length') return String(body.byteLength)
        if (key === 'content-disposition') return `attachment; filename="${filename}"`
        return null
      },
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    text: async () => serialized,
  } as Response
}

describe('workflow native tools', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const tempDirs: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  async function writeTokenFile(value: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-control-token-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'token')
    await fs.writeFile(file, value, 'utf8')
    return file
  }

  it('workflow tool factory exposes the runtime workflow tools after the module split', () => {
    const tools = createWorkflowTools({ getEnv: env() })
    expect(tools.map(tool => tool.name())).toEqual([
      'workflow_list',
      'workflow_status',
      'workflow_health',
      'workflow_trigger',
    ])
    expect(tools.map(tool => tool.requiresApproval())).toEqual([false, false, false, true])
  })

  it('workflow tool factory omits workflow_trigger without runtime approval tokens', () => {
    const tools = createWorkflowTools({
      getEnv: env({
        MCP_HOST_RUNTIME_ACCESS_TOKEN: '',
        MCP_HOST_RUNTIME_REFRESH_TOKEN: '',
      }),
    })

    expect(tools.map(tool => tool.name())).toEqual([
      'workflow_list',
      'workflow_status',
      'workflow_health',
    ])
  })

  it('authenticated workflow chat hides approval target fields from the model contract', () => {
    const tools = createWorkflowTools({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        targetTeamId: '00000000-0000-4000-8000-0000000000aa',
        conversationId: 'thread-1',
      },
    })

    expect(tools.map(tool => tool.name())).toEqual([
      'workflow_list',
      'workflow_status',
      'workflow_health',
      'workflow_trigger',
      'workflow_result',
    ])
    expect(tools.findIndex(tool => tool.name() === 'workflow_trigger')).toBeLessThan(
      tools.findIndex(tool => tool.name() === 'workflow_result')
    )
    expect(tools[0].parametersSchema()).toEqual({
      type: 'object',
      properties: {},
      required: [],
    })
    expect(JSON.stringify(tools.map(tool => tool.parametersSchema()))).not.toContain('targetUserId')
    expect(JSON.stringify(tools.map(tool => tool.parametersSchema()))).not.toContain('targetTeamId')
    expect(JSON.stringify(tools.map(tool => tool.parametersSchema()))).not.toContain('namespace')
    expect(JSON.stringify(tools.map(tool => tool.parametersSchema()))).not.toContain(
      'timeoutSeconds'
    )
  })

  it('workflow_list calls the runtime broker via gateway', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ name: 'recipe-a' }], count: 1 }),
    } as Response)

    const tool = new WorkflowListTool({ getEnv: env() })
    const result = await tool.execute({})

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content).count).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/workflows',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${jwtWithSub('sandbox-recipes/source-recipe')}`,
        }),
      })
    )
  })

  it('workflow_list uses the current file-backed workflow-control token', async () => {
    const tokenFile = await writeTokenFile(jwtWithSub('sandbox-recipes/file-recipe-a'))
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], count: 0 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], count: 0 }),
      } as Response)
    const tool = new WorkflowListTool({
      getEnv: env({
        MCP_HOST_WORKFLOW_CONTROL_TOKEN: 'stale-env-token',
        MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE: tokenFile,
      }),
    })

    await tool.execute({})
    await fs.writeFile(tokenFile, jwtWithSub('sandbox-recipes/file-recipe-b'), 'utf8')
    await tool.execute({})

    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${jwtWithSub('sandbox-recipes/file-recipe-a')}`,
      })
    )
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${jwtWithSub('sandbox-recipes/file-recipe-b')}`,
      })
    )
  })

  it('workflow list/read/health forward explicit approval target context to the gateway', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], count: 0 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'target-recipe', phase: 'Ready' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ recipe: 'sandbox-recipes/target-recipe', activeRuns: 0 }),
      } as Response)

    await new WorkflowListTool({ getEnv: env() }).execute({
      targetUserId: '00000000-0000-4000-8000-000000000001',
    })
    await new WorkflowStatusTool({ getEnv: env() }).execute({
      namespace: 'sandbox-recipes',
      name: 'target-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
    })
    await new WorkflowHealthTool({ getEnv: env() }).execute({
      namespace: 'sandbox-recipes',
      name: 'target-recipe',
      targetTeamId: '00000000-0000-4000-8000-000000000002',
    })

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows?targetUserId=00000000-0000-4000-8000-000000000001'
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/target-recipe?targetUserId=00000000-0000-4000-8000-000000000001'
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/target-recipe/health?targetTeamId=00000000-0000-4000-8000-000000000002'
    )
  })

  it('workflow_list combines current user and active team grants from authenticated chat context', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            namespace: 'sandbox-recipes',
            name: 'user-granted',
            description: 'User-visible workflow',
            inputContract: null,
          },
          {
            namespace: 'sandbox-recipes',
            name: 'team-granted',
            description: 'Team-visible workflow',
            inputContract: {
              type: 'object',
              required: ['company'],
              properties: {
                company: {
                  type: 'string',
                  description: 'Target company or organization.',
                },
                depth: {
                  type: 'string',
                  enum: ['standard', 'full'],
                  default: 'full',
                  description: 'Due diligence depth.',
                },
              },
            },
          },
        ],
        count: 2,
      }),
    } as Response)

    const result = await new WorkflowListTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        targetTeamId: '00000000-0000-4000-8000-0000000000aa',
      },
    }).execute({})

    expect(result.is_error).toBe(false)
    expect(result.content).not.toContain('namespace')
    expect(result.content).not.toContain('sandbox-recipes')
    expect(result.content).not.toContain('inputContract')
    const parsed = JSON.parse(result.content) as {
      items: Array<{ name: string; requiresInput: boolean; inputs: Array<Record<string, unknown>> }>
      count: number
    }
    expect(parsed.count).toBe(2)
    expect(parsed.items.map(item => item.name)).toEqual(['user-granted', 'team-granted'])
    expect(parsed.items[0]).toEqual({
      name: 'user-granted',
      description: 'User-visible workflow',
      requiresInput: false,
      inputs: [],
    })
    expect(parsed.items[1]).toEqual({
      name: 'team-granted',
      description: 'Team-visible workflow',
      requiresInput: true,
      inputs: [
        {
          name: 'company',
          required: true,
          description: 'Target company or organization.',
        },
        {
          name: 'depth',
          required: false,
          description: 'Due diligence depth.',
          options: ['standard', 'full'],
          default: 'full',
        },
      ],
    })
    expect(fetchMock.mock.calls).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve'
    )
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'list',
      userId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('workflow_list uses server-side effective targets for provider chat context', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            namespace: 'sandbox-recipes',
            name: 'risk-review',
            targets: [
              { kind: 'user', label: 'Personal' },
              { kind: 'team', label: 'Treasury' },
            ],
            inputContract: null,
          },
          {
            namespace: 'sandbox-recipes',
            name: 'treasury-review',
            targets: [{ kind: 'team', label: 'Treasury' }],
            inputContract: null,
          },
        ],
      }),
    } as Response)

    const result = await new WorkflowListTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({})

    expect(result.is_error).toBe(false)
    const parsed = JSON.parse(result.content)
    expect(parsed.items).toEqual([
      {
        name: 'risk-review',
        targets: [
          { kind: 'user', label: 'Personal' },
          { kind: 'team', label: 'Treasury' },
        ],
        requiresInput: false,
        inputs: [],
      },
      {
        name: 'treasury-review',
        targets: [{ kind: 'team', label: 'Treasury' }],
        requiresInput: false,
        inputs: [],
      },
    ])
    expect(result.content).not.toContain('sandbox-recipes')
    expect(result.content).not.toContain('targetUserId')
    expect(result.content).not.toContain('targetTeamId')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve'
    )
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'list',
      userId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'thread-1',
    })
  })

  it('workflow_list fails closed without gateway URL', async () => {
    const tool = new WorkflowListTool({ getEnv: env({ MCP_HOST_GATEWAY_URL: '' }) })
    const result = await tool.execute({})

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('MCP_HOST_GATEWAY_URL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workflow_status and workflow_health call runtime broker detail endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'source-recipe', phase: 'Ready' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ recipe: 'sandbox-recipes/source-recipe', activeRuns: 0 }),
      } as Response)

    const statusResult = await new WorkflowStatusTool({ getEnv: env() }).execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
    })
    const healthResult = await new WorkflowHealthTool({ getEnv: env() }).execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
    })

    expect(statusResult.is_error).toBe(false)
    expect(healthResult.is_error).toBe(false)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe'
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/health'
    )
  })

  it('workflow_result reads the latest authorized run artifact in authenticated chat with internal verification context but no run ids', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [
            {
              name: 'seed-result.json',
              format: 'json',
              sizeBytes: 123,
              createdAt: '2026-05-26T12:01:00.000Z',
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({
          marker: 'agent-chat-mongo-mcp-test',
          status: 'ready-for-mcp-read',
          database: 'clerum',
          collection: 'agent_chat_mongo_mcp',
          note: 'Use Bearer top-secret-token for diagnostics',
          jwt: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.signature',
          scopes: ['workflow:read'],
        })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({
      workflowName: 'source-recipe',
    })

    expect(result.is_error).toBe(false)
    const content = JSON.parse(result.content)
    expect(content).toMatchObject({
      workflowName: 'source-recipe',
      artifactAvailable: true,
      result: {
        marker: 'agent-chat-mongo-mcp-test',
        status: 'ready-for-mcp-read',
      },
    })
    expect(result.content).toContain('ready-for-mcp-read')
    expect(result.content).not.toContain('sandbox-recipes')
    expect(result.content).not.toContain('seed-result.json')
    expect(result.content).toContain('clerum')
    expect(result.content).toContain('agent_chat_mongo_mcp')
    expect(result.content).toContain('database')
    expect(result.content).toContain('collection')
    expect(result.content).not.toContain('top-secret-token')
    expect(result.content).not.toContain('eyJhbGci')
    expect(result.content).not.toContain('workflow:read')
    expect(result.content).not.toContain('scopes')
    expect(result.content).not.toContain('runId')
    expect(result.content).not.toContain('approvalRequestId')
    expect(result.content).not.toContain('targetUserId')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      kind: 'file',
      mimeType: 'application/json',
      filename: 'seed-result.json',
      sourceTool: 'workflow_result',
    })
    expect(
      Buffer.from(
        result.attachments?.[0].dataBase64 || '',
        ('base' + '64') as BufferEncoding
      ).toString('utf8')
    ).toContain('agent-chat-mongo-mcp-test')
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts/seed-result.json/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
    ])
    const downloadInit = fetchMock.mock.calls[2][1] as RequestInit
    expect(downloadInit.method).toBe('GET')
    expect(downloadInit.headers).not.toMatchObject({ 'Content-Type': expect.any(String) })
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'source-recipe',
      conversationId: 'thread-1',
    })
  })

  it('workflow_result tells the model when a binary artifact is attached to the response', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [{ name: 'research-summary.pdf', format: 'pdf', sizeBytes: 21 }],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse('%PDF-1.7 fake binary', {
          artifactName: 'research-summary.pdf',
          filename: 'research-summary.pdf',
          contentType: 'application/pdf',
        })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({ workflowName: 'source-recipe' })

    expect(result.is_error).toBe(false)
    const content = JSON.parse(result.content)
    expect(content.result).toMatchObject({
      message: 'Artifact is available for download and attached as research-summary.pdf.',
    })
    expect(result.content).not.toContain('dataBase64')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      kind: 'file',
      mimeType: 'application/pdf',
      filename: 'research-summary.pdf',
      sourceTool: 'workflow_result',
      lane: 'workflow_result',
    })
  })

  it('workflow_result downloads an exact authorized provider workflow run', async () => {
    const workflowRunId = '11111111-2222-4333-8444-555555555555'
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workflowRunId,
          workflowName: 'source-recipe',
          artifacts: [{ name: 'research-summary.pdf', format: 'pdf', sizeBytes: 21 }],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse('%PDF-1.7 fake binary', {
          artifactName: 'research-summary.pdf',
          filename: 'research-summary.pdf',
          contentType: 'application/pdf',
        })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).executeForRun(workflowRunId, 'research-summary.pdf')

    expect(result.is_error).toBe(false)
    expect(result.attachments?.[0]).toMatchObject({
      filename: 'research-summary.pdf',
      sourceTool: 'workflow_result',
    })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `http://gateway:8092/api/v1/workflows/runs/${workflowRunId}/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1`,
      `http://gateway:8092/api/v1/workflows/runs/${workflowRunId}/artifacts/research-summary.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1`,
    ])
  })

  it('workflow_result refreshes workflow-control auth once when artifact download returns 401', async () => {
    const provider = {
      getWorkflowControlToken: vi.fn().mockResolvedValue('expired-control'),
      refreshWorkflowControlToken: vi.fn().mockResolvedValue('fresh-control'),
    }
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [{ name: 'seed-result.json', format: 'json', sizeBytes: 42 }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'Unauthorized' }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({ artifactProof: 'download-after-refresh' })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowControlTokenProvider: provider,
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({ name: 'source-recipe' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('download-after-refresh')
    expect(provider.refreshWorkflowControlToken).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[2][0]).toBe(fetchMock.mock.calls[3][0])
  })

  it('workflow_result fails closed when artifact download omits content length', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [{ name: 'seed-result.json', format: 'json', sizeBytes: 42 }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type'
              ? 'application/json'
              : name.toLowerCase() === 'content-disposition'
                ? 'attachment; filename="seed-result.json"'
                : null,
        },
        arrayBuffer: async () => Buffer.from('{"artifactProof":"missing-length"}').buffer,
      } as Response)

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({ name: 'source-recipe' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('missing content length')
    expect(result.content).not.toContain('missing-length')
  })

  it('workflow_result fails closed when artifact download exceeds byte cap while streaming', async () => {
    const body = Buffer.from('{"artifactProof":"stream-too-large"}')
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [{ name: 'seed-result.json', format: 'json', sizeBytes: body.byteLength }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => {
            const key = name.toLowerCase()
            if (key === 'content-type') return 'application/json'
            if (key === 'content-disposition') return 'attachment; filename="seed-result.json"'
            if (key === 'content-length') return '4'
            return null
          },
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body.subarray(0, 2))
            controller.enqueue(body.subarray(2))
            controller.close()
          },
        }),
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as Response)

    const result = await new WorkflowResultTool({
      getEnv: env({ CLERUM_ATTACHMENT_MAX_BYTES: '4' }),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({ name: 'source-recipe' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('artifact exceeds byte cap')
    expect(result.content).not.toContain('stream-too-large')
  })

  it('workflow_result waits briefly for artifact metadata after the latest run appears', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ artifacts: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [
            {
              name: 'seed-result.json',
              format: 'json',
              sizeBytes: 77,
              createdAt: '2026-05-29T12:01:00.000Z',
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({
          artifactProof: 'artifact-output-delayed',
        })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({ name: 'source-recipe' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('artifact-output-delayed')
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts/seed-result.json/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
    ])
  })

  it('workflow_result retries transient artifact lookup failures while a run is preparing outputs', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 410,
        text: async () => JSON.stringify({ error: 'Run artifact metadata has been pruned' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [
            {
              name: 'seed-result.json',
              format: 'json',
              sizeBytes: 83,
              createdAt: '2026-05-29T12:02:00.000Z',
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({
          artifactProof: 'artifact-output-after-transient-error',
        })
      )

    const result = await new WorkflowResultTool({
      getEnv: env({
        CLERUM_WORKFLOW_RESULT_ARTIFACT_POLL_INTERVAL_MS: '1',
      }),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({ name: 'source-recipe' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('artifact-output-after-transient-error')
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts/seed-result.json/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
    ])
  })

  it('workflow_result rejects model-supplied run ids and ignores artifact names in authenticated chat', async () => {
    const tool = new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    })

    const schema = JSON.stringify(tool.parametersSchema())
    expect(schema).not.toContain('runId')
    expect(schema).not.toContain('artifactName')
    const runOverride = await tool.execute({
      name: 'source-recipe',
      runId: '9409e908-0000-4000-8000-000000000123',
    })
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          artifacts: [
            { name: 'seed-result.json', format: 'json' },
            { name: 'model-requested.json', format: 'json' },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({
          status: 'runtime-selected-artifact',
        })
      )
    const artifactOverride = await tool.execute({
      name: 'source-recipe',
      artifactName: 'model-requested.json',
    })

    expect(runOverride.is_error).toBe(true)
    expect(runOverride.content).toContain('derived from the authenticated conversation')
    expect(artifactOverride.is_error).toBe(false)
    expect(artifactOverride.content).toContain('runtime-selected-artifact')
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/runs/latest/artifacts/seed-result.json/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
    ])
  })

  it('workflow_result uses the broker canonical workflow name when a child recipe alias is resolved', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workflowName: 'source-recipe',
          artifacts: [{ name: 'seed-result.json', format: 'json' }],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({
          marker: 'child-alias-result',
        })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({
      name: 'source-recipe-run-1',
    })

    expect(result.is_error).toBe(false)
    const content = JSON.parse(result.content)
    expect(content.workflowName).toBe('source-recipe')
    expect(content.result.marker).toBe('child-alias-result')
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe-run-1/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe-run-1/runs/latest/artifacts/seed-result.json/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1',
    ])
  })

  it('workflow_result scopes artifact reads to the effective team target', async () => {
    const teamId = '00000000-0000-4000-8000-0000000000aa'
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
        json: async () => ({
          artifacts: [{ name: 'seed-result.json', format: 'json' }],
        }),
      } as Response)
      .mockResolvedValueOnce(
        workflowResultDownloadResponse({ artifactProof: 'artifact-output-team-target' })
      )

    const result = await new WorkflowResultTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({
      name: 'treasury-review',
    })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('artifact-output-team-target')
    expect(result.content).not.toContain(teamId)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/treasury-review/runs/latest/artifacts?targetTeamId=00000000-0000-4000-8000-0000000000aa&workflowConversationId=thread-1',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/treasury-review/runs/latest/artifacts/seed-result.json/download?targetTeamId=00000000-0000-4000-8000-0000000000aa&workflowConversationId=thread-1',
    ])
  })

  it('workflow_status and workflow_health derive approval target from authenticated chat context', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          namespace: 'sandbox-recipes',
          name: 'source-recipe',
          hostRef: 'sandbox-recipes/source-recipe',
          phase: 'Ready',
          workflowPhase: 'Idle',
          triggers: { onDemand: { requiresApproval: false } },
          latestRun: {
            id: '00000000-0000-4000-8000-000000000123',
            phase: 'Succeeded',
            actor: { hostRef: 'sandbox-recipes/source-recipe' },
            triggeredAt: '2026-05-26T12:00:00.000Z',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          recipe: 'sandbox-recipes/source-recipe',
          phase: 'Ready',
          workflowPhase: 'Idle',
          activeRuns: 0,
          lastRun: {
            id: '00000000-0000-4000-8000-000000000123',
            phase: 'Succeeded',
            actor: { hostRef: 'sandbox-recipes/source-recipe' },
            completedAt: '2026-05-26T12:01:00.000Z',
          },
        }),
      } as Response)

    const workflowCallerContext = { targetUserId: '00000000-0000-4000-8000-000000000001' }
    const statusResult = await new WorkflowStatusTool({
      getEnv: env(),
      workflowCallerContext,
    }).execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
    })
    const healthResult = await new WorkflowHealthTool({
      getEnv: env(),
      workflowCallerContext,
    }).execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
    })

    expect(statusResult.is_error).toBe(false)
    expect(healthResult.is_error).toBe(false)
    expect(statusResult.content).toContain('source-recipe')
    expect(statusResult.content).toContain('Succeeded')
    expect(statusResult.content).not.toContain('sandbox-recipes')
    expect(statusResult.content).not.toContain('00000000-0000-4000-8000-000000000123')
    expect(statusResult.content).not.toContain('triggers')
    expect(healthResult.content).toContain('source-recipe')
    expect(healthResult.content).toContain('Succeeded')
    expect(healthResult.content).not.toContain('sandbox-recipes')
    expect(healthResult.content).not.toContain('00000000-0000-4000-8000-000000000123')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve'
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe?targetUserId=00000000-0000-4000-8000-000000000001'
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve'
    )
    expect(fetchMock.mock.calls[3][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/health?targetUserId=00000000-0000-4000-8000-000000000001'
    )
  })

  it('workflow_status and workflow_health resolve the active team grant through control-api', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'team',
            label: 'Treasury',
            teamId: '00000000-0000-4000-8000-0000000000aa',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'team-recipe', phase: 'Ready' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'team',
            label: 'Treasury',
            teamId: '00000000-0000-4000-8000-0000000000aa',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ recipe: 'sandbox-recipes/team-recipe', activeRuns: null }),
      } as Response)

    const workflowCallerContext = {
      targetUserId: '00000000-0000-4000-8000-000000000001',
      targetTeamId: '00000000-0000-4000-8000-0000000000aa',
    }
    const statusResult = await new WorkflowStatusTool({
      getEnv: env(),
      workflowCallerContext,
    }).execute({
      namespace: 'sandbox-recipes',
      name: 'team-recipe',
    })
    const healthResult = await new WorkflowHealthTool({
      getEnv: env(),
      workflowCallerContext,
    }).execute({
      namespace: 'sandbox-recipes',
      name: 'team-recipe',
    })

    expect(statusResult.is_error).toBe(false)
    expect(healthResult.is_error).toBe(false)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/team-recipe?targetTeamId=00000000-0000-4000-8000-0000000000aa',
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/team-recipe/health?targetTeamId=00000000-0000-4000-8000-0000000000aa',
    ])
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'team-recipe',
    })
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'team-recipe',
    })
  })

  it('workflow read tools reject model-supplied target overrides in authenticated chat', async () => {
    const result = await new WorkflowStatusTool({
      getEnv: env(),
      workflowCallerContext: { targetUserId: '00000000-0000-4000-8000-000000000001' },
    }).execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000999',
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('authenticated conversation')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workflow broker errors expose only safe error codes', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: 'approval_target_not_allowed',
          detail: 'Bearer secret-token should not be returned',
        }),
    } as Response)

    const result = await new WorkflowListTool({ getEnv: env() }).execute({})

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('approval_target_not_allowed')
    expect(result.content).not.toContain('secret-token')
    expect(result.content).not.toContain('Bearer')
  })

  it('refreshes the workflow-control token once when the broker returns 401', async () => {
    const provider = {
      getWorkflowControlToken: vi.fn().mockResolvedValue('expired-control'),
      refreshWorkflowControlToken: vi.fn().mockResolvedValue('fresh-control'),
    }
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'Unauthorized' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], count: 0 }),
      } as Response)

    const result = await new WorkflowListTool({
      getEnv: env(),
      workflowControlTokenProvider: provider,
    }).execute({})

    expect(result.is_error).toBe(false)
    expect(provider.refreshWorkflowControlToken).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer expired-control' })
    )
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer fresh-control' })
    )
  })

  it('workflow_trigger requests durable user approval before calling trigger broker', async () => {
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000123',
      status: 'approved',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'run-1', phase: 'Pending' }),
    } as Response)

    const tool = new WorkflowTriggerTool({
      getEnv: env({
        CLERUM_WORKFLOW_NAMESPACE: 'sandbox-recipes',
        CLERUM_WORKFLOW_RECIPE: 'source-recipe-run-12345678',
      }),
    })
    expect(tool.requiresApproval()).toBe(true)

    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
      approvalMessage: 'Approve trigger',
      inputs: { topic: 'alpha' },
    })

    expect(result.is_error).toBe(false)
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: 'workflow_trigger:sandbox-recipes/source-recipe',
        runtimeMcpHostRef: 'sandbox-recipes/source-recipe-run-12345678',
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'source-recipe',
        },
        target: { userId: '00000000-0000-4000-8000-000000000001' },
        payloadMetadata: {
          workflowTrigger: {
            namespace: 'sandbox-recipes',
            name: 'source-recipe',
            caller: 'sandbox-recipes/source-recipe',
          },
        },
      }),
      expect.objectContaining({
        accessToken: jwtWithSub('sandbox-recipes/source-recipe'),
        refreshToken: 'runtime-refresh',
        baseUrl: 'http://gateway:8092',
      })
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/source-recipe/trigger'
    )
    const expectedKey = `workflow-trigger-${createHash('sha256')
      .update(
        '00000000-0000-4000-8000-000000000123:sandbox-recipes:source-recipe:sandbox-recipes/source-recipe'
      )
      .digest('hex')}`
    expect(init.headers).toEqual(
      expect.objectContaining({
        'Idempotency-Key': expectedKey,
        Authorization: `Bearer ${jwtWithSub('sandbox-recipes/source-recipe')}`,
      })
    )
    expect(JSON.parse(String(init.body))).toEqual({
      approvalRequestId: '00000000-0000-4000-8000-000000000123',
      inputs: { topic: 'alpha' },
    })
    expect(result.metadata).toEqual({
      workflowArtifactScope: {
        namespace: 'sandbox-recipes',
        name: 'source-recipe',
        label: 'source-recipe',
        runId: 'run-1',
      },
    })
  })

  it('workflow_trigger derives approval target from authenticated chat context', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId,
      status: 'approved',
    })
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'unique',
          target: {
            kind: 'user',
            label: 'Personal',
            userId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '9409e908-0000-4000-8000-000000000123',
          phase: 'Pending',
          triggeredAt: '2026-05-26T12:44:18.681Z',
        }),
      } as Response)

    const tool = new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
        originChannelType: 'teams',
        providerUserId: 'teams-user-1',
        providerWorkspaceId: 'teams-tenant-1',
        providerChannelId: 'teams-conversation-1',
        sourceThreadId: 'teams-thread-1',
      },
    })
    const result = await tool.execute({
      name: 'due-diligence',
      inputs: { company: 'Acme', depth: 'full' },
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual(
      expect.objectContaining({
        workflowName: 'due-diligence',
        phase: 'Pending',
      })
    )
    expect(result.content).not.toContain('9409e908-0000-4000-8000-000000000123')
    expect(result.content).not.toContain('runId')
    expect(result.content).not.toContain('workflowNamespace')
    expect(result.content).not.toContain('sandbox-recipes')
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: 'workflow_trigger:sandbox-recipes/due-diligence',
        message: 'Approve workflow trigger for due-diligence',
        timeoutSeconds: 180,
        target: { userId: '00000000-0000-4000-8000-000000000001' },
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'due-diligence',
        },
        payloadMetadata: {
          workflowTrigger: {
            namespace: 'sandbox-recipes',
            name: 'due-diligence',
            caller: 'sandbox-recipes/source-recipe',
            requesterUserId: '00000000-0000-4000-8000-000000000001',
            conversationId: 'thread-1',
            providerBinding: {
              medium: 'teams',
              providerChannelId: 'teams-conversation-1',
              providerWorkspaceId: 'teams-tenant-1',
              providerThreadId: 'teams-thread-1',
            },
          },
        },
      }),
      expect.any(Object)
    )
    expect(result.metadata).toEqual({
      workflowArtifactScope: {
        namespace: 'sandbox-recipes',
        name: 'due-diligence',
        label: 'due-diligence',
        runId: '9409e908-0000-4000-8000-000000000123',
        requestedAt: Date.parse('2026-05-26T12:44:18.681Z'),
      },
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve'
    )
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'due-diligence',
      conversationId: 'thread-1',
    })
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/due-diligence/trigger'
    )
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      approvalRequestId,
      inputs: { company: 'Acme', depth: 'full' },
    })
  })

  it('workflow_trigger auto-selects a unique team effective target before requesting approval', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000789'
    const teamId = '00000000-0000-4000-8000-0000000000aa'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId,
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
        json: async () => ({ id: 'team-run-1', phase: 'Pending' }),
      } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({
      name: 'treasury-review',
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual(
      expect.objectContaining({
        workflowName: 'treasury-review',
        target: { label: 'Treasury' },
        phase: 'Pending',
      })
    )
    expect(result.content).not.toContain(teamId)
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { teamId },
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'treasury-review',
        },
      }),
      expect.any(Object)
    )
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://gateway:8092/api/v1/workflows/effective-targets/resolve',
      'http://gateway:8092/api/v1/workflows/sandbox-recipes/treasury-review/trigger',
    ])
  })

  it('workflow_trigger asks for target clarification without creating approval or run when targets are ambiguous', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ambiguous',
        targets: [
          { kind: 'user', label: 'Personal' },
          { kind: 'team', label: 'Treasury' },
        ],
      }),
    } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({
      name: 'risk-review',
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      workflowName: 'risk-review',
      status: 'needs_clarification',
      message:
        'risk-review is available for multiple targets: Personal, Treasury. Ask the user to choose one of these labels.',
      targets: [
        { kind: 'user', label: 'Personal' },
        { kind: 'team', label: 'Treasury' },
      ],
    })
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('workflow_trigger fails fast against effective workflow list when the requested name is not available', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'none' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ namespace: 'sandbox-recipes', name: 'research-summary-workflow' }],
          count: 1,
        }),
      } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
        sourceMessageContent:
          'run esearch-summary-workflow tema "latest SOTA Model of Anthropic and OpenAI"',
      },
    }).execute({
      name: 'research-summary-workflow',
      inputs: { tema: 'latest SOTA Model of Anthropic and OpenAI' },
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      workflowName: 'esearch-summary-workflow',
      status: 'workflow_not_found',
      message:
        'Workflow not found: esearch-summary-workflow. Did you mean research-summary-workflow?',
      suggestedWorkflowName: 'research-summary-workflow',
    })
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'esearch-summary-workflow',
      conversationId: 'thread-1',
    })
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      purpose: 'list',
      userId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'thread-1',
    })
  })

  it('workflow_trigger ignores model-supplied target labels that the user did not say', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ambiguous',
        targets: [
          { kind: 'user', label: 'Personal' },
          { kind: 'team', label: 'Treasury' },
        ],
      }),
    } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
        sourceMessageContent: 'Run risk-review with marker alpha',
      },
    }).execute({
      name: 'risk-review',
      targetLabel: 'Treasury',
      inputs: { marker: 'alpha' },
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      workflowName: 'risk-review',
      status: 'needs_clarification',
      message:
        'risk-review is available for multiple targets: Personal, Treasury. Ask the user to choose one of these labels.',
      targets: [
        { kind: 'user', label: 'Personal' },
        { kind: 'team', label: 'Treasury' },
      ],
    })
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'risk-review',
      conversationId: 'thread-1',
    })
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('workflow_trigger does not treat the workflow name as a user-selected target label', async () => {
    const teamId = '00000000-0000-4000-8000-0000000000aa'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: 'approval-1',
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
        sourceMessageContent: 'Trigger the workflow recipe named risk-review with marker alpha',
      },
    }).execute({
      name: 'risk-review',
      targetLabel: 'risk-review',
      inputs: { marker: 'alpha' },
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'risk-review',
      conversationId: 'thread-1',
    })
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({ target: { teamId } }),
      expect.any(Object)
    )
  })

  it('workflow_trigger fails closed on duplicate target labels without exposing target ids', async () => {
    const teamId = '00000000-0000-4000-8000-0000000000aa'
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ambiguous',
        duplicateLabels: true,
        targets: [
          { kind: 'team', label: 'Treasury', teamId },
          { kind: 'team', label: 'Treasury', teamId: '00000000-0000-4000-8000-0000000000bb' },
        ],
      }),
    } as Response)

    const result = await new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'thread-1',
      },
    }).execute({
      name: 'risk-review',
      targetLabel: 'Treasury',
    })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('duplicate target labels')
    expect(result.content).toContain('Control UI')
    expect(result.content).not.toContain(teamId)
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('workflow_trigger rejects model-supplied operational timing in authenticated chat', async () => {
    const tool = new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: { targetUserId: '00000000-0000-4000-8000-000000000001' },
    })
    const result = await tool.execute({
      name: 'due-diligence',
      timeoutSeconds: 180,
      inputs: { company: 'Acme', depth: 'full' },
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timeoutSeconds is derived by the runtime')
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workflow_trigger uses effective target resolution instead of legacy team fallback', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'none',
      }),
    } as Response)
    const tool = new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: {
        targetUserId: '00000000-0000-4000-8000-000000000001',
        targetTeamId: '00000000-0000-4000-8000-0000000000aa',
      },
    })
    const result = await tool.execute({
      name: 'membership-only-recipe',
      inputs: { marker: 'team-membership-without-grant' },
    })

    expect(result.is_error).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      workflowName: 'membership-only-recipe',
      status: 'not_available',
      message: 'membership-only-recipe is not available for this conversation target.',
    })
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      purpose: 'trigger',
      userId: '00000000-0000-4000-8000-000000000001',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'membership-only-recipe',
    })
  })

  it('workflow_trigger rejects model-supplied operational overrides in authenticated chat', async () => {
    const tool = new WorkflowTriggerTool({
      getEnv: env(),
      workflowCallerContext: { targetUserId: '00000000-0000-4000-8000-000000000001' },
    })

    const mismatchedTarget = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'due-diligence',
      targetUserId: '00000000-0000-4000-8000-000000000999',
    })
    const idempotencyOverride = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'due-diligence',
      idempotencyKey: 'caller-controlled',
    })
    const outputOverride = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'due-diligence',
      outputOverrides: { path: '/tmp/untrusted' },
    })
    const approvalMessageOverride = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'due-diligence',
      approvalMessage: 'attacker-controlled approval message',
    })

    expect(mismatchedTarget.is_error).toBe(true)
    expect(mismatchedTarget.content).toContain('authenticated conversation')
    expect(idempotencyOverride.is_error).toBe(true)
    expect(idempotencyOverride.content).toContain('idempotencyKey')
    expect(outputOverride.is_error).toBe(true)
    expect(outputOverride.content).toContain('outputOverrides')
    expect(approvalMessageOverride.is_error).toBe(true)
    expect(approvalMessageOverride.content).toContain('approvalMessage')
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workflow_trigger binds shared HCC approvals to hostRefs[0] instead of sentinel sub', async () => {
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000123',
      status: 'approved',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'run-1', phase: 'Pending' }),
    } as Response)

    const tool = new WorkflowTriggerTool({
      getEnv: env({
        MCP_HOST_WORKFLOW_CONTROL_TOKEN: jwtWithClaims({
          sub: 'mcp-host/standalone',
          recipeNamespace: 'mcp-host',
          recipeName: 'standalone',
          hostRefs: ['trader'],
        }),
        MCP_HOST_RUNTIME_ACCESS_TOKEN: jwtWithClaims({
          sub: 'mcp-host/standalone',
          recipeNamespace: 'mcp-host',
          recipeName: 'standalone',
          hostRefs: ['trader'],
        }),
        CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE: 'mcp-host',
        CLERUM_WORKFLOW_APPROVAL_RECIPE: 'standalone',
      }),
    })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'idem-hcc',
    })

    expect(result.is_error).toBe(false)
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadMetadata: {
          workflowTrigger: {
            namespace: 'sandbox-recipes',
            name: 'source-recipe',
            caller: 'trader',
          },
        },
        approvalRecipe: {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'source-recipe',
        },
      }),
      expect.objectContaining({
        hostRef: 'trader',
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
      })
    )
  })

  it('workflow_trigger preserves file-backed workflow-control tokens in approval auth', async () => {
    const callerToken = jwtWithClaims({
      sub: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['chatllm'],
    })
    const tokenFile = await writeTokenFile(callerToken)
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000123',
      status: 'approved',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'run-1', phase: 'Pending' }),
    } as Response)

    const tool = new WorkflowTriggerTool({
      getEnv: env({
        MCP_HOST_WORKFLOW_CONTROL_TOKEN: '',
        MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE: tokenFile,
        MCP_HOST_RUNTIME_ACCESS_TOKEN: callerToken,
        MCP_HOST_RUNTIME_REFRESH_TOKEN: 'runtime-refresh',
        CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE: 'mcp-host',
        CLERUM_WORKFLOW_APPROVAL_RECIPE: 'standalone',
      }),
    })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'idem-file-backed-approval-auth',
    })

    expect(result.is_error).toBe(false)
    expect(mockedGateStep).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        hostRef: 'chatllm',
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        mcpHostControlToken: callerToken,
      })
    )
  })

  it.each(['workflow-caller-alpha', 'workflow-caller-beta'])(
    'workflow_trigger binds alternate sandbox caller %s from JWT identity, not caller-controlled input',
    async callerName => {
      const approvalRequestId = '00000000-0000-4000-8000-000000000123'
      const callerKey = `sandbox-recipes/${callerName}`
      const callerToken = jwtWithClaims({
        sub: callerKey,
        recipeNamespace: 'sandbox-recipes',
        recipeName: callerName,
        hostRefs: [callerKey],
      })
      mockedGateStep.mockResolvedValueOnce({
        approvalRequestId,
        status: 'approved',
      })
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'run-1', phase: 'Pending' }),
      } as Response)

      const tool = new WorkflowTriggerTool({
        getEnv: env({
          MCP_HOST_WORKFLOW_CONTROL_TOKEN: callerToken,
          MCP_HOST_RUNTIME_ACCESS_TOKEN: callerToken,
          CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE: 'sandbox-recipes',
          CLERUM_WORKFLOW_APPROVAL_RECIPE: callerName,
        }),
      })
      const result = await tool.execute({
        namespace: 'sandbox-recipes',
        name: 'target-recipe',
        targetUserId: '00000000-0000-4000-8000-000000000001',
        approvalMessage: 'Approve target workflow',
        caller: 'attacker-controlled-caller',
      } as never)

      expect(result.is_error).toBe(false)
      expect(mockedGateStep).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalRecipe: {
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'target-recipe',
          },
          payloadMetadata: {
            workflowTrigger: {
              namespace: 'sandbox-recipes',
              name: 'target-recipe',
              caller: callerKey,
            },
          },
        }),
        expect.objectContaining({
          hostRef: callerKey,
          recipeNamespace: 'sandbox-recipes',
          recipeName: callerName,
        })
      )

      const expectedKey = `workflow-trigger-${createHash('sha256')
        .update(`${approvalRequestId}:sandbox-recipes:target-recipe:${callerKey}`)
        .digest('hex')}`
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(init.headers).toEqual(
        expect.objectContaining({
          Authorization: `Bearer ${callerToken}`,
          'Idempotency-Key': expectedKey,
        })
      )
      expect(JSON.parse(String(init.body))).toEqual({
        approvalRequestId,
      })
    }
  )

  it('workflow_trigger sends consumed approval ids to broker for idempotent retry', async () => {
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId: '00000000-0000-4000-8000-000000000123',
      status: 'consumed',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'existing-run', phase: 'Running' }),
    } as Response)

    const tool = new WorkflowTriggerTool({ getEnv: env() })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'idem-consumed',
    })

    expect(result.is_error).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      approvalRequestId: '00000000-0000-4000-8000-000000000123',
    })
  })

  it('workflow_trigger derives a deterministic retry idempotency key when one is not supplied', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockedGateStep.mockResolvedValueOnce({
      approvalRequestId,
      status: 'approved',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'run-1', phase: 'Pending' }),
    } as Response)

    const tool = new WorkflowTriggerTool({ getEnv: env() })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.is_error).toBe(false)
    const expectedKey = `workflow-trigger-${createHash('sha256')
      .update(`${approvalRequestId}:sandbox-recipes:source-recipe:sandbox-recipes/source-recipe`)
      .digest('hex')}`
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['Idempotency-Key']).toBe(
      expectedKey
    )
  })

  it('workflow_trigger fails closed unless exactly one approval target is supplied', async () => {
    const tool = new WorkflowTriggerTool({ getEnv: env() })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('exactly one')
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workflow_trigger ignores retired approval env vars and requires mcpHost runtime token names', async () => {
    const retiredEnvPrefix = 'APPROVAL'
    const retiredAccessName = `${retiredEnvPrefix}_ACCESS_TOKEN`
    const retiredRefreshName = `${retiredEnvPrefix}_REFRESH_TOKEN`
    const tool = new WorkflowTriggerTool({
      getEnv: env({
        MCP_HOST_RUNTIME_ACCESS_TOKEN: '',
        MCP_HOST_RUNTIME_REFRESH_TOKEN: '',
        [retiredAccessName]: 'retired-access',
        [retiredRefreshName]: 'retired-refresh',
      }),
    })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'source-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('MCP_HOST_RUNTIME_ACCESS_TOKEN')
    expect(result.content).toContain('MCP_HOST_RUNTIME_REFRESH_TOKEN')
    expect(result.content).not.toContain(retiredAccessName)
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workflow_trigger rejects mismatched workflow-control and runtime approval caller bindings', async () => {
    const tool = new WorkflowTriggerTool({
      getEnv: env({
        MCP_HOST_WORKFLOW_CONTROL_TOKEN: jwtWithSub('sandbox-recipes/child-recipe'),
        MCP_HOST_RUNTIME_ACCESS_TOKEN: jwtWithSub('sandbox-recipes/parent-recipe'),
      }),
    })
    const result = await tool.execute({
      namespace: 'sandbox-recipes',
      name: 'child-recipe',
      targetUserId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('caller bindings must match')
    expect(mockedGateStep).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

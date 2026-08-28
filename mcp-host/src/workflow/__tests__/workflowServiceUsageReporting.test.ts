import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import type { SingleTurnProvider } from '../../llm'
import type { LlmUsageEvent, UsageReporter } from '../../usage/usageReporter'
import type { McpClientConnection, McpClientFactory } from '../stepRouter'
import type { ConfigureRequest } from '../types'
import type { McpHostRuntimeAuth } from '../userApprovalRequester'
import { WorkflowService } from '../workflowService'

function mockRuntimeAuth(
  recipeName: string,
  recipeNamespace = 'sandbox-recipes',
  hostRef = `${recipeNamespace}/${recipeName}`
): McpHostRuntimeAuth {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    baseUrl: 'http://gw',
    hostRef,
    recipeName,
    recipeNamespace,
  }
}

function mockLlmProvider(
  responses: Array<{
    content: string | null
    tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> | null
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
  }>
): SingleTurnProvider {
  let i = 0
  return {
    completeSingleTurn: vi.fn().mockImplementation(() => {
      const r = responses[i++] ?? { content: 'done' }
      return Promise.resolve({
        content: r.content ?? '',
        usage: r.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: 'stop',
      })
    }),
    completeSingleTurnWithTools: vi.fn().mockImplementation(() => {
      const r = responses[i++] ?? { content: 'done', tool_calls: null }
      return Promise.resolve({
        content: r.content,
        tool_calls: r.tool_calls ?? null,
        usage: r.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: r.tool_calls ? 'tool_use' : 'stop',
      })
    }),
    getProviderType: () => 'openai',
    classifyError: vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'mock',
    })),
  }
}

function mockMcpClient(tools: Array<{ name: string }> = []): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools.map(t => ({ name: t.name, description: '' }))),
    callTool: vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ content: `result-${name}`, isError: false })
      ),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function mockMcpFactory(clients: Map<string, McpClientConnection> = new Map()): McpClientFactory {
  return server => clients.get(server.name) ?? mockMcpClient()
}

function makeReporter(): { reporter: UsageReporter; enqueued: LlmUsageEvent[] } {
  const enqueued: LlmUsageEvent[] = []
  const reporter = {
    enqueue: (e: LlmUsageEvent) => {
      enqueued.push(e)
    },
    drain: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    bufferSize: () => enqueued.length,
  } as unknown as UsageReporter
  return { reporter, enqueued }
}

describe('WorkflowService — UsageReporter integration', () => {
  const workflowExecutionId =
    '11111111-1111-4111-8111-111111111111:my-recipe:2026-05-09T00:00:00.000Z'
  const workflowTeamId = '22222222-2222-4222-8222-222222222222'
  const workflowUserId = '33333333-3333-4333-8333-333333333333'

  it('enqueues exactly one workflow event for a single-iteration step', async () => {
    const llm = mockLlmProvider([{ content: 'final answer', tool_calls: null }])
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('my-recipe-12345', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth('my-recipe'),
    })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-123',
      llmSecretName: 'chatllm-api-keys',
    })
    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })
    expect(res.status).toBe('completed')
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      source_kind: 'workflow',
      run_id: '11111111-1111-4111-8111-111111111111',
      recipe_name: 'my-recipe',
      host_ref: 'sandbox-recipes/my-recipe',
      team_id: workflowTeamId,
      provider: 'openai',
      model: 'gpt-4o',
      llm_secret_name: 'chatllm-api-keys',
      user_id: workflowUserId,
      input_tokens: 10,
      output_tokens: 5,
      task_id: workflowExecutionId,
    })
    expect(typeof enqueued[0]?.request_id).toBe('string')
  })

  it('enqueues one event per iteration in the with-tools path, each with iteration=N', async () => {
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__t1', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__t1', arguments: {} }] },
      { content: 'wrap up', tool_calls: null },
    ])
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('multi-step-run-7', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(new Map([['srv', mockMcpClient([{ name: 't1' }])]])),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth('multi-step'),
    })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-123',
      llmSecretName: 'chatllm-api-keys',
    })
    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'go',
      mcpServers: [{ name: 'srv', url: 'http://srv' }],
      contextVars: { workflowExecutionId, workflowTeamId },
    })
    expect(res.status).toBe('completed')
    expect(enqueued).toHaveLength(3)
    expect(enqueued.map(e => e.iteration)).toEqual([1, 2, 3])
    for (const e of enqueued) {
      expect(e.source_kind).toBe('workflow')
      expect(e.recipe_name).toBe('multi-step')
      expect(e.user_id).toBeNull()
      expect(e.sender).toBeNull()
      expect(e.recipe_name).toBe('multi-step')
    }
  })

  it('threads workflowExecutionId from contextVars into task_id', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('rec-run-1', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth('rec'),
    })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-123',
      llmSecretName: 'chatllm-api-keys',
    })
    await svc.executeStep({
      stepId: 's1',
      instruction: 'go',
      contextVars: { workflowExecutionId, workflowTeamId },
    })
    expect(enqueued[0]?.task_id).toBe(workflowExecutionId)
    expect(enqueued[0]?.team_id).toBe(workflowTeamId)
    expect(enqueued[0]?.llm_secret_name).toBe('chatllm-api-keys')
    expect(enqueued[0]?.recipe_name).toBe('rec')
    expect(enqueued[0]?.host_ref).toBe('sandbox-recipes/rec')
  })

  it('preserves admin-ui usage actor keys without treating them as JWT identities', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('rec-run-1', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth('rec'),
    })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-123',
      llmSecretName: 'chatllm-api-keys',
    })
    await svc.executeStep({
      stepId: 's1',
      instruction: 'go',
      contextVars: {
        workflowExecutionId,
        workflowTeamId: 'control-plane-admin-ui',
        workflowUserId: 'admin-ui/33333333-3333-4333-8333-333333333333',
      },
    })

    expect(enqueued[0]?.team_id).toBe('control-plane-admin-ui')
    expect(enqueued[0]?.user_id).toBe('admin-ui/33333333-3333-4333-8333-333333333333')
    expect(enqueued[0]?.task_id).toBe(workflowExecutionId)
  })

  it('binds host_ref/recipe_name to JWT claims, not reconstructed local names', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('parent-recipe-runabc123', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth(
        'parent-recipe',
        'sandbox-recipes',
        'sandbox-recipes/host-ref-from-jwt'
      ),
    })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-123',
      llmSecretName: 'chatllm-api-keys',
    })
    await svc.executeStep({
      stepId: 's1',
      instruction: 'go',
      contextVars: { workflowExecutionId, workflowTeamId },
    })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.recipe_name).toBe('parent-recipe')
    expect(enqueued[0]?.host_ref).toBe('sandbox-recipes/host-ref-from-jwt')
  })

  it('fails closed before usage reporting without a canonical workflowExecutionId', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('rec-run-1', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth('rec'),
    })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-123',
      llmSecretName: 'chatllm-api-keys',
    })
    const res = await svc.executeStep({ stepId: 's1', instruction: 'go' })
    expect(res.status).toBe('failed')
    expect(res.error).toContain('workflowExecutionId')
    expect(enqueued).toHaveLength(0)
  })

  it('does not enqueue Codex workflow usage because proxy finalize owns the ledger', async () => {
    const llm = mockLlmProvider([{ content: 'final answer', tool_calls: null }])
    llm.getProviderType = () => 'codex-subscription'
    const { reporter, enqueued } = makeReporter()
    const svc = new WorkflowService('my-recipe-12345', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      usageReporter: reporter,
      runtimeAuth: mockRuntimeAuth('my-recipe'),
    })
    const configured = svc.configure({
      provider: 'codex-subscription',
      model: 'gpt-5.3-codex',
    } as ConfigureRequest)
    expect(configured.configured).toBe(true)
    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })
    expect(res.status).toBe('completed')
    expect(enqueued).toHaveLength(0)
  })

  it('does NOT enqueue when no reporter is wired (workflow mode without ingest)', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const svc = new WorkflowService('rec', {
      llmFactory: () => llm,
      mcpClientFactory: mockMcpFactory(),
      runtimeAuth: null,
      // usageReporter omitted intentionally
    })
    svc.configure({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-123' })
    // Only assertion is "doesn't throw" — the reporter is null, so the
    // helper short-circuits before touching it.
    const res = await svc.executeStep({ stepId: 's1', instruction: 'hi' })
    expect(res.status).toBe('completed')
  })
})

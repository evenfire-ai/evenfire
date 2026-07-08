import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { FinishReason, type ToolCompletionResponse } from '../../core/types'
import type { SingleTurnProvider } from '../../llm'
import type { McpClientConnection, McpClientFactory } from '../stepRouter'
import { WorkflowService } from '../workflowService'

// ─── Mock Factories ─────────────────────────────────────────────────────

function mockLlmProvider(
  responses: Array<{
    content: string | null
    tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> | null
    finish_reason?: FinishReason | string
  }>
): SingleTurnProvider {
  let callIndex = 0
  return {
    completeSingleTurn: vi.fn().mockImplementation(() => {
      const r = responses[callIndex++] ?? { content: 'done' }
      return Promise.resolve({
        content: r.content ?? '',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: r.finish_reason ?? 'stop',
      })
    }),
    completeSingleTurnWithTools: vi.fn().mockImplementation(() => {
      const r = responses[callIndex++] ?? { content: 'done', tool_calls: null }
      return Promise.resolve({
        content: r.content,
        tool_calls: r.tool_calls ?? null,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: r.finish_reason ?? (r.tool_calls ? 'tool_use' : 'stop'),
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

afterEach(() => {
  delete process.env.MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS
})

function mockLlmFactory(provider: SingleTurnProvider) {
  return () => provider
}

function mockMcpClient(
  tools: Array<{ name: string }> = [],
  callResults: Record<string, unknown> = {}
): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools.map(t => ({ name: t.name, description: '' }))),
    callTool: vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ content: callResults[name] ?? `result-${name}`, isError: false })
      ),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function mockMcpFactory(clients: Map<string, McpClientConnection>): McpClientFactory {
  return server => clients.get(server.name) ?? mockMcpClient()
}

function createConfiguredService(
  llmProvider: SingleTurnProvider,
  mcpClients?: Map<string, McpClientConnection>
) {
  const svc = new WorkflowService('test-recipe', {
    llmFactory: mockLlmFactory(llmProvider),
    mcpClientFactory: mcpClients ? mockMcpFactory(mcpClients) : () => mockMcpClient(),
  })
  svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
  return svc
}

describe('POST /execute — happy path', () => {
  it('connects to declared MCP servers', async () => {
    const client = mockMcpClient([{ name: 'tool1' }])
    const llm = mockLlmProvider([{ content: 'done', tool_calls: null }])
    const svc = createConfiguredService(llm, new Map([['srv', client]]))

    await svc.executeStep({
      stepId: 's1',
      instruction: 'do stuff',
      mcpServers: [{ name: 'srv', url: 'http://srv' }],
    })
    expect(client.connect).toHaveBeenCalled()
  })

  it('calls LLM with filtered tool list', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const client = mockMcpClient([{ name: 'read' }, { name: 'write' }])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    await svc.executeStep({
      stepId: 's1',
      instruction: 'query',
      mcpServers: [{ name: 'db', url: 'http://db' }],
      allowedTools: { include: ['db__read'] },
    })

    expect(llm.completeSingleTurnWithTools).toHaveBeenCalled()
  })

  it('passes caller abort signal into the LLM provider', async () => {
    let providerSignal: AbortSignal | undefined
    let markProviderCalled!: () => void
    const providerCalled = new Promise<void>(resolve => {
      markProviderCalled = resolve
    })
    const completeSingleTurnWithTools = vi.fn(
      (
        _messages: Parameters<SingleTurnProvider['completeSingleTurnWithTools']>[0],
        _tools: Parameters<SingleTurnProvider['completeSingleTurnWithTools']>[1],
        options?: Parameters<SingleTurnProvider['completeSingleTurnWithTools']>[2]
      ): Promise<ToolCompletionResponse> =>
        new Promise<ToolCompletionResponse>((_resolve, reject) => {
          providerSignal = options?.signal
          markProviderCalled()
          if (options?.signal?.aborted) {
            reject(new Error(String(options.signal.reason ?? 'aborted')))
            return
          }
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error(String(options.signal?.reason ?? 'aborted'))),
            { once: true }
          )
        })
    )
    const llm: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools,
      getProviderType: () => 'openai',
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'mock',
      })),
    }
    const client = mockMcpClient([{ name: 'read' }])
    const svc = createConfiguredService(llm, new Map([['db', client]]))
    const controller = new AbortController()

    const pending = svc.executeStep(
      {
        stepId: 's1',
        instruction: 'query',
        mcpServers: [{ name: 'db', url: 'http://db' }],
      },
      undefined,
      { signal: controller.signal }
    )
    await providerCalled
    controller.abort('client-disconnected')
    const result = await pending

    expect(result.status).toBe('failed')
    expect(result.error).toBe('client-disconnected')
    expect(providerSignal).toBeInstanceOf(AbortSignal)
  })

  it('dispatches tool calls returned by LLM', async () => {
    const client = mockMcpClient([{ name: 'read' }])
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'db__read', arguments: { q: 'SELECT 1' } }] },
      { content: 'Query result: 1', tool_calls: null },
    ])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'query',
      mcpServers: [{ name: 'db', url: 'http://db' }],
    })

    expect(client.callTool).toHaveBeenCalledWith(
      'read',
      { q: 'SELECT 1' },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
      })
    )
    const callOptions = (client.callTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
    expect(callOptions?.signal.aborted).toBe(false)
    expect(callOptions?.timeoutMs).toBeGreaterThan(0)
    expect(result.status).toBe('completed')
  })

  it('continues LLM loop until no tool calls in response', async () => {
    const client = mockMcpClient([{ name: 't1' }])
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__t1', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__t1', arguments: {} }] },
      { content: 'final answer', tool_calls: null },
    ])
    const svc = createConfiguredService(llm, new Map([['srv', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'loop test',
      mcpServers: [{ name: 'srv', url: 'http://srv' }],
    })

    expect(result.output).toBe('final answer')
    expect(result.toolsCalled).toHaveLength(2)
  })

  it('returns StepExecutionResult with output, toolsCalled, tokensUsed', async () => {
    const llm = mockLlmProvider([{ content: 'done', tool_calls: null }])
    const svc = createConfiguredService(llm)

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.stepId).toBe('s1')
    expect(result.status).toBe('completed')
    expect(result.output).toBe('done')
    expect(result.tokensUsed).toBeDefined()
  })

  it('includes completedAt in ISO 8601 format', async () => {
    const llm = mockLlmProvider([{ content: 'done' }])
    const svc = createConfiguredService(llm)

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('passes MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS to text-only provider calls when configured', async () => {
    process.env.MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS = '2048'
    const llm = mockLlmProvider([{ content: 'done', tool_calls: null }])
    const svc = createConfiguredService(llm)

    await svc.executeStep({ stepId: 's1', instruction: 'test' })

    expect(llm.completeSingleTurn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ max_tokens: 2048 })
    )
  })

  it('passes MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS to tool-capable provider calls when configured', async () => {
    process.env.MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS = '1024'
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const svc = createConfiguredService(llm)

    await svc.executeStep({
      stepId: 's1',
      instruction: 'generate report',
      allowedTools: { include: ['clerum__generate_pdf'] },
    })

    expect(llm.completeSingleTurnWithTools).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({ max_tokens: 1024 })
    )
  })

  it('retries once when provider stops by length and completes with continuation output', async () => {
    const llm = mockLlmProvider([
      { content: 'part one', finish_reason: FinishReason.Length },
      { content: 'part two', finish_reason: FinishReason.Stop },
    ])
    const svc = createConfiguredService(llm)

    const result = await svc.executeStep({ stepId: 's1', instruction: 'write report' })

    expect(result.status).toBe('completed')
    expect(result.output).toBe('part one\npart two')
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(2)
  })

  it('fails explicitly when provider remains length-limited without an artifact', async () => {
    const llm = mockLlmProvider([
      { content: 'part one', finish_reason: FinishReason.Length },
      { content: 'part two', finish_reason: FinishReason.Length },
    ])
    const svc = createConfiguredService(llm)

    const result = await svc.executeStep({ stepId: 's1', instruction: 'write report' })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('provider_output_length_exceeded')
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(2)
  })

  it('keeps artifact source of truth when provider remains length-limited after creating an artifact', async () => {
    const artifact = {
      success: true,
      artifact: {
        name: 'report.pdf',
        format: 'pdf',
        path: '/output/report.pdf',
        sizeBytes: 12,
        createdAt: '2026-05-13T00:00:00.000Z',
      },
    }
    const client = mockMcpClient([{ name: 'make_report' }], { make_report: artifact })
    const llm = mockLlmProvider([
      {
        content: null,
        tool_calls: [
          {
            name: 'srv__make_report',
            arguments: { filename: 'report.pdf' },
          },
        ],
      },
      { content: 'partial summary', finish_reason: FinishReason.Length },
      { content: 'still partial', finish_reason: FinishReason.Length },
    ])
    const svc = createConfiguredService(llm, new Map([['srv', client]]))

    const result = await svc.executeStep({
      stepId: 'generate-report',
      instruction: 'generate a report',
      mcpServers: [{ name: 'srv', url: 'http://srv' }],
    })

    expect(result.status).toBe('completed')
    expect(result.output).toContain('Use the run artifacts for the complete output')
    expect(result.output).toContain('report.pdf')
    expect(result.toolsCalled).toHaveLength(1)
  })
})

describe('POST /execute — tool scoping', () => {
  it('uses text-only LLM calls for steps without MCP servers or explicit allowedTools', async () => {
    const llm = mockLlmProvider([{ content: 'analysis complete', tool_calls: null }])
    const svc = createConfiguredService(llm)

    await svc.executeStep({
      stepId: 'analysis',
      instruction: 'summarize the prior output',
    })

    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(1)
    expect(llm.completeSingleTurnWithTools).not.toHaveBeenCalled()
  })

  it('presents internal tools only when explicitly allowed by the step', async () => {
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const svc = createConfiguredService(llm)

    await svc.executeStep({
      stepId: 'generate-report',
      instruction: 'generate a report',
      allowedTools: { include: ['clerum__generate_pdf'] },
    })

    const callArgs = (llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mock.calls[0]
    const tools = callArgs[1]
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('clerum__generate_pdf')
  })

  it('presents only allowedTools.include tools to LLM', async () => {
    const client = mockMcpClient([{ name: 'read' }, { name: 'write' }, { name: 'delete' }])
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    await svc.executeStep({
      stepId: 's1',
      instruction: 'safe query',
      mcpServers: [{ name: 'db', url: 'http://db' }],
      allowedTools: { include: ['db__read'] },
    })

    const callArgs = (llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mock.calls[0]
    const tools = callArgs[1]
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('db__read')
  })

  it('forwards explicit toolChoice to the tool-calling provider call', async () => {
    const client = mockMcpClient([{ name: 'read' }])
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'db__read', arguments: { id: 'one' } }] },
      { content: 'ok', tool_calls: null },
    ])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    await svc.executeStep({
      stepId: 's1',
      instruction: 'safe query',
      mcpServers: [{ name: 'db', url: 'http://db' }],
      allowedTools: { include: ['db__read'] },
      toolChoice: 'required',
      maxIterations: 2,
    })

    const callArgs = (llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[2]).toEqual(expect.objectContaining({ tool_choice: 'required' }))
  })

  it('fails explicit toolChoice=required when the provider never emits a structured tool call', async () => {
    const client = mockMcpClient([{ name: 'read' }])
    const llm = mockLlmProvider([
      { content: 'plain text is not enough', tool_calls: null },
      { content: 'still no tool call', tool_calls: null },
    ])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'safe query',
      mcpServers: [{ name: 'db', url: 'http://db' }],
      allowedTools: { include: ['db__read'] },
      toolChoice: 'required',
      maxIterations: 2,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('required-tool-call-not-made')
    expect(client.callTool).not.toHaveBeenCalled()
    expect(llm.completeSingleTurnWithTools).toHaveBeenCalledTimes(2)
    const calls = (llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][1]).toHaveLength(1)
    expect(calls[1][1]).toHaveLength(1)
    expect(calls[1][2]).toEqual(expect.objectContaining({ tool_choice: 'required' }))
  })

  it('fails explicit toolChoice=required when the required tool returns an error result', async () => {
    const client = mockMcpClient([{ name: 'read' }], {
      read: { success: false, error: 'broker denied the workflow trigger' },
    })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'db__read', arguments: { id: 'one' } }] },
      { content: 'done anyway', tool_calls: null },
    ])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'safe query',
      mcpServers: [{ name: 'db', url: 'http://db' }],
      allowedTools: { include: ['db__read'] },
      toolChoice: 'required',
      maxIterations: 2,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('required-tool-call-failed')
    expect(result.error).toContain('broker denied the workflow trigger')
    expect(client.callTool).toHaveBeenCalledWith(
      'read',
      { id: 'one' },
      expect.objectContaining({
        signal: expect.any(Object),
        timeoutMs: expect.any(Number),
      })
    )
  })

  it('does not present disallowed tools even when server exposes them', async () => {
    const client = mockMcpClient([{ name: 'read' }, { name: 'delete' }])
    const llm = mockLlmProvider([{ content: 'ok', tool_calls: null }])
    const svc = createConfiguredService(llm, new Map([['db', client]]))

    await svc.executeStep({
      stepId: 's1',
      instruction: 'safe',
      mcpServers: [{ name: 'db', url: 'http://db' }],
      allowedTools: { include: ['db__read'] },
    })

    const tools = (llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(tools.some((t: { name: string }) => t.name === 'db__delete')).toBe(false)
  })
})

describe('POST /execute — connection failure', () => {
  it('returns failed with error when MCP connect fails', async () => {
    const client = mockMcpClient()
    ;(client.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refused'))
    const llm = mockLlmProvider([])
    const svc = createConfiguredService(llm, new Map([['bad', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'test',
      mcpServers: [{ name: 'bad', url: 'http://bad' }],
    })
    expect(result.status).toBe('failed')
  })

  it('calls disconnect in finally block on connection failure', async () => {
    // disconnect is called inside the StepMcpRouter — tested in stepRouter.test.ts
    // Here we verify the service doesn't throw uncaught
    const client = mockMcpClient()
    ;(client.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refused'))
    const llm = mockLlmProvider([])
    const svc = createConfiguredService(llm, new Map([['bad', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'test',
      mcpServers: [{ name: 'bad', url: 'http://bad' }],
    })
    expect(result.status).toBe('failed')
  })
})

describe('POST /execute — SOUL lifecycle', () => {
  it('uses per-step SOUL when soulOverrideActive is true', async () => {
    const llm = mockLlmProvider([{ content: 'ok' }])
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(llm),
      mcpClientFactory: () => mockMcpClient(),
      globalSoulContent: 'Global SOUL',
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k', soulContent: 'Step SOUL' })

    expect(svc.getActiveSoulContent()).toBe('Step SOUL')
  })

  it('reverts to global SOUL after step completes successfully', async () => {
    const llm = mockLlmProvider([{ content: 'ok' }])
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(llm),
      mcpClientFactory: () => mockMcpClient(),
      globalSoulContent: 'Global SOUL',
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k', soulContent: 'Step SOUL' })

    await svc.executeStep({ stepId: 's1', instruction: 'test' })

    expect(svc.isSoulOverrideActive()).toBe(false)
    expect(svc.getActiveSoulContent()).toBe('Global SOUL')
  })

  it('reverts to global SOUL after step fails', async () => {
    const client = mockMcpClient()
    ;(client.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'))
    const llm = mockLlmProvider([])
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(llm),
      mcpClientFactory: () => client,
      globalSoulContent: 'Global',
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k', soulContent: 'Override' })

    await svc.executeStep({
      stepId: 's1',
      instruction: 'test',
      mcpServers: [{ name: 's', url: 'http://s' }],
    })

    expect(svc.isSoulOverrideActive()).toBe(false)
  })
})

describe('POST /execute — not configured', () => {
  it('returns failed when service not configured', async () => {
    const svc = new WorkflowService('test')
    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('not configured')
  })
})

describe('POST /execute — ToolCallRecord', () => {
  it('records serverName, toolName, args, result, durationMs for each tool call', async () => {
    const client = mockMcpClient([{ name: 'add' }], { add: 42 })
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'calc__add', arguments: { a: 1, b: 2 } }] },
      { content: '42' },
    ])
    const svc = createConfiguredService(llm, new Map([['calc', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'add',
      mcpServers: [{ name: 'calc', url: 'http://calc' }],
    })

    expect(result.toolsCalled).toHaveLength(1)
    expect(result.toolsCalled![0].serverName).toBe('calc')
    expect(result.toolsCalled![0].toolName).toBe('add')
    expect(result.toolsCalled![0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records multiple tool calls in order of dispatch', async () => {
    const client = mockMcpClient([{ name: 'a' }, { name: 'b' }])
    const llm = mockLlmProvider([
      { content: null, tool_calls: [{ name: 'srv__a', arguments: {} }] },
      { content: null, tool_calls: [{ name: 'srv__b', arguments: {} }] },
      { content: 'done' },
    ])
    const svc = createConfiguredService(llm, new Map([['srv', client]]))

    const result = await svc.executeStep({
      stepId: 's1',
      instruction: 'multi',
      mcpServers: [{ name: 'srv', url: 'http://srv' }],
    })

    expect(result.toolsCalled).toHaveLength(2)
    expect(result.toolsCalled![0].toolName).toBe('a')
    expect(result.toolsCalled![1].toolName).toBe('b')
  })
})

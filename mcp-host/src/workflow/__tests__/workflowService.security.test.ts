import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import type { SingleTurnProvider } from '../../llm'
import { INTERNAL_TOOLS } from '../internalTools'
import { type McpClientConnection, StepMcpRouter } from '../stepRouter'
import type { AllowedToolsConfig, ExecuteStepRequest } from '../types'
import { WorkflowService } from '../workflowService'

// ─── Mock Factories ─────────────────────────────────────────────────────

function mockLlmProvider(
  responses: Array<{
    content: string | null
    tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> | null
  }>
): SingleTurnProvider {
  let callIndex = 0
  return {
    completeSingleTurn: vi.fn().mockImplementation(() => {
      const r = responses[callIndex++] ?? { content: 'done' }
      return Promise.resolve({
        content: r.content ?? '',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: 'stop',
      })
    }),
    completeSingleTurnWithTools: vi.fn().mockImplementation(() => {
      const r = responses[callIndex++] ?? { content: 'done', tool_calls: null }
      return Promise.resolve({
        content: r.content,
        tool_calls: r.tool_calls ?? null,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
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

function mockLlmFactory(provider?: SingleTurnProvider) {
  return (_p: string, _m: string, _apiKey: string) =>
    provider ?? mockLlmProvider([{ content: 'ok' }])
}

function mockMcpClient(
  tools: Array<{ name: string; description?: string }> = []
): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: 'result', isError: false }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function createService(opts?: { globalSoul?: string }) {
  return new WorkflowService('test', {
    llmFactory: mockLlmFactory(),
    mcpClientFactory: () => mockMcpClient(),
    globalSoulContent: opts?.globalSoul,
  })
}

// ─── V6: Error message sanitization ────────────────────────────────────

describe('V6: error message sanitization in executeStep', () => {
  it('redacts OpenAI API key patterns from error messages', async () => {
    const llm = mockLlmProvider([])
    const err = new Error(
      'Authentication failed: Invalid API key sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz'
    )
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-test' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).not.toContain('sk-proj-abc123')
    expect(result.error).toContain('[REDACTED]')
  })

  it('redacts Anthropic API key patterns from error messages', async () => {
    const llm = mockLlmProvider([])
    const err = new Error('Error: sk-ant-api03-longkeyvalue1234567890abcdef is invalid')
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.error).not.toContain('sk-ant-api03')
    expect(result.error).toContain('[REDACTED]')
  })

  it('redacts Bearer tokens from error messages', async () => {
    const llm = mockLlmProvider([])
    const err = new Error('Request failed: Bearer header.payload.signature was rejected')
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.error).not.toContain('eyJhbGci')
    expect(result.error).toContain('[REDACTED]')
  })

  it('redacts Zhipu AI API key patterns from error messages', async () => {
    // Zhipu AI keys use hex32.alnum16 format (no "zai-" prefix)
    const zhipuKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.AbCdEfGh12345678'
    const llm = mockLlmProvider([])
    const err = new Error(`Unauthorized: ${zhipuKey} is expired`)
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.error).not.toContain('a1b2c3d4e5f6')
    expect(result.error).toContain('[REDACTED]')
  })

  it('preserves non-sensitive error messages unchanged', async () => {
    const llm = mockLlmProvider([])
    const err = new Error('Connection timeout after 30000ms')
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.error).toBe('Connection timeout after 30000ms')
  })
})

// ─── apiKey in-memory lifecycle ────────────────────────────────────────

describe('apiKey in-memory lifecycle', () => {
  it('apiKey is NOT exposed via getStatus()', () => {
    const svc = createService()
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-secret-key' })

    const status = svc.getStatus()
    const statusStr = JSON.stringify(status)
    expect(statusStr).not.toContain('sk-secret-key')
    expect(statusStr).not.toContain('apiKey')
  })

  it('apiKey is NOT exposed via any public getter', () => {
    const svc = createService()
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-secret-key' })

    // Enumerate all public methods/properties
    const publicApi = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter(
      key =>
        key !== 'constructor' &&
        typeof (svc as unknown as Record<string, unknown>)[key] === 'function'
    )

    for (const method of publicApi) {
      if (method === 'executeStep' || method === 'configure') continue
      const result = (svc as unknown as Record<string, (...args: unknown[]) => unknown>)[method]()
      if (result !== undefined) {
        const resultStr = JSON.stringify(result)
        expect(resultStr).not.toContain('sk-secret-key')
      }
    }
  })

  it('configure response does not contain apiKey', () => {
    const svc = createService()
    const result = svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-secret-key' })
    const resultStr = JSON.stringify(result)
    expect(resultStr).not.toContain('sk-secret-key')
    expect(resultStr).not.toContain('apiKey')
  })
})

// ─── SOUL content security ─────────────────────────────────────────────

describe('SOUL content security boundaries', () => {
  it('rejects soulContent exceeding 64KB', () => {
    const svc = createService()
    const bigContent = 'x'.repeat(65 * 1024)
    const result = svc.configure({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'k',
      soulContent: bigContent,
    })
    expect(result.configured).toBe(false)
    expect(result.message).toContain('64KB')
  })

  it('accepts soulContent at exactly 64KB boundary', () => {
    const svc = createService()
    const content = 'x'.repeat(64 * 1024)
    const result = svc.configure({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'k',
      soulContent: content,
    })
    expect(result.configured).toBe(true)
  })

  it('SOUL override is always reverted after executeStep even on error', async () => {
    const client = mockMcpClient()
    ;(client.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'))
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(),
      mcpClientFactory: () => client,
      globalSoulContent: 'Global',
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k', soulContent: 'Override' })
    expect(svc.isSoulOverrideActive()).toBe(true)

    await svc.executeStep({
      stepId: 's1',
      instruction: 'test',
      mcpServers: [{ name: 's', url: 'http://s' }],
    })

    expect(svc.isSoulOverrideActive()).toBe(false)
    expect(svc.getActiveSoulContent()).toBe('Global')
  })

  it('SOUL override is reverted after successful executeStep', async () => {
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(mockLlmProvider([{ content: 'ok' }])),
      mcpClientFactory: () => mockMcpClient(),
      globalSoulContent: 'Global',
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k', soulContent: 'Step SOUL' })

    await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(svc.isSoulOverrideActive()).toBe(false)
  })
})

// ─── Provider validation ───────────────────────────────────────────────

describe('provider validation security', () => {
  it('rejects empty provider string', () => {
    const svc = createService()
    const result = svc.configure({ provider: '' as never, model: 'gpt-4', apiKey: 'k' })
    expect(result.configured).toBe(false)
  })

  it('rejects unknown provider strings (prevents arbitrary LLM endpoint injection)', () => {
    const svc = createService()
    const result = svc.configure({ provider: 'evil-provider' as never, model: 'x', apiKey: 'k' })
    expect(result.configured).toBe(false)
  })

  it('rejects missing apiKey', () => {
    const svc = createService()
    const result = svc.configure({ provider: 'openai', model: 'gpt-4' } as never)
    expect(result.configured).toBe(false)
  })

  it('executeStep returns failed when service not configured', async () => {
    const svc = new WorkflowService('test')
    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('not configured')
  })
})

// ─── Auth error diagnostics (401/403) ────────────────────────────────

describe('LLM auth error detection and diagnostics', () => {
  it('detects 401 error with err.status and produces actionable diagnostic', async () => {
    const llm = mockLlmProvider([])
    const err = Object.assign(new Error('401 token expired or incorrect'), { status: 401 })
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'zai', model: 'glm-4.7', apiKey: 'valid-key-12345' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('LLM authentication failed')
    expect(result.error).toContain('zai')
    expect(result.error).toContain('glm-4.7')
    expect(result.error).toContain('Kubernetes Secret')
    expect(result.error).not.toContain('placeholder')
  })

  it('detects placeholder API key and surfaces specific diagnostic', async () => {
    const llm = mockLlmProvider([])
    const err = Object.assign(new Error('401 Unauthorized'), { status: 401 })
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'zai', model: 'glm-5', apiKey: 'REPLACE_WITH_ZAI_API_KEY' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('placeholder')
    // Without a configured secret ref, diagnostics point to the mapped Secret instead of hardcoding one.
    expect(result.error).toContain('mapped model Secret')
    expect(result.error).toContain('mcp-host namespace')
  })

  it('detects 403 forbidden as auth error', async () => {
    const llm = mockLlmProvider([])
    const err = Object.assign(new Error('403 Forbidden'), { status: 403 })
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({
      provider: 'claude',
      model: 'claude-4-sonnet',
      apiKey: 'sk-ant-valid-key-12345',
    })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('LLM authentication failed')
    expect(result.error).toContain('claude')
  })

  it('detects 401 from error message when err.status is unavailable', async () => {
    const llm = mockLlmProvider([])
    // Some providers embed status in message instead of err.status
    const err = new Error('Request failed with status 401')
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'valid-key-here' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('LLM authentication failed')
  })

  it('non-auth errors still get sanitized but no auth diagnostic', async () => {
    const llm = mockLlmProvider([])
    const err = new Error('Connection timeout after 30000ms')
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(err)
    const svc = new WorkflowService('test', {
      llmFactory: () => llm,
      mcpClientFactory: () => mockMcpClient(),
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })

    const result = await svc.executeStep({ stepId: 's1', instruction: 'test' })
    expect(result.status).toBe('failed')
    expect(result.error).not.toContain('LLM authentication failed')
    expect(result.error).toBe('Connection timeout after 30000ms')
  })
})

// ─── Spec §3.1.2: workflow tool allowlist enforced at call time ─────────

describe('workflow tool allowlist enforced at call time (spec §3.1.2)', () => {
  const FINAL_TEXT = 'Review complete: no blocking issues found.'
  // Schema-valid for the module-level INTERNAL_TOOLS read/trigger definitions
  // (required: namespace + name), so a regression reaches execute() instead of
  // being stopped early by argument validation.
  const FOREIGN_WORKFLOW_ARGS = { namespace: 'sandbox-recipes', name: 'other-recipe' }
  const PR_REVIEW_ALLOWLIST: AllowedToolsConfig = { include: ['srv__read'] }

  const notAllowed = (toolName: string) =>
    `Tool '${toolName}' is not allowed in this step and was not run. Use only the tools provided for this step.`

  type ScriptedCall = { name: string; arguments: Record<string, unknown> }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function spyInternalExecute(name: string) {
    const tool = INTERNAL_TOOLS.find(t => t.name === name)
    if (!tool) throw new Error(`INTERNAL_TOOLS has no ${name}`)
    return vi
      .spyOn(tool, 'execute')
      .mockResolvedValue({ success: true, content: `${name} executed` })
  }

  // Server `srv` exposes [read, write]. The fake provider answers the first
  // turn with `toolCalls` (if any) and the next turn with FINAL_TEXT.
  function harness(toolCalls: ScriptedCall[]) {
    const client = mockMcpClient([{ name: 'read' }, { name: 'write' }])
    const llm = mockLlmProvider(
      toolCalls.length > 0
        ? [
            { content: null, tool_calls: toolCalls },
            { content: FINAL_TEXT, tool_calls: null },
          ]
        : [{ content: FINAL_TEXT, tool_calls: null }]
    )
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(llm),
      mcpClientFactory: () => client,
    })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })
    return { client, llm, svc }
  }

  function runStep(
    svc: WorkflowService,
    allowedTools?: AllowedToolsConfig,
    extra: Partial<ExecuteStepRequest> = {}
  ) {
    return svc.executeStep({
      stepId: 'review',
      instruction: 'Review the pull request.',
      mcpServers: [{ name: 'srv', url: 'http://srv' }],
      ...(allowedTools ? { allowedTools } : {}),
      ...extra,
    })
  }

  function providerCall(llm: SingleTurnProvider, index: number) {
    const calls = vi.mocked(llm.completeSingleTurnWithTools).mock.calls
    expect(calls.length, `provider was called ${calls.length} times`).toBeGreaterThan(index)
    return {
      messages: calls[index][0] as Array<{ role: string; content: string }>,
      tools: calls[index][1] as Array<{ name: string }>,
    }
  }

  // The model sees each tool result as `<tool-result server="<name>" …>\n<json>\n</tool-result>`
  // on the turn after the call (workflowService.ts executeStep tool loop).
  function toolResultSeenByModel(llm: SingleTurnProvider, toolName: string): unknown {
    const { messages } = providerCall(llm, 1)
    const prefix = `<tool-result server="${toolName}" data-only="true">\n`
    const suffix = '\n</tool-result>'
    const message = messages.find(m => m.role === 'user' && m.content.startsWith(prefix))
    expect(message, `the model never received a tool result for ${toolName}`).toBeDefined()
    const content = message?.content ?? ''
    return JSON.parse(content.slice(prefix.length, content.length - suffix.length))
  }

  it.each<[string, Record<string, unknown>]>([
    ['srv__write', { path: 'README.md', content: 'pwned' }],
    ['clerum__trigger_workflow', FOREIGN_WORKFLOW_ARGS],
    ['clerum__read_workflow', FOREIGN_WORKFLOW_ARGS],
  ])(
    'never runs %s outside include, returns a tool error to the model, and completes the step',
    async (toolName, args) => {
      const triggerExecute = spyInternalExecute('clerum__trigger_workflow')
      const readExecute = spyInternalExecute('clerum__read_workflow')
      const { client, llm, svc } = harness([{ name: toolName, arguments: args }])

      const result = await runStep(svc, PR_REVIEW_ALLOWLIST)

      expect(result.status).toBe('completed')
      expect(result.output).toBe(FINAL_TEXT)
      expect(client.callTool).not.toHaveBeenCalled()
      expect(triggerExecute).not.toHaveBeenCalled()
      expect(readExecute).not.toHaveBeenCalled()
      expect(providerCall(llm, 0).tools.map(t => t.name)).toEqual(['srv__read'])
      expect(toolResultSeenByModel(llm, toolName)).toEqual({
        success: false,
        error: notAllowed(toolName),
      })
      expect(result.toolsCalled?.map(r => r.result)).toEqual([
        { success: false, error: notAllowed(toolName) },
      ])
    }
  )

  it('rejects every forbidden call in one turn while the allowlisted call still dispatches', async () => {
    const triggerExecute = spyInternalExecute('clerum__trigger_workflow')
    const readExecute = spyInternalExecute('clerum__read_workflow')
    const { client, llm, svc } = harness([
      { name: 'srv__write', arguments: { path: 'README.md', content: 'pwned' } },
      { name: 'clerum__trigger_workflow', arguments: FOREIGN_WORKFLOW_ARGS },
      { name: 'clerum__read_workflow', arguments: FOREIGN_WORKFLOW_ARGS },
      { name: 'srv__read', arguments: { path: 'README.md' } },
    ])

    const result = await runStep(svc, PR_REVIEW_ALLOWLIST)

    expect(result.status).toBe('completed')
    expect(result.output).toBe(FINAL_TEXT)
    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(client.callTool).toHaveBeenCalledWith(
      'read',
      { path: 'README.md' },
      expect.objectContaining({ signal: expect.any(Object), timeoutMs: expect.any(Number) })
    )
    expect(triggerExecute).not.toHaveBeenCalled()
    expect(readExecute).not.toHaveBeenCalled()
    for (const toolName of ['srv__write', 'clerum__trigger_workflow', 'clerum__read_workflow']) {
      expect(toolResultSeenByModel(llm, toolName)).toEqual({
        success: false,
        error: notAllowed(toolName),
      })
    }
    expect(toolResultSeenByModel(llm, 'srv__read')).toBe('result')
  })

  it('still runs an internal tool the allowlist names', async () => {
    const listExecute = spyInternalExecute('clerum__list_workflows')
    const { client, llm, svc } = harness([{ name: 'clerum__list_workflows', arguments: {} }])

    const result = await runStep(svc, { include: ['srv__read', 'clerum__list_workflows'] })

    expect(result.status).toBe('completed')
    expect(listExecute).toHaveBeenCalledTimes(1)
    expect(client.callTool).not.toHaveBeenCalled()
    expect(providerCall(llm, 0).tools.map(t => t.name)).toEqual([
      'clerum__list_workflows',
      'srv__read',
    ])
    expect(toolResultSeenByModel(llm, 'clerum__list_workflows')).toEqual({
      success: true,
      content: 'clerum__list_workflows executed',
    })
  })

  it('registers only the internal tools the allowlist names', async () => {
    const register = vi.spyOn(StepMcpRouter.prototype, 'registerInternalTools')
    const { svc } = harness([])

    const result = await runStep(svc, { include: ['srv__read', 'clerum__list_workflows'] })

    expect(result.status).toBe('completed')
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0][0].map(t => t.name)).toEqual(['clerum__list_workflows'])
  })

  it.each<[string, AllowedToolsConfig | undefined]>([
    ['absent', undefined],
    ['empty', { include: [] }],
  ])(
    "keeps today's behaviour when allowedTools.include is %s: every tool is registered, offered and callable",
    async (_label, allowedTools) => {
      const register = vi.spyOn(StepMcpRouter.prototype, 'registerInternalTools')
      const listExecute = spyInternalExecute('clerum__list_workflows')
      const { client, llm, svc } = harness([
        { name: 'srv__write', arguments: { path: 'notes.md' } },
        { name: 'clerum__list_workflows', arguments: {} },
      ])

      const result = await runStep(svc, allowedTools)

      expect(result.status).toBe('completed')
      expect(client.callTool).toHaveBeenCalledWith(
        'write',
        { path: 'notes.md' },
        expect.objectContaining({ signal: expect.any(Object) })
      )
      expect(listExecute).toHaveBeenCalledTimes(1)
      const workflowAndCapabilityTools = [
        'clerum__list_workflows',
        'clerum__read_workflow',
        'clerum__trigger_workflow',
        'clerum__get_capabilities',
        'clerum__generate_markdown',
      ]
      expect(register.mock.calls[0][0].map(t => t.name)).toEqual(
        expect.arrayContaining(workflowAndCapabilityTools)
      )
      expect(providerCall(llm, 0).tools.map(t => t.name)).toEqual(
        expect.arrayContaining(['srv__read', 'srv__write', ...workflowAndCapabilityTools])
      )
    }
  )

  it('keeps failing the step on an unknown tool name when no allowlist is in effect', async () => {
    const { client, svc } = harness([{ name: 'ghost__tool', arguments: {} }])

    const result = await runStep(svc)

    expect(result.status).toBe('failed')
    expect(result.error).toContain("Unknown tool: 'ghost__tool'")
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('does not let a rejected call satisfy toolChoice=required', async () => {
    const { client, svc } = harness([{ name: 'srv__write', arguments: { path: 'README.md' } }])

    const result = await runStep(svc, PR_REVIEW_ALLOWLIST, { toolChoice: 'required' })

    expect(result.status).toBe('failed')
    expect(result.error).toBe(`required-tool-call-failed: srv__write: ${notAllowed('srv__write')}`)
    expect(client.callTool).not.toHaveBeenCalled()
  })
})

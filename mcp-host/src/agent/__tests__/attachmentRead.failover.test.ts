import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { toolMessageBudgetTokens } from '../../core/extensions/contextManager'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import type { TokenCounter } from '../../core/tokenizer/tokenCounter'
import { type ChatMessage, FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { FailoverEngine } from '../../llm/failover/engine'
import type { LlmPolicy } from '../../llm/failover/types'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import { validateIncomingAttachments } from '../incomingAttachments'
import { TaskExecutor } from '../taskExecutor'

const saved = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  tokenizerDryrun: appConfig.tokenizerDryrun,
}
afterEach(() => Object.assign(appConfig, saved))

it.each([true, false])(
  'bounds the page for a smaller fallback tokenizer (fail before page: %s)',
  async failBeforePage => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      tokenizerDryrun: true,
    })
    const bytes = Buffer.from('A'.repeat(65_535))
    const admitted = validateIncomingAttachments(
      [
        {
          id: 'file-1',
          kind: 'file',
          filename: 'public-dense.txt',
          mimeType: 'text/plain',
          detectedMediaType: 'text/plain',
          encoding: 'base64',
          sizeBytes: bytes.length,
          dataBase64: bytes.toString('base64'),
          digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
        },
      ],
      { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 11_534_336, messageId: 'window-message' }
    )
    if (!admitted.ok) throw new Error('Invalid public file fixture')
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    const received: ChatMessage[][] = []
    let primaryCalls = 0
    const readResponse = () => ({
      content: null,
      usage,
      finish_reason: FinishReason.ToolUse,
      tool_calls: [
        {
          id: 'window-read',
          name: 'clerum__attachment_read',
          arguments: { attachmentId: 'file-1' },
        },
      ],
    })
    const unexpected = () => {
      throw new Error('Unexpected completion')
    }
    const primary: SingleTurnProvider = {
      getProviderType: () => 'openai',
      classifyError: unexpected,
      completeSingleTurn: unexpected,
      completeSingleTurnWithTools: vi.fn(async () => {
        primaryCalls += 1
        if (!failBeforePage && primaryCalls === 1) return readResponse()
        throw new LlmError('Public quota fixture', 'openai', LlmErrorCode.InsufficientQuota, false)
      }),
    }
    const fallback: SingleTurnProvider = {
      getProviderType: () => 'claude',
      classifyError: unexpected,
      completeSingleTurn: unexpected,
      completeSingleTurnWithTools: async messages => {
        received.push(structuredClone(messages))
        if (failBeforePage && received.length === 1) return readResponse()
        return {
          content: 'Page received',
          tool_calls: null,
          usage,
          finish_reason: FinishReason.Stop,
        }
      },
    }
    const fallbackCounter: TokenCounter = {
      providerName: 'claude',
      modelName: 'public-small-model',
      warmup: vi.fn(async () => {}),
      countSync: messages =>
        Math.ceil(messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 2) + 6,
      count: vi.fn(async () => {
        throw new Error('Network counting is forbidden in page measurement')
      }),
      recordObservedUsage: () => {},
      lastObservedInputTokens: () => null,
    }
    Object.assign(fallback, { createTokenCounter: () => fallbackCounter })
    const policy: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['insufficient_quota'],
      fallbacks: [{ provider: 'claude', model: 'public-small-model' }],
    }
    const catalog = vi.fn((provider: string, model: string) =>
      provider === 'claude' && model === 'public-small-model' ? 32_000 : undefined
    )
    const task: Task = {
      id: 'public-window-task',
      source: 'channel',
      status: 'pending',
      priority: 'normal',
      createdAt: new Date(),
      responseCallback: vi.fn(async () => {}),
      sourceMessage: {
        sender: 'authenticated-user',
        content: 'Read the file',
        channelType: 'rpc',
        channelId: 'isolated-channel',
        messageId: 'window-message',
        hostRef: 'fixture-host',
        timestamp: new Date().toISOString(),
        attachments: admitted.attachments,
      },
      conversationHistory: [{ role: 'user', content: 'Read the file', timestamp: new Date() }],
    }
    const lifecycle = new TaskLifecycle()
    lifecycle.register(task)
    const onFail = vi.fn()
    const executor = new TaskExecutor(task, {
      conversationManager: new ConversationManager(),
      llmProvider: primary,
      modelName: 'public-primary-model',
      contextWindowTokens: 128_000,
      mcpManager: new McpManager(),
      workspaceService: undefined,
      approvalConfig: undefined,
      config: {
        maxTaskDuration: 300_000,
        maxToolCallsPerTask: 10,
        autoStart: true,
        taskDelay: 0,
        approvalTimeout: 300_000,
      },
      coreEvents: new SimpleEventEmitter(),
      cronScheduler: null,
      taskLifecycle: lifecycle,
      onApprovalNeeded: vi.fn(),
      onComplete: vi.fn(),
      onFail,
      failover: {
        engine: new FailoverEngine(policy),
        policy,
        buildProvider: () => fallback,
        contextWindowForPair: catalog,
      },
    })
    await executor.run()
    expect(onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(primary.completeSingleTurnWithTools).toHaveBeenCalledTimes(failBeforePage ? 1 : 2)
    expect(received).toHaveLength(failBeforePage ? 2 : 1)
    const page = received
      .at(-1)!
      .find(message => message.role === 'tool' && message.tool_call_id === 'window-read')
    expect(page?.content).toContain('"kind":"text"')
    expect(page?.content).toContain('"truncated":true')
    expect(toolMessageBudgetTokens(page!, undefined, true)).toBeLessThanOrEqual(3_200)
    expect(fallbackCounter.countSync([page!])).toBeLessThanOrEqual(3_200)
    expect(fallbackCounter.count).not.toHaveBeenCalled()
    expect(catalog).toHaveBeenCalledWith('claude', 'public-small-model')
  }
)

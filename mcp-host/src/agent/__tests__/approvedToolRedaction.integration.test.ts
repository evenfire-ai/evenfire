/**
 * An approved card's call runs on the resume path, outside the loop. Its
 * result must get the same `post_tool_use` redaction a call admitted in the
 * loop gets, in every approval mode.
 *
 * The real post_tool_use hook path runs. Only the hook's HTTP call is answered
 * in-process, the way the guardrail adapter's own tests inject `fetchImpl`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import type { ApprovalMode } from '../../core/approval/approvalMode'
import { ConversationManager } from '../../core/conversation/conversation'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GuardrailsConfig } from '../../core/guardrails'
import type { FetchLike } from '../../core/guardrails/hooks/hookFetcher'
import { requestPinned } from '../../core/net/ssrf'
import type { ChatMessage } from '../../core/types'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { CronScheduler } from '../cronScheduler'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const SECRET = 'fixture-redaction-sentinel-7d41'
const REDACTED = '[redacted by hook]'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

vi.mock('../../core/net/ssrf', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/net/ssrf')>()
  return {
    ...actual,
    resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
    requestPinned: vi.fn(async () => ({ statusCode: 200, body: 'http-ok' })),
  }
})

const hookFetch = vi.hoisted(() => vi.fn())

vi.mock('../../core/guardrails', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/guardrails')>()
  return {
    ...actual,
    buildToolLaneGuardrail: (config: GuardrailsConfig | undefined) =>
      actual.buildToolLaneGuardrail(config, {
        getAuthToken: () => '',
        fetchImpl: hookFetch as unknown as FetchLike,
      }),
  }
})

/** A post_tool_use hook that may rewrite the model-visible result. */
const REDACTING_HOOK = {
  id: 'redact-results',
  endpoint: 'http://redactor',
  path: '/',
  lifecyclePoints: ['post_tool_use'],
  capabilities: ['may_rewrite'],
  failMode: 'open',
  order: 100,
} as const

const ASK_HTTP_RULE = {
  id: 'ask-http',
  action: 'ask',
  match: { tool: { provenance: 'native', name: 'http_request' } },
} as const

const savedEnableApproval = appConfig.enableApproval
const savedAllowlist = [...appConfig.nativeTool.httpAllowlist]

beforeEach(() => {
  appConfig.enableApproval = true
  appConfig.nativeTool.httpAllowlist = []
  vi.mocked(requestPinned).mockReset()
  vi.mocked(requestPinned).mockResolvedValue({ statusCode: 200, body: `token=${SECRET}` })
  hookFetch.mockReset()
  hookFetch.mockImplementation(async (url: string, init: { body: string }) => {
    if (!url.endsWith('/v1/post_tool_use')) return { status: 200, text: async () => '{}' }
    const sent = JSON.parse(init.body) as { result: { content: string } }
    const content = sent.result.content.replaceAll(SECRET, REDACTED)
    return { status: 200, text: async () => JSON.stringify({ updatedResult: { content } }) }
  })
})

afterEach(() => {
  appConfig.enableApproval = savedEnableApproval
  appConfig.nativeTool.httpAllowlist = savedAllowlist
})

function approvalPolicy(tools?: Record<string, boolean>): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: 'allow_all',
    channels: {},
    ...(tools ? { tools } : {}),
  }
}

function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

async function start(
  mode: ApprovalMode,
  guardrails: GuardrailsConfig,
  tools?: Record<string, boolean>
) {
  const manager = new ConversationManager()
  const lifecycle = new TaskLifecycle()
  const scheduler = new CronScheduler(new MessageQueue(), {
    statelessLifecycle: false,
    allowEnabledJobs: true,
  })
  const task: Task = {
    id: `redaction-${Math.random().toString(36).slice(2)}`,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'redaction-user',
      content: 'fetch it',
      channelType: 'rpc',
      channelId: 'redaction-agent',
      messageId: 'redaction-message',
      timestamp: new Date().toISOString(),
      hostRef: 'redaction-host',
    },
    conversationHistory: [{ role: 'user', content: 'fetch it', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: 'redaction-user',
    channelType: 'rpc',
    approvalMode: mode,
  })
  const seen: ChatMessage[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'claude',
    classifyError: () => {
      throw new Error('fixture classification is unused')
    },
    completeSingleTurn: vi.fn(async () => ({
      content: 'ESCALATE',
      usage,
      finish_reason: FinishReason.Stop,
    })),
    completeSingleTurnWithTools: vi.fn(async (messages: ChatMessage[]) => {
      seen.push(structuredClone(messages))
      const call =
        seen.length === 1
          ? [
              {
                id: 'http-redact',
                name: 'http_request',
                arguments: { url: 'https://example.test/x' },
              },
            ]
          : null
      return {
        content: call ? null : 'done',
        tool_calls: call,
        usage,
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    }),
  }
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'dispatched')
  const policy = approvalPolicy(tools)
  const deps: TaskExecutorDeps = {
    conversationManager: manager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    modelName: 'claude-test',
    approvalConfig: policy,
    approvalConfigProvider: () => ({ effective: policy, hostSpec: policy }),
    guardrailsConfig: guardrails,
    coreEvents: { emit: () => {}, on: () => {}, off: () => {} } as never,
    cronScheduler: scheduler,
    taskLifecycle: lifecycle,
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 8,
      autoStart: false,
      taskDelay: 0,
      approvalTimeout: 0,
    },
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
  }
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  scheduler.stop()
  return {
    executor,
    toolText: () =>
      (seen.at(-1) ?? [])
        .filter(message => message.role === 'tool')
        .map(messageText)
        .join('\n'),
    postHookCalls: () =>
      hookFetch.mock.calls.filter(call => String(call[0]).endsWith('/v1/post_tool_use')).length,
  }
}

describe('post_tool_use redaction of an approved call', () => {
  it.each([
    ['manual', 'an ordinary card', { hookDescriptors: [REDACTING_HOOK] }, undefined],
    ['auto', 'an admin-forced card', { hookDescriptors: [REDACTING_HOOK] }, { http_request: true }],
    [
      'allow_all',
      'a guardrail ask card',
      { rules: [ASK_HTTP_RULE], hookDescriptors: [REDACTING_HOOK] },
      undefined,
    ],
  ] as const)(
    'redacts the result in %s after %s is approved',
    async (mode, _card, guardrails, tools) => {
      const run = await start(mode, guardrails as unknown as GuardrailsConfig, tools)
      expect(run.executor.executorState).toBe('waiting_approval')
      expect(run.executor.pendingApproval?.tool_name).toBe('http_request')
      expect(requestPinned).not.toHaveBeenCalled()

      await run.executor.resumeAfterApproval(false, 'redaction-user', {
        effectiveMode: mode,
        surface: 'desktop',
      })

      expect(run.executor.executorState).toBe('completed')
      expect(requestPinned).toHaveBeenCalledTimes(1)
      expect(run.postHookCalls()).toBe(1)
      expect(run.toolText()).toContain(REDACTED)
      expect(run.toolText()).not.toContain(SECRET)
    }
  )

  // Control: a call admitted in the loop was already redacted before this fix.
  it('redacts the result of an allow-all call that runs with no card', async () => {
    const run = await start('allow_all', {
      hookDescriptors: [REDACTING_HOOK],
    } as unknown as GuardrailsConfig)

    expect(run.executor.executorState).toBe('completed')
    expect(requestPinned).toHaveBeenCalledTimes(1)
    expect(run.postHookCalls()).toBe(1)
    expect(run.toolText()).toContain(REDACTED)
    expect(run.toolText()).not.toContain(SECRET)
  })
})

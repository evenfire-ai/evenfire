/**
 * Live approval config at the AgentStateMachine: ceiling, tools, and the live
 * set are read on the next admission, including a same-batch drop and a
 * guardrail hook that outlives the old ceiling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import type { ApprovalMode } from '../../core/approval/approvalMode'
import { applyHostChange } from '../../core/approval/hostChange'
import { createHostEventGate } from '../../core/approval/hostEventGate'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import { requestPinned } from '../../core/net/ssrf'
import type { ChatMessage, ToolCall } from '../../core/types'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import type { HostCRD } from '../../types'
import { AgentStateMachine } from '../stateMachine'
import { resolveTaskSessionKey } from '../taskExecutor'

vi.mock('../../core/net/ssrf', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/net/ssrf')>()
  return {
    ...actual,
    resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
    requestPinned: vi.fn(async () => ({ statusCode: 200, body: 'http-ok' })),
  }
})

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const savedApproval = appConfig.enableApproval

beforeEach(() => {
  appConfig.enableApproval = true
  vi.mocked(requestPinned).mockReset()
  vi.mocked(requestPinned).mockResolvedValue({ statusCode: 200, body: 'http-ok' })
})

afterEach(() => {
  appConfig.enableApproval = savedApproval
  vi.unstubAllGlobals()
})

function policy(
  ceiling: ApprovalMode,
  tools?: Record<string, boolean>,
  allowModeChange = true
): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: ceiling,
    channels: {
      telegram: { enabled: true, allowModeChange },
      slack: { enabled: true, allowModeChange },
      email: { enabled: true, allowModeChange },
    },
    ...(tools ? { tools } : {}),
  }
}

function host(name: string, approval: ApprovalConfig): HostCRD {
  return { name, namespace: 'ns', spec: { host: name, contextRef: 'ctx', approval } }
}

function task(id: string, sender: string, channelType: 'rpc' | 'slack' | 'telegram'): Task {
  return {
    id,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender,
      content: 'run the tool',
      channelType,
      channelId: 'live-channel',
      messageId: id,
      timestamp: new Date().toISOString(),
      hostRef: 'live-host',
    },
    conversationHistory: [{ role: 'user', content: 'run the tool', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
}

function http(id: string): ToolCall {
  return { id, name: 'http_request', arguments: { url: 'https://example.test/live' } }
}

describe('approval mode live config', () => {
  it('setApprovalConfig changes the ceiling, the tools override, and the live set for the next admission', async () => {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const batches: Array<ToolCall[] | null> = []
    const provider: SingleTurnProvider = {
      getProviderType: () => 'claude',
      classifyError: () => {
        throw new Error('unused')
      },
      completeSingleTurn: vi.fn(async () => ({
        content: 'APPROVE',
        usage,
        finish_reason: FinishReason.Stop,
      })),
      completeSingleTurnWithTools: vi.fn(async () => {
        const calls = batches.shift()
        if (!calls) {
          return { content: 'done', tool_calls: null, usage, finish_reason: FinishReason.Stop }
        }
        return { content: null, tool_calls: calls, usage, finish_reason: FinishReason.ToolUse }
      }),
    }
    const agent = new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      approvalTimeout: 0,
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 6,
      taskDelay: 0,
    })
    agent.setLLMProvider(provider, 'claude-test')
    agent.setApprovalConfig(policy('allow_all'), policy('allow_all'))
    const first = task('ceil-1', 'live-user', 'rpc')
    const conversation = await agent
      .getConversationManager()
      .getOrCreate(resolveTaskSessionKey(first), {
        userId: 'live-user',
        channelType: 'rpc',
        approvalMode: 'auto',
      })
    conversation.last_effective_approval_mode = 'auto'

    batches.push([http('http-run')], null)
    queue.enqueue(first)
    await agent.executeTask(queue.dequeue()!)
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    expect(agent.getPendingApprovals()).toHaveLength(0)

    agent.setApprovalConfig(policy('manual'), policy('manual'))
    batches.push([http('http-manual')])
    const manual = task('ceil-2', 'live-user', 'rpc')
    queue.enqueue(manual)
    await agent.executeTask(queue.dequeue()!)
    expect(agent.getPendingApprovals()).toEqual([
      expect.objectContaining({ toolName: 'http_request', requestId: expect.any(String) }),
    ])
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    await agent.getConversationManager().deny(conversation)

    agent.setApprovalConfig(policy('allow_all', { http_request: true }), policy('allow_all'))
    batches.push([http('http-forced')])
    const forced = task('ceil-3', 'live-user', 'rpc')
    queue.enqueue(forced)
    await agent.executeTask(queue.dequeue()!)
    expect(agent.getPendingApprovals()[0]?.toolName).toBe('http_request')
    expect(conversation.pending_approval?.authorization_scope).toBe('exact_invocation')
    expect(vi.mocked(provider.completeSingleTurn)).not.toHaveBeenCalled()
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    await agent.getConversationManager().deny(conversation)

    conversation.approval_mode = 'manual'
    conversation.last_effective_approval_mode = 'manual'
    agent.setGfsDownloadStore({ isAvailable: () => true } as never)
    agent.setApprovalConfig(policy('allow_all'), policy('allow_all'))
    batches.push([{ id: 'gfs-live', name: 'clerum__gfs_download', arguments: { drive: 'w' } }])
    const live = task('ceil-4', 'live-user', 'rpc')
    queue.enqueue(live)
    await agent.executeTask(queue.dequeue()!)
    expect(conversation.pending_approval).toMatchObject({
      tool_name: 'clerum__gfs_download',
      authorization_scope: 'exact_invocation',
    })
    await agent.getConversationManager().deny(conversation)

    agent.setApprovalConfig(policy('allow_all', { shell_exec: false }), policy('allow_all'))
    batches.push(
      [{ id: 'shell-off', name: 'shell_exec', arguments: { command: 'printf admission-ok' } }],
      null
    )
    const hidden = task('ceil-5', 'live-user', 'rpc')
    queue.enqueue(hidden)
    await agent.executeTask(queue.dequeue()!)
    expect(conversation.pending_approval).toBeUndefined()
    expect(agent.getPendingApprovals()).toHaveLength(0)
  })

  it('a same-batch ceiling drop decides the second call under the new mode', async () => {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const agent = new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      approvalTimeout: 0,
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 6,
      taskDelay: 0,
    })
    const provider: SingleTurnProvider = {
      getProviderType: () => 'claude',
      classifyError: () => {
        throw new Error('unused')
      },
      completeSingleTurn: vi.fn(async () => ({
        content: 'APPROVE',
        usage,
        finish_reason: FinishReason.Stop,
      })),
      completeSingleTurnWithTools: vi.fn(async (messages: ChatMessage[]) => {
        const toolMessages = messages.filter(message => message.role === 'tool')
        if (toolMessages.length > 0) {
          return { content: 'done', tool_calls: null, usage, finish_reason: FinishReason.Stop }
        }
        return {
          content: null,
          tool_calls: [http('batch-1'), http('batch-2')],
          usage,
          finish_reason: FinishReason.ToolUse,
        }
      }),
    }
    agent.setLLMProvider(provider, 'claude-test')
    agent.setApprovalConfig(policy('allow_all'), policy('allow_all'))
    vi.mocked(requestPinned).mockImplementation(async () => {
      agent.setApprovalConfig(policy('allow_all'), policy('manual'))
      return { statusCode: 200, body: 'http-ok' }
    })
    const first = task('batch-task', 'batch-user', 'rpc')
    const conversation = await agent
      .getConversationManager()
      .getOrCreate(resolveTaskSessionKey(first), {
        userId: 'batch-user',
        channelType: 'rpc',
        approvalMode: 'allow_all',
      })
    conversation.last_effective_approval_mode = 'allow_all'
    queue.enqueue(first)
    await agent.executeTask(queue.dequeue()!)
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    expect(conversation.pending_approval?.tool_call_id).toBe('batch-2')
    expect(conversation.pending_approval?.tool_name).toBe('http_request')
  })

  it('reads the ceiling after a guardrail hook resolves, so the HTTP call is a manual card', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const agent = new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      approvalTimeout: 0,
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 4,
      taskDelay: 0,
    })
    let release: ((response: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(resolve => {
            release = resolve
          })
      )
    )
    const provider: SingleTurnProvider = {
      getProviderType: () => 'claude',
      classifyError: () => {
        throw new Error('unused')
      },
      completeSingleTurn: vi.fn(async () => ({
        content: 'APPROVE',
        usage,
        finish_reason: FinishReason.Stop,
      })),
      completeSingleTurnWithTools: vi.fn(async () => ({
        content: null,
        tool_calls: [http('hook-http')],
        usage,
        finish_reason: FinishReason.ToolUse,
      })),
    }
    agent.setLLMProvider(provider, 'claude-test')
    agent.setGuardrailsConfig({
      hookDescriptors: [
        {
          id: 'delay-ceiling',
          endpoint: 'http://hook.local',
          path: '/',
          lifecyclePoints: ['pre_tool_use'],
          capabilities: ['may_rewrite'],
          failMode: 'open',
          order: 1,
        },
      ],
    })
    agent.setApprovalConfig(policy('allow_all'), policy('allow_all'))
    const first = task('hook-task', 'hook-user', 'rpc')
    const conversation = await agent
      .getConversationManager()
      .getOrCreate(resolveTaskSessionKey(first), {
        userId: 'hook-user',
        channelType: 'rpc',
        approvalMode: 'allow_all',
      })
    conversation.last_effective_approval_mode = 'allow_all'
    queue.enqueue(first)
    const running = agent.executeTask(queue.dequeue()!)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    agent.setApprovalConfig(policy('allow_all'), policy('manual'))
    release!(new Response('{"decision":"allow"}', { status: 200 }))
    await running
    expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()
    expect(vi.mocked(provider.completeSingleTurn)).not.toHaveBeenCalled()
    expect(conversation.pending_approval).toMatchObject({
      tool_name: 'http_request',
      authorization_scope: 'turn_tools',
    })
    expect(conversation.last_effective_approval_mode).toBe('manual')
    const l2 = info.mock.calls.filter(call => (call[0] as { event?: string }).event === 'L2')
    expect(l2).toHaveLength(1)
    info.mockRestore()
  })

  it('a stale host event leaves the next admission, and the channel cap, on manual', async () => {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const agent = new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      approvalTimeout: 0,
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 4,
      taskDelay: 0,
    })
    const provider: SingleTurnProvider = {
      getProviderType: () => 'claude',
      classifyError: () => {
        throw new Error('unused')
      },
      completeSingleTurn: vi.fn(async () => ({
        content: 'APPROVE',
        usage,
        finish_reason: FinishReason.Stop,
      })),
      completeSingleTurnWithTools: vi.fn(async () => ({
        content: null,
        tool_calls: [http('stale-http')],
        usage,
        finish_reason: FinishReason.ToolUse,
      })),
    }
    agent.setLLMProvider(provider, 'claude-test')
    const gate = createHostEventGate()
    const releases: Array<() => void> = []
    const ensureConfigStore = vi.fn(
      () =>
        new Promise<void>(resolve => {
          releases.push(resolve)
        })
    )
    const publish = (next: HostCRD) => {
      agent.setApprovalConfig(next.spec.approval, next.spec.approval)
    }
    const first = task('stale-task', 'stale-user', 'rpc')
    const conversation = await agent
      .getConversationManager()
      .getOrCreate(resolveTaskSessionKey(first), {
        userId: 'stale-user',
        channelType: 'rpc',
        approvalMode: 'allow_all',
      })
    conversation.last_effective_approval_mode = 'allow_all'
    conversation.auto_shell_grants = { wholeTool: true, commands: new Set(['printf stale']) }
    const e1 = applyHostChange(host('e1', policy('allow_all')), {
      gate,
      publishApproval: publish,
      ensureConfigStore,
      commitHost: publish,
    })
    const e2 = applyHostChange(host('e2', policy('manual')), {
      gate,
      publishApproval: publish,
      ensureConfigStore,
      commitHost: publish,
    })
    releases[1]!()
    await e2
    releases[0]!()
    await e1
    queue.enqueue(first)
    await agent.executeTask(queue.dequeue()!)
    expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()
    expect(conversation.pending_approval?.tool_name).toBe('http_request')
    expect(conversation.last_effective_approval_mode).toBe('manual')
    expect(conversation.auto_shell_grants.wholeTool).toBe(false)

    await agent.getConversationManager().deny(conversation)
    const slack = task('cap-task', 'cap-user', 'slack')
    const capped = await agent.getConversationManager().getOrCreate(resolveTaskSessionKey(slack), {
      userId: 'cap-user',
      channelType: 'slack',
      approvalMode: 'allow_all',
    })
    capped.last_effective_approval_mode = 'allow_all'
    capped.auto_shell_grants = { wholeTool: true, commands: new Set() }
    const capGate = createHostEventGate()
    const capReleases: Array<() => void> = []
    const capEnsure = vi.fn(
      () =>
        new Promise<void>(resolve => {
          capReleases.push(resolve)
        })
    )
    const open = applyHostChange(host('cap-open', policy('allow_all', undefined, true)), {
      gate: capGate,
      publishApproval: publish,
      ensureConfigStore: capEnsure,
      commitHost: publish,
    })
    const closed = applyHostChange(host('cap-closed', policy('allow_all', undefined, false)), {
      gate: capGate,
      publishApproval: publish,
      ensureConfigStore: capEnsure,
      commitHost: publish,
    })
    capReleases[1]!()
    await closed
    capReleases[0]!()
    await open
    provider.completeSingleTurnWithTools = vi.fn(async () => ({
      content: null,
      tool_calls: [http('cap-http')],
      usage,
      finish_reason: FinishReason.ToolUse,
    }))
    queue.enqueue(slack)
    await agent.executeTask(queue.dequeue()!)
    expect(capped.pending_approval?.tool_name).toBe('http_request')
    expect(capped.last_effective_approval_mode).toBe('manual')
    expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()
  })
})

describe('approval config warnings', () => {
  function newAgent(): AgentStateMachine {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    return new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      approvalTimeout: 0,
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 6,
      taskDelay: 0,
    })
  }

  function invalidFields(warn: { mock: { calls: unknown[][] } }): unknown[] {
    return warn.mock.calls
      .map(call => call[0] as Record<string, unknown> | undefined)
      .filter(fields => fields?.event === 'approval_config_invalid')
      .map(fields => fields?.field)
  }

  it('logs one warning per malformed mode field in the host spec it installs', () => {
    const agent = newAgent()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const malformed = {
        defaultPolicy: 'channel_users',
        modeCeiling: 'yolo',
        channels: { telegram: false, slack: { allowModeChange: 'false' } },
      } as unknown as ApprovalConfig
      agent.setApprovalConfig(policy('allow_all'), malformed)
      expect(invalidFields(warn)).toEqual([
        'modeCeiling',
        'channels.telegram',
        'channels.slack.allowModeChange',
      ])

      warn.mockClear()
      agent.setApprovalConfig(policy('allow_all'), policy('allow_all'))
      expect(invalidFields(warn)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

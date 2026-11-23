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

describe('approver policy on a running channel session', () => {
  type PolicyChannel = 'telegram' | 'slack' | 'teams' | 'email'

  /** One approver list per messaging channel; every switch is on. */
  function approverPolicy(
    defaultPolicy: ApprovalConfig['defaultPolicy'] | undefined,
    approvers: Partial<Record<PolicyChannel, string[]>> = {}
  ): ApprovalConfig {
    const channels = Object.fromEntries(
      (['telegram', 'slack', 'teams', 'email'] as const).map(channel => [
        channel,
        {
          enabled: true,
          allowModeChange: true,
          ...(approvers[channel] ? { approvers: approvers[channel] } : {}),
        },
      ])
    )
    return {
      ...(defaultPolicy !== undefined ? { defaultPolicy } : {}),
      modeCeiling: 'allow_all',
      channels,
    } as ApprovalConfig
  }

  function channelTask(id: string, sender: string, channelType: PolicyChannel | 'rpc'): Task {
    const base = task(id, sender, 'rpc')
    return { ...base, sourceMessage: { ...base.sourceMessage!, channelType } }
  }

  function newRun() {
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
    agent.setLLMProvider(provider, 'claude-test')
    const seed = (t: Task, approvalMode: ApprovalMode) =>
      agent.getConversationManager().getOrCreate(resolveTaskSessionKey(t), {
        userId: t.sourceMessage!.sender,
        channelType: t.sourceMessage!.channelType,
        approvalMode,
      })
    /** One turn that asks for one HTTP call. */
    const runHttp = async (t: Task, callId: string) => {
      batches.push([http(callId)], null)
      queue.enqueue(t)
      await agent.executeTask(queue.dequeue()!)
      batches.length = 0
    }
    return { agent, seed, runHttp }
  }

  function l2Events(info: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
    return info.mock.calls
      .map(call => call[0] as Record<string, unknown>)
      .filter(fields => fields?.event === 'L2')
  }

  it('a mode stored under an unset policy runs manual once designated_approvers leaves its owner out, and the sweep clears its grants', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const { agent, seed, runHttp } = newRun()
      agent.setApprovalConfig(approverPolicy(undefined), approverPolicy(undefined))
      const staged = channelTask('staged-1', 'staged-user', 'telegram')
      const conversation = await seed(staged, 'allow_all')

      // Unset policy: the stored allow_all runs with no card.
      await runHttp(staged, 'staged-open')
      expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
      expect(conversation.pending_approval).toBeUndefined()
      expect(conversation.last_effective_approval_mode).toBe('allow_all')

      conversation.auto_shell_grants = { wholeTool: true, commands: new Set(['printf staged']) }
      conversation.auto_approved_tools.add('shell_exec')
      conversation.task_approved_tools = new Set(['http_request', 'cron_manage'])
      info.mockClear()

      const designated = approverPolicy('designated_approvers', { telegram: ['approver-1'] })
      agent.setApprovalConfig(designated, designated)

      // The sweep lowers it like a ceiling drop: grants cleared, one L2.
      expect(conversation.last_effective_approval_mode).toBe('manual')
      expect(conversation.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
      expect(conversation.auto_approved_tools.has('shell_exec')).toBe(false)
      expect(conversation.task_approved_tools).toEqual(new Set(['cron_manage']))
      expect(l2Events(info)).toEqual([
        expect.objectContaining({
          storedMode: 'allow_all',
          previousEffectiveMode: 'allow_all',
          effectiveApprovalMode: 'manual',
        }),
      ])

      // The next tool call shows a manual card. The stored mode is kept.
      await runHttp(channelTask('staged-2', 'staged-user', 'telegram'), 'staged-closed')
      expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
      expect(conversation.pending_approval).toMatchObject({
        tool_name: 'http_request',
        authorization_scope: 'turn_tools',
      })
      expect(conversation.approval_mode).toBe('allow_all')
    } finally {
      info.mockRestore()
    }
  })

  it('a listed approver keeps allow_all until removed from approvers, then runs manual at the next tool call', async () => {
    const { agent, seed, runHttp } = newRun()
    const listed = approverPolicy('designated_approvers', { slack: ['U0LISTED'] })
    agent.setApprovalConfig(listed, listed)
    const first = channelTask('revoke-1', 'U0LISTED', 'slack')
    const conversation = await seed(first, 'allow_all')

    await runHttp(first, 'revoke-listed')
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    expect(conversation.pending_approval).toBeUndefined()

    const removed = approverPolicy('designated_approvers', { slack: ['U0SOMEONE'] })
    agent.setApprovalConfig(removed, removed)

    await runHttp(channelTask('revoke-2', 'U0LISTED', 'slack'), 'revoke-removed')
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    expect(conversation.pending_approval?.tool_name).toBe('http_request')
    expect(conversation.last_effective_approval_mode).toBe('manual')
    expect(conversation.approval_mode).toBe('allow_all')
  })

  it('cli_only lowers every messaging session and leaves an rpc session at its mode', async () => {
    const { agent, seed, runHttp } = newRun()
    const open = approverPolicy('channel_users')
    agent.setApprovalConfig(open, open)
    const channels = ['telegram', 'slack', 'teams', 'email'] as const
    const sessions = await Promise.all(
      channels.map(async channel => {
        const conversation = await seed(
          channelTask(`cli-${channel}`, `${channel}-owner`, channel),
          'allow_all'
        )
        conversation.last_effective_approval_mode = 'allow_all'
        return conversation
      })
    )
    const desktopTask = channelTask('cli-rpc', 'desktop-owner', 'rpc')
    const desktop = await seed(desktopTask, 'allow_all')
    desktop.last_effective_approval_mode = 'allow_all'

    const cliOnly = approverPolicy('cli_only', {
      telegram: ['telegram-owner'],
      slack: ['slack-owner'],
      teams: ['teams-owner'],
      email: ['email-owner'],
    })
    agent.setApprovalConfig(cliOnly, cliOnly)

    expect(sessions.map(conversation => conversation.last_effective_approval_mode)).toEqual([
      'manual',
      'manual',
      'manual',
      'manual',
    ])
    expect(desktop.last_effective_approval_mode).toBe('allow_all')
    await runHttp(desktopTask, 'cli-rpc-http')
    expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
    expect(desktop.pending_approval).toBeUndefined()
  })

  it('channel_users and an unset policy leave a non-listed channel owner at allow_all', async () => {
    const { agent, seed, runHttp } = newRun()
    const designated = approverPolicy('designated_approvers', { telegram: ['someone-else'] })
    agent.setApprovalConfig(designated, designated)
    const first = channelTask('open-1', 'open-owner', 'telegram')
    const conversation = await seed(first, 'allow_all')
    conversation.last_effective_approval_mode = 'allow_all'
    agent.setApprovalConfig(designated, designated)
    expect(conversation.last_effective_approval_mode).toBe('manual')

    for (const [index, policy] of (['channel_users', undefined] as const).entries()) {
      const config = approverPolicy(policy, { telegram: ['someone-else'] })
      agent.setApprovalConfig(config, config)
      expect(conversation.last_effective_approval_mode).toBe('allow_all')
      await runHttp(channelTask(`open-${index + 2}`, 'open-owner', 'telegram'), `open-${index}`)
      expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(index + 1)
      expect(conversation.pending_approval).toBeUndefined()
    }
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

  it('logs defaultPolicy, never its value, when the policy in force is not a known value', () => {
    const agent = newAgent()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const unknown = {
        ...policy('allow_all'),
        defaultPolicy: 'admins_only',
      } as unknown as ApprovalConfig
      agent.setApprovalConfig(unknown, policy('allow_all'))
      expect(invalidFields(warn)).toEqual(['defaultPolicy'])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('admins_only')

      warn.mockClear()
      agent.setApprovalConfig(policy('allow_all'), policy('allow_all'))
      expect(invalidFields(warn)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

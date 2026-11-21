/**
 * Cause tags, live approval config, and the config-arrival sweep.
 * The admission decision itself stays today's until the decision table lands.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentStateMachine } from '../../../agent/stateMachine'
import { TaskExecutor, type TaskExecutorDeps } from '../../../agent/taskExecutor'
import { config as appConfig } from '../../../config'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import { logger } from '../../../logger'
import { MessageQueue } from '../../../queue/messageQueue'
import type { Task } from '../../../queue/types'
import { readChannelCap, readModeCeiling } from '../../approval/approvalMode'
import type { ApprovalConfigSnapshot } from '../../approval/approvalMode'
import { approvalLogId } from '../../approval/grantMemory'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../conversation/conversation'
import type { LoopController, Tool, ToolRegistry } from '../../interfaces'
import { DeferrableToolController } from '../../orchestration/deferrableToolController'
import { SimpleEventEmitter } from '../../orchestration/eventEmitter'
import type { LoopConfig } from '../../orchestration/loopConfig'
import { NativeToolPresentationController } from '../../orchestration/nativeToolPresentationController'
import { admitToolCall } from '../../orchestration/toolCallPolicy'
import type { Conversation, PendingApproval, ToolCall } from '../../types'
import { ApprovalController } from '../approvalController'
import type { ApprovalConfig } from '../approvalTypes'
import { UnifiedApprovalGateController } from '../mcpApprovalGateController'

function tool(name: string, requiresApproval: boolean): Tool {
  return {
    name: () => name,
    description: () => name,
    parametersSchema: () => ({ type: 'object' }),
    requiresSanitization: () => false,
    requiresApproval: () => requiresApproval,
    traceDescriptor: () => ({ kind: 'internal_tool', sourceRef: 'mcp-host' }),
    execute: async () => ({ content: 'ok', is_error: false, duration_ms: 0 }),
  }
}

function registry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map(item => [item.name(), item]))
  return {
    get: name => byName.get(name) ?? null,
    listDefinitions: () => [],
    register: () => {},
  }
}

function gateFor(
  tools: Tool[],
  approval?: ApprovalConfig,
  options?: { statelessLifecycle?: boolean }
): UnifiedApprovalGateController {
  const reg = registry(tools)
  return new UnifiedApprovalGateController(reg, approval, reg, options)
}

const baseApproval = {
  defaultPolicy: 'cli_only' as const,
  channels: {},
}

describe('approval cause tags', () => {
  it('tags an explicit tools override as admin_forced and a native gate as ordinary', () => {
    const forced = gateFor([tool('shell_exec', false)], {
      ...baseApproval,
      tools: { shell_exec: true },
    })
    const ordinary = gateFor([tool('shell_exec', true)], baseApproval)

    expect(forced.beforeTool('shell_exec', { command: 'ls' })).toMatchObject({
      type: 'suspend',
      cause: 'admin_forced',
    })
    expect(ordinary.beforeTool('shell_exec', { command: 'ls' })).toMatchObject({
      type: 'suspend',
      cause: 'ordinary',
    })
  })

  it('tags the stateless cron create gate as cron_forced', () => {
    const gate = gateFor([tool('cron_manage', true)], baseApproval, { statelessLifecycle: true })
    expect(gate.beforeTool('cron_manage', { action: 'create' })).toMatchObject({
      type: 'suspend',
      cause: 'cron_forced',
      approval: { authorization_scope: 'exact_invocation' },
    })
  })

  it('tags denial re-asks, denials_active, and the live set', () => {
    const reg = registry([
      tool('shell_exec', true),
      tool('workflow_trigger', true),
      tool('clerum__gfs_download', true),
    ])
    const delegate = new UnifiedApprovalGateController(reg, baseApproval, reg)
    const denied = new ApprovalController(
      makeFakeConversation({ denials: new Map([['shell_exec', 'user-a']]) }),
      delegate,
      { toolRegistry: reg }
    )
    const denialsActive = new ApprovalController(
      makeFakeConversation({ denials: new Map([['other_tool', 'user-a']]) }),
      delegate,
      { toolRegistry: reg }
    )
    const live = new ApprovalController(makeFakeConversation(), delegate, {
      toolRegistry: reg,
      liveApprovalTools: new Set(['clerum__gfs_download']),
    })

    expect(denied.beforeTool('shell_exec', { command: 'ls' }, 'tc-1')).toMatchObject({
      type: 'suspend',
      cause: 'denied',
      approval: { reask: 'denied', authorization_scope: 'exact_invocation' },
    })
    expect(denialsActive.beforeTool('workflow_trigger', { name: 'wf' }, 'tc-2')).toMatchObject({
      type: 'suspend',
      cause: 'denials_active',
      approval: { reask: 'denials_active', authorization_scope: 'exact_invocation' },
    })
    expect(live.beforeTool('clerum__gfs_download', { drive: 'w' }, 'tc-3')).toMatchObject({
      type: 'suspend',
      cause: 'live',
      approval: { authorization_scope: 'exact_invocation' },
    })
  })

  it('tags a guardrail ask, and none when the one-shot satisfies it', async () => {
    const call: ToolCall = { id: 'c1', name: 'shell_exec', arguments: { command: 'ls' } }
    const reg = registry([tool('shell_exec', true)])
    const ask = {
      async decide(_id: unknown, input: Record<string, unknown>) {
        return {
          decision: 'ask' as const,
          reasonCode: 'needs_ok',
          effectiveInput: input,
          source: 'host_rule' as const,
        }
      },
    }
    const loop = (conversation: Conversation): LoopConfig =>
      ({
        reasoning: {} as never,
        toolRegistry: reg,
        safety: {} as never,
        events: { emit: () => {}, on: () => {}, off: () => {} },
        conversation,
        loopController: {
          shouldAccept: () => true,
          onTextRejected: () => null,
          beforeTool: () => 'proceed',
          onExhaustion: () => '',
          refreshTools: async tools => tools,
        },
        contextManager: {} as never,
        toolOutputProcessor: {
          beforeExecution: () => ({ is_valid: true, errors: [] }),
          afterExecution: (_n: string, output: { content: string }) => output.content,
        },
        guardrails: ask,
        maxIterations: 2,
        toolTimeout: 1000,
        toolProgressInterval: 0,
      }) as LoopConfig

    const suspended = await admitToolCall(call, loop(makeFakeConversation()), 0)
    expect(suspended).toMatchObject({ kind: 'suspend', cause: 'guardrail_ask' })

    const approved = makeFakeConversation({
      pending_approval: {
        request_id: 'req-1',
        tool_name: 'shell_exec',
        tool_call_id: 'c1',
        parameters: { command: 'ls' },
        description: 'once',
        context_snapshot: [],
        authorization_scope: 'exact_invocation',
      },
    })
    const executed = await admitToolCall(call, loop(approved), 0)
    expect(executed).toMatchObject({ kind: 'execute', cause: 'none' })
    expect(approved.pending_approval).toBeUndefined()
  })

  it('returns the delegate suspend object by identity from the presentation wrappers', () => {
    const approval: PendingApproval = {
      request_id: 'req-wrap',
      tool_name: 'shell_exec',
      parameters: { command: 'ls' },
      description: 'wrap',
      tool_call_id: 'tc-wrap',
      context_snapshot: [],
    }
    const suspend = { type: 'suspend' as const, approval }
    const delegate: LoopController = {
      shouldAccept: () => true,
      onTextRejected: () => null,
      beforeTool: () => suspend,
      onExhaustion: () => '',
      refreshTools: async tools => tools,
    }
    const native = new NativeToolPresentationController(delegate, [], {
      mode: 'direct',
      discoveryBytes: 1000,
    })
    const deferrable = new DeferrableToolController(
      delegate,
      new Set(),
      { dynamicToolsEnabled: false, dynamicToolsThreshold: 60 },
      { get: () => undefined, set: () => {} }
    )

    expect(native.beforeTool('shell_exec', { command: 'ls' }, 'tc-wrap')).toBe(suspend)
    expect(deferrable.beforeTool('shell_exec', { command: 'ls' }, 'tc-wrap')).toBe(suspend)
  })
})

function task(source: Task['source']): Task {
  return {
    id: `task-${source}`,
    source,
    sourceMessage:
      source === 'cron'
        ? undefined
        : {
            sender: 'user-1',
            content: 'hello',
            channelType: 'rpc',
            channelId: 'desktop',
            messageId: 'm1',
            timestamp: new Date().toISOString(),
            hostRef: 'host',
          },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

function executorDeps(
  manager: ConversationManager,
  approval: ApprovalConfig,
  provider: () => ApprovalConfigSnapshot
): TaskExecutorDeps {
  return {
    conversationManager: manager,
    llmProvider: {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'claude' as const,
    } as never,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: { isAvailable: () => true } as never,
    gfsCallerWorkspacePath: '/tmp/caller',
    config: {
      maxTaskDuration: 30000,
      maxToolCallsPerTask: 5,
      autoStart: false,
      taskDelay: 0,
      approvalTimeout: 30000,
    },
    modelName: 'claude-test',
    approvalConfig: approval,
    approvalConfigProvider: provider,
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: new TaskLifecycle(),
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
  }
}

async function builtLoop(
  source: Task['source'],
  approval: ApprovalConfig,
  provider: () => ApprovalConfigSnapshot
): Promise<{ loop: LoopConfig; conversation: Conversation }> {
  const manager = new ConversationManager()
  const conversation = await manager.getOrCreate(`live-${source}`, {
    userId: 'user-1',
    channelType: 'rpc',
    approvalMode: 'auto',
  })
  const executor = new TaskExecutor(task(source), executorDeps(manager, approval, provider))
  const opened = executor as unknown as {
    conversation: Conversation | null
    buildLoopConfig(): Promise<LoopConfig>
  }
  opened.conversation = conversation
  return { loop: await opened.buildLoopConfig(), conversation }
}

describe('live approval config on an executor built earlier', () => {
  it('sees a later tools and live-set change only when the mode is set', async () => {
    const previousApproval = appConfig.enableApproval
    const shellOff: ApprovalConfig = { ...baseApproval, tools: { shell_exec: false } }
    const holder: { current: ApprovalConfigSnapshot } = {
      current: { effective: shellOff, hostSpec: shellOff },
    }
    try {
      appConfig.enableApproval = true
      const live = await builtLoop('channel', shellOff, () => holder.current)
      expect(live.loop.approvalMode).toBeDefined()
      expect(live.loop.loopController.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')
      const gfsBefore = live.loop.loopController.beforeTool('clerum__gfs_download', {
        drive: 'w',
      })
      if (typeof gfsBefore === 'object') expect(gfsBefore.cause).not.toBe('live')

      const shellOn: ApprovalConfig = {
        ...baseApproval,
        tools: { shell_exec: true, clerum__gfs_download: true },
        modeCeiling: 'manual',
      }
      holder.current = { effective: shellOn, hostSpec: shellOn }
      expect(live.loop.approvalMode?.ceiling()).toBe('manual')
      expect(live.loop.loopController.beforeTool('shell_exec', { command: 'ls' })).toMatchObject({
        type: 'suspend',
        cause: 'admin_forced',
      })
      expect(
        live.loop.loopController.beforeTool('clerum__gfs_download', { drive: 'w' })
      ).toMatchObject({
        type: 'suspend',
        cause: 'live',
        approval: { authorization_scope: 'exact_invocation' },
      })

      appConfig.enableApproval = false
      const unset = await builtLoop('channel', shellOff, () => holder.current)
      expect(unset.loop.approvalMode).toBeUndefined()
      expect(unset.loop.loopController.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')

      appConfig.enableApproval = true
      const cron = await builtLoop('cron', shellOn, () => holder.current)
      expect(cron.loop.approvalMode).toBeUndefined()
      expect(cron.loop.loopController.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')
    } finally {
      appConfig.enableApproval = previousApproval
    }
  }, 60_000)
})

const SENDER = 'sender-sentinel@example.test'
const THREAD = 'thread-sentinel@example.test'

function policy(ceiling: 'manual' | 'allow_all', allowModeChange: boolean): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: ceiling,
    channels: { slack: { enabled: true, allowModeChange } },
  }
}

describe('config-arrival sweep', () => {
  it('clears shell grants when the ceiling drops and logs L2 once', async () => {
    const agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
      autoStart: false,
    })
    const manager = agent.getConversationManager()
    const changed = await manager.getOrCreate(`${SENDER}:slack:C1:${THREAD}`, {
      userId: SENDER,
      channelType: 'slack',
      approvalMode: 'auto',
    })
    changed.last_effective_approval_mode = 'auto'
    changed.auto_shell_grants = { wholeTool: true, commands: new Set(['ls']) }
    changed.task_approved_tools = new Set(['shell_exec', 'cron_manage'])
    const other = await manager.getOrCreate('other-session', { approvalMode: 'manual' })
    other.auto_shell_grants = { wholeTool: true, commands: new Set(['pwd']) }

    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const effective = policy('allow_all', true)
      agent.setApprovalConfig(effective, policy('manual', true))
      expect(changed.auto_shell_grants.wholeTool).toBe(false)
      expect(changed.auto_shell_grants.commands).toEqual(new Set())
      expect(changed.task_approved_tools).toEqual(new Set(['cron_manage']))
      expect(other.auto_shell_grants.wholeTool).toBe(true)

      const l2 = info.mock.calls.filter(call => (call[0] as { event?: string }).event === 'L2')
      expect(l2).toHaveLength(1)
      expect(l2[0]?.[0]).toMatchObject({
        event: 'L2',
        session: approvalLogId(changed.id),
      })
      expect(JSON.stringify(l2[0])).not.toContain(SENDER)
      expect(JSON.stringify(l2[0])).not.toContain(THREAD)
    } finally {
      info.mockRestore()
    }
  })

  it('clears wholeTool when allowModeChange turns off and does not restore it', async () => {
    const agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
      autoStart: false,
    })
    const changed = await agent.getConversationManager().getOrCreate('slack-cap', {
      userId: 'user-1',
      channelType: 'slack',
      approvalMode: 'auto',
    })
    changed.last_effective_approval_mode = 'auto'
    changed.auto_shell_grants = { wholeTool: true, commands: new Set(['ls']) }
    changed.task_approved_tools = new Set(['cron_manage'])

    const open = policy('allow_all', true)
    agent.setApprovalConfig(open, policy('allow_all', false))
    expect(readModeCeiling({ effective: open, hostSpec: policy('allow_all', false) })).toBe(
      'allow_all'
    )
    expect(
      readChannelCap({ effective: open, hostSpec: policy('allow_all', false) }, 'slack', 'user-1')
    ).toBe('manual')
    expect(changed.auto_shell_grants.wholeTool).toBe(false)
    expect(changed.task_approved_tools).toEqual(new Set(['cron_manage']))

    agent.setApprovalConfig(open, policy('allow_all', true))
    expect(changed.auto_shell_grants.wholeTool).toBe(false)
    expect(changed.last_effective_approval_mode).toBe('auto')
  })
})

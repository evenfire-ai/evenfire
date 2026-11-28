import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import {
  WorkflowBrokerClient,
  WorkflowBrokerRequestError,
} from '../../core/tools/workflowBrokerClient'
import { WorkflowTriggerTool } from '../../core/tools/workflowTriggerTool'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { workflowAccessDeniedResponse } from '../providerWorkflowAccessGate'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'
import type { CronJob } from '../types'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    dynamicToolsEnabled: false,
    dynamicToolsThreshold: 60,
    codexToolPresentation: 'auto',
    codexToolDiscoveryBytes: 32768,
    enableApproval: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    toolSpilloverThresholdBytes: 1_048_576,
    nativeToolPresentation: 'direct',
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      maxOutputLength: 10000,
      enableShell: false,
      attachmentTextReadMaxBytes: 262_144,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
  extractInputPreview: vi.fn().mockReturnValue(''),
  buildOutputPreview: vi.fn((content: string) =>
    content ? { headLines: [content], tailLines: [], totalLines: 1, truncated: false } : undefined
  ),
}))

vi.mock('../../core/tools/desktopTools', () => ({
  registerDesktopTools: vi.fn(),
}))

const PROMPT = 'check the deploy workflow status'
const WORKFLOW_ENV = [
  'MCP_HOST_GATEWAY_URL',
  'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
  'MCP_HOST_RUNTIME_ACCESS_TOKEN',
  'MCP_HOST_RUNTIME_REFRESH_TOKEN',
] as const

function teamsIdentity(): NonNullable<CronJob['providerIdentity']> {
  return {
    medium: 'teams',
    providerUserId: 'user-1',
    providerWorkspaceId: 'workspace-1',
    providerChannelId: '19:channel',
    providerChannelType: 'channel',
    providerEventId: 'evt-should-not-fire',
    providerTarget: {
      hostRef: 'host-1',
      communicationChannelNamespace: 'channels',
      communicationChannelName: 'general',
      providerBotId: null,
      providerBotUsername: null,
    },
  }
}

function cronTask(
  origin: CronJob['origin'] | undefined,
  identity?: CronJob['providerIdentity']
): Task {
  const queue = new MessageQueue()
  const task = queue.createTaskFromCron('job-1', PROMPT, origin, 'normal', identity)
  task.responseCallback = vi.fn(async () => undefined)
  return task
}

function createDeps(): TaskExecutorDeps {
  return {
    conversationManager: new ConversationManager(),
    llmProvider: {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    } as unknown as TaskExecutorDeps['llmProvider'],
    mcpManager: {
      getAllTools: () => [],
      callTool: vi.fn(),
      bootstrapUserCatalog: vi.fn(async () => ({
        candidates: 0,
        probed: 0,
        admitted: 0,
        pending: 0,
        skipped: {},
        waitedMs: 0,
        timedOut: false,
      })),
    } as unknown as TaskExecutorDeps['mcpManager'],
    workspaceService: undefined,
    config: {
      maxTaskDuration: 300000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300000,
    },
    modelName: 'test-model',
    approvalConfig: undefined,
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: new TaskLifecycle(),
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
  }
}

function workflowTriggerProperties(registry: {
  listDefinitions: () => Array<{ name: string; parameters: unknown }>
}): Record<string, unknown> {
  const trigger = registry
    .listDefinitions()
    .find(definition => definition.name === 'workflow_trigger')
  const parameters =
    trigger && typeof trigger.parameters === 'object' && trigger.parameters
      ? (trigger.parameters as { properties?: Record<string, unknown> })
      : undefined
  return parameters?.properties ?? {}
}

describe('TaskExecutor cron workflow gate', () => {
  const previousEnv = new Map<string, string | undefined>()

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    for (const key of WORKFLOW_ENV) {
      const value = previousEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function enableWorkflowEnv(): void {
    for (const key of WORKFLOW_ENV) previousEnv.set(key, process.env[key])
    process.env.MCP_HOST_GATEWAY_URL = 'http://gateway.example'
    process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = 'fixture-workflow-token'
    process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN = 'fixture-runtime-access'
    process.env.MCP_HOST_RUNTIME_REFRESH_TOKEN = 'fixture-runtime-refresh'
  }

  it('calls the model when resolve returns a user id and starts the turn with the task', async () => {
    enableWorkflowEnv()
    const request = vi
      .spyOn(WorkflowBrokerClient.prototype, 'request')
      .mockResolvedValue({ userId: 'user-1' })
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'deploy is healthy',
    } as never)
    const startTurn = vi.spyOn(ConversationManager.prototype, 'startTurn')
    const task = cronTask(
      {
        channelType: 'teams',
        channelId: '19:conversation',
        sender: 'user-1',
        threadId: 'reply-1',
      },
      teamsIdentity()
    )

    await new TaskExecutor(task, createDeps()).run()

    expect(startTurn.mock.calls[0]?.[1]).toBe(PROMPT)
    expect(String(startTurn.mock.calls[0]?.[1])).not.toContain('Scheduled task triggered:')
    expect(request).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))
    expect(body.providerIdentity.providerChannelId).toBe('19:channel')
    expect(body.providerIdentity.providerTarget).toEqual(
      expect.objectContaining({
        hostRef: 'host-1',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'general',
      })
    )
    expect(body.providerIdentity).not.toHaveProperty('providerEventId')
    expect(task.sourceMessage?.channelId).toBe('19:conversation')
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    const loopConfig = vi.mocked(runToolUseLoop).mock.calls[0]?.[0] as {
      toolRegistry: { listDefinitions: () => Array<{ name: string; parameters: unknown }> }
    }
    expect(loopConfig.toolRegistry.listDefinitions().map(definition => definition.name)).toContain(
      'workflow_trigger'
    )
    expect(workflowTriggerProperties(loopConfig.toolRegistry)).not.toHaveProperty('targetUserId')
    expect(workflowTriggerProperties(loopConfig.toolRegistry)).not.toHaveProperty('targetTeamId')
  })

  it('does not call the model when resolve throws 403 and does not build a targetUserId schema', async () => {
    enableWorkflowEnv()
    const schema = vi.spyOn(WorkflowTriggerTool.prototype, 'parametersSchema')
    const request = vi
      .spyOn(WorkflowBrokerClient.prototype, 'request')
      .mockRejectedValue(
        new WorkflowBrokerRequestError(403, null, 'Workflow broker request failed (403)')
      )
    vi.mocked(runToolUseLoop).mockResolvedValue({
      type: 'response',
      content: 'should not run',
    } as never)
    const task = cronTask(
      {
        channelType: 'teams',
        channelId: '19:conversation',
        sender: 'user-1',
        threadId: 'reply-1',
      },
      teamsIdentity()
    )

    await new TaskExecutor(task, createDeps()).run()

    expect(request).toHaveBeenCalledTimes(1)
    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(schema).not.toHaveBeenCalled()
    for (const result of schema.mock.results) {
      const properties =
        result.value && typeof result.value === 'object'
          ? ((result.value as { properties?: Record<string, unknown> }).properties ?? {})
          : {}
      expect(properties).not.toHaveProperty('targetUserId')
      expect(properties).not.toHaveProperty('targetTeamId')
    }
    expect(task.responseCallback).toHaveBeenCalledWith({
      response: workflowAccessDeniedResponse('teams'),
    })
  })

  it('calls the model for an email origin of the same prompt', async () => {
    enableWorkflowEnv()
    const request = vi.spyOn(WorkflowBrokerClient.prototype, 'request')
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'email answer',
    } as never)
    const startTurn = vi.spyOn(ConversationManager.prototype, 'startTurn')
    const task = cronTask({
      channelType: 'email',
      channelId: 'inbox@example.com',
      sender: 'user-1',
    })

    await new TaskExecutor(task, createDeps()).run()

    expect(startTurn.mock.calls[0]?.[1]).toBe(PROMPT)
    expect(request).not.toHaveBeenCalled()
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    const loopConfig = vi.mocked(runToolUseLoop).mock.calls[0]?.[0] as {
      toolRegistry: { listDefinitions: () => Array<{ name: string; parameters: unknown }> }
    }
    expect(workflowTriggerProperties(loopConfig.toolRegistry)).not.toHaveProperty('targetUserId')
    expect(workflowTriggerProperties(loopConfig.toolRegistry)).not.toHaveProperty('targetTeamId')
  })

  it('calls the model for an origin-less fire without a model-supplied workflow target', async () => {
    enableWorkflowEnv()
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'originless answer',
    } as never)
    const startTurn = vi.spyOn(ConversationManager.prototype, 'startTurn')
    const task = cronTask(undefined)

    await new TaskExecutor(task, createDeps()).run()

    expect(startTurn.mock.calls[0]?.[1]).toBe(PROMPT)
    expect(String(startTurn.mock.calls[0]?.[1])).not.toContain('Scheduled task triggered:')
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    const loopConfig = vi.mocked(runToolUseLoop).mock.calls[0]?.[0] as {
      toolRegistry: { listDefinitions: () => Array<{ name: string; parameters: unknown }> }
    }
    expect(workflowTriggerProperties(loopConfig.toolRegistry)).not.toHaveProperty('targetUserId')
    expect(workflowTriggerProperties(loopConfig.toolRegistry)).not.toHaveProperty('targetTeamId')
  })
})

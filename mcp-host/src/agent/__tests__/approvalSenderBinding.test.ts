import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { resolveProviderWorkflowCallerContext } from '../../workflow/providerWorkflowCallerContextClient'
import { AgentStateMachine } from '../stateMachine'

// Mock config to avoid CLERUM_HOST_NAME requirement
vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      maxOutputLength: 10000,
      enableShell: false,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

vi.mock('../../workflow/providerWorkflowCallerContextClient', () => ({
  resolveProviderWorkflowCallerContext: vi.fn(),
}))

const UUID = '00000000-0000-4000-8000-000000000001'
const SENDER = '516801777'

function createTestTask(content: string, sender: string): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender,
      content,
      channelType: 'telegram',
      channelId: 'test-channel',
      messageId: `msg-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: SENDER,
        providerChannelId: 'test-channel',
        providerChannelType: 'private',
      },
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content, timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

function setupAgent() {
  const queue = new MessageQueue()
  const lifecycle = new TaskLifecycle()
  const agent = new AgentStateMachine(queue, lifecycle, {
    autoStart: false,
    taskDelay: 0,
    approvalTimeout: 5000,
  })
  agent.setLLMProvider({
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: () => 'openai' as const,
  } as any)
  const skipSummary = {
    candidates: 0,
    probed: 0,
    admitted: 0,
    pending: 0,
    skipped: {},
    waitedMs: 0,
    timedOut: false,
  }
  agent.setMcpManager({
    getAllTools: () => [],
    callTool: vi.fn(),
    bootstrapUserCatalog: vi.fn(async () => skipSummary),
  } as any)
  agent.start()
  return { agent, lifecycle }
}

describe('approval binding stays on the channel sender', () => {
  let agent: AgentStateMachine
  let task: Task

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValue({
      targetUserId: UUID,
    } as any)
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-bind',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'List files',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    } as any)
    const setup = setupAgent()
    agent = setup.agent
    task = createTestTask('run it', SENDER)
    // Registered like a queued task, so the shutdown drain in stop() can
    // cancel a turn still waiting for approval.
    setup.lifecycle.register(task)
  })

  afterEach(async () => {
    // Clears the approval timer and awaits the resume an approve starts, so
    // neither outlives the test.
    await agent.stop()
  })

  it('the approval notification and snapshot carry the sender, not the resolved user', async () => {
    const events: any[] = []
    agent.on('tool:approval_needed', e => events.push(e))

    await agent.executeTask(task)

    expect(resolveProviderWorkflowCallerContext).toHaveBeenCalled()
    expect(events[0].data.userId).toBe(SENDER)
    expect(agent.getPendingApprovals()[0]).toMatchObject({ requestId: 'req-bind', userId: SENDER })
    expect(JSON.stringify(events[0].data)).not.toContain(UUID)
  })

  it('the resolved Evenfire user cannot approve; the sender can', async () => {
    // A successful approve with an empty snapshot re-runs the loop.
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'done' } as any)

    await agent.executeTask(task)

    await expect(
      agent.handleApproval(UUID, 'req-bind', false, 'telegram', 'test-channel')
    ).resolves.toMatchObject({
      success: false,
      error: 'Approval decision does not match the originating user',
    })
    await expect(
      agent.handleApproval(SENDER, 'req-bind', false, 'telegram', 'test-channel')
    ).resolves.toMatchObject({ success: true })
  })
})

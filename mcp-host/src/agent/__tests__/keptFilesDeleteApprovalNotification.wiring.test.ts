// The delete approval text a channel task's notification carries, built by the
// real AgentStateMachine from the task's own channel type. The tool loop is
// mocked to suspend on the delete, so the approval reaches the notification
// without admission: an over-limit card is fed directly here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import type { PendingApproval } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { logger } from '../../logger'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

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

const DELETE = 'clerum__kept_files_delete'
const CONTROLS = 'Use the approval controls to continue or cancel.'
const REPLY = 'Reply /approve or /deny to this message.'
const instructionFor = (channelType: string) => (channelType === 'slack' ? CONTROLS : REPLY)

// Channel limits and counting rules, written out as channel-reader sends the text.
const LIMITS = {
  telegram: { max: 4096, size: (text: string) => text.length },
  slack: {
    max: 3000,
    size: (text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').length,
  },
  teams: { max: 12_000, size: (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') },
} as const

type ChannelType = NonNullable<Task['sourceMessage']>['channelType']

function channelTask(channelType: ChannelType): Task {
  return {
    id: `task-${channelType}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-1',
      content: 'Delete my kept files',
      channelType,
      channelId: 'delete-channel',
      messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'Delete my kept files', timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

function deleteApproval(requestId: string, files: Array<{ kind: string; name: string }>) {
  return {
    request_id: requestId,
    tool_name: DELETE,
    parameters: {
      files: files.map((file, n) => ({
        ...file,
        id: String(n).padStart(12, '0'),
        createdAt: '2026-11-10T09:12:45.123Z',
        sizeBytes: 1_234_567,
      })),
    },
    description: 'Delete kept files',
    tool_call_id: `tc-${requestId}`,
    context_snapshot: [],
  } satisfies PendingApproval
}

/** The notification the state machine emits when the task suspends on `approval`. */
async function notificationFor(channelType: ChannelType, approval: PendingApproval) {
  ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    type: 'need_approval',
    approval,
  })
  const agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
    autoStart: false,
    taskDelay: 0,
    approvalTimeout: 5000,
  })
  agent.setLLMProvider({
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: () => 'openai' as const,
  } as never)
  agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
  agent.setApprovalConfig({ defaultPolicy: 'channel_users', channels: {} })
  agent.setSecretEntriesProvider(() => [])
  agent.start()
  const events: Array<{ data: Record<string, unknown> }> = []
  agent.on('tool:approval_needed', (e: { data: Record<string, unknown> }) => events.push(e))
  await agent.executeTask(channelTask(channelType))
  expect(events).toHaveLength(1)
  expect(events[0]!.data).toMatchObject({ toolName: DELETE, requestId: approval.request_id })
  return events[0]!.data.notification as string
}

const VALUES = ' — 1.2 MB (1,234,567 bytes), created 2026-11-10 09:12:45 UTC'

function card(files: Array<{ kind: string; name: string }>, instruction: string): string {
  return [
    'Delete these files permanently:',
    ...files.map(file => `${file.kind}: "${file.name}"${VALUES}`),
    `Total files: ${files.length}`,
    instruction,
  ].join('\n')
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  errorSpy = vi.spyOn(logger, 'error')
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('the delete approval notification of a channel task', () => {
  it('W1 is the whole card and the instruction of the task channel', async () => {
    const files = [{ kind: 'generated', name: 'kept-report.md' }]
    for (const channelType of ['slack', 'telegram', 'teams', 'email', 'rpc'] as const) {
      const notification = await notificationFor(
        channelType,
        deleteApproval(`req-w1-${channelType}`, files)
      )
      expect(notification).toBe(card(files, instructionFor(channelType)))
    }
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('W2 sends a card over the channel limit whole and logs the mismatch', async () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'€'.repeat(250)}${String(n).padStart(5, '0')}`,
    }))
    for (const channelType of ['slack', 'telegram', 'teams'] as const) {
      errorSpy.mockClear()
      const requestId = `req-w2-${channelType}`
      const expected = card(files, instructionFor(channelType))
      const { max, size } = LIMITS[channelType]
      expect(size(expected)).toBeGreaterThan(max)

      const notification = await notificationFor(channelType, deleteApproval(requestId, files))

      expect(notification).toBe(expected)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(
        { requestId, channelType, size: size(expected), max },
        'Kept-files delete card is over the one-message limit of its channel; the card is sent whole'
      )
    }
    // The same parameters in channels with no message limit log nothing; the
    // whole card they carry is the witness that the branch ran.
    for (const channelType of ['rpc', 'email'] as const) {
      errorSpy.mockClear()
      const notification = await notificationFor(
        channelType,
        deleteApproval(`req-w2-${channelType}`, files)
      )
      expect(notification).toBe(card(files, REPLY))
      expect(errorSpy).not.toHaveBeenCalled()
    }
  })
})

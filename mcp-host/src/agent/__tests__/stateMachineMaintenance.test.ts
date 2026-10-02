import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryConversationStore } from '../../core/conversation/conversationStore'
import type { Conversation, PendingApproval } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: true,
    enableNudge: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
  },
}))

class DurableApprovals extends InMemoryConversationStore {
  readonly rows = new Set<string>()
  failures = 0
  alwaysFail = false
  gate?: Promise<void>
  calls = 0
  override async persistSuspend(_conv: Conversation, approval: PendingApproval) {
    this.rows.add(approval.request_id)
  }
  override async persistApprovalResolved(_conv: Conversation, requestId: string) {
    this.calls++
    if (this.gate) await this.gate
    if (this.alwaysFail || this.failures-- > 0) throw new Error('fixture persistence failure')
    this.rows.delete(requestId)
  }
}
interface Internals {
  activeExecutors: Map<string, unknown>
  approvalMap: Map<
    string,
    {
      taskId: string
      expiresAt?: number
      timerId?: ReturnType<typeof setTimeout>
      registeredAt: Date
      binding: object
    }
  >
  failedClears: Map<string, unknown>
  clearPendingApprovalRetries: Map<string, unknown>
  tryClearPendingApproval(key: string): Promise<void>
}
const agents: AgentStateMachine[] = []
afterEach(() => {
  for (const agent of agents.splice(0)) agent.beginConversationStoreMaintenance()
  vi.useRealTimers()
})
async function fixture() {
  const lifecycle = new TaskLifecycle()
  const agent = new AgentStateMachine(new MessageQueue(), lifecycle, { approvalTimeout: 100000 })
  agents.push(agent)
  const store = new DurableApprovals()
  agent.setConversationStore(store)
  const manager = agent.getConversationManager()
  const key = 'user:rpc:agent:chat'
  const conv = await manager.getOrCreate(key)
  await manager.startTurn(conv, 'pending fixture', 'task')
  const approval: PendingApproval = {
    request_id: 'request',
    tool_name: 'shell_exec',
    tool_call_id: 'call',
    parameters: { command: 'pwd' },
    description: 'pending action',
    context_snapshot: [],
  }
  await manager.suspendForApproval(conv, approval)
  const task: Task = {
    id: 'task',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    conversationHistory: [],
    sourceMessage: {
      sender: 'user',
      channelType: 'rpc',
      channelId: 'agent',
      threadId: 'chat',
      hostRef: 'host',
      messageId: 'message',
      content: 'pending fixture',
      timestamp: new Date().toISOString(),
    },
  }
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'natural')
  lifecycle.transition(task.id, 'waiting_approval', 'natural')
  const internals = agent as unknown as Internals
  internals.activeExecutors.set(task.id, {
    executorState: 'waiting_approval',
    pendingApproval: conv.pending_approval,
    sourceTask: task,
    abort: vi.fn(),
    waitForCompletion: async () => {},
  })
  internals.approvalMap.set('request', {
    taskId: task.id,
    registeredAt: new Date(),
    binding: {},
    expiresAt: Date.now() + 100000,
  })
  return { agent, lifecycle, store, conv, manager, key, internals }
}

describe('agent maintenance approval persistence', () => {
  it('cancel followed by transient clear failure is durably settled before restart can resurrect it', async () => {
    const f = await fixture()
    f.store.failures = 1
    f.lifecycle.transition('task', 'cancelled', 'user_requested')
    await f.agent.quiesceForConversationStoreMaintenance()
    expect(f.store.calls).toBe(2)
    expect(f.store.rows.size).toBe(0)
    expect(f.conv.pending_approval).toBeUndefined()
    expect(f.internals.failedClears.size).toBe(0)
    // A cold-start loader can only return the remaining durable approval rows.
    expect(Array.from(f.store.rows)).toEqual([])
  })
  it('waits for an already-running durable clear before retiring RAM', async () => {
    const f = await fixture()
    let finish!: () => void
    f.store.gate = new Promise(resolve => {
      finish = resolve
    })
    f.lifecycle.transition('task', 'cancelled', 'user_requested')
    let closed = false
    const quiesce = f.agent.quiesceForConversationStoreMaintenance().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(f.store.rows.has('request')).toBe(true)
    expect(f.conv.pending_approval?.request_id).toBe('request')
    finish()
    await quiesce
    expect(closed).toBe(true)
    expect(f.store.rows.has('request')).toBe(false)
  })
  it('does not forget exhausted failures or claim quiescence while a clear still fails', async () => {
    const f = await fixture()
    f.store.alwaysFail = true
    for (let n = 0; n < 11; n++)
      await f.internals.tryClearPendingApproval(f.key).catch(() => undefined)
    expect(f.internals.clearPendingApprovalRetries.size).toBe(0)
    expect(f.internals.failedClears.size).toBe(1)
    await expect(f.agent.quiesceForConversationStoreMaintenance()).rejects.toThrow(
      'ApprovalPending'
    )
    expect(f.store.rows.has('request')).toBe(true)
    expect(f.conv.pending_approval?.request_id).toBe('request')
    expect(f.internals.activeExecutors.size).toBe(1)
    expect(f.internals.approvalMap.size).toBe(1)
  })
  it('activates only a fresh prepared agent and restores live approval timers at commit', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    f.agent.beginConversationStoreMaintenance()
    expect(f.internals.approvalMap.get('request')?.timerId).toBeUndefined()
    expect(() => f.agent.start()).toThrow('AgentFenced')
    expect(() => f.agent.resume()).toThrow('AgentFenced')
    f.agent.activateAfterConversationStoreMaintenance()
    expect(f.internals.approvalMap.get('request')?.timerId).toBeDefined()
    f.agent.beginConversationStoreMaintenance()
    await f.agent.quiesceForConversationStoreMaintenance()
    expect(() => f.agent.activateAfterConversationStoreMaintenance()).toThrow('AgentRetired')
  })
})

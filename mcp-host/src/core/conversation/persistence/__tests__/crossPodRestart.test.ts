/**
 * Cross-pod-restart resume — the P.3 invariant #3 golden, now backed by
 * a real SQLite file. After a "Pod A" persists a pending_approval and the
 * worker terminates, "Pod B" rehydrates the store and finds the same
 * approval — the user retry no longer races a phantom in-memory state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentStateMachine } from '../../../../agent/stateMachine'
import { TaskLifecycle } from '../../../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../../../queue/messageQueue'
import type { IncomingMessage } from '../../../../server'
import { ConversationState, type TraceContextV1 } from '../../../types'
import { ConversationManager } from '../../conversation'
import { SqliteColdStartLoader } from '../sqliteColdStartLoader'
import { makeSqliteStore } from './testHelpers'

describe('Cross-pod-restart resume — P.3 invariant #3', () => {
  let dbPath: string

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-t21-'))
    dbPath = path.join(dir, 'state.db')
  })

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('round-trips exact trace context and the active task id across approval rehydration', async () => {
    // Pod A — write a session with a pending_approval.
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const managerA = new ConversationManager(podA.store)
    const sessionKey = 'user-1:rpc:agent:default'
    const traceContext = {
      version: 1,
      runId: 'run-cross-pod',
      sessionId: 'trace-session-1',
      origin: 'direct_chat',
      correlationRefs: ['edge-request:req-7', 'channel-message:msg-7'],
    } satisfies TraceContextV1
    const message: IncomingMessage = {
      content: 'do dangerous thing',
      channelType: 'rpc',
      channelId: 'agent',
      sender: 'user-1',
      timestamp: new Date().toISOString(),
      messageId: 'msg-7',
      hostRef: 'chatllm',
      traceContext,
    }
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const task = queue.createTaskFromMessage(message)

    expect(task.traceContext).toEqual(traceContext)
    expect(queue.admit(task)).toEqual({ admitted: true })
    expect(lifecycle.get(task.id)?.traceContext).toEqual(traceContext)

    const convA = await managerA.getOrCreate(sessionKey)
    await managerA.startTurn(convA, message.content, task.id, task.traceContext ?? null)
    expect(convA.traceContext).toEqual(traceContext)
    await managerA.suspendForApproval(convA, {
      request_id: 'req-cross-pod',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-cross-pod',
      parameters: { command: 'rm -rf /' },
      description: 'dangerous',
      context_snapshot: [],
    })
    await podA.shutdown()

    // Pod B — fresh worker, same dbPath. The pending_approval must come back.
    const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
    try {
      const loader = new SqliteColdStartLoader(podB.store)
      const rehydrated = await loader.loadPendingApprovals(Date.now())
      expect(rehydrated).toHaveLength(1)
      expect(rehydrated[0].request_id).toBe('req-cross-pod')
      expect(rehydrated[0].task_id).toBe(task.id)
      expect(rehydrated[0].approval.tool_name).toBe('shell_exec')
      expect(rehydrated[0].approval.traceContext).toEqual(traceContext)

      const conv = podB.store.get(sessionKey)
      expect(conv).toBeDefined()
      expect(conv!.state).toBe(ConversationState.AwaitingApproval)
      expect(conv!.turns).toHaveLength(1)
      expect(conv!.turns[0].user_input).toBe('do dangerous thing')
      expect(conv!.activeTaskId).toBe(task.id)
      expect(conv!.traceContext).toEqual(traceContext)

      const podBAgent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
        autoStart: false,
      })
      podBAgent.setLLMProvider({
        completeSingleTurn: async () => ({ content: 'done' }),
        completeSingleTurnWithTools: async () => ({ type: 'response', content: 'done' }),
        getProviderType: () => 'openai',
      } as never)
      podBAgent.setMcpManager({ getAllTools: () => [], callTool: async () => ({}) } as never)
      podBAgent.setConversationStore(podB.store)
      podBAgent.setColdStartLoader(loader)
      await podBAgent.bootstrap()
      expect(podBAgent.getPendingApprovals()).toEqual([
        expect.objectContaining({ requestId: 'req-cross-pod', toolName: 'shell_exec' }),
      ])
      const rehydratedExecutor = (
        podBAgent as unknown as {
          activeExecutors: Map<string, { sourceTask: { traceContext?: unknown } }>
        }
      ).activeExecutors.get(task.id)
      expect(rehydratedExecutor?.sourceTask.traceContext).toEqual(traceContext)
      await expect(
        podBAgent.handleDenial('user-1', 'req-cross-pod', 'rpc', 'agent')
      ).resolves.toEqual({ success: true })
    } finally {
      await podB.shutdown()
    }
  })

  it('Pod B sees zero pending_approvals after the user approves on Pod A', async () => {
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const managerA = new ConversationManager(podA.store)
    const sessionKey = 'user-1:rpc:agent:default'

    const convA = await managerA.getOrCreate(sessionKey)
    await managerA.startTurn(convA, 'do safe thing', 'test-task')
    await managerA.suspendForApproval(convA, {
      request_id: 'req-approve',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-approve',
      parameters: {},
      description: 'safe',
      context_snapshot: [],
    })
    await managerA.approve(convA, false)
    await podA.shutdown()

    const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
    try {
      const loader = new SqliteColdStartLoader(podB.store)
      const rehydrated = await loader.loadPendingApprovals(Date.now())
      expect(rehydrated).toHaveLength(0)
    } finally {
      await podB.shutdown()
    }
  })

  it('skips an unauthorized pending approval without rejecting agent bootstrap', async () => {
    const pod = makeSqliteStore({ dbPath, cacheSize: 4 })
    const manager = new ConversationManager(pod.store)
    const sessionKey = 'user-1:rpc:agent:default'
    const conv = await manager.getOrCreate(sessionKey, {
      userId: 'user-1',
      channelType: 'rpc',
      channelId: 'agent',
      source: 'rpc',
    })
    await manager.startTurn(conv, 'needs approval', 'task-unsafe-owner')
    await manager.suspendForApproval(conv, {
      request_id: 'req-unsafe-owner',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-unsafe-owner',
      parameters: {},
      description: 'unsafe owner fixture',
      context_snapshot: [],
    })
    pod.worker.db
      .prepare('UPDATE sessions SET user_id = ? WHERE id = ?')
      .run('different-owner', conv.id)
    pod.store['cache'].clear()
    pod.store['ordinals'].clear()
    pod.store['sessionKeyById'].clear()

    const agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
      autoStart: false,
    })
    agent.setLLMProvider({
      completeSingleTurn: async () => ({ content: 'done' }),
      completeSingleTurnWithTools: async () => ({ type: 'response', content: 'done' }),
      getProviderType: () => 'openai',
    } as never)
    agent.setMcpManager({ getAllTools: () => [], callTool: async () => ({}) } as never)
    agent.setConversationStore(pod.store)
    agent.setColdStartLoader(new SqliteColdStartLoader(pod.store))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(agent.bootstrap()).resolves.toBeUndefined()
      expect(agent.getPendingApprovals()).toEqual([])
      expect(log).toHaveBeenCalledWith(expect.stringContaining('CONV_OWNERSHIP_MISMATCH'))
      await expect(manager.getOrCreate(sessionKey, { userId: 'user-1' })).rejects.toMatchObject({
        code: 'CONV_OWNERSHIP_MISMATCH',
      })
    } finally {
      log.mockRestore()
      await pod.shutdown()
    }
  })

  it('D.2 — a processing session left by a crashed Pod A is reaped on Pod B boot, then usable', async () => {
    // Pod A — start a turn but crash (shutdown) before completing it.
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const managerA = new ConversationManager(podA.store)
    const sessionKey = 'user-1:rpc:agent:default'
    const convA = await managerA.getOrCreate(sessionKey)
    await managerA.startTurn(convA, 'long running task', 'task-ghost')
    await podA.persistQueue.drainSessionKey(sessionKey)
    await podA.shutdown() // crash mid-task: no complete/fail/cancel

    // Pod B — fresh worker, same dbPath. The reaper runs at boot.
    const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
    try {
      const loader = new SqliteColdStartLoader(podB.store)
      const reaped = await loader.reapProcessingSessions(Date.now())
      expect(reaped).toHaveLength(1)
      expect(reaped[0].activeTaskId).toBe('task-ghost')

      // Session is now idle with the synthetic interruption message.
      const conv = await podB.store.getOrLoad(sessionKey)
      expect(conv!.state).toBe(ConversationState.Idle)
      expect(conv!.activeTaskId).toBeUndefined()
      const lastTurn = conv!.turns[conv!.turns.length - 1]
      expect(lastTurn.response).toBe('[Task interrupted by server restart]')

      // The chat is usable again: a fresh startTurn must not throw
      // "conversation is processing".
      const managerB = new ConversationManager(podB.store)
      await expect(managerB.startTurn(conv!, 'retry', 'task-retry')).resolves.toBeDefined()
    } finally {
      await podB.shutdown()
    }
  })
})

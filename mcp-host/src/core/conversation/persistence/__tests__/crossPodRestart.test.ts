/**
 * Cross-pod-restart resume — the P.3 invariant #3 golden, now backed by
 * a real SQLite file. After a "Pod A" persists a pending_approval and the
 * worker terminates, "Pod B" rehydrates the store and finds the same
 * approval — the user retry no longer races a phantom in-memory state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationState } from '../../../types'
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

  it('a pending_approval survives a Pod restart and rehydrates with the same task_id', async () => {
    // Pod A — write a session with a pending_approval.
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const managerA = new ConversationManager(podA.store)
    const sessionKey = 'user-1:rpc:agent:default'

    const convA = await managerA.getOrCreate(sessionKey)
    managerA.startTurn(convA, 'do dangerous thing', 'test-task')
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
      expect(rehydrated[0].approval.tool_name).toBe('shell_exec')

      const conv = podB.store.get(sessionKey)
      expect(conv).toBeDefined()
      expect(conv!.state).toBe(ConversationState.AwaitingApproval)
      expect(conv!.turns).toHaveLength(1)
      expect(conv!.turns[0].user_input).toBe('do dangerous thing')
    } finally {
      await podB.shutdown()
    }
  })

  it('Pod B sees zero pending_approvals after the user approves on Pod A', async () => {
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const managerA = new ConversationManager(podA.store)
    const sessionKey = 'user-1:rpc:agent:default'

    const convA = await managerA.getOrCreate(sessionKey)
    managerA.startTurn(convA, 'do safe thing', 'test-task')
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

  it('D.2 — a processing session left by a crashed Pod A is reaped on Pod B boot, then usable', async () => {
    // Pod A — start a turn but crash (shutdown) before completing it.
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    const managerA = new ConversationManager(podA.store)
    const sessionKey = 'user-1:rpc:agent:default'
    const convA = await managerA.getOrCreate(sessionKey)
    managerA.startTurn(convA, 'long running task', 'task-ghost')
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
      expect(() => managerB.startTurn(conv!, 'retry', 'task-retry')).not.toThrow()
    } finally {
      await podB.shutdown()
    }
  })
})

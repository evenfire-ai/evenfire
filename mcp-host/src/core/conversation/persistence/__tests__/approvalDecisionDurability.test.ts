/**
 * Durability of approval decisions across a restart, against a real
 * file-backed SQLite store: what a fresh pod reads back after deny, approve
 * and cancel, and after a decision whose write failed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApprovalController } from '../../../extensions/approvalController'
import { DefaultLoopController } from '../../../orchestration/loopConfig'
import { ConversationState } from '../../../types'
import { ConversationManager } from '../../conversation'
import { SqliteColdStartLoader } from '../sqliteColdStartLoader'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-a:rpc:agent:default'

describe('approval decisions across a restart', () => {
  let dbPath: string
  const open: StoreHandle[] = []

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-decisions-')), 'state.db')
  })

  afterEach(async () => {
    for (const handle of open.splice(0)) await handle.shutdown().catch(() => {})
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  function pod(): StoreHandle {
    const handle = makeSqliteStore({ dbPath, cacheSize: 4 })
    open.push(handle)
    return handle
  }

  async function restart(handle: StoreHandle): Promise<StoreHandle> {
    await handle.shutdown()
    open.splice(open.indexOf(handle), 1)
    return pod()
  }

  async function suspendOn(manager: ConversationManager, requestId: string, toolName: string) {
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'do it', `task-${requestId}`)
    await manager.suspendForApproval(conv, {
      request_id: requestId,
      tool_name: toolName,
      tool_call_id: `tc-${requestId}`,
      parameters: { path: '/tmp/x' },
      description: 'x',
      context_snapshot: [],
    })
    return conv
  }

  function pendingRows(handle: StoreHandle): number {
    return (
      handle.worker.db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as {
        n: number
      }
    ).n
  }

  it('reloads a denial, its denier, and keeps blocking the tool', async () => {
    const podA = pod()
    const conv = await suspendOn(new ConversationManager(podA.store), 'req-1', 'shell_exec')
    await new ConversationManager(podA.store).deny(conv, { userId: 'user-a' })
    expect(pendingRows(podA)).toBe(0)

    const podB = await restart(podA)
    const reloaded = await new ConversationManager(podB.store).getOrCreate(SESSION_KEY)

    expect(reloaded.state).toBe(ConversationState.Idle)
    expect([...(reloaded.denied_tools ?? [])]).toEqual(['shell_exec'])
    expect(reloaded.denied_by?.shell_exec).toBe('user-a')
    const decision = new ApprovalController(reloaded, new DefaultLoopController()).beforeTool(
      'shell_exec',
      { path: '/tmp/x' },
      'tc-next'
    )
    expect(decision).toMatchObject({ type: 'suspend' })
  })

  it('saves an approval that lifts a denial, so it stays lifted after a restart', async () => {
    const podA = pod()
    const manager = new ConversationManager(podA.store)
    const conv = await suspendOn(manager, 'req-1', 'shell_exec')
    await manager.deny(conv, { userId: 'user-a' })
    await manager.startTurn(conv, 'again', 'task-req-2')
    await manager.suspendForApproval(conv, {
      request_id: 'req-2',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-req-2',
      parameters: { path: '/tmp/x' },
      description: 'x',
      context_snapshot: [],
    })
    await manager.approve(conv, false, 'user-a')
    expect(pendingRows(podA)).toBe(0)

    const podB = await restart(podA)
    const reloaded = await new ConversationManager(podB.store).getOrCreate(SESSION_KEY)

    expect(reloaded.denied_tools?.size ?? 0).toBe(0)
    expect(reloaded.denied_by?.shell_exec).toBeUndefined()
  })

  it('consumes the pending row when an approval is cancelled', async () => {
    const podA = pod()
    const manager = new ConversationManager(podA.store)
    await suspendOn(manager, 'req-1', 'shell_exec')
    expect(pendingRows(podA)).toBe(1)

    await manager.clearPendingApproval(SESSION_KEY)

    expect(pendingRows(podA)).toBe(0)
  })

  describe('a decision whose write fails does not come back after a restart', () => {
    function failSessionResolution(handle: StoreHandle) {
      handle.worker.db.exec(`CREATE TRIGGER fail_resolution BEFORE UPDATE OF state ON sessions
        WHEN NEW.state <> 'awaiting_approval'
        BEGIN SELECT RAISE(ABORT, 'injected resolution failure'); END`)
    }

    it('deny', async () => {
      const podA = pod()
      const manager = new ConversationManager(podA.store)
      const conv = await suspendOn(manager, 'req-1', 'shell_exec')
      failSessionResolution(podA)

      await expect(manager.deny(conv, { userId: 'user-a' })).rejects.toThrow(
        'injected resolution failure'
      )
      expect(pendingRows(podA)).toBe(0)

      const podB = await restart(podA)
      expect(await new SqliteColdStartLoader(podB.store).loadPendingApprovals(Date.now())).toEqual(
        []
      )
    })

    it('cancel', async () => {
      const podA = pod()
      const manager = new ConversationManager(podA.store)
      await suspendOn(manager, 'req-1', 'shell_exec')
      failSessionResolution(podA)

      await manager.clearPendingApproval(SESSION_KEY).catch(() => {})
      expect(pendingRows(podA)).toBe(0)

      const podB = await restart(podA)
      expect(await new SqliteColdStartLoader(podB.store).loadPendingApprovals(Date.now())).toEqual(
        []
      )
    })
  })
})

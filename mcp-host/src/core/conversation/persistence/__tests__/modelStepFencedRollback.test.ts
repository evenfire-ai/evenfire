// RAM, the store's reopened-turn mirror and the durable
// rows must agree after a rejected fenced write. A fenced completion rolls
// RAM back on any rejection; fail/cancel keep the fence-only rule, and the
// store mirror follows the manager.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelStepCheckpointFence } from '../../../../db/worker/modelStepCheckpointOps'
import { isModelStepFenceMismatch } from '../../../../db/worker/protocol'
import type { ModelStepTurnFence, WorkerOp } from '../../../../db/worker/protocol'
import { ConversationState } from '../../../types'
import { ConversationManager } from '../../conversation'
import { ModelStepCheckpointStore } from '../modelStepCheckpointStore'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-1043:rpc:agent:default'
const LEASE_MS = 300_000
const CLOCK = 1_000_000

const handles: StoreHandle[] = []

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown()
})

function freshStore(): StoreHandle {
  const handle = makeSqliteStore()
  handles.push(handle)
  return handle
}

function turnRows(handle: StoreHandle, sessionId: string, turnNumber: number): string[][] {
  return (
    handle.worker.db
      .prepare(
        `SELECT role, content FROM messages WHERE session_id = ? AND turn_number = ? ORDER BY ordinal`
      )
      .all(sessionId, turnNumber) as Array<{ role: string; content: string }>
  ).map(row => [row.role, row.content])
}

function sessionRow(handle: StoreHandle, sessionId: string) {
  return handle.worker.db
    .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
    .get(sessionId) as { state: string; active_task_id: string | null }
}

function checkpointStatus(handle: StoreHandle, checkpointId: string): string | undefined {
  const row = handle.worker.db
    .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
    .get(checkpointId) as { status: string } | undefined
  return row?.status
}

async function claimedCheckpoint(handle: StoreHandle): Promise<ModelStepCheckpointFence> {
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => CLOCK,
    blockedTtlMs: 7 * 24 * 3_600_000,
  })
  const fence = await checkpoints.open(
    {
      checkpointId: 'cp-rollback',
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId: 'task-origin',
      provider: 'codex-subscription',
      model: 'gpt-5.5',
      hostId: 'host-a',
      principal: 'user-1043',
      loopState: JSON.stringify({ nextIteration: 0 }),
      taskBudget: null,
      sourceMessage: null,
    },
    [
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({ role: 'user', content: 'origin input' }),
      },
    ]
  )
  const version = await checkpoints.transition(SESSION_KEY, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: CLOCK,
    expiresAt: CLOCK + 7 * 24 * 3_600_000,
  })
  if (version === null) throw new Error('checkpoint transition was rejected')
  const claim = await checkpoints.claim({
    sessionKey: SESSION_KEY,
    checkpointId: 'cp-rollback',
    version,
    hostInstanceId: 'host-instance-a',
    newTaskId: 'task-continuation',
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') throw new Error(`claim failed: ${claim.outcome}`)
  return claim.fence
}

function turnFence(fence: ModelStepCheckpointFence): ModelStepTurnFence {
  return { fence, activeTaskId: 'task-continuation', originTurnNumber: 1 }
}

async function reopenedContinuation(opts: Parameters<typeof makeSqliteStore>[0] = {}) {
  const handle = makeSqliteStore(opts)
  const manager = new ConversationManager(handle.store)
  const conv = await manager.getOrCreate(SESSION_KEY)
  await manager.startTurn(conv, 'origin input', 'task-origin')
  await manager.failTurn(conv)
  const fence = await claimedCheckpoint(handle)
  await manager.resumeTurnForContinuation(
    conv,
    'task-continuation',
    1,
    null,
    undefined,
    turnFence(fence)
  )
  return { handle, manager, conv, fence }
}

describe('model-step fenced rollback (#1043 R2-M2)', () => {
  it('recognises both worker fence-mismatch messages and nothing else', () => {
    expect(isModelStepFenceMismatch(new Error('model-step continuation fence mismatch'))).toBe(true)
    expect(
      isModelStepFenceMismatch(new Error('model-step checkpoint fence mismatch on completion'))
    ).toBe(true)
    expect(isModelStepFenceMismatch(new Error('sqlite busy'))).toBe(false)
    expect(isModelStepFenceMismatch(new Error('model-step fence mismatch'))).toBe(false)
    expect(isModelStepFenceMismatch('model-step continuation fence mismatch')).toBe(false)
    expect(isModelStepFenceMismatch(undefined)).toBe(false)
  })

  it('P-C1. a non-fence rejection of a fenced completion keeps RAM, mirror and durable state on the continuation', async () => {
    const { handle, manager, conv, fence } = await reopenedContinuation()
    handle.worker.db.exec(`
      CREATE TRIGGER reject_completion BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant' AND NEW.content = 'unpersisted answer'
      BEGIN SELECT RAISE(ABORT, 'probe completion rejected'); END
    `)

    await expect(
      manager.completeTurn(conv, 'unpersisted answer', {
        completeModelStepCheckpoint: fence,
        modelStepTurnFence: turnFence(fence),
      })
    ).rejects.toThrow('probe completion rejected')

    // Durable witnesses: the trigger fired and the whole boundary rolled back.
    expect(turnRows(handle, conv.id, 1)).toEqual([['user', 'origin input']])
    expect(checkpointStatus(handle, fence.checkpointId)).toBe('claimed')
    expect(sessionRow(handle, conv.id)).toEqual({
      state: 'processing',
      active_task_id: 'task-continuation',
    })
    expect(handle.store.activeTurnNumber(conv)).toBe(1)
    // RAM agrees with the durable rows.
    expect(conv.state).toBe(ConversationState.Processing)
    expect(conv.activeTaskId).toBe('task-continuation')
    expect(conv.turns.at(-1)?.response).toBeUndefined()
    const history = manager.buildMessageHistory(conv).map(message => message.content)
    expect(history).toContain('origin input')
    expect(history).not.toContain('unpersisted answer')

    handle.worker.db.exec('DROP TRIGGER reject_completion')
    await manager.failTurn(conv, turnFence(fence))
    expect(sessionRow(handle, conv.id)).toEqual({ state: 'idle', active_task_id: null })
    await manager.startTurn(conv, 'next question', 'task-next')
    expect(handle.store.activeTurnNumber(conv)).toBe(2)
    await manager.completeTurn(conv, 'next answer')
    expect(turnRows(handle, conv.id, 2)).toEqual([
      ['user', 'next question'],
      ['assistant', 'next answer'],
    ])
  })

  it.each(['fail-fenced', 'cancel-fenced', 'fail-unfenced'] as const)(
    'P-F1. a non-fence rejection of %s keeps the turn released in RAM and closed in the store mirror',
    async mode => {
      const { handle, manager, conv, fence } = await reopenedContinuation()
      handle.worker.db.exec(`
        CREATE TRIGGER reject_release BEFORE UPDATE OF state ON sessions
        WHEN NEW.state = 'idle' AND OLD.active_task_id = 'task-continuation'
        BEGIN SELECT RAISE(ABORT, 'probe release rejected'); END
      `)

      if (mode === 'fail-fenced') {
        await expect(manager.failTurn(conv, turnFence(fence))).rejects.toThrow(
          'probe release rejected'
        )
      } else if (mode === 'cancel-fenced') {
        await expect(manager.cancelTurn(conv, turnFence(fence))).rejects.toThrow(
          'probe release rejected'
        )
      } else {
        await expect(manager.failTurn(conv)).rejects.toThrow('probe release rejected')
      }

      // Durable witness: the release rolled back atomically.
      expect(sessionRow(handle, conv.id)).toEqual({
        state: 'processing',
        active_task_id: 'task-continuation',
      })
      expect(turnRows(handle, conv.id, 1)).toEqual([['user', 'origin input']])
      // Fence-only rule for fail/cancel: RAM stays released.
      expect(conv.state).toBe(ConversationState.Idle)
      expect(conv.activeTaskId).toBeUndefined()

      handle.worker.db.exec('DROP TRIGGER reject_release')
      await manager.startTurn(conv, 'next question', 'task-next')
      expect(handle.store.activeTurnNumber(conv)).toBe(2)
      await manager.completeTurn(conv, 'next answer')
      expect(turnRows(handle, conv.id, 2)).toEqual([
        ['user', 'next question'],
        ['assistant', 'next answer'],
      ])
      expect(turnRows(handle, conv.id, 1)).toEqual([['user', 'origin input']])
    }
  )

  it.each(['fail', 'cancel'] as const)(
    'WP-H2-001. a fenced %s that times out and fails late restores RAM and the reopened turn',
    async boundary => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      let releaseOp!: () => void
      const held = new Promise<void>(resolve => {
        releaseOp = resolve
      })
      let signalHeld!: () => void
      const opHeld = new Promise<void>(resolve => {
        signalHeld = resolve
      })
      const gate = (op: WorkerOp) => {
        const matches =
          boundary === 'fail'
            ? op.kind === 'update_session_state' &&
              op.state === 'idle' &&
              op.modelStepTurnFence !== undefined
            : op.kind === 'persist_turn_boundary' &&
              op.message.role === 'assistant' &&
              op.message.content === '[Task cancelled by user before completion]'
        if (matches) {
          signalHeld()
          return held
        }
        return Promise.resolve()
      }
      const { handle, manager, conv, fence } = await reopenedContinuation({
        persistQueue: { syncTimeoutMs: 25 },
        holdOps: gate,
      })
      handles.push(handle)
      const previousCompletedAt = conv.turns.at(-1)?.completed_at

      const attempt =
        boundary === 'fail'
          ? manager.failTurn(conv, turnFence(fence))
          : manager.cancelTurn(conv, turnFence(fence))
      const outcome = attempt.then(
        () => undefined,
        (err: Error) => err
      )
      await opHeld
      // Liveness witness: the worker has not committed the boundary while the
      // caller already ran past its optimistic RAM release.
      expect(sessionRow(handle, conv.id)).toEqual({
        state: 'processing',
        active_task_id: 'task-continuation',
      })
      handle.worker.db.exec(
        boundary === 'fail'
          ? `CREATE TRIGGER reject_late_${boundary} BEFORE UPDATE OF state ON sessions
             WHEN NEW.state = 'idle' AND OLD.active_task_id = 'task-continuation'
             BEGIN SELECT RAISE(ABORT, 'probe late ${boundary} rejected'); END`
          : `CREATE TRIGGER reject_late_${boundary} BEFORE INSERT ON messages
             WHEN NEW.role = 'assistant' AND NEW.content = '[Task cancelled by user before completion]'
             BEGIN SELECT RAISE(ABORT, 'probe late ${boundary} rejected'); END`
      )
      try {
        await vi.advanceTimersByTimeAsync(26)
        releaseOp()
        const err = await outcome
        // The late worker error is the delivered failure, not the timeout.
        expect(err?.message).toBe(`probe late ${boundary} rejected`)

        // RAM returns to the pre-call snapshot: the continuation still owns an
        // open turn, and the synthetic cancel response never survives.
        expect(conv.state).toBe(ConversationState.Processing)
        expect(conv.activeTaskId).toBe('task-continuation')
        expect(conv.turns.at(-1)?.completed_at).toBe(previousCompletedAt)
        expect(conv.turns.at(-1)?.response).toBeUndefined()
        // The store mirror and durable rows agree with RAM.
        expect(handle.store.activeTurnNumber(conv)).toBe(1)
        expect(sessionRow(handle, conv.id)).toEqual({
          state: 'processing',
          active_task_id: 'task-continuation',
        })
        expect(checkpointStatus(handle, fence.checkpointId)).toBe('claimed')
        // The restored RAM ownership refuses a conflicting new turn.
        await expect(manager.startTurn(conv, 'next question', 'task-next')).rejects.toThrow(
          /Cannot start turn: conversation is processing/
        )
      } finally {
        releaseOp()
        vi.useRealTimers()
        handle.worker.db.exec(`DROP TRIGGER reject_late_${boundary}`)
      }
    }
  )
})

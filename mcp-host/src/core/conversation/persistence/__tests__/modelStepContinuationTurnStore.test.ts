import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../../agent/incomingAttachments'
import { sourceMessageForResume } from '../../../../agent/sourceMessageForResume'
import type { ModelStepCheckpointFence } from '../../../../db/worker/modelStepCheckpointOps'
import type { ModelStepTurnFence, PendingApprovalRow } from '../../../../db/worker/protocol'
import { type Conversation, ConversationState } from '../../../types'
import { ConversationManager } from '../../conversation'
import { InMemoryConversationStore } from '../../conversationStore'
import { DualConversationStore } from '../dualConversationStore'
import { ModelStepCheckpointStore } from '../modelStepCheckpointStore'
import { SqliteConversationStore } from '../sqliteConversationStore'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-1043:rpc:agent:default'
const LEASE_MS = 300_000
const CLOCK = 1_000_000
const INLINE_BYTES = new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6])

const handles: StoreHandle[] = []

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown()
})

function freshStore(): StoreHandle {
  const handle = makeSqliteStore()
  handles.push(handle)
  return handle
}

interface MessageRowLite {
  ordinal: number
  role: string
  content: string | null
  tool_name: string | null
  turn_number: number
  model_step_checkpoint_id: string | null
}

function turnRows(handle: StoreHandle, sessionId: string, turnNumber: number): MessageRowLite[] {
  return handle.worker.db
    .prepare(
      `SELECT ordinal, role, content, tool_name, turn_number, model_step_checkpoint_id
       FROM messages WHERE session_id = ? AND turn_number = ? ORDER BY ordinal`
    )
    .all(sessionId, turnNumber) as MessageRowLite[]
}

function checkpointStatus(handle: StoreHandle, checkpointId: string): string | undefined {
  const row = handle.worker.db
    .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
    .get(checkpointId) as { status: string } | undefined
  return row?.status
}

function attachmentCount(handle: StoreHandle, checkpointId: string): number {
  return (
    handle.worker.db
      .prepare(
        'SELECT COUNT(*) AS n FROM model_step_checkpoint_attachments WHERE checkpoint_id = ?'
      )
      .get(checkpointId) as { n: number }
  ).n
}

async function claimedCheckpoint(
  handle: StoreHandle,
  sessionKey = SESSION_KEY,
  checkpointId = 'cp-turn',
  originTurnNumber = 1,
  continuationTaskId = 'task-continuation'
): Promise<ModelStepCheckpointFence> {
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => CLOCK,
    blockedTtlMs: 7 * 24 * 3_600_000,
  })
  const fence = await checkpoints.open(
    {
      checkpointId,
      sessionKey,
      originTurnNumber,
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
  const appended = await checkpoints.append(sessionKey, fence, [
    {
      kind: 'tool_dispatch',
      toolCallId: 'tc-1',
      payload: JSON.stringify({ name: 'list_files' }),
    },
    {
      kind: 'tool_result',
      toolCallId: 'tc-1',
      payload: JSON.stringify({ name: 'list_files', isError: false }),
    },
  ])
  if (!appended) throw new Error('checkpoint fixture append was rejected')
  const version = await checkpoints.transition(sessionKey, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: CLOCK,
    expiresAt: CLOCK + 7 * 24 * 3_600_000,
    attachments: [
      {
        attachmentId: `${checkpointId}-att`,
        digestHex: 'ab'.repeat(32),
        bytes: INLINE_BYTES,
        expiresAt: CLOCK + 3_600_000,
      },
    ],
  })
  if (version === null) throw new Error('checkpoint fixture transition was rejected')
  const claim = await checkpoints.claim({
    sessionKey,
    checkpointId,
    version,
    hostInstanceId: 'host-instance-a',
    newTaskId: continuationTaskId,
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') {
    throw new Error(`checkpoint fixture claim failed: ${claim.outcome}`)
  }
  return claim.fence
}

function turnFence(
  fence: ModelStepCheckpointFence,
  activeTaskId = 'task-continuation',
  originTurnNumber = 1
): ModelStepTurnFence {
  return { fence, activeTaskId, originTurnNumber }
}

describe('SqliteConversationStore — reopened continuation turns (#1043)', () => {
  it.each(['cancel', 'fail'] as const)(
    'keeps a non-reopened turn reservation when %s persistence rejects',
    async boundary => {
      const handle = freshStore()
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'origin input', 'task-origin')
      handle.worker.db.exec(`
        CREATE TRIGGER reject_turn_boundary BEFORE UPDATE OF state ON sessions
        WHEN NEW.state = 'idle'
        BEGIN SELECT RAISE(ABORT, 'turn boundary rejected'); END
      `)

      if (boundary === 'cancel') {
        await expect(handle.store.persistTurnCancel(conv)).rejects.toThrow('turn boundary rejected')
      } else {
        await expect(handle.store.persistTurnFail(conv)).rejects.toThrow('turn boundary rejected')
      }
      expect(handle.store.activeTurnNumber(conv)).toBe(2)
      handle.worker.db.exec('DROP TRIGGER reject_turn_boundary')

      await manager.failTurn(conv)
      await manager.startTurn(conv, 'message after rejected boundary', 'task-after')
      expect(turnRows(handle, conv.id, 2).map(row => [row.role, row.content])).toEqual([
        ['user', 'message after rejected boundary'],
      ])
    }
  )

  it('continues and completes the same origin after boot recovery while an ordinary restart is answered', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const origin = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(origin, 'origin input', 'task-origin')
    await manager.failTurn(origin)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => CLOCK,
      blockedTtlMs: 7 * 24 * 3_600_000,
    })
    const fence = await checkpoints.open(
      {
        checkpointId: 'cp-restart',
        sessionKey: SESSION_KEY,
        originTurnNumber: 1,
        originTaskId: 'task-origin',
        provider: 'codex-subscription',
        model: 'gpt-5.5',
        hostId: 'host-a',
        principal: 'user-1043',
        loopState: JSON.stringify({ nextIteration: 1, originUserMessageIndex: 0 }),
        taskBudget: JSON.stringify({
          elapsedActiveMs: 12,
          iterationsUsed: 2,
          durationMs: 300_000,
          maxIterations: 10,
        }),
        sourceMessage: JSON.stringify({
          content: 'origin input',
          sender: 'user-1043',
          channelType: 'rpc',
          channelId: 'agent',
          messageId: 'origin-message',
          timestamp: new Date(CLOCK).toISOString(),
          hostRef: 'host-a',
        }),
      },
      [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({ role: 'user', content: 'origin input' }),
        },
      ]
    )
    await checkpoints.append(SESSION_KEY, fence, [
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc-restart', name: 'list_files', arguments: {} }],
        }),
      },
      {
        kind: 'tool_dispatch',
        toolCallId: 'tc-restart',
        payload: JSON.stringify({ name: 'list_files' }),
      },
      {
        kind: 'tool_result',
        toolCallId: 'tc-restart',
        payload: JSON.stringify({ name: 'list_files', isError: false }),
      },
      {
        kind: 'message',
        toolCallId: 'tc-restart',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'tc-restart',
          name: 'list_files',
          content: 'confirmed files',
        }),
      },
    ])
    const version = await checkpoints.transition(SESSION_KEY, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: CLOCK,
      expiresAt: CLOCK + 7 * 24 * 3_600_000,
    })
    expect(version).not.toBeNull()
    const first = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-restart',
      version: version!,
      hostInstanceId: 'host-old',
      newTaskId: 'task-old',
      leaseMs: LEASE_MS,
    })
    expect(first.outcome).toBe('claimed')
    if (first.outcome !== 'claimed') throw new Error('restart claim was rejected')
    await manager.resumeTurnForContinuation(
      origin,
      'task-old',
      1,
      null,
      undefined,
      turnFence(first.fence, 'task-old')
    )
    const ordinary = await manager.getOrCreate('ordinary:rpc:agent:default')
    await manager.startTurn(ordinary, 'ordinary input', 'task-ordinary')

    expect(await checkpoints.bootReap('host-new')).toEqual({ abandoned: 0, reopened: 1 })
    await handle.persistQueue.enqueueSync({ kind: 'reap_processing_sessions', nowEpoch: CLOCK + 1 })
    expect(turnRows(handle, ordinary.id, 1).map(row => row.content)).toEqual([
      'ordinary input',
      '[Task interrupted by server restart]',
    ])
    const recovered = await checkpoints.loadLive(SESSION_KEY)
    expect(recovered?.header.status).toBe('resumable')
    if (!recovered) throw new Error('recovered checkpoint is missing')
    const next = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-restart',
      version: recovered.header.version,
      hostInstanceId: 'host-new',
      newTaskId: 'task-new',
      leaseMs: LEASE_MS,
    })
    expect(next.outcome).toBe('claimed')
    if (next.outcome !== 'claimed') throw new Error('recovered claim was rejected')
    expect(next.snapshot.tools.confirmed).toBe(1)
    // A new store facade cold-loads the durable turn after the restart reaper.
    const coldManager = new ConversationManager(
      new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
    )
    const coldOrigin = await coldManager.getOrCreate(SESSION_KEY)
    expect(coldOrigin.turns[0]?.response).toBeUndefined()
    await coldManager.resumeTurnForContinuation(
      coldOrigin,
      'task-new',
      1,
      null,
      undefined,
      turnFence(next.fence, 'task-new')
    )
    await coldManager.completeTurn(coldOrigin, 'recovered answer', {
      completeModelStepCheckpoint: next.fence,
      modelStepTurnFence: { fence: next.fence, activeTaskId: 'task-new', originTurnNumber: 1 },
    })
    expect(checkpointStatus(handle, 'cp-restart')).toBe('completed')
    expect(turnRows(handle, origin.id, 1)).toEqual([
      expect.objectContaining({ role: 'user', content: 'origin input', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'recovered answer',
        turn_number: 1,
        model_step_checkpoint_id: 'cp-restart',
      }),
    ])
    expect(coldOrigin.turns).toHaveLength(1)
  })

  it('keeps continuation tool calls and completion in the origin turn, then numbers the next message', async () => {
    const handle = freshStore()
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
    expect(handle.store.activeTurnNumber(conv)).toBe(1)
    handle.store.persistToolCall(conv, {
      name: 'list_files',
      parameters: { path: '.' },
      result: 'file-a\nfile-b',
    })
    await handle.persistQueue.drainSessionKey(SESSION_KEY)
    await manager.completeTurn(conv, 'final answer')
    await manager.startTurn(conv, 'next ordinary message', 'task-next')

    expect(turnRows(handle, conv.id, 1).map(row => [row.role, row.content])).toEqual([
      ['user', 'origin input'],
      ['assistant', null],
      ['tool', 'file-a\nfile-b'],
      ['assistant', 'final answer'],
    ])
    expect(turnRows(handle, conv.id, 2).map(row => [row.role, row.content])).toEqual([
      ['user', 'next ordinary message'],
    ])
    expect(handle.store.activeTurnNumber(conv)).toBe(2)
  })

  it('rejects an untracked session and an out-of-range turn, while a real turn reopens', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    const invalidFence = turnFence(
      { checkpointId: 'cp-invalid', owner: 'owner', generation: 1 },
      'task-cont'
    )

    await expect(
      handle.store.persistContinuationStart({ ...conv, id: 'conv-untracked' }, 1, invalidFence)
    ).rejects.toThrow(/untracked session/)
    await expect(handle.store.persistContinuationStart(conv, 1, invalidFence)).rejects.toThrow(
      /latest turn is 0/
    )

    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    expect(handle.store.activeTurnNumber(conv)).toBe(2)

    const fence = await claimedCheckpoint(handle)
    conv.state = ConversationState.Processing
    conv.activeTaskId = 'task-continuation'
    await handle.store.persistContinuationStart(conv, 1, turnFence(fence))
    expect(handle.store.activeTurnNumber(conv)).toBe(1)
  })

  it('rejects a prior turn after a newer turn was opened, while the latest still reopens', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'first input', 'task-first')
    await manager.failTurn(conv)
    await manager.startTurn(conv, 'second input', 'task-second')
    await manager.failTurn(conv)
    const invalidFence = turnFence(
      { checkpointId: 'cp-invalid', owner: 'owner', generation: 1 },
      'task-old',
      2
    )
    const fence = await claimedCheckpoint(handle, SESSION_KEY, 'cp-turn-latest', 2)
    conv.state = ConversationState.Processing
    conv.activeTaskId = 'task-continuation'

    await expect(handle.store.persistContinuationStart(conv, 1, invalidFence)).rejects.toThrow(
      /latest turn is 2/
    )
    await handle.store.persistContinuationStart(conv, 2, turnFence(fence, 'task-continuation', 2))
    expect(handle.store.activeTurnNumber(conv)).toBe(2)
  })

  it('rolls the reopened ordinal back when the durable continuation start fails', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    expect(
      handle.worker.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(conv.id)
    ).toMatchObject({ n: 1 })

    handle.worker.crash()
    await expect(
      handle.store.persistContinuationStart(
        conv,
        1,
        turnFence({ checkpointId: 'cp-crash', owner: 'owner', generation: 1 })
      )
    ).rejects.toThrow()

    expect(handle.store.activeTurnNumber(conv)).toBe(2)
    // The crashed worker never ACKs shutdown, so the queue reports the exit.
    handles.splice(handles.indexOf(handle), 1)
    await expect(handle.shutdown()).rejects.toThrow(/db worker exited \(code=1\)/)
  })

  it('ends a cancelled reopened turn in the origin turn without advancing the next number', async () => {
    const handle = freshStore()
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

    manager.cancelTurn(conv)
    await handle.persistQueue.drainSessionKey(SESSION_KEY)
    await manager.startTurn(conv, 'message after cancel', 'task-after')

    const cancelled = turnRows(handle, conv.id, 1)
    expect(cancelled.map(row => [row.role, row.content])).toEqual([
      ['user', 'origin input'],
      ['assistant', '[Task cancelled by user before completion]'],
    ])
    expect(turnRows(handle, conv.id, 2).map(row => [row.role, row.content])).toEqual([
      ['user', 'message after cancel'],
    ])
    expect(handle.store.activeTurnNumber(conv)).toBe(2)
  })

  it('clears the reopened number when the continuation fails, so the next message takes turn N+1', async () => {
    const handle = freshStore()
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

    await manager.failTurn(conv)
    const session = handle.worker.db
      .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
      .get(conv.id) as { state: string; active_task_id: string | null }
    expect(session).toEqual({ state: 'idle', active_task_id: null })

    await manager.startTurn(conv, 'message after failure', 'task-after')

    expect(turnRows(handle, conv.id, 1).map(row => [row.role, row.content])).toEqual([
      ['user', 'origin input'],
    ])
    expect(turnRows(handle, conv.id, 2).map(row => [row.role, row.content])).toEqual([
      ['user', 'message after failure'],
    ])
    expect(handle.store.activeTurnNumber(conv)).toBe(2)
  })

  it('completes the claimed checkpoint and deletes its attachments in the completion boundary', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    const fence = await claimedCheckpoint(handle)
    expect(checkpointStatus(handle, fence.checkpointId)).toBe('claimed')
    expect(attachmentCount(handle, fence.checkpointId)).toBe(1)

    await manager.resumeTurnForContinuation(
      conv,
      'task-continuation',
      1,
      null,
      undefined,
      turnFence(fence)
    )
    await manager.completeTurn(conv, 'final answer', {
      completeModelStepCheckpoint: fence,
    })

    const finalRows = turnRows(handle, conv.id, 1).filter(row => row.content === 'final answer')
    expect(finalRows).toHaveLength(1)
    expect(finalRows[0]?.model_step_checkpoint_id).toBe(fence.checkpointId)
    expect(checkpointStatus(handle, fence.checkpointId)).toBe('completed')
    expect(attachmentCount(handle, fence.checkpointId)).toBe(0)
  })

  it('R1-L4 — rejects a delayed stale continuation start while the current owner can reopen', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    const fence = await claimedCheckpoint(handle)
    const ownerFence: ModelStepTurnFence = {
      fence,
      activeTaskId: 'task-continuation',
      originTurnNumber: 1,
    }
    const durable = () =>
      handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null }

    await manager.resumeTurnForContinuation(
      conv,
      'task-continuation',
      1,
      null,
      undefined,
      ownerFence
    )
    expect(durable()).toEqual({ state: 'processing', active_task_id: 'task-continuation' })

    await expect(
      manager.resumeTurnForContinuation(conv, 'task-delayed-a', 1, null, 'task-continuation', {
        ...ownerFence,
        fence: { ...fence, generation: fence.generation - 1 },
        activeTaskId: 'task-delayed-a',
      })
    ).rejects.toThrow('model-step continuation fence mismatch')
    expect(durable()).toEqual({ state: 'processing', active_task_id: 'task-continuation' })
    expect(conv.state).toBe('processing')
    expect(conv.activeTaskId).toBe('task-continuation')

    await manager.failTurn(conv, ownerFence)
    await manager.resumeTurnForContinuation(
      conv,
      'task-continuation',
      1,
      null,
      undefined,
      ownerFence
    )
    expect(durable()).toEqual({ state: 'processing', active_task_id: 'task-continuation' })
    expect(conv.activeTaskId).toBe('task-continuation')
  })

  it('requires a tracked, reopened turn for a completion fence; an ordinary completion leaves the claim live', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    const fence = await claimedCheckpoint(handle)

    await expect(
      handle.store.persistTurnComplete({ ...conv, id: 'conv-untracked' }, 'untracked', {
        completeModelStepCheckpoint: fence,
      })
    ).rejects.toThrow(/untracked session/)
    await expect(
      handle.store.persistTurnComplete(conv, 'without reopen', {
        completeModelStepCheckpoint: fence,
      })
    ).rejects.toThrow(/only complete a reopened turn/)

    await manager.resumeTurnForContinuation(
      conv,
      'task-continuation',
      1,
      null,
      undefined,
      turnFence(fence)
    )
    await manager.completeTurn(conv, 'ordinary final')

    const ordinary = turnRows(handle, conv.id, 1).filter(row => row.content === 'ordinary final')
    expect(ordinary).toHaveLength(1)
    expect(ordinary[0]?.model_step_checkpoint_id).toBeNull()
    expect(checkpointStatus(handle, fence.checkpointId)).toBe('claimed')
  })

  it('rejects a wrong fence atomically, then the live fence completes the same boundary', async () => {
    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    const fence = await claimedCheckpoint(handle)
    const wrongFence: ModelStepCheckpointFence = {
      checkpointId: fence.checkpointId,
      owner: fence.owner,
      generation: fence.generation + 1,
    }
    await manager.resumeTurnForContinuation(
      conv,
      'task-continuation',
      1,
      null,
      undefined,
      turnFence(fence)
    )

    await expect(
      handle.store.persistTurnComplete(conv, 'stale final', {
        completeModelStepCheckpoint: wrongFence,
      })
    ).rejects.toThrow(/fence mismatch/)
    expect(
      handle.worker.db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND content = 'stale final'"
        )
        .get(conv.id)
    ).toMatchObject({ n: 0 })
    expect(checkpointStatus(handle, fence.checkpointId)).toBe('claimed')

    await handle.store.persistContinuationStart(conv, 1, turnFence(fence))
    await manager.completeTurn(conv, 'final answer', {
      completeModelStepCheckpoint: fence,
    })
    const finalRows = turnRows(handle, conv.id, 1).filter(row => row.content === 'final answer')
    expect(finalRows).toHaveLength(1)
    expect(finalRows[0]?.model_step_checkpoint_id).toBe(fence.checkpointId)
    expect(checkpointStatus(handle, fence.checkpointId)).toBe('completed')
  })
})

describe('DualConversationStore — continuation routing (#1043)', () => {
  it('routes completion options to SQLite only and completes the durable checkpoint', async () => {
    const sqlite = freshStore()
    const memory = new InMemoryConversationStore()
    const dual = new DualConversationStore(memory, sqlite.store)
    const manager = new ConversationManager(dual)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'origin input', 'task-origin')
    await manager.failTurn(conv)
    const fence = await claimedCheckpoint(sqlite)
    await manager.resumeTurnForContinuation(
      conv,
      'task-continuation',
      1,
      null,
      undefined,
      turnFence(fence)
    )

    const memoryComplete = vi.spyOn(memory, 'persistTurnComplete')
    const sqliteComplete = vi.spyOn(sqlite.store, 'persistTurnComplete')
    const options = { completeModelStepCheckpoint: fence }
    await manager.completeTurn(conv, 'dual final', options)

    expect(memoryComplete).toHaveBeenCalledTimes(1)
    expect(memoryComplete.mock.calls[0]?.[2]).toBeUndefined()
    expect(sqliteComplete).toHaveBeenCalledTimes(1)
    expect(sqliteComplete).toHaveBeenCalledWith(conv, 'dual final', options)
    expect(checkpointStatus(sqlite, fence.checkpointId)).toBe('completed')
  })

  it('fails loud when the SQLite side cannot reopen a turn', async () => {
    const sqlite = freshStore()
    const memory = new InMemoryConversationStore()
    expect(typeof sqlite.store.persistContinuationStart).toBe('function')

    const dualWithoutReopen = new DualConversationStore(memory, {} as never)
    const conversation = {
      id: 'conv-dual',
      state: 'idle',
    } as Conversation

    await expect(
      dualWithoutReopen.persistContinuationStart(
        conversation,
        1,
        turnFence({ checkpointId: 'cp-dual', owner: 'owner', generation: 1 })
      )
    ).rejects.toThrow(/SQLite side of the dual store cannot reopen a turn/)
  })
})

describe('pending approvals — inline source attachments (#1043)', () => {
  it('stores attachment metadata in source_message but never the inline bytes', async () => {
    const bytes = Buffer.from('SENTINEL-1043-inline-file-bytes')
    const admission = validateIncomingAttachments(
      [
        {
          id: 'file-1043',
          kind: 'file',
          mimeType: 'text/plain',
          detectedMediaType: 'text/plain',
          encoding: 'base64',
          dataBase64: bytes.toString('base64'),
          filename: 'notes-1043.txt',
          sizeBytes: bytes.length,
          digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
        },
      ],
      {
        maxCount: 20,
        maxBytes: 1_000_000,
        maxFileBytes: 3_145_728,
        messageId: 'message-1043',
      }
    )
    if (!admission.ok) throw new Error(`fixture rejected: ${admission.error.code}`)

    const handle = freshStore()
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'summarize the notes', 'task-files')
    const incoming = {
      content: 'summarize the notes',
      channelType: 'rpc',
      channelId: 'chatllm',
      sender: 'user-1043',
      timestamp: '2026-10-08T10:00:00Z',
      messageId: 'message-1043',
      hostRef: 'chatllm',
      attachments: admission.attachments,
    } as unknown as Parameters<typeof sourceMessageForResume>[0]
    await manager.suspendForApproval(conv, {
      request_id: 'req-1043-files',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-1043',
      context_snapshot: [],
      sourceMessage: sourceMessageForResume(incoming),
      task_budget: {
        elapsedActiveMs: 0,
        iterationsUsed: 1,
        durationMs: 86_400_000,
        maxIterations: 1000,
      },
    })

    const row = handle.worker.db
      .prepare('SELECT request_id, source_message FROM pending_approvals WHERE request_id = ?')
      .get('req-1043-files') as (PendingApprovalRow & { request_id: string }) | undefined
    expect(row?.request_id).toBe('req-1043-files')
    expect(row?.source_message).toContain('notes-1043.txt')
    expect(row?.source_message).not.toContain(bytes.toString('base64'))
    expect(row?.source_message).not.toContain('dataBase64')
  })
})

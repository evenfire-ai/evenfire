import { describe, expect, it } from 'vitest'
import { ConversationError, ConversationErrorCode } from '../../errors'
import { type Conversation, ConversationState, type TraceContextV1 } from '../../types'
import { ConversationManager } from '../conversation'
import { InMemoryConversationStore } from '../conversationStore'

const CHECKPOINT_FENCE = { checkpointId: 'cp-1', owner: 'task-origin', generation: 0 }
const TRACE: TraceContextV1 = {
  version: 1,
  runId: 'run-1043',
  sessionId: 'session-1043',
  origin: 'api',
  correlationRefs: [],
}

class ReopenableMemoryStore extends InMemoryConversationStore {
  readonly continuationStarts: Array<{ conversationId: string; turnNumber: number }> = []

  constructor(private readonly rejectStart = false) {
    super()
  }

  async persistContinuationStart(conversation: Conversation, turnNumber: number): Promise<void> {
    this.continuationStarts.push({ conversationId: conversation.id, turnNumber })
    if (this.rejectStart) throw new Error('durable continuation start failed')
  }
}

async function expectInvalidTransition(promise: Promise<void>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ConversationError)
  await expect(promise).rejects.toMatchObject({ code: ConversationErrorCode.InvalidTransition })
}

describe('ConversationManager.resumeTurnForContinuation (#1043)', () => {
  it('rejects a completion fence on the in-memory store while ordinary completions still work', async () => {
    const manager = new ConversationManager()
    const ordinary = await manager.getOrCreate('user-ordinary')
    await manager.startTurn(ordinary, 'hello', 'task-ordinary')
    await manager.completeTurn(ordinary, 'ordinary answer')
    expect(ordinary.turns[0]?.response).toBe('ordinary answer')

    const fenced = await manager.getOrCreate('user-fenced')
    await manager.startTurn(fenced, 'hello again', 'task-fenced')
    await expect(
      manager.completeTurn(fenced, 'never persisted', {
        completeModelStepCheckpoint: CHECKPOINT_FENCE,
      })
    ).rejects.toThrow(/in-memory conversation store cannot complete a model-step checkpoint/)
  })

  it('requires Idle and an unanswered last turn', async () => {
    const manager = new ConversationManager(new ReopenableMemoryStore())

    const processing = await manager.getOrCreate('user-processing')
    await manager.startTurn(processing, 'origin', 'task-processing')
    expect(processing.state).toBe(ConversationState.Processing)
    await expectInvalidTransition(
      manager.resumeTurnForContinuation(processing, 'task-cont', 1, null)
    )

    const answered = await manager.getOrCreate('user-answered')
    await manager.startTurn(answered, 'already answered', 'task-answered')
    await manager.completeTurn(answered, 'done')
    expect(answered.turns[0]?.response).toBe('done')
    await expectInvalidTransition(manager.resumeTurnForContinuation(answered, 'task-cont', 1, null))

    const empty = await manager.getOrCreate('user-empty')
    expect(empty.state).toBe(ConversationState.Idle)
    await expectInvalidTransition(manager.resumeTurnForContinuation(empty, 'task-cont', 1, null))
  })

  it('reopens the failed turn in Processing and clears per-turn wildcard consent', async () => {
    const store = new ReopenableMemoryStore()
    const manager = new ConversationManager(store)
    const conv = await manager.getOrCreate('user-resume')
    await manager.startTurn(conv, 'origin', 'task-origin', TRACE)
    // A turn-wide approval grants '*' for the remainder of this turn.
    conv.auto_approved_tools.add('*')
    await manager.failTurn(conv)
    expect(conv.turns[0]?.completed_at).toBeInstanceOf(Date)
    expect(conv.auto_approved_tools.has('*')).toBe(true)

    await manager.resumeTurnForContinuation(conv, 'task-continuation', 1, TRACE)

    expect(conv.state).toBe(ConversationState.Processing)
    expect(conv.activeTaskId).toBe('task-continuation')
    expect(conv.traceContext).toBe(TRACE)
    expect(conv.auto_approved_tools.has('*')).toBe(false)
    expect(conv.turns[0]?.completed_at).toBeUndefined()
    expect(store.continuationStarts).toEqual([{ conversationId: conv.id, turnNumber: 1 }])
  })

  it('rolls the in-RAM reopen back when the durable continuation start fails', async () => {
    const manager = new ConversationManager(new ReopenableMemoryStore(true))
    const conv = await manager.getOrCreate('user-rollback')
    await manager.startTurn(conv, 'origin', 'task-origin', TRACE)
    await manager.failTurn(conv)
    const completedAt = conv.turns[0]?.completed_at
    expect(completedAt).toBeInstanceOf(Date)

    await expect(
      manager.resumeTurnForContinuation(conv, 'task-continuation', 1, null)
    ).rejects.toThrow(/durable continuation start failed/)

    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.activeTaskId).toBeUndefined()
    expect(conv.traceContext).toBeNull()
    expect(conv.turns[0]?.completed_at).toBe(completedAt)
  })
})

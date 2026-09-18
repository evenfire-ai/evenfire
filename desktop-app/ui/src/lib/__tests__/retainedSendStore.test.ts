import { describe, expect, it, vi } from 'vitest'
import { type RetainedSendSnapshot, createRetainedSendStore } from '../retainedSendStore'

function snapshot(
  userMessageId: string,
  timestamp: number,
  overrides: Partial<RetainedSendSnapshot> = {}
): RetainedSendSnapshot {
  return {
    agentRef: 'agent-x',
    chatId: 'chat-1',
    userMessageId,
    content: userMessageId,
    attachments: [],
    references: [],
    reason: 'post_failed',
    timestamp,
    draftRevision: 0,
    failure: { message: `${userMessageId} failed`, kind: 'network' },
    ...overrides,
  }
}

function held(store: ReturnType<typeof createRetainedSendStore>, ids: string[]): string[] {
  return ids.filter(id => {
    const [chatId, userMessageId] = id.split('/') as [string, string]
    return store.getRetainedSendSnapshot('agent-x', chatId, userMessageId) !== undefined
  })
}

describe('retainedSendStore — superseded failures (#654 M2)', () => {
  function seed() {
    const changed = vi.fn()
    const store = createRetainedSendStore(changed)
    store.retainSendSnapshot(snapshot('old-failure', 100))
    // Still awaiting its terminal: it can still fail and be the only copy.
    store.retainSendSnapshot(
      snapshot('awaiting', 150, { reason: 'awaiting_terminal', failure: undefined })
    )
    store.retainSendSnapshot(
      snapshot('succeeded', 200, { reason: 'awaiting_terminal', failure: undefined })
    )
    store.retainSendSnapshot(snapshot('newer-failure', 300))
    store.retainSendSnapshot(snapshot('other-chat', 100, { chatId: 'chat-2' }))
    changed.mockClear()
    return { store, changed }
  }
  const ALL = [
    'chat-1/old-failure',
    'chat-1/awaiting',
    'chat-1/succeeded',
    'chat-1/newer-failure',
    'chat-2/other-chat',
  ]

  it('a successful send releases itself and only the older failures of its chat', () => {
    const { store, changed } = seed()

    store.releaseSucceededRetainedSend('agent-x', 'chat-1', 'succeeded')

    expect(changed).toHaveBeenCalled()
    expect(held(store, ALL)).toEqual([
      'chat-1/awaiting',
      'chat-1/newer-failure',
      'chat-2/other-chat',
    ])
  })

  it('a successful task releases itself and only the older failures of its chat', () => {
    const { store, changed } = seed()
    store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'succeeded', 'task-ok')

    store.releaseSucceededRetainedSendsForTask('task-ok')

    expect(changed).toHaveBeenCalled()
    expect(held(store, ALL)).toEqual([
      'chat-1/awaiting',
      'chat-1/newer-failure',
      'chat-2/other-chat',
    ])
  })

  it('releases failures up to a timestamp and keeps sends awaiting their terminal', () => {
    const { store } = seed()

    store.releaseRetainedFailuresForChat('agent-x', 'chat-1', 300)

    expect(held(store, ALL)).toEqual(['chat-1/awaiting', 'chat-1/succeeded', 'chat-2/other-chat'])
    expect(store.getLatestRetainedSendSnapshotForChat('agent-x', 'chat-1')).toBeUndefined()
  })
})

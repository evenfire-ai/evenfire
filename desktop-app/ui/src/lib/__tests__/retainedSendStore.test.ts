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
    files: [],
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

describe('retainedSendStore — documents the Host never received (#678 D13)', () => {
  it('still releases a succeeded task whose files reached the Host', () => {
    const store = createRetainedSendStore(vi.fn())
    store.retainSendSnapshot(
      snapshot('delivered', 200, { reason: 'awaiting_terminal', failure: undefined })
    )
    store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'delivered', 'task-ok')
    expect(held(store, ['chat-1/delivered'])).toEqual(['chat-1/delivered'])

    store.releaseSucceededRetainedSendsForTask('task-ok')

    expect(held(store, ['chat-1/delivered'])).toEqual([])
  })

  it('keeps the undelivered file ids only while the text counts as answered', () => {
    const store = createRetainedSendStore(vi.fn())
    store.retainSendSnapshot(
      snapshot('with-files', 200, { reason: 'awaiting_terminal', failure: undefined })
    )
    store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'with-files', 'task-files')
    store.markRetainedSendReason('task-files', 'host_files_dropped', 'Dropped.', 'upstream', ['b'])
    // Witness: the drop recorded which document the Host did not admit.
    const dropped = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'with-files')
    expect(dropped?.undeliveredFileIds).toEqual(['b'])

    store.markRetainedSendReason('task-files', 'async_task_failed', 'Failed.', 'upstream')

    // The text was not answered either: a retry sends every document again.
    const failed = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'with-files')
    expect(failed?.reason).toBe('host_files_unsupported')
    expect(failed).not.toHaveProperty('undeliveredFileIds')
  })

  // Twin of the test above (A15 Nit B): a lost stream says nothing about the
  // answer, so the text may have been answered and a retry could send it again.
  it('keeps a drop as answered without its files when the stream is lost afterwards', () => {
    const store = createRetainedSendStore(vi.fn())
    store.retainSendSnapshot(
      snapshot('with-files', 200, { reason: 'awaiting_terminal', failure: undefined })
    )
    store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'with-files', 'task-files')
    store.markRetainedSendReason('task-files', 'host_files_dropped', 'Dropped.', 'upstream', ['b'])

    store.markRetainedSendReason('task-files', 'stream_lost', 'The stream was lost.', 'upstream')

    const lost = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'with-files')
    // Witness: the second mark ran and replaced the failure message.
    expect(lost?.failure).toEqual({ message: 'The stream was lost.', kind: 'upstream' })
    expect(lost?.reason).toBe('host_files_dropped')
    expect(lost?.undeliveredFileIds).toEqual(['b'])
  })

  // Both reasons hold documents that exist nowhere else: a rejected send
  // (nothing answered) and a message answered without its documents.
  describe.each(['host_files_unsupported', 'host_files_dropped'] as const)('%s', reason => {
    // A failure other than a lost stream recorded after the drop means the
    // text was not answered either: the snapshot becomes a rejected send, so
    // the files stay held and the text and Retry come back.
    const reasonAfterFailure = 'host_files_unsupported'

    it('keeps the snapshot of a task that succeeded without its files', () => {
      const store = createRetainedSendStore(vi.fn())
      store.retainSendSnapshot(snapshot('older', 100))
      store.retainSendSnapshot(
        snapshot('with-files', 200, { reason: 'awaiting_terminal', failure: undefined })
      )
      store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'with-files', 'task-files')
      store.markRetainedSendReason(
        'task-files',
        reason,
        'The Host does not accept file attachments yet.',
        'upstream'
      )

      store.releaseSucceededRetainedSendsForTask('task-files')

      // Liveness witness: the flagged snapshot is still there, marked with its reason.
      const kept = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'with-files')
      expect(kept?.reason).toBe(reason)
      // The success released nobody, not even the older failure it would supersede.
      expect(held(store, ['chat-1/older', 'chat-1/with-files'])).toEqual([
        'chat-1/older',
        'chat-1/with-files',
      ])
    })

    function seedUndeliveredFiles() {
      const store = createRetainedSendStore(vi.fn())
      store.retainSendSnapshot(
        snapshot('undelivered', 100, {
          reason: reason,
          failure: { message: 'The Host did not receive the files.', kind: 'upstream' },
        })
      )
      store.retainSendSnapshot(snapshot('ordinary-failure', 150))
      store.retainSendSnapshot(
        snapshot('later', 200, { reason: 'awaiting_terminal', failure: undefined })
      )
      return store
    }
    const SEEDED = ['chat-1/undelivered', 'chat-1/ordinary-failure', 'chat-1/later']

    it('a later successful send in the chat keeps an older snapshot whose files never arrived', () => {
      const store = seedUndeliveredFiles()

      store.releaseSucceededRetainedSend('agent-x', 'chat-1', 'later')

      // Witness: the success did supersede the ordinary older failure.
      expect(held(store, SEEDED)).toEqual(['chat-1/undelivered'])
    })

    it('a later successful task in the chat keeps an older snapshot whose files never arrived', () => {
      const store = seedUndeliveredFiles()
      store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'later', 'task-later')

      store.releaseSucceededRetainedSendsForTask('task-later')

      expect(held(store, SEEDED)).toEqual(['chat-1/undelivered'])
    })

    it('releasing failures without keepUndeliveredFiles also releases an older snapshot whose files never arrived', () => {
      const store = seedUndeliveredFiles()

      store.releaseRetainedFailuresForChat('agent-x', 'chat-1', 150)

      // Witness: the send still awaiting its terminal is not a failure and stays.
      expect(held(store, SEEDED)).toEqual(['chat-1/later'])
    })

    it('releasing failures with keepUndeliveredFiles keeps an older snapshot whose files never arrived', () => {
      const store = seedUndeliveredFiles()

      store.releaseRetainedFailuresForChat('agent-x', 'chat-1', 150, { keepUndeliveredFiles: true })

      // Witness: the ordinary failure recorded before the same timestamp is released.
      expect(held(store, SEEDED)).toEqual(['chat-1/undelivered', 'chat-1/later'])
    })

    // A15 item 3: a cancel, or a stream loss the turn already covered, ends
    // the task, but the documents the Host never received exist nowhere else.
    it('releasing a task keeps its snapshot whose files never arrived', () => {
      const changed = vi.fn()
      const store = createRetainedSendStore(changed)
      store.retainSendSnapshot(
        snapshot('plain', 100, { reason: 'awaiting_terminal', failure: undefined })
      )
      store.retainSendSnapshot(
        snapshot('with-files', 200, {
          reason,
          failure: { message: 'The Host did not receive the files.', kind: 'upstream' },
        })
      )
      store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'plain', 'task-shared')
      store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'with-files', 'task-shared')
      changed.mockClear()

      store.releaseRetainedSendsForTask('task-shared')

      // Witness: the plain snapshot of the same task is released.
      expect(changed).toHaveBeenCalledTimes(1)
      expect(held(store, ['chat-1/plain', 'chat-1/with-files'])).toEqual(['chat-1/with-files'])
      // The kept snapshot is still the visible failure of its chat.
      expect(store.getLatestRetainedSendSnapshotForChat('agent-x', 'chat-1')).toMatchObject({
        userMessageId: 'with-files',
        reason,
      })
    })

    it('a later task failure updates the message and keeps the files held as a rejected send', () => {
      const store = createRetainedSendStore(vi.fn())
      store.retainSendSnapshot(
        snapshot('with-files', 200, { reason: 'awaiting_terminal', failure: undefined })
      )
      store.attachTaskIdToRetainedSend('agent-x', 'chat-1', 'with-files', 'task-files')
      store.markRetainedSendReason(
        'task-files',
        reason,
        'The Host did not receive the files.',
        'upstream'
      )

      store.markRetainedSendReason(
        'task-files',
        'async_task_failed',
        'The task failed.',
        'upstream'
      )

      const kept = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'with-files')
      // Witness: the second mark ran and replaced the failure message.
      expect(kept?.failure).toEqual({ message: 'The task failed.', kind: 'upstream' })
      expect(kept?.reason).toBe(reasonAfterFailure)
      // So the task's later success still keeps it.
      store.releaseSucceededRetainedSendsForTask('task-files')
      expect(held(store, ['chat-1/with-files'])).toEqual(['chat-1/with-files'])
    })

    it('a later send failure updates the message and keeps the files held as a rejected send', () => {
      const store = seedUndeliveredFiles()

      store.failRetainedSend(
        'agent-x',
        'chat-1',
        'undelivered',
        'post_failed',
        'The send failed.',
        'network'
      )

      const kept = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'undelivered')
      expect(kept?.failure).toEqual({ message: 'The send failed.', kind: 'network' })
      expect(kept?.reason).toBe(reasonAfterFailure)
    })

    // A15 Nit B: a lost stream does not tell whether the text was answered, so
    // the snapshot keeps the reason it had.
    it('a later stream loss updates the message and keeps the reason the snapshot had', () => {
      const store = seedUndeliveredFiles()

      store.failRetainedSend(
        'agent-x',
        'chat-1',
        'undelivered',
        'stream_lost',
        'The stream was lost.',
        'network'
      )

      const kept = store.getRetainedSendSnapshot('agent-x', 'chat-1', 'undelivered')
      // Witness: the failure was recorded.
      expect(kept?.failure).toEqual({ message: 'The stream was lost.', kind: 'network' })
      expect(kept?.reason).toBe(reason)
    })
  })
})

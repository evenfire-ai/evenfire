import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { withAccessDatabaseTransaction } from '../src/services/access/accessDatabaseQuery.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'

// pg-pool removes its idle 'error' listener while a client is checked out. An
// access transaction can wait on non-SQL work (for example a Kubernetes read)
// while PostgreSQL terminates the backend; node-postgres then emits 'error' on
// the borrowed client in another tick. Without a listener owned by the
// transaction, Node's EventEmitter throws and Control API exits. The client is
// a real EventEmitter so the emit has exactly that semantics.

type FakeClient = EventEmitter & {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

function createFakeClient(): FakeClient {
  const client = new EventEmitter() as FakeClient
  client.query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  client.release = vi.fn()
  return client
}

describe('withAccessDatabaseTransaction — async out-of-band client error', () => {
  const uncaught: unknown[] = []
  // Without the fix the emit surfaces here; recording it turns the crash into
  // an assertion failure instead of a worker abort.
  const onUncaught = (err: unknown): void => {
    uncaught.push(err)
  }

  beforeEach(() => {
    uncaught.length = 0
    process.on('uncaughtException', onUncaught)
  })

  afterEach(() => {
    process.removeListener('uncaughtException', onUncaught)
    vi.clearAllMocks()
  })

  it('contains the client error during non-SQL work and discards the client once', async () => {
    const client = createFakeClient()
    const connectionPool = { connect: vi.fn().mockResolvedValue(client) }
    const budget = AccessExecutionBudget.create('action')
    const terminated = Object.assign(
      new Error('terminating connection due to administrator command'),
      {
        code: '57P01',
      }
    )
    let releaseExternalWait!: () => void
    const externalWait = new Promise<void>(resolve => {
      releaseExternalWait = resolve
    })
    let workEntered = false

    try {
      const resultPromise = withAccessDatabaseTransaction(
        budget,
        async () => {
          workEntered = true
          setTimeout(() => client.emit('error', terminated), 0)
          await externalWait
          return 'done'
        },
        { connectionPool }
      )

      await new Promise(resolve => setTimeout(resolve, 10))
      releaseExternalWait()
      const result = await resultPromise
      await new Promise(resolve => setTimeout(resolve, 0))

      // Liveness witness: the transaction opened and the work ran.
      expect(workEntered).toBe(true)
      expect(client.query).toHaveBeenCalledWith('BEGIN', [])
      expect(result).toBe('done')
      expect(uncaught).toEqual([])
      expect(client.listenerCount('error')).toBe(0)
      expect(client.release).toHaveBeenCalledTimes(1)
      expect(client.release).toHaveBeenCalledWith(terminated)
    } finally {
      budget.close()
    }
  })
})

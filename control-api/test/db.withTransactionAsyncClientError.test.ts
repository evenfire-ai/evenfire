import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Pool } from 'pg'
import { withTransaction } from '../src/db.js'

// R3-H3: the proactive OAuth-refresh carrier holds an open, idle transaction
// across an external POST. If idle_in_transaction_session_timeout fires, Postgres
// terminates the backend (25P03) and node-postgres emits an 'error' event on the
// BORROWED client — for which pg-pool has removed its own listener while the
// client is checked out. With no listener, Node's EventEmitter throws in that
// tick, off any await stack, which the cron's try/catch cannot see → the process
// exits. This test drives that exact out-of-band 'error' through a REAL
// EventEmitter (the actual producer of the "emit 'error' with no listener throws"
// semantics) so the assertion — not a setup crash — is what distinguishes the
// pre-fix behavior (uncaught → process would exit) from the fix (captured, client
// destroyed).

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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise(res => setTimeout(res, 0))

describe('db.withTransaction — async out-of-band client error (R3-H3)', () => {
  const uncaught: unknown[] = []
  // Record uncaughtException instead of letting it crash the worker: on the
  // pre-fix code the emitted 'error' has no listener and surfaces here; the
  // assertion below then fails. This handler must be installed so the observable
  // difference is an assertion, not a nondeterministic worker abort.
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

  it('captures the async client error, destroys the client, and never crashes the process', async () => {
    const client = createFakeClient()
    const fakePool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool

    const terminated = new Error('terminating connection due to idle-in-transaction timeout')
    // Mimic 25P03 delivered by node-postgres on the checked-out client.
    ;(terminated as Error & { code?: string }).code = '25P03'

    const externalCall = createDeferred()

    const resultPromise = withTransaction(async () => {
      // The transaction is open and idle here (no query running), awaiting an
      // external POST. Fire the backend error out-of-band on the next tick — on a
      // stack independent of this await, exactly as node-postgres delivers 25P03.
      setTimeout(() => client.emit('error', terminated), 0)
      await externalCall.promise
      return 'done'
    }, fakePool)

    // Let the out-of-band 'error' (delay 0) fire and be processed BEFORE we let
    // work finish: a later delay guarantees the emit runs first, so on the pre-fix
    // code it surfaces as an uncaughtException here while work is still parked.
    await new Promise(res => setTimeout(res, 10))
    externalCall.resolve()

    const result = await resultPromise
    // Give any pending uncaughtException a tick to surface.
    await tick()

    expect(result).toBe('done')
    // Observable outcome (T4): no uncaught error escaped, and the poisoned client
    // was released WITH an Error so pg-pool destroys it rather than recycling it.
    expect(uncaught).toEqual([])
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledWith(expect.any(Error))
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../observability/logger'
import {
  PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
  createGrantUpdateListener,
  parseGrantUpdatePayload,
} from './grantUpdateListener'

function makeLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withStep: vi.fn(),
  }
  logger.withStep.mockReturnValue(logger)
  return logger as unknown as Logger
}

type NotificationHandler = (msg: { channel: string; payload?: string }) => void

/**
 * Minimal fake of a pg PoolClient scoped to LISTEN: records the channel it
 * LISTENed on and lets the test emit notifications / connection errors into the
 * registered handlers. `query` can be made to reject to simulate a LISTEN that
 * fails without an 'error' emission (H3).
 */
function makeFakeClient(opts: { failQuery?: boolean } = {}) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const queries: string[] = []
  const client = {
    on(event: string, handler: (...args: unknown[]) => void) {
      ;(handlers[event] ??= []).push(handler)
      return client
    },
    query: vi.fn(async (sql: string) => {
      queries.push(sql)
      if (opts.failQuery) throw new Error('LISTEN failed')
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return {
    client,
    queries,
    emitNotification(msg: { channel: string; payload?: string }) {
      for (const handler of handlers.notification ?? []) (handler as NotificationHandler)(msg)
    },
    emitError(err: Error) {
      for (const handler of handlers.error ?? []) handler(err)
    },
  }
}

describe('parseGrantUpdatePayload', () => {
  it('parses a well-formed payload with a capability family', () => {
    expect(
      parseGrantUpdatePayload(
        JSON.stringify({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'research',
          capabilityFamily: 'promptBridge',
        })
      )
    ).toEqual({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
      capabilityFamily: 'promptBridge',
    })
  })

  it('parses a payload without a capability family (whole-recipe revoke)', () => {
    expect(
      parseGrantUpdatePayload(
        JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' })
      )
    ).toEqual({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' })
  })

  it('returns null for non-JSON, missing fields, or wrong types (data, not command)', () => {
    expect(parseGrantUpdatePayload('not json')).toBeNull()
    expect(parseGrantUpdatePayload(JSON.stringify({ recipeName: 'research' }))).toBeNull()
    expect(
      parseGrantUpdatePayload(JSON.stringify({ recipeNamespace: 'sandbox-recipes' }))
    ).toBeNull()
    expect(
      parseGrantUpdatePayload(JSON.stringify({ recipeNamespace: 1, recipeName: 2 }))
    ).toBeNull()
    expect(parseGrantUpdatePayload(JSON.stringify(['array']))).toBeNull()
  })
})

describe('createGrantUpdateListener', () => {
  it('LISTENs on the grant-update channel on start', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => fake.client as never,
    })

    await listener.start()

    expect(fake.queries.some(sql => /LISTEN\s+plugin_workload_sdk_grant_update/.test(sql))).toBe(
      true
    )
    await listener.stop()
    expect(fake.client.query).toHaveBeenCalledWith(
      expect.stringMatching(/UNLISTEN\s+plugin_workload_sdk_grant_update/)
    )
    expect(fake.client.release).toHaveBeenCalled()
  })

  it('forwards the parsed notification to onGrantUpdate', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => fake.client as never,
    })
    await listener.start()

    fake.emitNotification({
      channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
      payload: JSON.stringify({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'research',
        capabilityFamily: 'promptBridge',
      }),
    })

    expect(onGrantUpdate).toHaveBeenCalledWith({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
      capabilityFamily: 'promptBridge',
    })
    await listener.stop()
  })

  it('warns and does not dispatch on an unparseable payload (payload is data, not a command)', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const logger = makeLogger()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger,
      connect: async () => fake.client as never,
    })
    await listener.start()

    fake.emitNotification({
      channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
      payload: 'garbage-not-json',
    })

    expect(onGrantUpdate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    await listener.stop()
  })

  it('ignores notifications on other channels', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => fake.client as never,
    })
    await listener.start()

    fake.emitNotification({
      channel: 'some_other_channel',
      payload: JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' }),
    })

    expect(onGrantUpdate).not.toHaveBeenCalled()
    await listener.stop()
  })
})

describe('createGrantUpdateListener — reconnect / stop resilience (issue #375 H1-H3)', () => {
  /** A sleep seam that never resolves, so we can count reconnect scheduling without real timers. */
  function pendingSleep() {
    const calls: number[] = []
    const sleep = vi.fn((ms: number) => {
      calls.push(ms)
      return new Promise<void>(() => {
        /* never resolves — the reconnect stays parked in its backoff */
      })
    })
    return { sleep, calls }
  }

  it('H1: a connection drop schedules exactly ONE reconnect even when error fires repeatedly', async () => {
    const fake = makeFakeClient()
    const { sleep, calls } = pendingSleep()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate: vi.fn(),
      logger: makeLogger(),
      connect: async () => fake.client as never,
      sleep,
    })
    await listener.start()

    // Both the LISTEN-rejection path and the 'error' event fire on one drop; and
    // 'error' can fire more than once. All must collapse into a single reconnect.
    fake.emitError(new Error('connection reset'))
    fake.emitError(new Error('connection reset again'))

    expect(fake.client.release).toHaveBeenCalled()
    expect(calls).toHaveLength(1) // exactly one reconnect scheduled, no leaked loops
    await listener.stop()
  })

  it('H3: a LISTEN that fails without an error event releases the client and schedules a retry', async () => {
    const fake = makeFakeClient({ failQuery: true })
    const { sleep, calls } = pendingSleep()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate: vi.fn(),
      logger: makeLogger(),
      connect: async () => fake.client as never,
      sleep,
    })

    await listener.start()

    // LISTEN query rejected → attach catch must release the checked-out client
    // (no leak) and schedule the retry.
    expect(fake.client.release).toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    await listener.stop()
  })

  it('H2: stop() during an in-flight connect() leaves no live listener and dispatches nothing', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    let resolveConnect!: () => void
    const connectGate = new Promise<void>(resolve => {
      resolveConnect = resolve
    })
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => {
        await connectGate
        return fake.client as never
      },
    })

    const startPromise = listener.start() // parks awaiting connect()
    await listener.stop() // shutdown while the attach is mid-connect
    resolveConnect() // connect resolves AFTER stop
    await startPromise

    // The attach observed `stopped` after connect() resolved: it released the
    // client and registered NO handlers, so a late notification dispatches nothing.
    expect(fake.client.release).toHaveBeenCalled()
    fake.emitNotification({
      channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
      payload: JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' }),
    })
    expect(onGrantUpdate).not.toHaveBeenCalled()
  })
})

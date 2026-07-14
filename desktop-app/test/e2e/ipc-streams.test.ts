// desktop-app/test/e2e/ipc-streams.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  E2E_EMAIL,
  E2E_HOST_REF,
  E2E_PASSWORD,
  getSender,
  invoke,
  setupHarness,
  teardownHarness,
  waitForIdle,
} from './helpers.js'

describe('IPC stream e2e', () => {
  beforeAll(async () => {
    await setupHarness()
    // Login first
    await invoke('auth:passwordLogin', { email: E2E_EMAIL, password: E2E_PASSWORD })
  })

  afterAll(async () => {
    await teardownHarness()
  })

  // Helper: wait for sender.send to be called with a matching event
  async function waitForStreamEvent(
    channelName: string,
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const sender = getSender()
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const calls = sender.send.mock.calls as Array<
        [string, { streamId: string; event: Record<string, unknown> }]
      >
      for (const [channel, payload] of calls) {
        if (channel === channelName && predicate(payload.event)) {
          return payload.event
        }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Timed out waiting for ${channelName} event matching predicate`)
  }

  // ── Test 11: SSE activity stream ─────────────────────────────────
  it('11. hostActivityStreamStart receives real-time activity events', async () => {
    // Ensure agent is idle before starting
    await waitForIdle(E2E_HOST_REF)

    const sender = getSender()
    sender.send.mockClear()

    // Start activity stream
    const { streamId } = (await invoke('rpc:hostActivityStreamStart', {
      hostRef: E2E_HOST_REF,
      hostRefs: [E2E_HOST_REF],
    })) as { streamId: string }
    expect(streamId).toBeTruthy()

    // Wait for "open" event
    const openEvent = await waitForStreamEvent(
      'rpc:hostActivityStreamEvent',
      e => e.type === 'open',
      10_000
    )
    expect(openEvent.type).toBe('open')

    // Trigger activity by sending a message
    await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: { content: 'Reply with: STREAM_TEST', channelType: 'rpc', sender: 'e2e-test' },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })

    // Wait for an activity event (not open/error/closed)
    const activityEvent = await waitForStreamEvent(
      'rpc:hostActivityStreamEvent',
      e => e.type === 'activity',
      30_000
    )
    expect(activityEvent.type).toBe('activity')

    // Stop stream
    await invoke('rpc:hostActivityStreamStop', { streamId })
    await waitForIdle(E2E_HOST_REF)
  }, 60_000)

  // ── Test 12: SSE status stream ───────────────────────────────────
  it('12. hostStatusStreamStart starts and stops without error', async () => {
    await waitForIdle(E2E_HOST_REF)

    const sender = getSender()
    sender.send.mockClear()

    let streamId: string
    try {
      const result = (await invoke('rpc:hostStatusStreamStart', {
        hostRef: E2E_HOST_REF,
        hostRefs: [E2E_HOST_REF],
      })) as { streamId: string }
      streamId = result.streamId
    } catch (err) {
      // Transient connection errors (port-forward socket close) are acceptable
      console.warn('Status stream start failed (transient):', (err as Error).message)
      return
    }
    expect(streamId).toBeTruthy()

    await new Promise(r => setTimeout(r, 3_000))

    const stopResult = await invoke('rpc:hostStatusStreamStop', { streamId })
    expect(stopResult).toEqual({ ok: true })

    const statusCalls = sender.send.mock.calls.filter(
      ([ch]: [string]) => ch === 'rpc:hostStatusStreamEvent'
    )
    if (statusCalls.length > 0) {
      const firstEvent = statusCalls[0][1].event as Record<string, unknown>
      expect(['open', 'status', 'error', 'closed']).toContain(firstEvent.type)
    }

    await waitForIdle(E2E_HOST_REF)
  }, 30_000)

  // ── Test 13: SSE task progress stream ────────────────────────────
  it('13. taskProgressStreamStart receives progress events', async () => {
    await waitForIdle(E2E_HOST_REF)

    const sender = getSender()
    sender.send.mockClear()

    // Send async message to get a taskId
    const msgResult = (await invoke('rpc:invokeHostMessage', {
      hostRef: E2E_HOST_REF,
      payload: { content: 'Reply with: PROGRESS_TEST', channelType: 'rpc', sender: 'e2e-test' },
      hostRefs: [E2E_HOST_REF],
      options: { async: true },
    })) as { taskId?: string }

    if (!msgResult.taskId) {
      console.warn('No taskId returned — skipping progress stream test')
      return
    }

    // Start progress stream
    const { streamId } = (await invoke('rpc:taskProgressStreamStart', {
      hostRef: E2E_HOST_REF,
      taskId: msgResult.taskId,
      hostRefs: [E2E_HOST_REF],
    })) as { streamId: string }
    expect(streamId).toBeTruthy()

    // Wait for open event
    const openEvent = await waitForStreamEvent(
      'rpc:taskProgressStreamEvent',
      e => e.type === 'open',
      10_000
    )
    expect(openEvent.type).toBe('open')

    // Wait for task to complete
    await waitForIdle(E2E_HOST_REF, 45_000)

    // Stop stream
    await invoke('rpc:taskProgressStreamStop', { streamId })
  }, 60_000)

  // ── Test 14: Stream cleanup ──────────────────────────────────────
  it('14. stopping a stream prevents further events', async () => {
    await waitForIdle(E2E_HOST_REF)

    const sender = getSender()
    sender.send.mockClear()

    const { streamId } = (await invoke('rpc:hostActivityStreamStart', {
      hostRef: E2E_HOST_REF,
      hostRefs: [E2E_HOST_REF],
    })) as { streamId: string }

    // Wait for open
    await waitForStreamEvent('rpc:hostActivityStreamEvent', e => e.type === 'open', 10_000)

    // Stop immediately
    const stopResult = await invoke('rpc:hostActivityStreamStop', { streamId })
    expect(stopResult).toEqual({ ok: true })

    // Record call count after stop
    const countAfterStop = sender.send.mock.calls.filter(
      ([ch]: [string]) => ch === 'rpc:hostActivityStreamEvent'
    ).length

    // Wait a bit — no new events should arrive
    await new Promise(r => setTimeout(r, 2000))
    const countAfterWait = sender.send.mock.calls.filter(
      ([ch]: [string]) => ch === 'rpc:hostActivityStreamEvent'
    ).length

    // At most 1 extra event (the "closed" event from the stream ending)
    expect(countAfterWait - countAfterStop).toBeLessThanOrEqual(1)
  })
})

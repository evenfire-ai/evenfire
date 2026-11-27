import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Signal } from '../../src/config-loader/types'
import { createStaticRuntimeTokenProvider } from '../../src/runtime-token-provider/provider'
import { SignalPoller } from '../../src/signal-poller/poller'
import { AUTH_RETRY_DELAY_MS } from '../../src/status-reporter/authRetry'

const RUN_ID = 'run-a'
const OWN_CANCEL_ID = `cancel:${RUN_ID}`

function makePoller(
  fetchMock?: ReturnType<typeof vi.fn>,
  identity: { runId: string | undefined } = { runId: RUN_ID }
) {
  if (fetchMock) vi.stubGlobal('fetch', fetchMock)
  return new SignalPoller({
    wrcUrl: 'http://wrc:8082',
    workflowName: 'test-wf',
    tokenProvider: createStaticRuntimeTokenProvider({ wrcToken: 'tok' }),
    intervalMs: 60000, // high interval to avoid auto-polling in tests
    runId: identity.runId,
  })
}

// Seeds a poller the way production fills it: one poll whose response
// carries the given signals. The caller stops the returned poller.
async function seedByPoll(signals: Signal[]): Promise<SignalPoller> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ signals }),
  })
  const poller = makePoller(fetchMock)
  poller.pollSignals(() => {})
  await vi.waitFor(() => expect(poller.getSignals()).toHaveLength(signals.length))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return poller
}

describe('SignalPoller', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('has no push entry point', () => {
    const poller = makePoller()
    // Witness: the poll entry point exists on the same instance.
    expect(typeof poller.pollSignals).toBe('function')
    expect('pushSignal' in poller).toBe(false)
  })

  describe('hasSignal()', () => {
    it('returns true when signal type exists', async () => {
      const poller = await seedByPoll([
        { type: 'pause', requestId: 'r1', receivedAt: new Date().toISOString() },
      ])
      expect(poller.hasSignal('pause')).toBe(true)
      poller.stop()
    })

    it('returns false when signal type not present', () => {
      const poller = makePoller()
      expect(poller.hasSignal('cancel')).toBe(false)
    })
  })

  describe('consumeSignal()', () => {
    it('returns and removes signal of given type', async () => {
      const poller = await seedByPoll([
        { type: 'pause', requestId: 'r1', receivedAt: new Date().toISOString() },
      ])
      const consumed = poller.consumeSignal('pause')
      expect(consumed?.requestId).toBe('r1')
      expect(poller.hasSignal('pause')).toBe(false)
      poller.stop()
    })

    it('returns undefined when signal type not present', () => {
      const poller = makePoller()
      expect(poller.consumeSignal('cancel')).toBeUndefined()
    })
  })

  describe('pollSignals()', () => {
    it('invokes callback for new signals from HTTP poll', async () => {
      const signals: Signal[] = [
        { type: 'pause', requestId: 'r1', receivedAt: new Date().toISOString() },
      ]
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ signals }),
      })
      const poller = makePoller(fetchMock)
      const received: Signal[] = []
      const stop = poller.pollSignals(s => {
        received.push(s)
      })

      // Wait for initial poll
      await new Promise(r => setTimeout(r, 50))

      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('pause')
      stop()
    })

    it('drops a repeated requestId', async () => {
      vi.useFakeTimers()
      const ownCancel: Signal = {
        type: 'cancel',
        requestId: OWN_CANCEL_ID,
        receivedAt: new Date().toISOString(),
      }
      // workflow-recipes re-queues the same cancel on every tick, so a later
      // poll can return a signal the runtime already consumed.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ signals: [ownCancel] }),
      })
      const poller = makePoller(fetchMock)
      const received: Signal[] = []
      const stop = poller.pollSignals(s => {
        received.push(s)
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60000)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(received).toEqual([ownCancel])
      expect(poller.getSignals()).toEqual([ownCancel])
      stop()
    })

    it('continues polling when network error occurs', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('network fail'))
        .mockResolvedValue({
          ok: true,
          json: async () => ({ signals: [] }),
        })
      const poller = makePoller(fetchMock)
      const stop = poller.pollSignals(() => {})

      await new Promise(r => setTimeout(r, 50))
      // Should not throw — polling continues
      expect(fetchMock).toHaveBeenCalled()
      stop()
    })

    it('continues polling when response is not ok', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
      const poller = makePoller(fetchMock)
      const stop = poller.pollSignals(() => {})

      await new Promise(r => setTimeout(r, 50))
      expect(fetchMock).toHaveBeenCalled()
      stop()
    })

    it('rereads the token provider once after 401', async () => {
      vi.useFakeTimers()
      const provider = {
        getWrcToken: vi.fn().mockResolvedValueOnce('jwt-a').mockResolvedValueOnce('jwt-b'),
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ signals: [] }) })
      vi.stubGlobal('fetch', fetchMock)
      const poller = new SignalPoller({
        wrcUrl: 'http://wrc:8082',
        workflowName: 'test-wf',
        tokenProvider: provider,
        intervalMs: 60000,
        runId: RUN_ID,
      })
      const stop = poller.pollSignals(() => {})

      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-a')
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-b')
      stop()
    })
  })

  describe('cancel identity', () => {
    function signal(type: Signal['type'], requestId: string): Signal {
      return { type, requestId, receivedAt: new Date().toISOString() }
    }

    it('accepts only the cancel signal of its own run', async () => {
      vi.useFakeTimers()
      const foreignCancel = signal('cancel', 'cancel:run-b')
      const pause = signal('pause', 'pause-1')
      const ownCancel = signal('cancel', OWN_CANCEL_ID)
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ signals: [foreignCancel, pause] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ signals: [ownCancel] }) })
      const poller = makePoller(fetchMock)
      const received: Signal[] = []
      const stop = poller.pollSignals(s => {
        received.push(s)
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(poller.getSignals().map(s => s.requestId)).toEqual(['pause-1'])
      expect(poller.hasSignal('cancel')).toBe(false)
      expect(received.map(s => s.requestId)).toEqual(['pause-1'])

      await vi.advanceTimersByTimeAsync(60000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(poller.hasSignal('cancel')).toBe(true)
      expect(poller.getSignals().map(s => s.requestId)).toEqual(['pause-1', OWN_CANCEL_ID])
      expect(received.filter(s => s.type === 'cancel')).toEqual([ownCancel])
      stop()
    })

    it('drops every cancel when the pod has no run id', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ signals: [signal('cancel', OWN_CANCEL_ID), signal('pause', 'p-2')] }),
      })
      const poller = makePoller(fetchMock, { runId: undefined })
      const received: Signal[] = []
      const stop = poller.pollSignals(s => {
        received.push(s)
      })
      await new Promise(r => setTimeout(r, 50))

      // The poll ran: the pause signal of the same response was accepted.
      expect(received.map(s => s.requestId)).toEqual(['p-2'])
      expect(poller.getSignals().map(s => s.requestId)).toEqual(['p-2'])
      expect(poller.hasSignal('cancel')).toBe(false)
      stop()
    })
  })

  describe('stop()', () => {
    it('clears interval timer', () => {
      const poller = makePoller(
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ signals: [] }) })
      )
      const stop = poller.pollSignals(() => {})
      stop()
      // No assertion needed — just verify no error on double stop
      poller.stop()
    })

    it('preserves pendingSignals after stop so coordinator can drain them', async () => {
      // stop() intentionally does NOT clear pendingSignals — a cancel/approval signal
      // received just before shutdown must remain readable by the coordinator loop.
      const poller = await seedByPoll([
        { type: 'cancel', requestId: OWN_CANCEL_ID, receivedAt: new Date().toISOString() },
        { type: 'pause', requestId: 'req-2', receivedAt: new Date().toISOString() },
      ])
      expect(poller.getSignals()).toHaveLength(2)

      poller.stop()

      expect(poller.getSignals()).toHaveLength(2)
    })
  })
})

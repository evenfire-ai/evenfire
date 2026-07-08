import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Signal } from '../../src/config-loader/types'
import { createStaticRuntimeTokenProvider } from '../../src/runtime-token-provider/provider'
import { SignalPoller } from '../../src/signal-poller/poller'
import { AUTH_RETRY_DELAY_MS } from '../../src/status-reporter/authRetry'

function makePoller(fetchMock?: ReturnType<typeof vi.fn>) {
  if (fetchMock) vi.stubGlobal('fetch', fetchMock)
  return new SignalPoller({
    wrcUrl: 'http://wrc:8082',
    workflowName: 'test-wf',
    tokenProvider: createStaticRuntimeTokenProvider({ wrcToken: 'tok' }),
    intervalMs: 60000, // high interval to avoid auto-polling in tests
  })
}

describe('SignalPoller', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('pushSignal()', () => {
    it('stores a signal', () => {
      const poller = makePoller()
      const signal: Signal = {
        type: 'cancel',
        requestId: 'r1',
        receivedAt: new Date().toISOString(),
      }
      poller.pushSignal(signal)
      expect(poller.getSignals()).toHaveLength(1)
      expect(poller.getSignals()[0].type).toBe('cancel')
    })

    it('deduplicates by requestId', () => {
      const poller = makePoller()
      const signal: Signal = {
        type: 'cancel',
        requestId: 'r1',
        receivedAt: new Date().toISOString(),
      }
      poller.pushSignal(signal)
      poller.pushSignal(signal)
      expect(poller.getSignals()).toHaveLength(1)
    })
  })

  describe('hasSignal()', () => {
    it('returns true when signal type exists', () => {
      const poller = makePoller()
      poller.pushSignal({
        type: 'pause',
        requestId: 'r1',
        receivedAt: new Date().toISOString(),
      })
      expect(poller.hasSignal('pause')).toBe(true)
    })

    it('returns false when signal type not present', () => {
      const poller = makePoller()
      expect(poller.hasSignal('cancel')).toBe(false)
    })
  })

  describe('consumeSignal()', () => {
    it('returns and removes signal of given type', () => {
      const poller = makePoller()
      poller.pushSignal({
        type: 'pause',
        requestId: 'r1',
        receivedAt: new Date().toISOString(),
      })
      const consumed = poller.consumeSignal('pause')
      expect(consumed?.requestId).toBe('r1')
      expect(poller.hasSignal('pause')).toBe(false)
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

    it('does not invoke callback for duplicate signals', async () => {
      const signal: Signal = {
        type: 'cancel',
        requestId: 'r1',
        receivedAt: new Date().toISOString(),
      }
      let callCount = 0
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ signals: [signal] }),
      })
      const poller = makePoller(fetchMock)
      // Pre-push signal to mark as seen
      poller.pushSignal(signal)

      const stop = poller.pollSignals(() => {
        callCount++
      })

      await new Promise(r => setTimeout(r, 50))
      expect(callCount).toBe(0)
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

    it('preserves pendingSignals after stop so coordinator can drain them', () => {
      // stop() intentionally does NOT clear pendingSignals — a cancel/approval signal
      // received just before shutdown must remain readable by the coordinator loop.
      const poller = makePoller()
      poller.pushSignal({
        type: 'cancel',
        requestId: 'req-1',
        receivedAt: new Date().toISOString(),
      })
      poller.pushSignal({ type: 'pause', requestId: 'req-2', receivedAt: new Date().toISOString() })
      expect(poller.getSignals()).toHaveLength(2)

      poller.stop()

      expect(poller.getSignals()).toHaveLength(2)
    })
  })
})

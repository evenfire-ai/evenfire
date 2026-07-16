/**
 * HeartbeatPoller unit tests — HCC consumes heartbeats from control-api's
 * InternalControl feed instead of verifying Host JWTs itself. Fake timers +
 * injected fetch: no real network, no real clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HeartbeatPoller,
  type HeartbeatPollerFetch,
  type HeartbeatPollerOptions,
  INITIAL_HEARTBEAT_LOOKBACK_MS,
} from '../src/heartbeatPoller'
import { HeartbeatPayload, HeartbeatVerdict } from '../src/statelessLifecycleTracker'
import { HostCRD } from '../src/types'

const POLL_MS = 10_000

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string> }
}

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> }

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function makeHost(name = 'stateless-host'): HostCRD {
  return {
    name,
    namespace: 'mcp-host',
    spec: {
      host: name,
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
    },
    status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
  }
}

function feedRow(overrides: Partial<HeartbeatPayload & { receivedAtMs: number }> = {}) {
  return {
    hostRef: 'stateless-host',
    podUid: 'pod-a',
    activeWork: false,
    conditions: {
      activeTask: false,
      awaitingApproval: false,
      pendingResults: false,
      activeCronSchedules: false,
    },
    lastActivityTs: 1_700_000_000_000,
    state: 'active',
    receivedAtMs: 1_700_000_030_000,
    ...overrides,
  }
}

function makeHarness(overrides: Partial<HeartbeatPollerOptions> = {}) {
  const calls: RecordedCall[] = []
  let responder: () => Promise<FakeResponse> = async () => jsonResponse(200, { heartbeats: [] })
  const fetchImpl: HeartbeatPollerFetch = async (url, init) => {
    calls.push({ url, init })
    return responder()
  }
  const verdicts: HeartbeatVerdict[] = []
  const tracker = {
    handleHeartbeat: vi.fn(async (_payload: HeartbeatPayload): Promise<HeartbeatVerdict> => {
      return verdicts.shift() ?? { drain: false }
    }),
    noteSuccessfulPoll: vi.fn(),
    stop: vi.fn(),
  }
  const host = makeHost()
  const getHost = vi.fn((hostRef: string) => (hostRef === host.name ? host : undefined))
  const markHostDraining = vi.fn(async () => {})
  const poller = new HeartbeatPoller({
    pollIntervalMs: POLL_MS,
    controlApiBaseUrl: 'http://control-api.control-plane.svc.cluster.local:8090',
    tracker,
    getHost,
    markHostDraining,
    signInternalControlJwt: () => 'internal-control-jwt',
    fetchImpl,
    ...overrides,
  })
  return {
    poller,
    calls,
    tracker,
    host,
    getHost,
    markHostDraining,
    setResponder(next: () => Promise<FakeResponse>): void {
      responder = next
    },
    queueVerdicts(...next: HeartbeatVerdict[]): void {
      verdicts.push(...next)
    },
    sinceOf(index: number): number {
      const url = new URL(calls[index].url)
      return Number(url.searchParams.get('since'))
    },
  }
}

describe('HeartbeatPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fails loud at construction on a bad interval or an empty base URL', () => {
    expect(() => makeHarness({ pollIntervalMs: 0 })).toThrow(/positive integer/)
    expect(() => makeHarness({ pollIntervalMs: 1.5 })).toThrow(/positive integer/)
    expect(() => makeHarness({ controlApiBaseUrl: '  ' })).toThrow(/CONTROL_API_BASE_URL/)
  })

  it('GETs the InternalControl feed with the signed JWT and a 5-minute initial lookback', async () => {
    const h = makeHarness()
    const t0 = Date.now()
    h.poller.start()

    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe(
      `http://control-api.control-plane.svc.cluster.local:8090/api/v1/auth/mcp-host/heartbeats?since=${
        t0 - INITIAL_HEARTBEAT_LOOKBACK_MS
      }`
    )
    expect(h.calls[0].init.method).toBe('GET')
    expect(h.calls[0].init.headers.Authorization).toBe('Bearer internal-control-jwt')

    h.poller.stop()
  })

  it('advances the since cursor to the poll start time ONLY on success', async () => {
    const h = makeHarness()
    const t0 = Date.now()
    h.poller.start()

    await vi.advanceTimersByTimeAsync(POLL_MS) // poll 1 (success)
    await vi.advanceTimersByTimeAsync(POLL_MS) // poll 2
    expect(h.sinceOf(1)).toBe(t0 + POLL_MS)

    // Poll 3 fails → poll 4 repeats poll 3's cursor.
    h.setResponder(async () => jsonResponse(500, {}))
    await vi.advanceTimersByTimeAsync(POLL_MS) // poll 3 (fails)
    h.setResponder(async () => jsonResponse(200, { heartbeats: [] }))
    await vi.advanceTimersByTimeAsync(POLL_MS) // poll 4
    expect(h.sinceOf(2)).toBe(t0 + 2 * POLL_MS)
    expect(h.sinceOf(3)).toBe(t0 + 2 * POLL_MS)

    h.poller.stop()
  })

  it('feeds rows into the tracker oldest-first regardless of feed order (podUid ordering intact)', async () => {
    const h = makeHarness()
    h.setResponder(async () =>
      jsonResponse(200, {
        heartbeats: [
          feedRow({ podUid: 'pod-b', receivedAtMs: 2_000 }),
          feedRow({ podUid: 'pod-a', receivedAtMs: 1_000 }),
        ],
      })
    )
    h.poller.start()
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(h.tracker.handleHeartbeat).toHaveBeenCalledTimes(2)
    expect(h.tracker.handleHeartbeat.mock.calls[0][0]).toMatchObject({ podUid: 'pod-a' })
    expect(h.tracker.handleHeartbeat.mock.calls[1][0]).toMatchObject({ podUid: 'pod-b' })
    // The tracker payload is reconstructed with schemaVersion 1.
    expect(h.tracker.handleHeartbeat.mock.calls[0][0]).toMatchObject({ schemaVersion: 1 })

    h.poller.stop()
  })

  it('persists a drain:true decision via the draining status write; drain:false writes nothing', async () => {
    const h = makeHarness()
    h.setResponder(async () =>
      jsonResponse(200, {
        heartbeats: [feedRow({ receivedAtMs: 1_000 }), feedRow({ receivedAtMs: 2_000 })],
      })
    )
    h.queueVerdicts({ drain: false }, { drain: true, entryWakeHandledGeneration: 4 })
    h.poller.start()
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(h.markHostDraining).toHaveBeenCalledTimes(1)
    // The AP-1 epoch the tracker decided with rides through unchanged.
    expect(h.markHostDraining).toHaveBeenCalledWith(h.host, 4)

    h.poller.stop()
  })

  it('a drain for an unknown Host skips the status write loudly and keeps processing', async () => {
    const h = makeHarness()
    h.setResponder(async () =>
      jsonResponse(200, { heartbeats: [feedRow({ hostRef: 'ghost-host' })] })
    )
    h.queueVerdicts({ drain: true, entryWakeHandledGeneration: 0 })
    h.poller.start()
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(h.markHostDraining).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ghost-host'))

    // The poll still counts as a success: the next poll advances the cursor.
    const firstSince = h.sinceOf(0)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.sinceOf(1)).toBeGreaterThan(firstSince)

    h.poller.stop()
  })

  it('a failing draining status write is logged loudly and does not stop the poller', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(200, { heartbeats: [feedRow()] }))
    h.queueVerdicts(
      { drain: true, entryWakeHandledGeneration: 0 },
      { drain: true, entryWakeHandledGeneration: 0 }
    )
    h.markHostDraining.mockRejectedValueOnce(new Error('status write conflict'))
    h.poller.start()

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('draining status write failed'),
      expect.any(Error)
    )

    // Next poll retries the write.
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.markHostDraining).toHaveBeenCalledTimes(2)

    h.poller.stop()
  })

  it('reports feed health to the tracker ONLY on a fully-successful poll (FIX 4 seam)', async () => {
    const h = makeHarness()
    h.poller.start()
    // Successful (empty) poll → the tracker learns the feed is flowing.
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.tracker.noteSuccessfulPoll).toHaveBeenCalledTimes(1)
    expect(h.tracker.noteSuccessfulPoll).toHaveBeenCalledWith(POLL_MS)
    // Failing poll → NOT reported: a dead feed must never look healthy.
    h.setResponder(async () => jsonResponse(500, {}))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.tracker.noteSuccessfulPoll).toHaveBeenCalledTimes(1)
    // Malformed row fails the WHOLE poll → NOT reported either.
    h.setResponder(async () => jsonResponse(200, { heartbeats: [{ bogus: true }] }))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.tracker.noteSuccessfulPoll).toHaveBeenCalledTimes(1)

    h.poller.stop()
  })

  it('poll failures (HTTP error / rejecting fetch) log rate-limited and never stop the loop', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(503, {}))
    h.poller.start()

    // 5 failing polls inside the 60s suppression window → exactly one log.
    await vi.advanceTimersByTimeAsync(5 * POLL_MS)
    expect(h.calls).toHaveLength(5)
    expect(console.error).toHaveBeenCalledTimes(1)

    // Past the window the failure is re-logged; the poller keeps going.
    await vi.advanceTimersByTimeAsync(2 * POLL_MS)
    expect(h.calls).toHaveLength(7)
    expect(console.error).toHaveBeenCalledTimes(2)

    h.setResponder(async () => {
      throw new Error('ECONNREFUSED')
    })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.calls).toHaveLength(8)

    h.poller.stop()
  })

  it('a malformed feed row fails the WHOLE poll loudly: no partial apply, cursor not advanced', async () => {
    const h = makeHarness()
    h.setResponder(async () =>
      jsonResponse(200, {
        heartbeats: [feedRow(), feedRow({ state: 'sleeping' as never })],
      })
    )
    h.poller.start()

    const t0 = Date.now()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.tracker.handleHeartbeat).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledTimes(1)

    // Cursor stayed put.
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.sinceOf(1)).toBe(h.sinceOf(0))
    expect(t0).toBeGreaterThan(0)

    h.poller.stop()
  })

  it('a response without a heartbeats array is a contract breach, not an empty poll', async () => {
    const h = makeHarness()
    h.setResponder(async () => jsonResponse(200, { rows: [] }))
    h.poller.start()

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(console.error).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.sinceOf(1)).toBe(h.sinceOf(0))

    h.poller.stop()
  })

  it('stop() cancels the pending poll', async () => {
    const h = makeHarness()
    h.poller.start()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(h.calls).toHaveLength(1)

    h.poller.stop()
    await vi.advanceTimersByTimeAsync(10 * POLL_MS)
    expect(h.calls).toHaveLength(1)
  })
})

describe('parseHeartbeatPollMs (config load validation)', () => {
  it('returns the 10s default when unset or empty', async () => {
    const { parseHeartbeatPollMs } = await import('../src/config')
    expect(parseHeartbeatPollMs(undefined)).toBe(10_000)
    expect(parseHeartbeatPollMs('')).toBe(10_000)
    expect(parseHeartbeatPollMs('   ')).toBe(10_000)
  })

  it('parses an explicitly-set positive integer', async () => {
    const { parseHeartbeatPollMs } = await import('../src/config')
    expect(parseHeartbeatPollMs('5000')).toBe(5_000)
    expect(parseHeartbeatPollMs('1')).toBe(1)
  })

  it('fails config load loudly on garbage values', async () => {
    const { parseHeartbeatPollMs } = await import('../src/config')
    for (const bad of ['banana', '0', '-5', '1.5', '10s', 'NaN', 'Infinity']) {
      expect(() => parseHeartbeatPollMs(bad)).toThrow(/positive integer/)
    }
  })
})

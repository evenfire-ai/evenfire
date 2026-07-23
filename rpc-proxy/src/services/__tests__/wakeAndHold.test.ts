import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import type { ResolvedServerConnection, RpcAccessClaims, RpcScope } from '../../types.js'
import type { HostWakeApiResponse } from '../controlApiRestService.js'
import {
  WakeAndHoldCoordinator,
  type WakeCoordinatorDeps,
  isHostDownNetworkError,
  isHostDrainingError,
  respondWithWakeAndHold,
} from '../wakeAndHold.js'

const HOST: ResolvedServerConnection = {
  name: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
  headers: {},
}

const MAX_HOLD_MS = 90_000
const POLL_MS = 2_000
const RETRIGGER_MS = 15_000

function makeCoordinator(overrides?: Partial<WakeCoordinatorDeps>): {
  coordinator: WakeAndHoldCoordinator
  requestWake: ReturnType<typeof vi.fn>
  probeReady: ReturnType<typeof vi.fn>
} {
  const requestWake = vi.fn()
  const probeReady = vi.fn()
  const coordinator = new WakeAndHoldCoordinator({
    requestWake,
    probeReady,
    maxHoldMs: MAX_HOLD_MS,
    pollMs: POLL_MS,
    retriggerMs: RETRIGGER_MS,
    maxTrackedCoordinations: 1_000,
    ...overrides,
  })
  return { coordinator, requestWake, probeReady }
}

// Wake-capable by default (§11.2): the branch-matrix below asserts a wake IS
// triggered, which now requires the caller to carry host:wake:write + the
// target hostRef. `tokenExpMs` drives claims.exp so the token-TTL cases still
// exercise the hold budget.
function holdClaims(hostRef: string, tokenExpMs: number, scopes?: RpcScope[]): RpcAccessClaims {
  return {
    sub: 'user-1',
    typ: 'user',
    accessScope: 'team',
    teamId: 'team-1',
    scopes: scopes ?? ['host:wake:write', 'host:message:invoke'],
    hostRefs: [hostRef],
    jti: 'jti-1',
    iat: 1,
    exp: Math.floor(tokenExpMs / 1000),
  }
}

function holdParams(overrides?: { hostRef?: string; tokenExpMs?: number; scopes?: RpcScope[] }) {
  const hostRef = overrides?.hostRef ?? 'chatllm'
  const tokenExpMs = overrides?.tokenExpMs ?? Date.now() + 3_600_000
  return {
    hostRef,
    host: HOST,
    claims: holdClaims(hostRef, tokenExpMs, overrides?.scopes),
    rpcAccessToken: 'rpc-token',
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>
let debugSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0) // no dangling timers, ever
  vi.useRealTimers()
  warnSpy.mockRestore()
  debugSpy.mockRestore()
})

describe('WakeAndHoldCoordinator branch matrix', () => {
  it('200 active resolves proceed immediately without any hold loop', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'active', wakeGeneration: null })

    const outcome = await coordinator.hold(holdParams())

    expect(outcome).toEqual({ kind: 'proceed', lastKnownState: 'active' })
    expect(requestWake).toHaveBeenCalledTimes(1)
    expect(requestWake).toHaveBeenCalledWith('chatllm', 'rpc-token')
    expect(probeReady).not.toHaveBeenCalled()
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('200 active with wakeGeneration (drain-cancel) also resolves proceed immediately', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'active', wakeGeneration: 7 })

    const outcome = await coordinator.hold(holdParams())

    expect(outcome.kind).toBe('proceed')
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('202 wake-requested holds, polls readiness, and proceeds when the host is up', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 3 })
    probeReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(POLL_MS) // first probe: not ready
    expect(probeReady).toHaveBeenCalledTimes(1)
    expect(coordinator.trackedCoordinationCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(POLL_MS) // second probe: ready

    const outcome = await pending
    expect(outcome).toEqual({ kind: 'proceed', lastKnownState: 'wake-requested' })
    expect(probeReady).toHaveBeenCalledTimes(2)
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('409 not-stateless resolves legacy (today error path)', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'not-stateless' })

    const outcome = await coordinator.hold(holdParams())

    expect(outcome).toEqual({ kind: 'legacy', reason: 'not-stateless' })
  })

  it('404 unknown resolves not-found', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'unknown' })

    const outcome = await coordinator.hold(holdParams())

    expect(outcome).toEqual({ kind: 'not-found' })
  })

  it('429 rate-limited resolves waking with the control-api Retry-After respected', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'rate-limited', retryAfterSeconds: 30 })

    const outcome = await coordinator.hold(holdParams())

    expect(outcome).toEqual({
      kind: 'waking',
      retryAfterMs: 30_000,
      reason: 'wake-rate-limited',
      lastKnownState: 'unknown',
    })
  })

  it('wake endpoint failure on the initial call resolves legacy, never hangs', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockRejectedValue(new Error('control-api unreachable'))

    const outcome = await coordinator.hold(holdParams())

    expect(outcome).toEqual({ kind: 'legacy', reason: 'wake-endpoint-unreachable' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })
})

describe('bounded hold', () => {
  it('expires at maxHoldMs with a waking outcome and diagnostics, never exceeding the bound', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(false)

    const pending = coordinator.hold(holdParams())
    let resolved = false
    void pending.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - 1)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const outcome = await pending
    expect(outcome).toEqual({
      kind: 'waking',
      retryAfterMs: POLL_MS,
      reason: 'max-hold-exceeded',
      lastKnownState: 'wake-requested',
    })
    // Waiter release evicts the whole entry: no residual poll/retrigger/TTL timers.
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })
})

describe('token TTL', () => {
  it('aborts the hold before the rpc token expires, without any forward', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(false)

    // Token expires in 10s: hold budget = 10s - 2s safety margin = 8s.
    const pending = coordinator.hold(holdParams({ tokenExpMs: Date.now() + 10_000 }))
    await vi.advanceTimersByTimeAsync(8_000)

    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'waking', reason: 'token-expiring' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('rejects an already-expiring token synchronously without calling the wake endpoint', async () => {
    const { coordinator, requestWake } = makeCoordinator()

    const outcome = await coordinator.hold(holdParams({ tokenExpMs: Date.now() + 1_000 }))

    expect(outcome).toMatchObject({ kind: 'waking', reason: 'token-expiring' })
    expect(requestWake).not.toHaveBeenCalled()
  })
})

describe('local dedup', () => {
  it('N concurrent holds for one host share one wake call and one poll loop, all released on ready', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const pendings = [
      coordinator.hold(holdParams()),
      coordinator.hold(holdParams()),
      coordinator.hold(holdParams()),
    ]
    expect(coordinator.trackedCoordinationCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(POLL_MS) // shared probe #1
    expect(probeReady).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MS) // shared probe #2 → ready

    const outcomes = await Promise.all(pendings)
    for (const outcome of outcomes) {
      expect(outcome.kind).toBe('proceed')
    }
    expect(requestWake).toHaveBeenCalledTimes(1)
    expect(probeReady).toHaveBeenCalledTimes(2)
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('evicts the oldest host loudly when the tracked-host cap is exceeded', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator({ maxTrackedCoordinations: 2 })
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(false)

    const first = coordinator.hold(holdParams({ hostRef: 'host-a' }))
    await vi.advanceTimersByTimeAsync(1)
    const second = coordinator.hold(holdParams({ hostRef: 'host-b' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(coordinator.trackedCoordinationCount()).toBe(2)

    const third = coordinator.hold(holdParams({ hostRef: 'host-c' }))

    const firstOutcome = await first
    expect(firstOutcome).toMatchObject({ kind: 'waking', reason: 'capacity-evicted' })
    expect(coordinator.trackedCoordinationCount()).toBe(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('wake-hold capacity exceeded'))

    // Release the survivors so afterEach can assert zero dangling timers.
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)
    await Promise.all([second, third])
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('waiter-deadline expiry evicts an empty entry (TTL semantics), stopping all loops', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(false)

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)
    await pending

    expect(coordinator.trackedCoordinationCount()).toBe(0)
    // Poll/retrigger loops stopped with the entry: advancing time makes no calls.
    const probeCalls = probeReady.mock.calls.length
    const wakeCalls = requestWake.mock.calls.length
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS * 2)
    expect(probeReady.mock.calls.length).toBe(probeCalls)
    expect(requestWake.mock.calls.length).toBe(wakeCalls)
  })
})

describe('kill-switch and poll-source failure while held', () => {
  it('re-triggers the wake every retriggerMs while holding', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(false)

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS + POLL_MS)
    expect(requestWake).toHaveBeenCalledTimes(2) // initial + one retrigger

    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)
    await pending
  })

  it('skips a retrigger whose wake authorization has expired, keeps holding, and does not settle', async () => {
    // Drive the guard through the class's OWN injectable clock (deps.now, read
    // via this.now()) rather than mutating global time. That is how the rest of
    // this suite controls time, and it keeps the guard's predicate observable
    // without a wall-clock side effect.
    let clockMs = Date.now()
    const { coordinator, requestWake, probeReady } = makeCoordinator({ now: () => clockMs })
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(false)

    const tokenExpMs = clockMs + 60_000
    const pending = coordinator.hold(holdParams({ tokenExpMs }))
    expect(requestWake).toHaveBeenCalledTimes(1) // initial wake only

    // Drive the guard's precondition: the retrigger tick lands AFTER the wake
    // authorization expired. Advancing the injected clock without advancing the
    // timer queue models a blocked event loop / scheduler delay — the entry is
    // still unsettled and holding, but its token is now inside the safety margin.
    clockMs = tokenExpMs - 1_000
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS)

    // The doomed POST is NOT spent...
    expect(requestWake).toHaveBeenCalledTimes(1)
    // ...and the hold survives: the entry is still tracked, not settled, so the
    // readiness poll can still release this waiter.
    expect(coordinator.trackedCoordinationCount()).toBe(1)

    // Drain: let the hold reach its deadline so the pending promise resolves.
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)
    await pending
  })

  it('releases held requests via the legacy path when the wake endpoint turns 409 mid-hold', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake
      .mockResolvedValueOnce({ kind: 'wake-requested', wakeGeneration: 1 } as HostWakeApiResponse)
      .mockResolvedValueOnce({ kind: 'not-stateless' } as HostWakeApiResponse)
    probeReady.mockResolvedValue(false)

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS)

    const outcome = await pending
    expect(outcome).toEqual({ kind: 'legacy', reason: 'not-stateless' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('releases held requests when the host becomes ready mid-hold', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)

    const outcome = await pending
    expect(outcome.kind).toBe('proceed')
  })

  it('a persistently erroring poll source still resolves waking at the deadline, never hangs', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockRejectedValue(new Error('status endpoint exploded'))

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)

    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'waking', reason: 'max-hold-exceeded' })
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('a failing retrigger keeps the hold alive until the deadline instead of crashing it', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake
      .mockResolvedValueOnce({ kind: 'wake-requested', wakeGeneration: 1 } as HostWakeApiResponse)
      .mockRejectedValue(new Error('control-api blip'))
    probeReady.mockResolvedValue(false)

    const pending = coordinator.hold(holdParams())
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS)

    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'waking', reason: 'max-hold-exceeded' })
  })
})

describe('host error classification', () => {
  it('detects the mcp-host DRAINING fence by name/status/body, not class identity', () => {
    const draining = Object.assign(new Error('Upstream host returned 503'), {
      name: 'UpstreamHostError',
      status: 503,
      bodySnippet: '{"code":"host_draining"}',
    })
    expect(isHostDrainingError(draining)).toBe(true)

    const plain503 = Object.assign(new Error('Upstream host returned 503'), {
      name: 'UpstreamHostError',
      status: 503,
      bodySnippet: '{"error":"busy"}',
    })
    expect(isHostDrainingError(plain503)).toBe(false)
  })

  it('detects network-level host-down failures and excludes AbortError and HTTP answers', () => {
    expect(isHostDownNetworkError(new TypeError('fetch failed'))).toBe(true)
    const withCause = new Error('request failed')
    ;(withCause as Error & { cause?: { code: string } }).cause = { code: 'ECONNREFUSED' }
    expect(isHostDownNetworkError(withCause)).toBe(true)

    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isHostDownNetworkError(abort)).toBe(false)

    const upstream = Object.assign(new Error('Upstream host returned 500'), {
      name: 'UpstreamHostError',
      status: 500,
      bodySnippet: '',
    })
    expect(isHostDownNetworkError(upstream)).toBe(false)
  })
})

describe('post-resolution re-forward hardening (respondWithWakeAndHold)', () => {
  type FakeRes = {
    headersSent: boolean
    statusCode: number
    body: unknown
    headers: Record<string, string>
    setHeader: (name: string, value: string) => void
    status: (code: number) => FakeRes
    json: (payload: unknown) => FakeRes
  }

  function makeRes(): FakeRes {
    const res: FakeRes = {
      headersSent: false,
      statusCode: 0,
      body: undefined,
      headers: {},
      setHeader(name: string, value: string) {
        res.headers[name] = value
      },
      status(code: number) {
        res.statusCode = code
        return res
      },
      json(payload: unknown) {
        if (res.headersSent) {
          throw new Error('Cannot set headers after they are sent to the client')
        }
        res.headersSent = true
        res.body = payload
        return res
      },
    }
    return res
  }

  function upstreamDrainingError(): Error {
    return Object.assign(new Error('Upstream host returned 503'), {
      name: 'UpstreamHostError',
      status: 503,
      bodySnippet: '{"code":"host_draining"}',
    })
  }

  function respondOptions(
    coordinator: WakeAndHoldCoordinator,
    res: FakeRes,
    attemptUpstream: () => Promise<void>,
    overrides?: {
      hostRef?: string
      host?: ResolvedServerConnection
      respondLegacy?: (error: unknown) => void
    }
  ) {
    const hostRef = overrides?.hostRef ?? 'chatllm'
    return {
      res: res as unknown as ExpressResponse,
      hostRef,
      host: overrides?.host ?? HOST,
      claims: holdClaims(hostRef, Date.now() + 3_600_000),
      rpcAccessToken: 'rpc-token',
      attemptUpstream,
      respondLegacy:
        overrides?.respondLegacy ??
        ((_error: unknown) => {
          res.status(502).json({ error: 'Upstream host unavailable' })
        }),
      coordinator,
    }
  }

  it('(a) after a held request resolves 200, advancing every timer window forwards NOTHING further', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const res = makeRes()
    const attemptUpstream = vi.fn(async () => {
      res.status(200).json({ success: true, taskId: 't-1' })
    })
    const pending = respondWithWakeAndHold(respondOptions(coordinator, res, attemptUpstream))

    await vi.advanceTimersByTimeAsync(POLL_MS * 2) // probe #2 ready -> proceed -> forward
    await pending
    expect(attemptUpstream).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(coordinator.trackedCoordinationCount()).toBe(0)

    const wakeCalls = requestWake.mock.calls.length
    const probeCalls = probeReady.mock.calls.length
    // Way past every poll, retrigger, entry-TTL, and max-hold window.
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS * 3)
    expect(attemptUpstream).toHaveBeenCalledTimes(1) // ZERO further upstream forwards
    expect(requestWake.mock.calls.length).toBe(wakeCalls)
    expect(probeReady.mock.calls.length).toBe(probeCalls)
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('(b) after a terminal (non-availability) failure resolves the request, no artifact re-forwards', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    probeReady.mockResolvedValue(true)

    const res = makeRes()
    const attemptUpstream = vi.fn(async () => {
      // Host answered but errored: today's terminal legacy path (never retried).
      throw Object.assign(new Error('Upstream host returned 500'), {
        name: 'UpstreamHostError',
        status: 500,
        bodySnippet: '{"error":"boom"}',
      })
    })
    const respondLegacy = vi.fn((_error: unknown) => {
      res.status(502).json({ error: 'Upstream host unavailable' })
    })
    const pending = respondWithWakeAndHold(
      respondOptions(coordinator, res, attemptUpstream, { respondLegacy })
    )

    await vi.advanceTimersByTimeAsync(POLL_MS) // probe ready -> proceed -> failing forward
    await pending
    expect(attemptUpstream).toHaveBeenCalledTimes(1)
    expect(respondLegacy).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(502)
    expect(coordinator.trackedCoordinationCount()).toBe(0)

    const wakeCalls = requestWake.mock.calls.length
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS * 3)
    expect(attemptUpstream).toHaveBeenCalledTimes(1) // terminal failure stays terminal
    expect(requestWake.mock.calls.length).toBe(wakeCalls)
  })

  it('(c) an unresolved proceed still walks the short retry schedule exactly as today', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'active', wakeGeneration: null })

    const res = makeRes()
    const attemptUpstream = vi
      .fn()
      .mockRejectedValueOnce(upstreamDrainingError()) // immediate attempt still fenced
      .mockRejectedValueOnce(upstreamDrainingError()) // 250ms later still fenced
      .mockImplementationOnce(async () => {
        res.status(200).json({ success: true, taskId: 't-3' })
      })
    const pending = respondWithWakeAndHold(respondOptions(coordinator, res, attemptUpstream))

    await vi.advanceTimersByTimeAsync(1_250) // 0ms + 250ms + 1000ms schedule
    await pending
    expect(attemptUpstream).toHaveBeenCalledTimes(3) // pre-resolution retries are the feature
    expect(res.statusCode).toBe(200)
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('(d) two concurrent holds for different hosts do not cross-cancel each other', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'wake-requested', wakeGeneration: 1 })
    const HOST_A: ResolvedServerConnection = {
      name: 'host-a',
      url: 'http://host-a:8080',
      headers: {},
    }
    const HOST_B: ResolvedServerConnection = {
      name: 'host-b',
      url: 'http://host-b:8080',
      headers: {},
    }
    let readyB = false
    probeReady.mockImplementation(async (host: ResolvedServerConnection) =>
      host.name === 'host-a' ? true : readyB
    )

    const resA = makeRes()
    const resB = makeRes()
    const attemptA = vi.fn(async () => {
      resA.status(200).json({ success: true, taskId: 'a-1' })
    })
    const attemptB = vi.fn(async () => {
      resB.status(200).json({ success: true, taskId: 'b-1' })
    })
    const pendingA = respondWithWakeAndHold(
      respondOptions(coordinator, resA, attemptA, { hostRef: 'host-a', host: HOST_A })
    )
    const pendingB = respondWithWakeAndHold(
      respondOptions(coordinator, resB, attemptB, { hostRef: 'host-b', host: HOST_B })
    )

    await vi.advanceTimersByTimeAsync(POLL_MS) // A's first probe is ready -> A resolves
    await pendingA
    expect(attemptA).toHaveBeenCalledTimes(1)
    expect(resA.statusCode).toBe(200)
    // B is untouched by A's resolution: still held, still polling/retriggering.
    expect(attemptB).not.toHaveBeenCalled()
    expect(resB.headersSent).toBe(false)
    expect(coordinator.trackedCoordinationCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(RETRIGGER_MS)
    const wakeCallsForB = requestWake.mock.calls.filter(call => call[0] === 'host-b').length
    expect(wakeCallsForB).toBe(2) // initial + one retrigger: B's loops survived A's settle

    readyB = true
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await pendingB
    expect(attemptB).toHaveBeenCalledTimes(1)
    expect(resB.statusCode).toBe(200)
    expect(attemptA).toHaveBeenCalledTimes(1) // and B's resolution never re-forwarded A
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('incident shape: a wake-eligible error thrown AFTER the 200 was committed never re-forwards', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    requestWake.mockResolvedValue({ kind: 'active', wakeGeneration: null })

    const res = makeRes()
    // The upstream POST is delivered and the caller's 200 committed, then the
    // attempt throws an error the classifier would call "host down/draining".
    const attemptUpstream = vi.fn(async () => {
      res.status(200).json({ success: true, taskId: 't-dup' })
      throw upstreamDrainingError()
    })
    const pending = respondWithWakeAndHold(respondOptions(coordinator, res, attemptUpstream))

    await vi.advanceTimersByTimeAsync(5_000) // past the whole 0/250/1000ms schedule
    await pending
    expect(attemptUpstream).toHaveBeenCalledTimes(1) // the duplicate-delivery bug: exactly one forward
    expect(res.statusCode).toBe(200)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('wake-hold post-response failure suppressed')
    )
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('refuses to park a request whose response is already committed, loudly and without waking', async () => {
    const { coordinator, requestWake } = makeCoordinator()
    const res = makeRes()
    res.status(200).json({ success: true })
    const attemptUpstream = vi.fn(async () => {})

    await respondWithWakeAndHold(respondOptions(coordinator, res, attemptUpstream))

    expect(requestWake).not.toHaveBeenCalled()
    expect(attemptUpstream).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('wake-hold refused: response already committed')
    )
    expect(coordinator.trackedCoordinationCount()).toBe(0)
  })

  it('a readiness probe landing after resolution no-ops loudly instead of re-settling', async () => {
    const { coordinator, requestWake, probeReady } = makeCoordinator()
    requestWake
      .mockResolvedValueOnce({ kind: 'wake-requested', wakeGeneration: 1 } as HostWakeApiResponse)
      .mockResolvedValue({ kind: 'active', wakeGeneration: 1 } as HostWakeApiResponse)
    let resolveProbe: ((ready: boolean) => void) | null = null
    probeReady.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          resolveProbe = resolve
        })
    )

    const res = makeRes()
    const attemptUpstream = vi.fn(async () => {
      res.status(200).json({ success: true, taskId: 't-late' })
    })
    const pending = respondWithWakeAndHold(respondOptions(coordinator, res, attemptUpstream))

    await vi.advanceTimersByTimeAsync(POLL_MS) // probe #1 starts and hangs
    await vi.advanceTimersByTimeAsync(RETRIGGER_MS - POLL_MS) // retrigger: active -> settle proceed
    await pending
    expect(attemptUpstream).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(coordinator.trackedCoordinationCount()).toBe(0)

    // The in-flight probe finally lands AFTER resolution: loud no-op, no re-forward.
    expect(resolveProbe).not.toBeNull()
    resolveProbe!(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(attemptUpstream).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('late wake-hold artifact ignored (already resolved)')
    )
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('artifact=readiness-probe'))
  })
})

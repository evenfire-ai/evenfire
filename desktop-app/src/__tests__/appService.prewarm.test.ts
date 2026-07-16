import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// ── import after mocks are set up ─────────────────────────────────────────────

import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

// ── mock dependencies before AppService is imported ──────────────────────────

vi.mock('../config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

const mockGetOrIssue = vi.fn()
const mockRpcTokenManagerClear = vi.fn()
const mockRpcTokenManagerGetMetadata = vi.fn()

vi.mock('../rpcTokenManager.js', () => ({
  RpcTokenManager: class {
    getOrIssue = mockGetOrIssue
    clear = mockRpcTokenManagerClear
    getMetadata = mockRpcTokenManagerGetMetadata
  },
}))

const mockPrewarmHost = vi.fn()
const mockOpenHostStatusStream = vi.fn()
const mockHealth = vi.fn().mockResolvedValue({ status: 'ok' })

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    health = mockHealth
    prewarmHost = mockPrewarmHost
    openHostStatusStream = mockOpenHostStatusStream
  },
}))

vi.mock('../authClient.js', () => ({
  AuthClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    getMe = vi.fn()
  },
}))

vi.mock('../tokenStore.js', () => ({
  TokenStore: class {
    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    clearSessionToken = vi.fn()
  },
}))

// ── helpers ───────────────────────────────────────────────────────────────────

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
  ;(svc as unknown as { me: unknown }).me = { id: 1, teamId: 'team-1' }
  return svc
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AppService.prewarmHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrIssue.mockResolvedValue({ token: 'rpc-token' })
    mockRpcTokenManagerGetMetadata.mockReturnValue({
      expiresAtMs: null,
      scopes: [],
      hostRefs: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('POSTs the wake exactly once with the message-path RPC token and returns the terminal status', async () => {
    // 'active' is loop-free; the 202 re-emission cadence has its own suite.
    mockPrewarmHost.mockResolvedValue({ status: 'active' })
    const svc = makeService()

    const result = await svc.prewarmHost('chatllm', ['chatllm'])

    expect(result).toEqual({ requested: true, status: 'active' })
    expect(mockGetOrIssue).toHaveBeenCalledTimes(1)
    expect(mockGetOrIssue).toHaveBeenCalledWith(
      'session-token',
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['chatllm']
    )
    expect(mockPrewarmHost).toHaveBeenCalledTimes(1)
    expect(mockPrewarmHost).toHaveBeenCalledWith('rpc-token', 'chatllm')
  })

  it('cooldown: a re-open inside the window makes no HTTP call; after the window it fires again', async () => {
    vi.useFakeTimers()
    // 'active' is loop-free; the 202 re-emission cadence has its own suite.
    mockPrewarmHost.mockResolvedValue({ status: 'active' })
    const svc = makeService()

    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: true,
      status: 'active',
    })
    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: false,
      skipped: 'cooldown',
    })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(1)

    // A different host is not affected by chatllm's cooldown.
    await expect(svc.prewarmHost('other-host')).resolves.toEqual({
      requested: true,
      status: 'active',
    })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(60_001)
    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: true,
      status: 'active',
    })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)
  })

  it('409 not-stateless is a terminal success, not a failure', async () => {
    mockPrewarmHost.mockResolvedValue({ status: 'not-stateless' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    await expect(svc.prewarmHost('always-on')).resolves.toEqual({
      requested: true,
      status: 'not-stateless',
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('failure: warn-logged with hostRef + reason, structured result, no throw, token never logged', async () => {
    mockPrewarmHost.mockRejectedValue(
      new ApiError('Prewarm failed (404): host not found', 404, 'host not found')
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    const result = await svc.prewarmHost('missing-host')

    expect(result.requested).toBe(false)
    expect(result.error).toContain('404')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = warnSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(logged).toContain('missing-host')
    expect(logged).toContain('404')
    expect(logged).not.toContain('rpc-token')
    expect(logged).not.toContain('session-token')
    warnSpy.mockRestore()
  })

  it('a failed attempt is NOT silently retried inside the cooldown window', async () => {
    mockPrewarmHost.mockRejectedValue(new ApiError('Prewarm failed (503): boom', 503, 'boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    const first = await svc.prewarmHost('chatllm')
    expect(first.requested).toBe(false)
    expect(first.error).toContain('503')

    const second = await svc.prewarmHost('chatllm')
    expect(second).toEqual({ requested: false, skipped: 'cooldown' })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('rejects an empty hostRef', async () => {
    const svc = makeService()
    await expect(svc.prewarmHost('')).rejects.toThrow('hostRef is required')
    expect(mockPrewarmHost).not.toHaveBeenCalled()
  })
})

describe('AppService.prewarmHost — bounded wake re-emission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockGetOrIssue.mockResolvedValue({ token: 'rpc-token' })
    mockRpcTokenManagerGetMetadata.mockReturnValue({
      expiresAtMs: null,
      scopes: [],
      hostRefs: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('202→202→200: exactly three POSTs, stops on the 200 acknowledgment', async () => {
    mockPrewarmHost
      .mockResolvedValueOnce({ status: 'wake-requested' })
      .mockResolvedValueOnce({ status: 'wake-requested' })
      .mockResolvedValueOnce({ status: 'active' })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: true,
      status: 'wake-requested',
    })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)

    // Every re-emit reuses the invocation's token and hostRef.
    expect(mockPrewarmHost.mock.calls[1]).toEqual(['rpc-token', 'chatllm'])
    expect(mockPrewarmHost.mock.calls[2]).toEqual(['rpc-token', 'chatllm'])

    // Acknowledged by 200 active — nothing further is ever scheduled.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(50_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)
    expect(warnSpy).not.toHaveBeenCalled()

    const infoLogged = infoSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(infoLogged).toContain('host=chatllm')
    expect(infoLogged).toContain('attempt=1')
    expect(infoLogged).toContain('attempt=2')
    expect(infoLogged).not.toContain('rpc-token')
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('202 then active on the first re-emit: exactly two POSTs', async () => {
    mockPrewarmHost
      .mockResolvedValueOnce({ status: 'wake-requested' })
      .mockResolvedValueOnce({ status: 'active' })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const svc = makeService()

    await svc.prewarmHost('chatllm')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)
    infoSpy.mockRestore()
  })

  it('immediate 200 or 409 schedules no re-emission at all', async () => {
    mockPrewarmHost.mockResolvedValueOnce({ status: 'active' })
    const svc = makeService()
    await svc.prewarmHost('hot-host')

    mockPrewarmHost.mockResolvedValueOnce({ status: 'not-stateless' })
    await svc.prewarmHost('always-on')

    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)
  })

  it('bounded give-up: persistent 202 ends after the bounded re-emits with a loud warn, no further POST', async () => {
    mockPrewarmHost.mockResolvedValue({ status: 'wake-requested' })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    await svc.prewarmHost('chatllm')
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warnLogged = warnSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(warnLogged).toContain('host=chatllm')
    expect(warnLogged).toContain('reactive message path')
    expect(warnLogged).not.toContain('rpc-token')

    // Loop is over: no pending timers, no fourth POST ever.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('a re-emit error stops the loop with a warn and no further attempts', async () => {
    mockPrewarmHost
      .mockResolvedValueOnce({ status: 'wake-requested' })
      .mockRejectedValueOnce(new ApiError('Prewarm failed (503): boom', 503, 'boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: true,
      status: 'wake-requested',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)

    const warnLogged = warnSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(warnLogged).toContain('re-emit failed host=chatllm')
    expect(warnLogged).toContain('503')
    expect(warnLogged).not.toContain('rpc-token')

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  it('re-emits never consult or refresh the cooldown window', async () => {
    mockPrewarmHost.mockResolvedValue({ status: 'wake-requested' })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    await svc.prewarmHost('chatllm') // t=0: POST 1, cooldown recorded
    await vi.advanceTimersByTimeAsync(10_000) // t=10s: re-emit 1 (POST 2)
    await vi.advanceTimersByTimeAsync(10_000) // t=20s: re-emit 2 (POST 3), loop gives up
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)

    // The cooldown window runs from the ORIGINAL invocation (t=0), not from
    // the last re-emit (t=20s). At t=60.001s a new user open must fire.
    await vi.advanceTimersByTimeAsync(40_001)
    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: true,
      status: 'wake-requested',
    })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(4)

    // Drain the new invocation's loop so the test ends with no timers.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(0)
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('single loop per hostRef even if the cooldown entry is evicted (in-flight guard)', async () => {
    mockPrewarmHost.mockResolvedValue({ status: 'wake-requested' })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = makeService()

    await svc.prewarmHost('chatllm') // loop active
    // Simulate the bounded cooldown map evicting this host's entry while the
    // re-emission loop is still running.
    ;(
      svc as unknown as { prewarmAttemptAtByHostRef: Map<string, number> }
    ).prewarmAttemptAtByHostRef.clear()

    await expect(svc.prewarmHost('chatllm')).resolves.toEqual({
      requested: false,
      skipped: 'in-flight',
    })
    expect(mockPrewarmHost).toHaveBeenCalledTimes(1)

    // Only the ORIGINAL loop's two re-emits run — a second loop never spawned.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockPrewarmHost).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('AppService host status stream — ANTI-FLAP invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrIssue.mockResolvedValue({ token: 'rpc-token' })
    mockRpcTokenManagerGetMetadata.mockReturnValue({
      expiresAtMs: null,
      scopes: [],
      hostRefs: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('an auth-expired stream drop and its automatic reconnects NEVER call the wake route', async () => {
    vi.useFakeTimers()
    // Simulate rpc-proxy closing the stream with auth-expired (the ~300s RPC
    // token TTL) — the stream then resolves, which appService treats as a
    // disconnect and schedules an automatic reconnect.
    mockOpenHostStatusStream.mockImplementation(
      async (
        _token: string,
        _hostRef: string,
        onSse: (frame: { event: string; data: unknown }) => void
      ) => {
        onSse({ event: 'auth-expired', data: { message: 'RPC token expired' } })
      }
    )
    const svc = makeService()
    const events: unknown[] = []

    svc.startHostStatusStream('stream-1', 7, 'chatllm', ['chatllm'], event => {
      events.push(event)
    })

    // Flush the initial connect, then cross several backoff windows so the
    // stream reconnects automatically at least twice.
    await vi.advanceTimersByTimeAsync(0)
    expect(mockOpenHostStatusStream).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockOpenHostStatusStream.mock.calls.length).toBeGreaterThanOrEqual(2)

    // THE INVARIANT: the stream lifecycle (including token-expiry reconnects)
    // never wakes a suspended host. If someone wires prewarm into the stream
    // connect path, this fails.
    expect(mockPrewarmHost).not.toHaveBeenCalled()

    // And every token issued by the stream path carries ONLY the status
    // scope — never the message scopes the wake route uses.
    expect(mockGetOrIssue.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of mockGetOrIssue.mock.calls) {
      expect(call[1]).toEqual(['host:status:read'])
    }

    svc.stopHostStatusStream('stream-1')
  })
})

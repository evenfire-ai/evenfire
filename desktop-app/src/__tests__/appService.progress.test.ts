import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

// Enough microtask ticks to drain the team-context resolution chain
// (issueRpcTokenForHostRefs -> runWithTeamContext) plus the stream open.
async function flushAsyncWork(iterations = 16): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}

describe('AppService.startTaskProgressStream', () => {
  it('forwards waiting and open as DISTINCT renderer events (de-collapsed, §4.5-1)', async () => {
    const service = new AppService() as any

    service.sessionToken = 'session-token'
    // issueRpcTokenForHostRefs requires a resolvable current team (team-bounded

    // RPC tokens); me.teamId short-circuits resolution without network calls.
    service.me = { id: 7, teamId: 'team-1' }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({
        token: 'rpc-token',
        scopes: ['host:activity:read'],
      }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      openTaskProgressStream: vi
        .fn()
        .mockImplementation(
          async (
            _rpcToken: string,
            _hostRef: string,
            _taskId: string,
            onEvent: (event: { event: string; data: unknown }) => void
          ) => {
            onEvent({ event: 'waiting', data: { taskId: 'task-1' } })
            onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
            onEvent({ event: 'done', data: { taskId: 'task-1' } })
          }
        ),
    }

    const events: Array<{ type: string; data?: unknown }> = []
    service.startTaskProgressStream(
      'stream-1',
      7,
      'chatllm',
      'task-1',
      ['chatllm'],
      (event: { type: string; data?: unknown }) => {
        events.push(event)
      }
    )

    await flushAsyncWork()

    // §4.5-1 (R6/B2b): the bridge no longer collapses waiting→open. The renderer
    // sees `waiting` (connection established, reporter not live) then `open`
    // (reporter live) as separate events, so it can distinguish a queued task from
    // a live one and only reset its re-rejoin cap on the real `open`.
    expect(events.map(event => event.type)).toEqual(['waiting', 'open', 'terminal', 'closed'])
    expect(events[0]).toEqual({ type: 'waiting', taskId: 'task-1', hostRef: 'chatllm' })
    expect(events[2]).toEqual({
      type: 'terminal',
      data: {
        taskId: 'task-1',
        status: 'completed',
      },
    })
  })

  it('forwards heartbeat events to the renderer (watchdog keepalive)', async () => {
    const service = new AppService() as any

    service.sessionToken = 'session-token'
    // issueRpcTokenForHostRefs requires a resolvable current team (team-bounded

    // RPC tokens); me.teamId short-circuits resolution without network calls.
    service.me = { id: 7, teamId: 'team-1' }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({
        token: 'rpc-token',
        scopes: ['host:activity:read'],
      }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      openTaskProgressStream: vi
        .fn()
        .mockImplementation(
          async (
            _rpcToken: string,
            _hostRef: string,
            _taskId: string,
            onEvent: (event: { event: string; data: unknown }) => void
          ) => {
            onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
            // A keepalive surfaced by the SSE parser as a heartbeat.
            onEvent({ event: 'heartbeat', data: { taskId: 'task-1', iteration: 0, elapsedMs: 0 } })
            onEvent({ event: 'done', data: { taskId: 'task-1' } })
          }
        ),
    }

    const events: Array<{ type: string; data?: unknown }> = []
    service.startTaskProgressStream(
      'stream-1',
      7,
      'chatllm',
      'task-1',
      ['chatllm'],
      (event: { type: string; data?: unknown }) => {
        events.push(event)
      }
    )

    await flushAsyncWork()

    // The heartbeat must reach the renderer (where it resets the task watchdog),
    // ordered between open and the terminal.
    expect(events.map(event => event.type)).toEqual(['open', 'heartbeat', 'terminal', 'closed'])
  })

  it('stopAllStreams() tears down silently — no `closed`/terminal to a live tracker (R-F13)', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.me = { id: 7, teamId: 'team-1' }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-token', scopes: ['host:activity:read'] }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      openTaskProgressStream: vi
        .fn()
        .mockImplementation(
          async (
            _t: string,
            _h: string,
            _id: string,
            onEvent: (e: { event: string; data: unknown }) => void,
            signal: AbortSignal
          ) => {
            onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
            // Stay open until aborted (a live, in-flight task).
            await new Promise<void>(resolve => {
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        ),
    }

    const events: Array<{ type: string }> = []
    service.startTaskProgressStream(
      's1',
      7,
      'chatllm',
      'task-1',
      ['chatllm'],
      (e: { type: string }) => events.push(e)
    )
    await flushAsyncWork()
    expect(events.map(e => e.type)).toEqual(['open'])

    // Bulk teardown (logout/team-switch): the socket is aborted and the entry
    // removed, but NO `closed` is surfaced — so a still-live renderer tracker does
    // not fabricate a spurious stream-loss terminal before its own release runs.
    service.stopAllStreams()
    await flushAsyncWork()
    expect(events.map(e => e.type)).toEqual(['open'])
    expect(service.progressStreams.size).toBe(0)

    // Contrast: a NORMAL stop (renderer-requested) DOES emit `closed` — the silent
    // path is exclusive to bulk teardown.
    service.startTaskProgressStream(
      's2',
      7,
      'chatllm',
      'task-2',
      ['chatllm'],
      (e: { type: string }) => events.push(e)
    )
    await flushAsyncWork()
    service.stopTaskProgressStream('s2')
    expect(events.some(e => e.type === 'closed')).toBe(true)
  })

  it('reconnects after a transport drop and replays the terminal (no error)', async () => {
    vi.useFakeTimers()
    try {
      const service = new AppService() as any
      service.sessionToken = 'session-token'
      // issueRpcTokenForHostRefs requires a resolvable current team (team-bounded
      // RPC tokens); me.teamId short-circuits resolution without network calls.
      service.me = { id: 7, teamId: 'team-1' }
      service.rpcTokenManager = {
        getOrIssue: vi
          .fn()
          .mockResolvedValue({ token: 'rpc-token', scopes: ['host:activity:read'] }),
        clear: vi.fn(),
      }
      let calls = 0
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void
            ) => {
              calls += 1
              if (calls === 1) {
                onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
                // transport drops mid-stream: resolve WITHOUT a terminal.
                return
              }
              // reconnect: mcp-host replays the buffered terminal to the late subscriber.
              onEvent({ event: 'done', data: { taskId: 'task-1' } })
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )
      // First attempt + 500ms backoff + reconnect.
      await vi.advanceTimersByTimeAsync(800)

      expect(service.rpcClient.openTaskProgressStream).toHaveBeenCalledTimes(2)
      // No spurious error — the replayed terminal closes it cleanly.
      expect(events.map(e => e.type)).toEqual(['open', 'terminal', 'closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry on task_not_found_or_expired; surfaces the loss for reconcile', async () => {
    vi.useFakeTimers()
    try {
      const service = new AppService() as any
      service.sessionToken = 'session-token'
      // issueRpcTokenForHostRefs requires a resolvable current team (team-bounded
      // RPC tokens); me.teamId short-circuits resolution without network calls.
      service.me = { id: 7, teamId: 'team-1' }
      service.rpcTokenManager = {
        getOrIssue: vi
          .fn()
          .mockResolvedValue({ token: 'rpc-token', scopes: ['host:activity:read'] }),
        clear: vi.fn(),
      }
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void
            ) => {
              onEvent({ event: 'error', data: { message: 'task_not_found_or_expired' } })
            }
          ),
      }

      const events: Array<{ type: string; message?: string; reason?: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string; message?: string; reason?: string }) => events.push(e)
      )
      await vi.advanceTimersByTimeAsync(5000)

      // Reporter+result are gone → no point retrying; surface a single structured
      // `gone` (§4.5-2) so the renderer reconciles against the durable /messages (B).
      expect(service.rpcClient.openTaskProgressStream).toHaveBeenCalledTimes(1)
      expect(events.map(e => e.type)).toEqual(['gone', 'closed'])
      expect(events[0]).toMatchObject({ type: 'gone', reason: 'task_not_found_or_expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits a single gone after exhausting all reconnect attempts (§4.5-2)', async () => {
    vi.useFakeTimers()
    try {
      const service = new AppService() as any
      service.sessionToken = 'session-token'
      // issueRpcTokenForHostRefs requires a resolvable current team (team-bounded
      // RPC tokens); me.teamId short-circuits resolution without network calls.
      service.me = { id: 7, teamId: 'team-1' }
      service.rpcTokenManager = {
        getOrIssue: vi
          .fn()
          .mockResolvedValue({ token: 'rpc-token', scopes: ['host:activity:read'] }),
        clear: vi.fn(),
      }
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void
            ) => {
              // Every attempt opens then drops without a terminal.
              onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )
      // 3 attempts + 500 + 1000ms backoffs.
      await vi.advanceTimersByTimeAsync(3000)

      expect(service.rpcClient.openTaskProgressStream).toHaveBeenCalledTimes(3)
      // A single `open` (deduped across reconnects), then exactly one structured
      // `gone` (§4.5-2, replacing the generic `error`) + the local close.
      expect(events.filter(e => e.type === 'gone')).toHaveLength(1)
      expect(events.map(e => e.type)).toEqual(['open', 'gone', 'closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  // ── F3: the 8s bound guards CONNECTION ESTABLISHMENT, not the reporter wait ──

  function makeService(): any {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.me = { id: 7, teamId: 'team-1' }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-token', scopes: ['host:activity:read'] }),
      clear: vi.fn(),
    }
    return service
  }

  it('F3: a >8s gap between waiting and open does NOT abort or emit a false error', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService()
      let calls = 0
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void,
              signal: AbortSignal
            ) => {
              calls += 1
              // Connection established immediately (server flushes `waiting`),
              // then the server blocks in waitFor(reporter) — NO further bytes for
              // a long while. The 8s establishment bound must NOT fire here.
              onEvent({ event: 'waiting', data: { taskId: 'task-1' } })
              await new Promise<void>((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              })
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )

      // Drain the open handshake, then sit 30s past the OLD 8s bound.
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(30_000)

      // No abort/retry, no error: the connection is established, the task is alive.
      // §4.5-1: the renderer sees `waiting` (not a collapsed `open`) during the
      // legitimate pre-`open` reporter wait.
      expect(calls).toBe(1)
      expect(events.map(e => e.type)).toEqual(['waiting'])
      expect(events.some(e => e.type === 'error' || e.type === 'gone')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F3: no waiting within 8s still aborts the attempt and retries', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService()
      let calls = 0
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void,
              signal: AbortSignal
            ) => {
              calls += 1
              if (calls === 1) {
                // Connection never establishes — no `waiting` bytes at all. The 8s
                // establishment bound must abort so the loop retries.
                await new Promise<void>((resolve, reject) => {
                  signal.addEventListener('abort', () => reject(new Error('establish timeout')), {
                    once: true,
                  })
                })
                return
              }
              // Retry succeeds.
              onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
              onEvent({ event: 'done', data: { taskId: 'task-1' } })
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )

      // 8s establishment bound fires → abort → 500ms backoff → retry succeeds.
      await vi.advanceTimersByTimeAsync(9_000)

      expect(calls).toBe(2)
      expect(events.map(e => e.type)).toEqual(['open', 'terminal', 'closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('F3: a connection that goes silent AFTER waiting is still eventually caught', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService()
      let calls = 0
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void,
              signal: AbortSignal
            ) => {
              calls += 1
              // Establish (waiting), then hang forever with no open/keepalive. The
              // longer waiting-for-open bound (~195s) must eventually abort each
              // attempt; after the bounded retries the bridge emits one error.
              onEvent({ event: 'waiting', data: { taskId: 'task-1' } })
              await new Promise<void>((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              })
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )

      // 3 attempts × ~195s + backoffs — advance well past the worst case.
      await vi.advanceTimersByTimeAsync(195_000 * 3 + 5_000)

      expect(calls).toBe(3)
      // A single `waiting` (deduped across reconnects), then exactly one `gone`
      // after the budget is spent (§4.5-1/§4.5-2).
      expect(events.filter(e => e.type === 'gone')).toHaveLength(1)
      expect(events.map(e => e.type)).toEqual(['waiting', 'gone', 'closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  // ── F4: a single transient 401 on token re-issue retries instead of giving up ──

  it('F4: a single transient 401 on token re-issue retries and recovers', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService()
      let issueCalls = 0
      service.rpcTokenManager = {
        getOrIssue: vi.fn().mockImplementation(async () => {
          issueCalls += 1
          if (issueCalls === 1) {
            throw new ApiError('Unauthorized', 401, '')
          }
          return { token: 'rpc-token-fresh', scopes: ['host:activity:read'] }
        }),
        clear: vi.fn(),
      }
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void
            ) => {
              onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
              onEvent({ event: 'done', data: { taskId: 'task-1' } })
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )

      // First attempt 401s on re-issue → clear + 500ms backoff → re-mint succeeds.
      await vi.advanceTimersByTimeAsync(800)

      // The stale token was cleared so the NEXT attempt re-mints.
      expect(service.rpcTokenManager.clear).toHaveBeenCalledTimes(1)
      expect(issueCalls).toBe(2)
      // No error terminal — the stream recovered on the retry.
      expect(events.map(e => e.type)).toEqual(['open', 'terminal', 'closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4: a persistent 401 on token re-issue gives up after the reconnect budget', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService()
      service.rpcTokenManager = {
        getOrIssue: vi.fn().mockRejectedValue(new ApiError('Unauthorized', 401, '')),
        clear: vi.fn(),
      }
      service.rpcClient = { openTaskProgressStream: vi.fn() }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )

      // 3 attempts + backoffs — a genuinely revoked session still terminates.
      await vi.advanceTimersByTimeAsync(5_000)

      expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalledTimes(3)
      // The stream open was never reached (token re-issue failed every time).
      expect(service.rpcClient.openTaskProgressStream).not.toHaveBeenCalled()
      // §4.5-2: a genuinely revoked session gives up with a structured `gone`.
      expect(events.filter(e => e.type === 'gone')).toHaveLength(1)
      expect(events.map(e => e.type)).toEqual(['gone', 'closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('F4: a healthy stream that absorbed prior drops still survives a later 401 (attempt budget reset on heartbeat)', async () => {
    vi.useFakeTimers()
    try {
      const service = makeService()
      let issueCalls = 0
      service.rpcTokenManager = {
        getOrIssue: vi.fn().mockImplementation(async () => {
          issueCalls += 1
          // The 3rd re-issue 401s once (token expiry blip); all others succeed.
          if (issueCalls === 3) throw new ApiError('Unauthorized', 401, '')
          return { token: `rpc-token-${issueCalls}`, scopes: ['host:activity:read'] }
        }),
        clear: vi.fn(),
      }
      let openCalls = 0
      service.rpcClient = {
        openTaskProgressStream: vi
          .fn()
          .mockImplementation(
            async (
              _t: string,
              _h: string,
              _id: string,
              onEvent: (e: { event: string; data: unknown }) => void
            ) => {
              openCalls += 1
              onEvent({ event: 'open', data: { taskId: 'task-1', hostRef: 'chatllm' } })
              // A heartbeat proves the connection was genuinely alive → resets the
              // reconnect budget. Attempts 1 & 2 drop after the heartbeat; the
              // recovery attempt (after the 401) finishes cleanly.
              onEvent({ event: 'heartbeat', data: {} })
              if (openCalls >= 3) {
                onEvent({ event: 'done', data: { taskId: 'task-1' } })
              }
              // else: returns without a terminal → counts as a drop.
            }
          ),
      }

      const events: Array<{ type: string }> = []
      service.startTaskProgressStream(
        's1',
        7,
        'chatllm',
        'task-1',
        ['chatllm'],
        (e: { type: string }) => events.push(e)
      )

      // 2 healthy-but-dropped attempts (heartbeat resets the budget each time) +
      // a 401 re-issue + the clean recovery attempt + backoffs.
      await vi.advanceTimersByTimeAsync(5_000)

      // Without the heartbeat-driven reset, the 2 prior drops would have pushed
      // `attempt` to the cap and the 401 would have terminated with an error.
      // (Heartbeats are forwarded too, so assert on the meaningful outcomes.)
      expect(events.filter(e => e.type === 'error')).toHaveLength(0)
      expect(events.some(e => e.type === 'terminal')).toBe(true)
      expect(events.some(e => e.type === 'closed')).toBe(true)
      expect(openCalls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

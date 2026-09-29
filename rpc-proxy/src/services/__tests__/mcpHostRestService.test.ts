import { describe, expect, it, vi } from 'vitest'
import { config } from '../../config.js'
import {
  forwardCancelToHost,
  forwardHostActivity,
  forwardHostHealth,
  forwardHostMessageToHost,
  forwardHostStatus,
  forwardTaskResultFromHost,
  __test__normalizeHostStatusPayload as normalize,
} from '../mcpHostRestService.js'
import { isUpstreamTimeoutError } from '../wakeAndHold.js'

describe('host message availability probe', () => {
  it('aborts at the requested short timeout with the standard abort reason', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    )
    try {
      const pending = forwardHostMessageToHost(
        { name: 'chatllm', url: 'http://chatllm:8080', headers: {} },
        { content: 'hello', hostRef: 'chatllm' },
        { timeoutMs: 750 }
      )
      const rejection = expect(pending).rejects.toMatchObject({
        name: 'AbortError',
      })
      await vi.advanceTimersByTimeAsync(750)
      await rejection
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      fetchMock.mockRestore()
      vi.useRealTimers()
    }
  })
})

// Every upstream forwarder aborts its own fetch when the deadline fires. What
// the caller sees is whatever `signal.reason` is: the app's 504 mapping and the
// wake coordinator both classify by error NAME (AbortError / TimeoutError), so
// an abort that carries a custom reason would be reported as a 500 / 502.
describe('upstream forwarders abort with the standard classified reason', () => {
  const HOST = { name: 'chatllm', url: 'http://chatllm:8080', headers: {} }

  const PRODUCERS: Array<{
    label: string
    timeoutMs: number
    call: () => Promise<unknown>
  }> = [
    {
      label: 'forwardHostMessageToHost',
      timeoutMs: 750,
      call: () =>
        forwardHostMessageToHost(
          HOST,
          { content: 'hello', hostRef: 'chatllm' },
          { timeoutMs: 750 }
        ),
    },
    {
      label: 'forwardTaskResultFromHost',
      timeoutMs: 640,
      call: () => forwardTaskResultFromHost(HOST, 'task-1', 640),
    },
    {
      label: 'forwardHostStatus',
      timeoutMs: config.upstreamTimeoutMs,
      call: () => forwardHostStatus(HOST),
    },
    {
      label: 'forwardHostHealth',
      timeoutMs: config.upstreamTimeoutMs,
      call: () => forwardHostHealth(HOST),
    },
    {
      label: 'forwardHostActivity',
      timeoutMs: config.upstreamTimeoutMs,
      call: () => forwardHostActivity(HOST, 10),
    },
  ]

  it.each(PRODUCERS)(
    '$label rejects with an AbortError at its deadline, not earlier',
    async ({ timeoutMs, call }) => {
      vi.useFakeTimers()
      let signal: AbortSignal | undefined
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            signal = init?.signal as AbortSignal
            signal.addEventListener('abort', () => reject(signal!.reason))
          })
      )
      try {
        const pending = call()
        const rejection = pending.then(
          () => {
            throw new Error('expected the forwarder to reject at its deadline')
          },
          (error: unknown) => error
        )

        // Liveness witness: the request is in flight and still un-aborted just
        // before the deadline, so the rejection below is the deadline timer.
        await vi.advanceTimersByTimeAsync(timeoutMs - 1)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(signal?.aborted).toBe(false)

        await vi.advanceTimersByTimeAsync(1)
        const error = await rejection

        expect(signal?.aborted).toBe(true)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).name).toBe('AbortError')
        expect(isUpstreamTimeoutError(error)).toBe(true)
      } finally {
        fetchMock.mockRestore()
        vi.useRealTimers()
      }
    }
  )
})

// R3-L4 / R3-L6: task cancel is a mutating POST with no idempotency key, so it
// owns no deadline. The route passes one signal that carries the wake-hold
// deadline (retry only) and the client's disconnect.
describe('forwardCancelToHost aborts only through the caller signal', () => {
  const HOST = { name: 'chatllm', url: 'http://chatllm:8080', headers: {} }

  it('stays in flight past the upstream timeout and rejects with the caller abort reason', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal as AbortSignal
          signal.addEventListener('abort', () => reject(signal!.reason))
        })
    )
    try {
      const controller = new AbortController()
      const pending = forwardCancelToHost(HOST, 'task-1', 'user-1', controller.signal)
      const rejection = pending.then(
        () => {
          throw new Error('expected the forwarder to reject when the caller aborts')
        },
        (error: unknown) => error
      )

      // Liveness witness: the POST is in flight on the caller's own signal, and
      // four upstream timeouts later nothing has aborted it.
      await vi.advanceTimersByTimeAsync(config.upstreamTimeoutMs * 4)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(signal).toBe(controller.signal)
      expect(signal?.aborted).toBe(false)

      const reason = new DOMException('The operation was aborted.', 'AbortError')
      controller.abort(reason)
      const error = await rejection

      expect(error).toBe(reason)
      expect(isUpstreamTimeoutError(error)).toBe(true)
    } finally {
      fetchMock.mockRestore()
      vi.useRealTimers()
    }
  })
})

const baseUpstream = {
  agent: {
    state: 'idle',
    currentTaskId: null,
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    uptime: 1,
  },
  queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
  cronJobs: 0,
}

describe('normalizeHostStatusPayload — mcpServers passthrough', () => {
  it('returns undefined mcpServers when upstream omits the field (old mcp-host)', () => {
    const out = normalize('h1', { ...baseUpstream })
    expect(out).not.toBeNull()
    expect(out!.mcpServers).toBeUndefined()
  })

  it('normalizes a well-formed row verbatim', () => {
    const row = {
      name: 'mcp-coingecko-remote',
      state: 'failed',
      expected: true,
      toolCount: 0,
      reason: 'auth_failed',
      message: 'initialize returned 401',
      observedAt: '2026-04-21T18:00:00.000Z',
    }
    const out = normalize('h1', { ...baseUpstream, mcpServers: [row] })
    expect(out!.mcpServers).toEqual([row])
  })

  it("coerces unknown state strings to 'unknown'", () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'exploding',
          expected: true,
          toolCount: 0,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].state).toBe('unknown')
  })

  it("coerces unknown reason strings to 'unknown' when state !== connected", () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'failed',
          expected: true,
          toolCount: 0,
          reason: 'martian_intervention',
          message: 'what',
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].reason).toBe('unknown')
  })

  it('preserves null reason (connected row, no failure)', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'connected',
          expected: true,
          toolCount: 3,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].reason).toBeNull()
  })

  it('drops rows that are missing `name`', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        { state: 'connected' }, // no name
        {
          name: 'ok',
          state: 'connected',
          expected: true,
          toolCount: 1,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers).toHaveLength(1)
    expect(out!.mcpServers![0].name).toBe('ok')
  })

  it('returns undefined mcpServers when the field is non-array garbage', () => {
    const out = normalize('h1', { ...baseUpstream, mcpServers: 'no' })
    expect(out!.mcpServers).toBeUndefined()
  })

  it('clamps toolCount to non-negative integer', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'connected',
          expected: true,
          toolCount: -5,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].toolCount).toBe(0)
  })

  it('still returns a valid HostRuntimeStatus shape for existing fields', () => {
    const out = normalize('h1', baseUpstream)!
    expect(out.hostRef).toBe('h1')
    expect(out.agent.state).toBe('idle')
    expect(out.queue.pending).toBe(0)
    expect(out.cronJobs).toBe(0)
    expect(typeof out.observedAt).toBe('string')
  })
})

describe('normalizeHostStatusPayload — degraded passthrough', () => {
  it('omits degraded when upstream omits it', () => {
    const out = normalize('h1', baseUpstream)!
    expect(out.degraded).toBeUndefined()
  })

  it('passes degraded:null through verbatim', () => {
    const out = normalize('h1', { ...baseUpstream, degraded: null })!
    expect(out.degraded).toBeNull()
  })

  it('forwards a well-formed llm_key_missing payload', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      degraded: {
        reason: 'llm_key_missing',
        message: 'LLM API key is missing or the referenced Secret is empty.',
      },
    })!
    expect(out.degraded).toEqual({
      reason: 'llm_key_missing',
      message: 'LLM API key is missing or the referenced Secret is empty.',
    })
  })

  it('drops unknown reasons (forward-compat / forces narrow contract)', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      degraded: { reason: 'something_else', message: '...' },
    })!
    expect(out.degraded).toBeUndefined()
  })

  it('falls back to a default message when missing/blank', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      degraded: { reason: 'llm_key_missing' },
    })!
    expect(out.degraded?.reason).toBe('llm_key_missing')
    expect(out.degraded?.message).toBeTruthy()
  })
})

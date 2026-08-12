/**
 * U4 fix-round — broker token provider fail-closed matrix (T1/T5).
 *
 * Tests the REAL provider (mcp/brokerTokenProvider.ts) with only `fetch` stubbed
 * (never a hand-written double of the provider). Pins the fail-closed contract
 * and the per-user cache isolation (the load-bearing security invariant).
 */
import { describe, expect, it, vi } from 'vitest'
import { type BrokerTokenProviderDeps, createBrokerTokenProvider } from '../brokerTokenProvider'

interface StubResponse {
  status: number
  json?: () => Promise<unknown>
}

function stubFetch(handler: (url: string, init: RequestInit) => StubResponse) {
  return vi.fn(async (url: string, init: RequestInit) => handler(url, init) as unknown as Response)
}

function jsonResponse(status: number, body: unknown): StubResponse {
  return { status, json: async () => body }
}

function deps(
  fetchImpl: ReturnType<typeof stubFetch>,
  overrides: Partial<BrokerTokenProviderDeps> = {}
): BrokerTokenProviderDeps {
  return {
    gatewayUrl: () => 'http://gateway:8092',
    controlToken: () => 'control-jwt',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  }
}

function bodyOf(fetchImpl: ReturnType<typeof stubFetch>, call = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call][1] as RequestInit
  return JSON.parse(init.body as string)
}

describe('createBrokerTokenProvider — fail-closed contract', () => {
  it('200 → returns the token and POSTs the subject', async () => {
    const f = stubFetch(() => jsonResponse(200, { token: 'tok-abc', expiresAt: null }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    expect(await p.resolve()).toBe('tok-abc')
    expect(f).toHaveBeenCalledTimes(1)
    expect(bodyOf(f)).toEqual({ mcpServerName: 'gh', userId: 'alice' })
  })

  it('reuses a cached token within expiry headroom, refetches once expiry is near', async () => {
    let clock = 1_000_000
    const f = stubFetch(() =>
      jsonResponse(200, { token: 'tok', expiresAt: new Date(clock + 60_000).toISOString() })
    )
    const p = createBrokerTokenProvider(
      { name: 'gh' },
      { userId: 'alice' },
      deps(f, { now: () => clock })
    )
    expect(await p.resolve()).toBe('tok')
    // Still >30s headroom → cached, no new POST.
    clock += 20_000
    expect(await p.resolve()).toBe('tok')
    expect(f).toHaveBeenCalledTimes(1)
    // Now <30s headroom → refetch.
    clock += 15_000
    expect(await p.resolve()).toBe('tok')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('refresh() forces a fresh POST even when a valid token is cached', async () => {
    const f = stubFetch(() => jsonResponse(200, { token: 'tok', expiresAt: null }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    await p.resolve()
    expect(f).toHaveBeenCalledTimes(1)
    await p.resolve() // cached (expiresAt null → no expiry)
    expect(f).toHaveBeenCalledTimes(1)
    await p.refresh() // forced
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('404 no_grant → resolves undefined (fail-closed, call not forwarded)', async () => {
    const f = stubFetch(() => jsonResponse(404, { error: 'no_grant' }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    expect(await p.resolve()).toBeUndefined()
  })

  it('403 insufficient_scope → resolves undefined (fail-closed)', async () => {
    const f = stubFetch(() => jsonResponse(403, { error: 'insufficient_scope' }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    expect(await p.resolve()).toBeUndefined()
  })

  it('500 → throws (never forwards a stale/empty token)', async () => {
    const f = stubFetch(() => jsonResponse(500, { error: 'boom' }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    await expect(p.resolve()).rejects.toThrow(/500/)
  })

  it('malformed 200 body → throws, never returns a token', async () => {
    const f = stubFetch(() => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token')
      },
    }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    await expect(p.resolve()).rejects.toThrow()
  })

  it('200 with empty/absent token → throws', async () => {
    const f = stubFetch(() => jsonResponse(200, { token: '', expiresAt: null }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    await expect(p.resolve()).rejects.toThrow(/malformed/)
  })

  it('missing gateway URL → undefined, no fetch', async () => {
    const f = stubFetch(() => jsonResponse(200, { token: 't', expiresAt: null }))
    const p = createBrokerTokenProvider(
      { name: 'gh' },
      { userId: 'alice' },
      deps(f, { gatewayUrl: () => undefined })
    )
    expect(await p.resolve()).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })

  it('missing control token → undefined, no fetch', async () => {
    const f = stubFetch(() => jsonResponse(200, { token: 't', expiresAt: null }))
    const p = createBrokerTokenProvider(
      { name: 'gh' },
      { userId: 'alice' },
      deps(f, { controlToken: () => undefined })
    )
    expect(await p.resolve()).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })

  it('a hung broker aborts on the timeout signal → throws (fail-closed, no token)', async () => {
    // Never resolves on its own; rejects only when the provider's timeout signal
    // fires. Exercises the AbortSignal.timeout → throw → caller fail-closed chain.
    const f = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError'))
          )
        })
    )
    const p = createBrokerTokenProvider(
      { name: 'gh' },
      { userId: 'alice' },
      deps(f as unknown as ReturnType<typeof stubFetch>, { timeoutMs: 5 })
    )
    // Throw (not a stale/empty token) → the manager surfaces it as an auth
    // failure and never forwards the call.
    await expect(p.resolve()).rejects.toThrow(/abort/i)
  })

  it('grantScope=context subject POSTs contextId', async () => {
    const f = stubFetch(() => jsonResponse(200, { token: 'ctx-tok', expiresAt: null }))
    const p = createBrokerTokenProvider({ name: 'gh' }, { contextId: 'ctx-1' }, deps(f))
    expect(await p.resolve()).toBe('ctx-tok')
    expect(bodyOf(f)).toEqual({ mcpServerName: 'gh', contextId: 'ctx-1' })
  })
})

describe('createBrokerTokenProvider — per-user cache isolation (security)', () => {
  it('a token cached for user A is never returned for user B', async () => {
    // One shared stub fetch: echoes the requested subject back as the token.
    const f = stubFetch((_url, init) => {
      const body = JSON.parse((init.body as string) ?? '{}') as { userId?: string }
      return jsonResponse(200, { token: `tok-${body.userId}`, expiresAt: null })
    })
    const a = createBrokerTokenProvider({ name: 'gh' }, { userId: 'alice' }, deps(f))
    const b = createBrokerTokenProvider({ name: 'gh' }, { userId: 'bob' }, deps(f))

    expect(await a.resolve()).toBe('tok-alice')
    expect(await b.resolve()).toBe('tok-bob')
    // A's cache still serves only A; it never leaks B's token.
    expect(await a.resolve()).toBe('tok-alice')
    expect(await b.resolve()).toBe('tok-bob')
  })
})

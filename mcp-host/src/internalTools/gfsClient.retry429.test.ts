import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGfsReadTools } from './gfs'
import { GfscHttpError, createGfscClient } from './gfsClient'

/**
 * #699 stress: N agent pods rate limited by gfsc at once. One mcp-host process
 * holds one subject token, so N clients with distinct tokens stand for N
 * agents. The fetch stub is keyed by the bearer token and timers are faked.
 */

const N = 50

type Call = { token: string; at: number }

function rateLimited(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (retryAfter !== undefined) headers['retry-after'] = retryAfter
  return new Response(JSON.stringify({ ok: false, error: { code: 'rate_limited' } }), {
    status: 429,
    headers,
  })
}

function ok(token: string): Response {
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function tokenOf(init?: RequestInit): string {
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization
  if (!auth?.startsWith('Bearer ')) throw new Error('request carried no bearer token')
  return auth.slice('Bearer '.length)
}

// answer(token, attempt) decides the response for the attempt-th call (1-based)
// made with that token.
function fleet(answer: (token: string, attempt: number) => Response, maxRetryWaitMs: number) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (_input: string, init?: RequestInit) => {
    const token = tokenOf(init)
    calls.push({ token, at: Date.now() })
    return answer(token, calls.filter(c => c.token === token).length)
  })
  const clients = Array.from({ length: N }, (_, i) => ({
    token: `agent-${i}`,
    client: createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? `agent-${i}` : undefined),
        fetch: fetchFn,
      },
      { maxRetryWaitMs }
    ),
  }))
  const perToken = (token: string) => calls.filter(c => c.token === token)
  return { calls, clients, perToken }
}

describe('gfsc client under a concurrent 429 burst', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('M1: every agent retries once after Retry-After and succeeds', async () => {
    const { calls, clients, perToken } = fleet(
      (token, attempt) => (attempt === 1 ? rateLimited('2') : ok(token)),
      60_000
    )

    const results = Promise.all(
      clients.map(({ client }) => client.stat({ drive: 'main', resourceId: 'rid' }))
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(N)
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toHaveLength(N)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2 * N)

    await expect(results).resolves.toEqual(clients.map(({ token }) => ({ token })))
    for (const { token } of clients) {
      const [first, retry] = perToken(token)
      expect(perToken(token)).toHaveLength(2)
      expect(retry!.at - first!.at).toBeGreaterThanOrEqual(2000)
    }
  })

  it('M2: a 429 without Retry-After fails every agent at once', async () => {
    const { calls, clients } = fleet(() => rateLimited(), 60_000)

    const settled = await Promise.allSettled(
      clients.map(({ client }) => client.stat({ drive: 'main', resourceId: 'rid' }))
    )
    expect(calls).toHaveLength(N)
    expect(settled.every(s => s.status === 'rejected')).toBe(true)
    for (const s of settled) {
      const reason = (s as PromiseRejectedResult).reason
      expect(reason).toBeInstanceOf(GfscHttpError)
      expect(reason).toMatchObject({ status: 429, retryAfterSeconds: undefined })
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('M3: a Retry-After above the tool budget fails at once with the hint', async () => {
    const { calls, clients } = fleet(() => rateLimited('2'), 1000)

    const settled = await Promise.allSettled(
      clients.map(({ client }) => client.stat({ drive: 'main', resourceId: 'rid' }))
    )
    expect(calls).toHaveLength(N)
    for (const s of settled) {
      expect(s.status).toBe('rejected')
      const reason = (s as PromiseRejectedResult).reason as GfscHttpError
      expect(reason).toMatchObject({ status: 429, retryAfterSeconds: 2 })
      expect(reason.message).toContain('(retry after 2s)')
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('M4: an agent still denied after its retry stops at two calls', async () => {
    const { calls, clients, perToken } = fleet(() => rateLimited('2'), 60_000)

    const settled = Promise.allSettled(
      clients.map(({ client }) => client.stat({ drive: 'main', resourceId: 'rid' }))
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(2 * N)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toHaveLength(2 * N)

    for (const s of await settled) {
      expect(s.status).toBe('rejected')
      expect((s as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        retryAfterSeconds: 2,
      })
    }
    for (const { token } of clients) expect(perToken(token)).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('M5: the read tool returns rate_limited with the hint and never throws', async () => {
    const { calls, clients } = fleet(() => rateLimited('2'), 60_000)
    const statTools = clients.map(({ client }) => {
      const tool = buildGfsReadTools(client).find(t => t.name === 'clerum__gfs_stat')
      if (!tool) throw new Error('clerum__gfs_stat is not registered')
      return tool
    })

    const results = Promise.all(
      statTools.map(tool => tool.execute({ drive: 'main', resourceId: 'rid' }, ''))
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(2 * N)

    const settled = await results
    expect(settled).toHaveLength(N)
    for (const result of settled) {
      expect(result).toEqual({
        success: false,
        error: 'GFS read failed (gfsc 429: rate_limited, retry after 2s)',
      })
    }
  })
})

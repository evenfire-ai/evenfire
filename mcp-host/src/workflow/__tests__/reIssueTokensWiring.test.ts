/**
 * Task #20 — Unit tests for the mcp-host side of the reIssueTokens wiring.
 *
 * Covers `createReIssueTokensCallback`: the factory that produces the zero-arg
 * callback invoked by userApprovalRequester's recovery path. The callback is
 * exercised against a mocked `fetch` (native global) so these tests never
 * reach a real HTTP server — they validate URL shape, header construction,
 * body content, timeout handling, and error surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReIssueTokensCallback } from '../runtimeAuthFactory'

describe('createReIssueTokensCallback', () => {
  const baseAuth = {
    accessToken: 'initial-access',
    refreshToken: 'initial-refresh',
    baseUrl: 'http://control-api.test:8090',
  }
  const RECIPE = 'task-20-test-recipe'

  // Replace global fetch with a vi mock for each test — avoids polluting the
  // global across test files and makes assertions deterministic.
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = global.fetch

  beforeEach(() => {
    fetchMock = vi.fn()
    ;(global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    ;(global as { fetch: typeof fetch }).fetch = originalFetch
  })

  it('POSTs to {baseUrl}/api/v1/workflow-auth/reissue with correct headers and body', async () => {
    const authRef = { ...baseAuth }
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ accessToken: 'new-A', refreshToken: 'new-R', expiresInSeconds: 600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const reIssue = createReIssueTokensCallback(authRef, {
      kind: 'workflow',
      recipeName: RECIPE,
    })
    const result = await reIssue()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe('http://control-api.test:8090/api/v1/workflow-auth/reissue')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBe('Bearer initial-refresh')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ recipe_name: RECIPE })
    expect(result).toEqual({ accessToken: 'new-A', refreshToken: 'new-R' })
  })

  it('sends host_ref for HCC standalone hosts instead of treating standalone as a recipe', async () => {
    const authRef = { ...baseAuth }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new-A', refreshToken: 'new-R' }), {
        status: 200,
      })
    )

    const reIssue = createReIssueTokensCallback(authRef, {
      kind: 'standalone_host',
      hostRef: 'chatllm',
    })
    await reIssue()

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ host_ref: 'chatllm' })
    expect(body).not.toHaveProperty('recipe_name')
  })

  it('sends the CURRENT refreshToken, not the one captured at factory time', async () => {
    // Real-world: a prior /refresh rotated the token right before recovery
    // fires. The callback must observe the mutation through its closure
    // reference, NOT use a stale copy.
    const authRef = { ...baseAuth }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'R2' }), { status: 200 })
    )

    const reIssue = createReIssueTokensCallback(authRef, {
      kind: 'workflow',
      recipeName: RECIPE,
    })
    // Simulate an intervening rotate before the recovery path runs:
    authRef.refreshToken = 'rotated-refresh'

    await reIssue()

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer rotated-refresh')
  })

  it("throws a dedicated 'unauthorized' error on 401 so upstream can short-circuit", async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    const reIssue = createReIssueTokensCallback(
      { ...baseAuth },
      { kind: 'workflow', recipeName: RECIPE }
    )
    await expect(reIssue()).rejects.toThrow(/unauthorized.*401/i)
  })

  it('throws a status-bearing error on non-401 non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const reIssue = createReIssueTokensCallback(
      { ...baseAuth },
      { kind: 'workflow', recipeName: RECIPE }
    )
    try {
      await reIssue()
      throw new Error('expected reIssue to fail')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/reIssueTokens failed \(500\)/)
      expect(message).not.toContain('boom')
    }
  })

  it('throws when the response body is missing accessToken or refreshToken', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'only-access' }), { status: 200 })
    )
    const reIssue = createReIssueTokensCallback(
      { ...baseAuth },
      { kind: 'workflow', recipeName: RECIPE }
    )
    await expect(reIssue()).rejects.toThrow(/missing accessToken or refreshToken/)
  })

  it('aborts and surfaces a fetch error if the server hangs past the timeout', async () => {
    // Simulate hang → AbortController triggers → fetch rejects with AbortError.
    // Attach a .catch() before awaiting to guarantee the rejection is observed
    // synchronously by vitest — fake-timer-driven rejections can otherwise
    // fire after the assertion resolves, leaking an unhandled rejection.
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal as AbortSignal | undefined
          if (!signal) return // shouldn't happen
          signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
    )
    const reIssue = createReIssueTokensCallback(
      { ...baseAuth },
      { kind: 'workflow', recipeName: RECIPE }
    )

    vi.useFakeTimers()
    try {
      const pending = reIssue()
      // Attach rejection handler immediately so vitest observes it.
      const observed = pending.catch(e => e)
      await vi.advanceTimersByTimeAsync(11_000)
      const err = await observed
      expect((err as Error).message).toMatch(/reIssueTokens fetch failed.*aborted/)
    } finally {
      vi.useRealTimers()
    }
  })
})

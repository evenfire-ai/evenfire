import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '../api'

type DeferredResponse = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  signal: AbortSignal | undefined
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('apiGet stream revalidation and request deduplication', () => {
  let requests: DeferredResponse[]
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    requests = []
    fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        requests.push({ resolve, reject, signal: init?.signal ?? undefined })
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted', 'AbortError')),
          { once: true }
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('bypasses a stale in-flight GET and returns the fresh authoritative response', async () => {
    const path = '/api/v1/gfs/resources/current/children'
    const query = { drive: 'main' }
    const staleRead = apiGet(path, query)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const streamTriggeredRead = apiGet(path, query, { signal: controller.signal })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(requests[1]?.signal).toBeInstanceOf(AbortSignal)
    requests[1]!.resolve(jsonResponse({ revision: 'committed-current-state' }))

    await expect(streamTriggeredRead).resolves.toEqual({
      revision: 'committed-current-state',
    })
    requests[0]!.resolve(jsonResponse({ revision: 'stale-pre-commit-state' }))
    await expect(staleRead).resolves.toEqual({ revision: 'stale-pre-commit-state' })
  })

  it('cancels an obsolete signal-based background read', async () => {
    const controller = new AbortController()
    const request = apiGet('/api/v1/gfs/tree', { drive: 'main' }, { signal: controller.signal })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})

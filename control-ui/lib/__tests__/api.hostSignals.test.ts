import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiSend, getHost, getHostDetailBundle } from '../api'
import { __resetReadRequestCacheForTests } from '../readRequestCache'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Host reads and apiSend signals', () => {
  beforeEach(() => __resetReadRequestCacheForTests())
  afterEach(() => {
    __resetReadRequestCacheForTests()
    vi.unstubAllGlobals()
  })

  it('getHost without a signal joins an in-flight GET', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ name: 'h' }))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([getHost('h'), getHost('h')])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('getHost with a signal does not join an in-flight GET', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ name: 'h' }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await Promise.all([getHost('h'), getHost('h', { signal: controller.signal })])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('getHostDetailBundle with a signal does not join an in-flight GET', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ host: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await Promise.all([
      getHostDetailBundle('h'),
      getHostDetailBundle('h', { signal: controller.signal }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("apiSend rejects with AbortError when the caller's signal aborts", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const pending = apiSend(
      'PUT',
      '/api/v1/admin/hosts/h',
      { a: 1 },
      {},
      {},
      {
        signal: controller.signal,
      }
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('existing one-argument callers still work', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getHost('h')).resolves.toEqual({ ok: true })
    await expect(getHostDetailBundle('h')).resolves.toEqual({ ok: true })
    await expect(apiSend('POST', '/api/v1/x', { a: 1 })).resolves.toEqual({ ok: true })
    await expect(
      apiSend('POST', '/api/v1/x', { a: 1 }, {}, {}, { timeoutMs: 5000 })
    ).resolves.toEqual({
      ok: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiGet,
  apiSend,
  clearAdminAuthToken,
  loginControlUI,
  setControlUIReadPrincipal,
  setGlobalAuthErrorHandler,
} from '../api'
import { patchCodexCatalogModel } from '../codexSubscription'
import {
  __resetReadRequestCacheForTests,
  getReadRequestCacheEntry,
  getReadRequestPrincipal,
  invalidateReadRequestCache,
  setReadRequestCacheEntry,
} from '../readRequestCache'

const metadataOptions = { metadataRead: 'subscription-capabilities' } as const

function success(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function throttled(retryAfterSeconds = 12): Response {
  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      code: 'rate_limited',
      message: `This request limit has been reached. Try again in ${retryAfterSeconds} seconds.`,
      retryAfterSeconds,
    }),
    {
      status: 429,
      statusText: '',
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    }
  )
}

describe('bounded metadata read reuse', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    __resetReadRequestCacheForTests()
    setControlUIReadPrincipal('admin-one', 'admin')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    __resetReadRequestCacheForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setGlobalAuthErrorHandler(undefined)
  })

  it('deduplicates simultaneous metadata reads and expires the result after thirty seconds', async () => {
    fetchMock.mockReturnValue(new Promise(resolve => resolve(success({ value: 'first' }))))
    const first = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    const second = apiGet('/api/v1/admin/metadata', {}, metadataOptions)

    await expect(first).resolves.toEqual({ value: 'first' })
    await expect(second).resolves.toEqual({ value: 'first' })
    expect(fetchMock).toHaveBeenCalledOnce()

    fetchMock.mockClear()
    fetchMock.mockReturnValue(new Promise(resolve => resolve(success({ value: 'second' }))))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      value: 'first',
    })
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_001)
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      value: 'second',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('forces a metadata refresh past the cache and invalidates after a relevant mutation', async () => {
    fetchMock
      .mockResolvedValueOnce(success({ revision: 1 }))
      .mockResolvedValueOnce(success({ revision: 2 }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      revision: 1,
    })
    await expect(
      apiGet('/api/v1/admin/metadata', {}, { ...metadataOptions, refresh: true })
    ).resolves.toEqual({ revision: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(success({ models: [] }))
    await patchCodexCatalogModel('team-subscription', 'model-one', true)
    fetchMock.mockResolvedValueOnce(success({ revision: 3 }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      revision: 3,
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('bounds the metadata cache to one hundred twenty-eight entries', async () => {
    for (let index = 0; index <= 128; index += 1) {
      fetchMock.mockResolvedValueOnce(success({ index }))
      await apiGet(`/api/v1/admin/metadata/${index}`, {}, metadataOptions)
    }
    expect(fetchMock).toHaveBeenCalledTimes(129)

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(success({ index: 'fresh-first' }))
    await expect(apiGet('/api/v1/admin/metadata/0', {}, metadataOptions)).resolves.toEqual({
      index: 'fresh-first',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('shares one cooldown and at most one recovery after Retry-After', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(throttled(12)))
    const firstError = (await apiGet('/api/v1/admin/throttled', {}, metadataOptions).catch(
      reason => reason
    )) as Error & { retryAfterSeconds?: number }

    expect(firstError.message).toBe('This request limit has been reached. Try again in 12 seconds.')
    expect(firstError.retryAfterSeconds).toBe(12)

    const immediateError = (await apiGet('/api/v1/admin/throttled', {}, metadataOptions).catch(
      reason => reason
    )) as Error
    expect(immediateError).toBe(firstError)
    expect(fetchMock).toHaveBeenCalledOnce()

    fetchMock.mockImplementationOnce(() => Promise.resolve(throttled(12)))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(24_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares the denied subscription-read quota across URLs and forced refreshes', async () => {
    fetchMock.mockResolvedValueOnce(throttled(12))
    const error = await apiGet('/api/v1/admin/capabilities', {}, metadataOptions).catch(
      reason => reason
    )
    await expect(
      apiGet(
        '/api/v1/admin/connections',
        {},
        {
          metadataRead: 'subscription-connections',
          refresh: true,
        }
      )
    ).rejects.toBe(error)
    await expect(
      apiGet(
        '/api/v1/admin/models',
        {},
        {
          metadataRead: 'subscription-model-catalog',
        }
      )
    ).rejects.toBe(error)
    expect(fetchMock).toHaveBeenCalledOnce()

    let resolveRecovery!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolveRecovery = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const connections = apiGet(
      '/api/v1/admin/connections',
      {},
      {
        metadataRead: 'subscription-connections',
      }
    )
    const models = apiGet(
      '/api/v1/admin/models',
      {},
      {
        metadataRead: 'subscription-model-catalog',
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock
      .mockResolvedValueOnce(success({ connections: [] }))
      .mockResolvedValueOnce(success({ models: [] }))
    resolveRecovery(success({ providers: {} }))
    await expect(connections).resolves.toEqual({ connections: [] })
    await expect(models).resolves.toEqual({ models: [] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('deduplicates signalled readers while cancelling only the abandoned subscriber', async () => {
    let resolveFetch!: (response: Response) => void
    let physicalSignal: AbortSignal | undefined
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) => {
      physicalSignal = init.signal ?? undefined
      return new Promise<Response>(resolve => {
        resolveFetch = resolve
      })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = apiGet(
      '/api/v1/admin/metadata',
      {},
      { ...metadataOptions, signal: firstController.signal }
    )
    const second = apiGet(
      '/api/v1/admin/metadata',
      {},
      { ...metadataOptions, signal: secondController.signal }
    )
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    firstController.abort()
    await cancelled
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(physicalSignal?.aborted).toBe(false)
    resolveFetch(success({ stillVisible: true }))
    await expect(second).resolves.toEqual({ stillVisible: true })
  })

  it('starts a fresh GET when a new mount arrives just after the last old subscriber cancelled', async () => {
    const old = new AbortController()
    fetchMock
      .mockImplementationOnce(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () =>
              reject(new DOMException('Cancelled', 'AbortError'))
            )
          })
      )
      .mockResolvedValueOnce(success({ revision: 'fresh-mount' }))
    const oldRead = apiGet('/api/v1/admin/metadata', {}, { ...metadataOptions, signal: old.signal })
    const rejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' })
    old.abort()
    const freshRead = apiGet(
      '/api/v1/admin/metadata',
      {},
      { ...metadataOptions, signal: new AbortController().signal }
    )
    await rejected
    await expect(freshRead).resolves.toEqual({ revision: 'fresh-mount' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cancels the physical GET after its last subscriber leaves and cancels an unmounted recovery', async () => {
    const controller = new AbortController()
    let physicalSignal!: AbortSignal
    fetchMock.mockImplementationOnce((_url: unknown, init: RequestInit) => {
      physicalSignal = init.signal!
      return new Promise((_resolve, reject) => {
        physicalSignal.addEventListener('abort', () =>
          reject(new DOMException('Cancelled', 'AbortError'))
        )
      })
    })
    const pending = apiGet(
      '/api/v1/admin/metadata',
      {},
      { ...metadataOptions, signal: controller.signal }
    )
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(physicalSignal.aborted).toBe(true)

    const mounted = new AbortController()
    fetchMock.mockResolvedValueOnce(throttled(12))
    await expect(
      apiGet(
        '/api/v1/admin/capabilities',
        {},
        {
          ...metadataOptions,
          signal: mounted.signal,
        }
      )
    ).rejects.toMatchObject({ status: 429 })
    mounted.abort()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not result-cache general reads or automatically replay mutations', async () => {
    fetchMock
      .mockResolvedValueOnce(success({ revision: 1 }))
      .mockResolvedValueOnce(success({ revision: 2 }))
    await expect(apiGet('/api/v1/admin/hosts')).resolves.toEqual({ revision: 1 })
    await expect(apiGet('/api/v1/admin/hosts')).resolves.toEqual({ revision: 2 })
    fetchMock.mockResolvedValueOnce(throttled(12))
    await expect(apiSend('POST', '/api/v1/admin/explicit-action')).rejects.toMatchObject({
      status: 429,
    })
    await vi.advanceTimersByTimeAsync(24_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps a read-family cooldown after a successful independent subscription mutation', async () => {
    fetchMock.mockResolvedValueOnce(throttled(12))
    const denied = await apiGet('/api/v1/admin/capabilities', {}, metadataOptions).catch(
      reason => reason
    )
    fetchMock.mockResolvedValueOnce(success({ models: [] }))
    await patchCodexCatalogModel('team-subscription', 'model-one', true)
    await expect(
      apiGet(
        '/api/v1/admin/connections',
        {},
        { metadataRead: 'subscription-connections', refresh: true }
      )
    ).rejects.toBe(denied)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the latest family deadline and keeps recovery while another denied reader is still mounted', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    fetchMock.mockResolvedValueOnce(throttled(12)).mockResolvedValueOnce(throttled(20))
    await Promise.all([
      apiGet(
        '/api/v1/admin/capabilities',
        {},
        { ...metadataOptions, signal: firstController.signal }
      ).catch(() => undefined),
      apiGet(
        '/api/v1/admin/connections',
        {},
        { metadataRead: 'subscription-connections', signal: secondController.signal }
      ).catch(() => undefined),
    ])
    firstController.abort()
    fetchMock.mockResolvedValueOnce(success({ recovered: true }))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(apiGet('/api/v1/admin/capabilities', {}, metadataOptions)).resolves.toEqual({
      recovered: true,
    })
  })

  it('makes only one recovery when throttle timing is unavailable', async () => {
    const noTiming = () =>
      new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 })
    fetchMock.mockImplementation(() => Promise.resolve(noTiming()))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).rejects.toMatchObject({
      status: 429,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clears metadata on an epoch change and broadcasts only a non-sensitive invalidation', async () => {
    const listener = new BroadcastChannel('control-ui-read-metadata-invalidation')
    const received: unknown[] = []
    listener.onmessage = event => received.push(event.data)

    fetchMock.mockResolvedValueOnce(success({ principal: 'one' }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      principal: 'one',
    })

    clearAdminAuthToken()
    await vi.advanceTimersByTimeAsync(0)
    expect(received).toEqual([{ type: 'session-invalidation' }])
    expect(JSON.stringify(received)).not.toContain('admin-one')

    setControlUIReadPrincipal('admin-one', 'admin')
    setControlUIReadPrincipal('admin-two', 'admin')
    await vi.advanceTimersByTimeAsync(0)
    expect(received).toEqual([{ type: 'session-invalidation' }, { type: 'session-invalidation' }])

    fetchMock.mockResolvedValueOnce(success({ principal: 'two' }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      principal: 'two',
    })
    listener.close()
  })

  it('invalidates on a remote session change without rebroadcast or caching an unverified identity', async () => {
    const remoteTab = new BroadcastChannel('control-ui-read-metadata-invalidation')
    const rebroadcasts: unknown[] = []
    remoteTab.onmessage = event => rebroadcasts.push(event.data)
    fetchMock.mockResolvedValueOnce(success({ revision: 'old-tab' }))
    await apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    remoteTab.postMessage({ type: 'session-invalidation' })
    await vi.advanceTimersByTimeAsync(0)
    expect(getReadRequestPrincipal()).toBeNull()
    expect(rebroadcasts).toEqual([])
    fetchMock
      .mockResolvedValueOnce(success({ revision: 'new-tab' }))
      .mockResolvedValueOnce(success({ revision: 'fresh' }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      revision: 'new-tab',
    })
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      revision: 'fresh',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    remoteTab.close()
  })

  it('clears cached reads on successful login even when the principal is unchanged', async () => {
    fetchMock.mockResolvedValueOnce(success({ revision: 1 }))
    await apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    fetchMock.mockResolvedValueOnce(success({ me: { id: 'admin-one', role: 'admin' } }))
    await loginControlUI('operator', 'unit-test-password')
    setControlUIReadPrincipal('admin-one', 'admin')
    fetchMock.mockResolvedValueOnce(success({ revision: 2 }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      revision: 2,
    })
  })

  it('invalidates a scope change for the same verified principal', async () => {
    fetchMock.mockResolvedValueOnce(success({ scope: 'first' }))
    await apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    setControlUIReadPrincipal('admin-one', 'admin:second-scope')
    fetchMock.mockResolvedValueOnce(success({ scope: 'second' }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      scope: 'second',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('binds browser metadata to the API origin instead of reusing another origin response', async () => {
    fetchMock.mockResolvedValueOnce(success({ origin: 'first' }))
    await apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    const originalWindow = globalThis.window
    vi.stubGlobal('window', { location: { origin: 'https://other-control.example.test' } })
    try {
      fetchMock.mockResolvedValueOnce(success({ origin: 'second' }))
      await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
        origin: 'second',
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.stubGlobal('window', originalWindow)
    }
  })

  it('fences old errors and 401 responses before they can invalidate the new principal', async () => {
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolveFetch = resolve
        })
    )
    const authExpired = vi.fn()
    setGlobalAuthErrorHandler(authExpired)
    const oldRead = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    const rejected = expect(oldRead).rejects.toMatchObject({ name: 'AuthExpiredError' })
    setControlUIReadPrincipal('admin-two', 'admin')
    resolveFetch(new Response('{}', { status: 401 }))
    await rejected
    expect(authExpired).not.toHaveBeenCalled()
    expect(getReadRequestPrincipal()?.principalId).toBe('admin-two')
  })

  it('fences a delayed response body and a metadata mutation before result delivery', async () => {
    let resolveBody!: (value: string) => void
    const response = success({})
    vi.spyOn(response, 'text').mockImplementation(
      () =>
        new Promise(resolve => {
          resolveBody = resolve
        })
    )
    fetchMock.mockResolvedValueOnce(response)
    const pending = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    await vi.advanceTimersByTimeAsync(0)
    invalidateReadRequestCache()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resolveBody(JSON.stringify({ revision: 'before-mutation' }))
    await rejected
    fetchMock.mockResolvedValueOnce(success({ revision: 'after-mutation' }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      revision: 'after-mutation',
    })
  })

  it('rejects a late old-principal response before caching or delivering it to the new identity', async () => {
    let resolveFetch!: (response: Response) => void
    fetchMock.mockReturnValue(
      new Promise<Response>(resolve => {
        resolveFetch = resolve
      })
    )
    const staleRead = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledOnce()

    setControlUIReadPrincipal('admin-two', 'admin')
    resolveFetch(success({ principal: 'one' }))
    await expect(staleRead).rejects.toMatchObject({ name: 'AuthExpiredError' })

    fetchMock.mockResolvedValueOnce(success({ principal: 'two' }))
    await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
      principal: 'two',
    })
  })

  it('does not retain or deduplicate opt-in metadata during SSR execution', async () => {
    const originalWindow = globalThis.window
    vi.stubGlobal('window', undefined)
    try {
      setReadRequestCacheEntry('ssr-key', { value: 'must-not-cache' }, 30_000)
      expect(getReadRequestCacheEntry('ssr-key')).toBeUndefined()
      fetchMock
        .mockResolvedValueOnce(success({ principal: 'server-one' }))
        .mockResolvedValueOnce(success({ principal: 'server-two' }))
      const first = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
      const second = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
      await expect(first).resolves.toEqual({ principal: 'server-one' })
      await expect(second).resolves.toEqual({ principal: 'server-two' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.stubGlobal('window', originalWindow)
    }
  })
})

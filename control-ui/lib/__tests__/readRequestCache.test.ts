import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiGet,
  apiSend,
  clearAdminAuthToken,
  loginControlUI,
  logoutControlUI,
  setControlUIReadPrincipal,
  setGlobalAuthErrorHandler,
} from '../api'
import { patchCodexCatalogModel } from '../codexSubscription'
import {
  __resetReadRequestCacheForTests,
  getReadRequestCacheEntry,
  getReadRequestPrincipal,
  getReadRequestSessionIdentity,
  invalidateReadRequestCache,
  invalidateReadRequestCacheEntry,
  reserveReadRequestRecovery,
  scheduleReadRequestRetry,
  setReadRequestCacheEntry,
  setReadRequestCooldown,
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

    // The newest and the oldest retained entries are served from the cache, so
    // the bound evicts exactly one entry rather than caching nothing.
    fetchMock.mockClear()
    await expect(apiGet('/api/v1/admin/metadata/128', {}, metadataOptions)).resolves.toEqual({
      index: 128,
    })
    await expect(apiGet('/api/v1/admin/metadata/1', {}, metadataOptions)).resolves.toEqual({
      index: 1,
    })
    expect(fetchMock).not.toHaveBeenCalled()

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
    fetchMock
      .mockResolvedValueOnce(success({ recovered: true }))
      .mockResolvedValueOnce(success({ connections: ['recovered'] }))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Both URLs were denied, so the one recovery rereads each of them once.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await expect(apiGet('/api/v1/admin/capabilities', {}, metadataOptions)).resolves.toEqual({
      recovered: true,
    })
    await expect(
      apiGet('/api/v1/admin/connections', {}, { metadataRead: 'subscription-connections' })
    ).resolves.toEqual({ connections: ['recovered'] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('rereads every URL the server denied while the family recovery was scheduled', async () => {
    const codexUrl = '/api/v1/admin/codex-subscription/connections'
    const grokUrl = '/api/v1/admin/grok-subscription/connections'
    const connectionOptions = { metadataRead: 'subscription-connections' } as const
    const pending: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          pending.push(resolve)
        })
    )
    // Both inventories are in flight before either denial arrives, as when an
    // Agent page loads its Codex and Grok connections together.
    const codex = apiGet(codexUrl, {}, connectionOptions).catch(reason => reason)
    const grok = apiGet(grokUrl, {}, connectionOptions).catch(reason => reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(pending).toHaveLength(2)
    pending[0](throttled(12))
    pending[1](throttled(12))
    expect(await codex).toMatchObject({ status: 429 })
    expect(await grok).toMatchObject({ status: 429 })

    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(success({ from: url.includes('grok') ? 'grok' : 'codex' }))
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const recoveredUrls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(recoveredUrls).toHaveLength(2)
    expect(recoveredUrls.filter(url => url.endsWith(codexUrl))).toHaveLength(1)
    expect(recoveredUrls.filter(url => url.endsWith(grokUrl))).toHaveLength(1)

    // A Retry after the recovery is served from the recovered entries, so it
    // cannot spend a third read in the same window.
    await expect(apiGet(codexUrl, {}, connectionOptions)).resolves.toEqual({ from: 'codex' })
    await expect(apiGet(grokUrl, {}, connectionOptions)).resolves.toEqual({ from: 'grok' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops the family recovery at the first member the server denies again', async () => {
    const codexUrl = '/api/v1/admin/codex-subscription/connections'
    const grokUrl = '/api/v1/admin/grok-subscription/connections'
    const connectionOptions = { metadataRead: 'subscription-connections' } as const
    const pending: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          pending.push(resolve)
        })
    )
    const codex = apiGet(codexUrl, {}, connectionOptions).catch(reason => reason)
    const grok = apiGet(grokUrl, {}, connectionOptions).catch(reason => reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(pending).toHaveLength(2)
    pending[0](throttled(12))
    pending[1](throttled(12))
    expect(await codex).toMatchObject({ status: 429 })
    expect(await grok).toMatchObject({ status: 429 })

    fetchMock.mockReset()
    fetchMock.mockImplementation(() => Promise.resolve(throttled(12)))
    await vi.advanceTimersByTimeAsync(12_000)
    // The first reread is denied, which restores the family cooldown; the
    // second member is not sent into it, and no further attempt is scheduled.
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/codex-subscription\/connections$/)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('never sends the remaining members into the cooldown restored by a member denied again', async () => {
    // Drives the recovery directly: through apiGet the second member would be
    // refused locally by the restored cooldown and send nothing either way.
    const familyKey = 'family-under-test'
    const denial = Object.assign(new Error('denied again'), { status: 429 })
    const firstMember = vi.fn(() => Promise.reject(denial))
    const secondMember = vi.fn(() => Promise.resolve(undefined))
    const interest = new AbortController()
    const deadlineMs = Date.now() + 1_000
    expect(
      reserveReadRequestRecovery(familyKey, deadlineMs, 'first', firstMember, [interest.signal])
    ).toBe(true)
    expect(
      reserveReadRequestRecovery(familyKey, deadlineMs, 'second', secondMember, [interest.signal])
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    // Witness: the recovery ran and reread the first member.
    expect(firstMember).toHaveBeenCalledOnce()
    expect(secondMember).not.toHaveBeenCalled()
    // The denied attempt released its reservation for the next denial.
    expect(
      reserveReadRequestRecovery(familyKey, Date.now() + 1_000, 'first', firstMember, [
        interest.signal,
      ])
    ).toBe(true)
  })

  it('gives a waiter its own recovered result when a later member is denied again', async () => {
    const codexUrl = '/api/v1/admin/codex-subscription/connections'
    const grokUrl = '/api/v1/admin/grok-subscription/connections'
    const connectionOptions = { metadataRead: 'subscription-connections' } as const
    const pending: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          pending.push(resolve)
        })
    )
    const codexConsumer = new AbortController()
    const grokConsumer = new AbortController()
    const codex = apiGet(codexUrl, {}, { ...connectionOptions, signal: codexConsumer.signal })
    const grok = apiGet(grokUrl, {}, { ...connectionOptions, signal: grokConsumer.signal })
    await vi.advanceTimersByTimeAsync(0)
    pending.splice(0).forEach(resolve => resolve(throttled(12)))
    await expect(codex).rejects.toMatchObject({ status: 429 })
    await expect(grok).rejects.toMatchObject({ status: 429 })

    await vi.advanceTimersByTimeAsync(12_000)
    expect(pending).toHaveLength(1)
    const codexWaiter = apiGet(codexUrl, {}, { ...connectionOptions, signal: codexConsumer.signal })
    const grokWaiter = apiGet(grokUrl, {}, { ...connectionOptions, signal: grokConsumer.signal })
    const codexOutcome = codexWaiter.then(
      value => ({ value }),
      reason => ({ reason })
    )
    const grokOutcome = grokWaiter.then(
      value => ({ value }),
      reason => ({ reason })
    )
    pending.shift()?.(success({ from: 'codex' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(pending).toHaveLength(1)
    pending.shift()?.(throttled(12))

    // Codex was reread before Grok's denial and receives its own result; Grok's
    // waiter receives the denial that ended the recovery.
    expect(await codexOutcome).toEqual({ value: { from: 'codex' } })
    expect(await grokOutcome).toMatchObject({ reason: { status: 429 } })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('reads for a waiter without a signal when every registered interest cancels the recovery', async () => {
    const pending: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          pending.push(resolve)
        })
    )
    const mounted = new AbortController()
    const first = apiGet(
      '/api/v1/admin/metadata',
      {},
      { ...metadataOptions, signal: mounted.signal }
    )
    await vi.advanceTimersByTimeAsync(0)
    pending.shift()?.(throttled(2))
    await expect(first).rejects.toMatchObject({ status: 429 })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(pending).toHaveLength(1)
    // A consumer such as the feature probes has no signal and cannot be
    // registered as an interest.
    const unsignalled = apiGet('/api/v1/admin/metadata', {}, metadataOptions)
    const outcome = unsignalled.then(
      value => ({ value }),
      reason => ({ reason })
    )
    mounted.abort()
    await vi.advanceTimersByTimeAsync(0)
    // The cancelled recovery leaves it a read of its own.
    expect(pending).toHaveLength(2)
    pending[1](success({ value: 'own read' }))
    expect(await outcome).toEqual({ value: { value: 'own read' } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps a late recovery scheduled when a URL outside it succeeds', async () => {
    const codexUrl = '/api/v1/admin/codex-subscription/connections'
    const grokUrl = '/api/v1/admin/grok-subscription/connections'
    const connectionOptions = { metadataRead: 'subscription-connections' } as const
    const pending = new Map<string, (response: Response) => void>()
    fetchMock.mockImplementation(
      (input: RequestInfo | URL) =>
        new Promise<Response>(resolve => {
          pending.set(String(input).includes('grok') ? 'grok' : 'codex', resolve)
        })
    )
    const codex = apiGet(codexUrl, {}, connectionOptions)
    const grok = apiGet(grokUrl, {}, connectionOptions)
    await vi.advanceTimersByTimeAsync(0)
    pending.get('codex')?.(throttled(12))
    await expect(codex).rejects.toMatchObject({ status: 429 })

    // A background tab runs the recovery timer late: the clock passes the
    // deadline before the timer fires, and the slow Grok read succeeds first.
    vi.setSystemTime(Date.now() + 13_000)
    fetchMock.mockImplementation(() => Promise.resolve(success({ from: 'codex' })))
    pending.get('grok')?.(success({ from: 'grok' }))
    await expect(grok).resolves.toEqual({ from: 'grok' })
    // Fake timers keep their own clock, so the delayed timer fires only now.
    await vi.advanceTimersByTimeAsync(12_000)

    // The Codex member is still reread.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/codex-subscription\/connections$/)
    await expect(apiGet(codexUrl, {}, connectionOptions)).resolves.toEqual({ from: 'codex' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('moves the retry time of every earlier denial when a later one extends the cooldown', () => {
    const familyKey = 'family-under-test'
    const startedAt = Date.now()
    const earlier = Object.assign(new Error('earlier'), { status: 429 })
    const later = Object.assign(new Error('later'), { status: 429 })
    expect(setReadRequestCooldown(familyKey, earlier, 12, startedAt)).toBe(12_000)
    expect(setReadRequestCooldown(familyKey, later, 12, startedAt + 500)).toBe(12_000)
    expect(later.retryAtMs).toBe(startedAt + 12_500)
    expect(earlier.retryAtMs).toBe(startedAt + 12_500)

    // A denial after the cooldown expired starts a new window and leaves the
    // errors of the expired one alone.
    const next = Object.assign(new Error('next'), { status: 429 })
    setReadRequestCooldown(familyKey, next, 12, startedAt + 20_000)
    expect(next.retryAtMs).toBe(startedAt + 32_000)
    expect(earlier.retryAtMs).toBe(startedAt + 12_500)
  })

  it('schedules a retry at the extended time instead of the time first issued', async () => {
    const familyKey = 'family-under-test'
    const startedAt = Date.now()
    const earlier = Object.assign(new Error('earlier'), { status: 429 })
    setReadRequestCooldown(familyKey, earlier, 12, startedAt)
    const retry = vi.fn()
    scheduleReadRequestRetry(earlier, retry)
    await vi.advanceTimersByTimeAsync(500)
    setReadRequestCooldown(
      familyKey,
      Object.assign(new Error('later'), { status: 429 }),
      12,
      startedAt + 500
    )
    await vi.advanceTimersByTimeAsync(11_500)
    expect(retry).not.toHaveBeenCalled()
    // Witness: the retry runs once the extended time is reached.
    await vi.advanceTimersByTimeAsync(500)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('waits for the family recovery already rereading before it re-runs the consumer', async () => {
    const path = '/api/v1/admin/connections'
    const connections = { metadataRead: 'subscription-connections' } as const
    // The recovery's reread stays in flight until released, and rejects on
    // abort the way a browser fetch does.
    let releaseReread!: () => void
    let rereadAborted = false
    fetchMock.mockResolvedValueOnce(throttled(12)).mockImplementationOnce(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          releaseReread = () => resolve(success({ connections: ['recovered'] }))
          init?.signal?.addEventListener('abort', () => {
            rereadAborted = true
            reject(new DOMException('The read was cancelled', 'AbortError'))
          })
        })
    )
    // The consumer's effect: its cleanup aborts the signal registered as the
    // recovery's interest, then the effect reads again.
    const effect = new AbortController()
    let denial: unknown
    await apiGet(path, {}, { ...connections, signal: effect.signal }).catch(error => {
      denial = error
    })
    expect(denial).toMatchObject({ status: 429 })
    const rerun = vi.fn(() => {
      effect.abort()
      return apiGet(path, {}, connections)
    })
    // Scheduled after the recovery, as the consumer does, so at the shared
    // deadline the recovery's timer fires first and its reread is in flight
    // when this one fires.
    scheduleReadRequestRetry(denial as Parameters<typeof scheduleReadRequestRetry>[0], rerun)

    await vi.advanceTimersByTimeAsync(12_000)
    // Witness: the recovery is rereading at the deadline.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(rerun).not.toHaveBeenCalled()
    expect(rereadAborted).toBe(false)

    releaseReread()
    await vi.advanceTimersByTimeAsync(0)
    // The consumer re-runs once the recovery settled, and the recovered entry
    // serves its read.
    expect(rerun).toHaveBeenCalledOnce()
    await expect(rerun.mock.results[0]?.value).resolves.toEqual({ connections: ['recovered'] })
    expect(rereadAborted).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('changes the session identity only when the confirmed principal changes', () => {
    const start = getReadRequestSessionIdentity()
    setReadRequestCacheEntry('entry', { value: 1 }, 30_000)
    invalidateReadRequestCache()
    invalidateReadRequestCacheEntry('entry')
    setControlUIReadPrincipal('admin-one', 'admin')
    expect(getReadRequestSessionIdentity()).toBe(start)
    // Witness: a different principal does change it.
    setControlUIReadPrincipal('admin-two', 'admin')
    expect(getReadRequestSessionIdentity()).toBe(start + 1)
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

  it('schedules one recovery for a later denial after a recovery was itself denied', async () => {
    const path = '/api/v1/admin/connections'
    const connections = { metadataRead: 'subscription-connections' } as const
    fetchMock.mockResolvedValueOnce(throttled(12)).mockResolvedValueOnce(throttled(12))
    await expect(apiGet(path, {}, connections)).rejects.toMatchObject({ status: 429 })
    await vi.advanceTimersByTimeAsync(12_000)
    // The single recovery ran and was denied; it does not schedule another.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock
      .mockResolvedValueOnce(throttled(12))
      .mockResolvedValueOnce(success({ connections: ['recovered'] }))
    await expect(apiGet(path, {}, connections)).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[3][0])).toContain(path)
    await expect(apiGet(path, {}, connections)).resolves.toEqual({ connections: ['recovered'] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  describe('consumers refused by the family cooldown', () => {
    const connections = '/api/v1/admin/connections'
    const models = '/api/v1/admin/models'

    async function denyFirstConsumer(signal: AbortSignal) {
      fetchMock.mockResolvedValueOnce(throttled(2))
      await expect(
        apiGet(connections, {}, { metadataRead: 'subscription-connections', signal })
      ).rejects.toMatchObject({ status: 429 })
    }

    it.each([
      ['the same URL', connections],
      ['a different URL in the same family', models],
    ])(
      'keep the recovery alive after the first consumer leaves (%s)',
      async (_label, joinedPath) => {
        const first = new AbortController()
        const second = new AbortController()
        await denyFirstConsumer(first.signal)
        await vi.advanceTimersByTimeAsync(1_000)
        await expect(
          apiGet(
            joinedPath,
            {},
            { metadataRead: 'subscription-model-catalog', signal: second.signal }
          )
        ).rejects.toMatchObject({ status: 429 })
        // Joining sends nothing.
        expect(fetchMock).toHaveBeenCalledOnce()

        first.abort()
        fetchMock.mockResolvedValueOnce(success({ connections: ['recovered'] }))
        // The original deadline (t = 2 s) still applies: joining at t = 1 s
        // neither extended it nor added a second attempt.
        await vi.advanceTimersByTimeAsync(1_000)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/api\/v1\/admin\/connections$/)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(fetchMock).toHaveBeenCalledTimes(2)
      }
    )

    it('cancel the recovery once every registered consumer has left', async () => {
      const first = new AbortController()
      const second = new AbortController()
      await denyFirstConsumer(first.signal)
      await expect(
        apiGet(models, {}, { metadataRead: 'subscription-model-catalog', signal: second.signal })
      ).rejects.toMatchObject({ status: 429 })
      // Witness: the denial scheduled the recovery, so "no reread" below
      // means it was cancelled, not that it never existed.
      expect(vi.getTimerCount()).toBe(1)
      first.abort()
      expect(vi.getTimerCount()).toBe(1)
      second.abort()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('do not hold the recovery alive when they have no signal to observe', async () => {
      const first = new AbortController()
      await denyFirstConsumer(first.signal)
      await expect(
        apiGet(models, {}, { metadataRead: 'subscription-model-catalog' })
      ).rejects.toMatchObject({ status: 429 })
      expect(fetchMock).toHaveBeenCalledOnce()
      // Witness: the recovery was scheduled before the only registered
      // consumer left.
      expect(vi.getTimerCount()).toBe(1)
      first.abort()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  it('keeps a running recovery alive for a consumer waiting on it after the deadline', async () => {
    const path = '/api/v1/admin/connections'
    const connectionOptions = { metadataRead: 'subscription-connections' } as const
    const first = new AbortController()
    const waiter = new AbortController()
    fetchMock.mockResolvedValueOnce(throttled(2))
    await expect(
      apiGet(path, {}, { ...connectionOptions, signal: first.signal })
    ).rejects.toMatchObject({ status: 429 })
    let finishReread!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          finishReread = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(2_000)
    // The recovery is running: its reread is in flight.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const waiting = apiGet(path, {}, { ...connectionOptions, signal: waiter.signal })
    await vi.advanceTimersByTimeAsync(0)
    // The consumer that scheduled the recovery leaves while another waits on it.
    first.abort()
    finishReread(success({ connections: ['recovered'] }))
    await expect(waiting).resolves.toEqual({ connections: ['recovered'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('schedules a recovery for a remount after every earlier subscriber left', async () => {
    const path = '/api/v1/admin/connections'
    const firstMount = new AbortController()
    fetchMock.mockResolvedValueOnce(throttled(12))
    await expect(
      apiGet(path, {}, { metadataRead: 'subscription-connections', signal: firstMount.signal })
    ).rejects.toMatchObject({ status: 429 })
    firstMount.abort()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const secondMount = new AbortController()
    fetchMock
      .mockResolvedValueOnce(throttled(12))
      .mockResolvedValueOnce(success({ connections: ['remounted'] }))
    await expect(
      apiGet(path, {}, { metadataRead: 'subscription-connections', signal: secondMount.signal })
    ).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(apiGet(path, {}, { metadataRead: 'subscription-connections' })).resolves.toEqual({
      connections: ['remounted'],
    })
  })

  it('clears metadata on an epoch change and broadcasts only a non-sensitive invalidation', async () => {
    const listener = new BroadcastChannel('control-ui-read-metadata-invalidation')
    const received: unknown[] = []
    listener.onmessage = event => received.push(event.data)
    const sends = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
    try {
      fetchMock.mockResolvedValueOnce(success({ principal: 'one' }))
      await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
        principal: 'one',
      })

      clearAdminAuthToken()
      expect(sends).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(received).toEqual([{ type: 'session-invalidation' }]))
      expect(JSON.stringify(received)).not.toContain('admin-one')

      setControlUIReadPrincipal('admin-one', 'admin')
      setControlUIReadPrincipal('admin-two', 'admin')
      expect(sends).toHaveBeenCalledTimes(2)
      await vi.waitFor(() =>
        expect(received).toEqual([
          { type: 'session-invalidation' },
          { type: 'session-invalidation' },
        ])
      )

      fetchMock.mockResolvedValueOnce(success({ principal: 'two' }))
      await expect(apiGet('/api/v1/admin/metadata', {}, metadataOptions)).resolves.toEqual({
        principal: 'two',
      })
    } finally {
      listener.close()
    }
  })

  it('invalidates on a remote session change without rebroadcast or caching an unverified identity', async () => {
    const remoteTab = new BroadcastChannel('control-ui-read-metadata-invalidation')
    try {
      fetchMock.mockResolvedValueOnce(success({ revision: 'old-tab' }))
      await apiGet('/api/v1/admin/metadata', {}, metadataOptions)
      const sends = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
      remoteTab.postMessage({ type: 'session-invalidation' })
      // Witness: the message was delivered and this tab dropped its principal.
      await vi.waitFor(() => expect(getReadRequestPrincipal()).toBeNull())
      expect(sends.mock.contexts.filter(channel => channel !== remoteTab)).toHaveLength(0)
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
    } finally {
      remoteTab.close()
    }
  })

  it('answers the post-invalidation 401 locally so logged-out tabs cannot invalidate each other forever', async () => {
    const remoteTab = new BroadcastChannel('control-ui-read-metadata-invalidation')
    const received: unknown[] = []
    remoteTab.onmessage = event => received.push(event.data)
    const sends = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
    const sentByThisTab = () => sends.mock.contexts.filter(channel => channel !== remoteTab).length
    try {
      // The other tab logged out: this tab drops its principal on the message.
      remoteTab.postMessage({ type: 'session-invalidation' })
      await vi.waitFor(() => expect(getReadRequestPrincipal()).toBeNull())

      // Its /auth/me re-check now answers 401, which clears the token again.
      setReadRequestCacheEntry('post-invalidation-entry', { stale: true }, 30_000)
      clearAdminAuthToken()
      // Witness: the local clear ran and dropped the entry cached after the message.
      expect(getReadRequestCacheEntry('post-invalidation-entry')).toBeUndefined()
      expect(sentByThisTab()).toBe(0)

      // A verified tab that logs out still tells the others exactly once.
      setControlUIReadPrincipal('admin-one', 'admin')
      clearAdminAuthToken()
      expect(sentByThisTab()).toBe(1)
      await vi.waitFor(() => expect(received).toEqual([{ type: 'session-invalidation' }]))
    } finally {
      remoteTab.close()
    }
  })

  it('tells peer tabs about the committed cookie change after a login or logout POST', async () => {
    const peerTab = new BroadcastChannel('control-ui-read-metadata-invalidation')
    const received: unknown[] = []
    peerTab.onmessage = event => received.push(event.data)
    const sends = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
    const invalidation = { type: 'session-invalidation' }
    try {
      let commitLogin: (response: Response) => void = () => {}
      fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => (commitLogin = resolve)))
      const login = loginControlUI('operator', 'unit-test-password')
      // Pre-POST clear of the verified principal; a peer may now reconfirm the old cookie.
      expect(sends).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(received).toEqual([invalidation]))
      commitLogin(success({ me: { id: 'admin-two', role: 'admin' } }))
      await login
      expect(sends).toHaveBeenCalledTimes(2)
      await vi.waitFor(() => expect(received).toEqual([invalidation, invalidation]))

      setControlUIReadPrincipal('admin-two', 'admin')
      sends.mockClear()
      received.length = 0
      let commitLogout: (response: Response) => void = () => {}
      fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => (commitLogout = resolve)))
      const logout = logoutControlUI()
      expect(sends).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(received).toEqual([invalidation]))
      commitLogout(success({ ok: true }))
      await logout
      expect(sends).toHaveBeenCalledTimes(2)
      await vi.waitFor(() => expect(received).toEqual([invalidation, invalidation]))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      peerTab.close()
    }
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PublishScope,
  RegistryProxyError,
  __resetScopeCacheForTests,
  __resetTokenCacheForTests,
  applyPublishScope,
  createOrgGrant,
  downloadBundle,
  getCategories,
  invalidateRegistryIdentityCaches,
  mintToken,
  publishEntry,
  resolvePublishScope,
  searchEntries,
} from '../src/services/registryClient.js'
import { __resetRegistryIdentityCacheGenerationForTests } from '../src/services/registryIdentityCache.js'

// mintToken() with NO envOverride resolves both the active decision and the
// credential pair through this mode-aware dependency. Most tests in this file
// populate process.env; the default mock mirrors managed-mode resolution from
// those values so they exercise the normal client path without rebuilding the
// config singleton.
const connDb = vi.hoisted(() => ({
  resolveMachineCreds: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)

const ORIGINAL_ENV = { ...process.env }

function fakeTokenResponse(token = 'tok-abc', expiresIn = 600) {
  return new Response(
    JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

const ENV_OVERRIDE: NodeJS.ProcessEnv = {
  CLERUM_REGISTRY_URL: 'https://example.com',
  CLERUM_REGISTRY_CLIENT_ID: 'test-client',
  CLERUM_REGISTRY_CLIENT_SECRET: 'test-secret',
  CLERUM_REGISTRY_AUTH_ENABLED: 'true',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(message)
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  __resetRegistryIdentityCacheGenerationForTests()
  __resetTokenCacheForTests()
  __resetScopeCacheForTests()
  connDb.resolveMachineCreds.mockReset().mockImplementation(async () => {
    const clientId = process.env.CLERUM_REGISTRY_CLIENT_ID
    const clientSecret = process.env.CLERUM_REGISTRY_CLIENT_SECRET
    return clientId && clientSecret ? { clientId, clientSecret } : null
  })
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('registryClient — mintToken', () => {
  it('POSTs to /oauth/token on cache miss and returns the access_token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeTokenResponse('tok-1'))
    vi.stubGlobal('fetch', fetchMock)

    const t = await mintToken(ENV_OVERRIDE)

    expect(t).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(init.headers.Authorization).toMatch(/^Basic /)
    expect(init.body).toBe('grant_type=client_credentials')
  })
})

describe('registryClient — mintToken cache behavior', () => {
  it('returns the cached token on subsequent calls (no second POST)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeTokenResponse('tok-2', 600))
    vi.stubGlobal('fetch', fetchMock)

    const a = await mintToken(ENV_OVERRIDE)
    const b = await mintToken(ENV_OVERRIDE)
    expect(a).toBe('tok-2')
    expect(b).toBe('tok-2')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes 30s before expiry', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeTokenResponse('tok-first', 60))
      .mockResolvedValueOnce(fakeTokenResponse('tok-second', 60))
    vi.stubGlobal('fetch', fetchMock)

    const t1 = await mintToken(ENV_OVERRIDE)
    expect(t1).toBe('tok-first')

    // Advance 31s — within the 30s pre-expiry refresh window of a 60s token.
    vi.setSystemTime(Date.now() + 31_000)

    const t2 = await mintToken(ENV_OVERRIDE)
    expect(t2).toBe('tok-second')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns empty string in auth-off mode without making any HTTP call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const t = await mintToken({
      CLERUM_REGISTRY_AUTH_ENABLED: 'false',
      // CLIENT_ID / SECRET intentionally absent
    } as NodeJS.ProcessEnv)
    expect(t).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws clearly when /oauth/token returns 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad creds', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const err = (await mintToken(ENV_OVERRIDE).catch(e => e)) as Error
    expect(err.message).toMatch(/registry credential rejected: 401/)
    expect(err.message).not.toContain('bad creds')
  })

  it('cancels a rejected token response body before throwing', async () => {
    const response = new Response('bad creds', { status: 401 })
    const cancel = vi.spyOn(response.body!, 'cancel')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    await mintToken(ENV_OVERRIDE).catch(() => undefined)

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('keeps the "credential rejected" label on 403 (forbidden creds)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(mintToken(ENV_OVERRIDE)).rejects.toThrow(/registry credential rejected: 403/)
  })

  it('relabels a 5xx at the token endpoint as an origin/tunnel outage (not a bad credential)', async () => {
    // A 5xx here means the registry origin or its tunnel is down — paging
    // on-call to rotate secrets would be the wrong response.
    for (const status of [500, 502, 503, 504]) {
      __resetTokenCacheForTests()
      const fetchMock = vi.fn().mockResolvedValue(new Response('upstream down', { status }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(mintToken(ENV_OVERRIDE)).rejects.toThrow(
        new RegExp(`registry token endpoint unavailable \\(origin/tunnel\\): ${status}`)
      )
      // It must NOT use the credential-rejected wording.
      await expect(mintToken(ENV_OVERRIDE)).rejects.not.toThrow(/credential rejected/)
    }
  })
})

describe('registryClient — bundle response lifecycle', () => {
  it('cancels a non-OK bundle response body before throwing', async () => {
    const response = new Response('bundle missing', { status: 404 })
    const cancel = vi.spyOn(response.body!, 'cancel')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(fakeTokenResponse('bundle-token'))
        .mockResolvedValueOnce(response)
    )
    Object.assign(process.env, ENV_OVERRIDE)

    await downloadBundle('@clerum/example', '1.0.0').catch(() => undefined)

    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('registryClient — mintToken derived auth (no envOverride)', () => {
  // Critical: no ENV_OVERRIDE here. That test-only path intentionally bypasses
  // the mode-aware resolver.
  beforeEach(() => {
    process.env = {
      ...process.env,
      CLERUM_REGISTRY_CLIENT_ID: '',
      CLERUM_REGISTRY_CLIENT_SECRET: '',
    }
  })

  it('returns an empty token when auth is inactive and no creds exist', async () => {
    connDb.resolveMachineCreds.mockResolvedValue(null)
    await expect(mintToken()).resolves.toBe('') // NO ENV_OVERRIDE — see above
    expect(connDb.resolveMachineCreds).toHaveBeenCalledTimes(1)
  })
})

describe('registryClient — authedFetch', () => {
  it('attaches Authorization: Bearer on GET reads', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return Promise.resolve(fakeTokenResponse('tok-r', 600))
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 0, offset: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await searchEntries({})

    const apiCall = fetchMock.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('/entries')
    )
    expect(apiCall).toBeDefined()
    const headers = apiCall![1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-r')
    expect(headers['X-On-Behalf-Of']).toBeUndefined()
  })

  it('attaches Authorization: Bearer on POST publish', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return Promise.resolve(fakeTokenResponse('tok-w', 600))
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await publishEntry({ name: '@clerum/x', version: '0.0.1' })

    const publishCall = fetchMock.mock.calls.find(
      c =>
        typeof c[0] === 'string' &&
        c[0].endsWith('/entries') &&
        (c[1] as RequestInit | undefined)?.method === 'POST'
    )
    expect(publishCall).toBeDefined()
    const headers = publishCall![1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-w')
    expect(headers['X-On-Behalf-Of']).toBeUndefined()
  })

  it('evicts cache and retries once on 401', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        const n = fetchMock.mock.calls.filter(
          c => typeof c[0] === 'string' && c[0].endsWith('/oauth/token')
        ).length
        return Promise.resolve(fakeTokenResponse(`tok-${n}`, 600))
      }
      // First /entries call returns 401, second returns 200.
      const apiCalls = fetchMock.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('/entries')
      ).length
      return Promise.resolve(
        apiCalls === 1
          ? new Response('expired', { status: 401 })
          : new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 0, offset: 0 } }), {
              status: 200,
            })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await searchEntries({})

    const tokenCalls = fetchMock.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/oauth/token')
    )
    const entryCalls = fetchMock.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('/entries')
    )
    expect(tokenCalls.length).toBe(2)
    expect(entryCalls.length).toBe(2)
  })

  it('omits Authorization in auth-off mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 0, offset: 0 } }), {
        status: 200,
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    process.env = {
      ...process.env,
      CLERUM_REGISTRY_AUTH_ENABLED: 'false',
      CLERUM_REGISTRY_CLIENT_ID: '',
      CLERUM_REGISTRY_CLIENT_SECRET: '',
    }

    await searchEntries({})

    const call = fetchMock.mock.calls[0]
    const headers = (call[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined
    expect(headers?.Authorization).toBeUndefined()
    expect(headers?.['X-On-Behalf-Of']).toBeUndefined()
  })
})

describe('registryClient — GET retry-once (transient resilience)', () => {
  // Helper: build a fetch mock where the /entries response is decided by a
  // queue of status producers, while /oauth/token always succeeds.
  function entriesQueue(producers: Array<() => Response | Promise<Response>>) {
    let i = 0
    return vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return Promise.resolve(fakeTokenResponse('tok', 600))
      }
      const producer = producers[Math.min(i, producers.length - 1)]
      i += 1
      return Promise.resolve(producer())
    })
  }

  const okEntries = () =>
    new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 0, offset: 0 } }), {
      status: 200,
    })

  for (const status of [502, 503, 504]) {
    it(`retries a GET once on ${status} and returns the second (200) response`, async () => {
      const fetchMock = entriesQueue([() => new Response('gateway', { status }), okEntries])
      vi.stubGlobal('fetch', fetchMock)
      Object.assign(process.env, ENV_OVERRIDE)

      // A non-default search avoids the stale-while-error path so we exercise
      // the retry in isolation.
      const result = await searchEntries({ q: 'thing' })
      expect(result).toEqual({ data: [], meta: { total: 0, limit: 0, offset: 0 } })

      const entryCalls = fetchMock.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/entries')
      )
      expect(entryCalls.length).toBe(2)
    })
  }

  it('retries a GET once on a network/Abort rejection, then succeeds', async () => {
    let entryAttempts = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      entryAttempts += 1
      if (entryAttempts === 1) {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        return Promise.reject(err)
      }
      return Promise.resolve(okEntries())
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const result = await searchEntries({ q: 'thing' })
    expect(result.meta.total).toBe(0)
    expect(entryAttempts).toBe(2)
  })

  it('only retries ONCE — a second transient surfaces as registry_unavailable', async () => {
    const fetchMock = entriesQueue([
      () => new Response('gw', { status: 503 }),
      () => new Response('gw', { status: 503 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await searchEntries({ q: 'thing' }).catch(e => e)) as Error & {
      status?: number
      code?: string
    }
    expect(err.status).toBe(503)
    expect(err.code).toBe('registry_unavailable')

    const entryCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/entries')
    )
    expect(entryCalls.length).toBe(2)
  })

  it('remaps a persistent registry 401 to 502 (so control-ui does not force-logout)', async () => {
    // authedFetch evict-retries a 401 once; both attempts 401 → registryFetch
    // remaps to 502. A bare 401 here would trip control-ui's global 401 handler
    // and force-logout a valid admin session — the "session expires quickly" bug.
    const fetchMock = entriesQueue([
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await searchEntries({ q: 'thing' }).catch(e => e)) as Error & {
      status?: number
      code?: string
    }
    // Load-bearing: status MUST be 502, NOT 401.
    expect(err.status).toBe(502)
    expect(err.status).not.toBe(401)
    expect(err.code).toBe('registry_integration_error')
  })

  it('still forwards a registry 404 verbatim (not remapped)', async () => {
    // Guards the 401 remap against over-reach: non-401 statuses must pass through
    // so a registry 404 stays a 404 (the e2e-registry-publish-update-remove class).
    const fetchMock = entriesQueue([() => new Response('missing', { status: 404 })])
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await searchEntries({ q: 'thing' }).catch(e => e)) as Error & { status?: number }
    expect(err.status).toBe(404)
    expect(err.message).toMatch(/Registry 404/)
    expect(err.message).not.toContain('missing')
  })

  it('cancels a non-OK response body before propagating the upstream status', async () => {
    const response = new Response('missing', { status: 404 })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const fetchMock = entriesQueue([() => response])
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await searchEntries({ q: 'thing' }).catch(() => undefined)

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does NOT retry a non-GET (POST publish) on 503, and surfaces registry_unavailable', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(new Response('gw', { status: 503 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await publishEntry({ name: '@clerum/x', version: '0.0.1' }).catch(
      e => e
    )) as Error & {
      status?: number
      code?: string
    }
    expect(err.status).toBe(503)
    expect(err.code).toBe('registry_unavailable')

    const publishCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).endsWith('/entries') &&
        (c[1] as RequestInit | undefined)?.method === 'POST'
    )
    expect(publishCalls.length).toBe(1)
  })
})

describe('registryClient — registry-unavailable remap (Fix 2)', () => {
  it('remaps a TypeError ("fetch failed" = ECONNREFUSED / DNS) to 503 registry_unavailable', async () => {
    // A TypeError is NOT transient (isTransientFetchError is false for it), so
    // authedFetch does not retry it — it rethrows, and registryFetch remaps it.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.reject(new TypeError('fetch failed'))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await searchEntries({ q: 'thing' }).catch(e => e)) as Error & {
      status?: number
      code?: string
    }
    expect(err.status).toBe(503)
    expect(err.code).toBe('registry_unavailable')
  })

  it('remaps an upstream HTTP 5xx (origin/gateway down) to 503 registry_unavailable', async () => {
    // The dominant real-world path: the edge is reachable but the origin returns
    // a 5xx. A GET retries once (RETRIABLE_GET_STATUSES) then maps to unavailable.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(new Response('origin down', { status: 503 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await searchEntries({ q: 'thing' }).catch(e => e)) as Error & {
      status?: number
      code?: string
    }
    expect(err.status).toBe(503)
    expect(err.code).toBe('registry_unavailable')
  })

  it('does NOT relabel a status-less credential-rejected error as registry_unavailable', async () => {
    // mintToken throws "registry credential rejected: 401 …" (a wrong-secret
    // misconfig) — a status-less, non-network Error. It must surface unchanged,
    // NOT collapsed into the "unavailable" message.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token'))
        return Promise.resolve(new Response('bad creds', { status: 401 }))
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 0, offset: 0 } }), {
          status: 200,
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await searchEntries({ q: 'thing' }).catch(e => e)) as Error & {
      status?: number
      code?: string
    }
    expect(err.message).toMatch(/registry credential rejected: 401/)
    expect(err.code).not.toBe('registry_unavailable')
    expect(err.status).toBeUndefined()
  })
})

describe('registryClient — resolvePublishScope', () => {
  // whoami() mints a token first (POST /oauth/token) and then GETs /api/v1/whoami,
  // so the fetch mock must answer BOTH calls. Branch on URL like the other tests.
  function whoamiMock(whoami: { clientId?: string; orgName: string | null; curator: boolean }) {
    return vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return Promise.resolve(fakeTokenResponse('tok-w', 600))
      }
      return Promise.resolve(
        new Response(JSON.stringify(whoami), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })
  }

  it("org-bound (curator:false) → scope '@<orgName>'", async () => {
    const fetchMock = whoamiMock({
      clientId: 'newtenantwf',
      orgName: 'newtenantwf',
      curator: false,
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const s = await resolvePublishScope({ force: true })

    expect(s).toEqual({ curator: false, orgName: 'newtenantwf', scope: '@newtenantwf' })

    // It hits /api/v1/whoami (registryFetch prefixes /api/v1 exactly once), not
    // /api/v1/api/v1/whoami — confirms resolvePublishScope passes '/whoami'.
    const whoamiCall = fetchMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).endsWith('/whoami')
    )
    expect(whoamiCall).toBeDefined()
    const whoamiUrl = whoamiCall![0] as string
    expect(whoamiUrl.endsWith('/api/v1/whoami')).toBe(true)
    expect(whoamiUrl).not.toContain('/api/v1/api/v1')
  })

  it('curator → scope null (unscoped → @clerum bridge)', async () => {
    const fetchMock = whoamiMock({
      clientId: 'example-prod-control-api',
      orgName: 'clerum',
      curator: true,
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const s = await resolvePublishScope({ force: true })

    expect(s).toEqual({ curator: true, orgName: 'clerum', scope: null })
  })

  it('caches the resolved scope; a second call makes no further fetch', async () => {
    const fetchMock = whoamiMock({
      clientId: 'newtenantwf',
      orgName: 'newtenantwf',
      curator: false,
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const first = await resolvePublishScope()
    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await resolvePublishScope()

    expect(second).toEqual(first)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('revalidates cached publish scope after the registry cache TTL expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    let whoamiCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) {
        return Promise.resolve(fakeTokenResponse('tok-scope', 6000))
      }
      whoamiCalls += 1
      const orgName = whoamiCalls === 1 ? 'alpha' : 'bravo'
      return Promise.resolve(
        new Response(JSON.stringify({ clientId: orgName, orgName, curator: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await expect(resolvePublishScope()).resolves.toEqual({
      curator: false,
      orgName: 'alpha',
      scope: '@alpha',
    })

    vi.setSystemTime(Date.now() + 14_999)
    await expect(resolvePublishScope()).resolves.toEqual({
      curator: false,
      orgName: 'alpha',
      scope: '@alpha',
    })

    vi.setSystemTime(Date.now() + 1)
    await expect(resolvePublishScope()).resolves.toEqual({
      curator: false,
      orgName: 'bravo',
      scope: '@bravo',
    })
    expect(whoamiCalls).toBe(2)
  })

  it('invalidates cached token and publish scope when registry identity changes', async () => {
    let tokenCalls = 0
    let whoamiCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth/token')) {
        tokenCalls += 1
        return Promise.resolve(fakeTokenResponse(tokenCalls === 1 ? 'tok-alpha' : 'tok-bravo'))
      }
      whoamiCalls += 1
      const headers = init?.headers as Record<string, string> | undefined
      const orgName = headers?.Authorization === 'Bearer tok-alpha' ? 'alpha' : 'bravo'
      return Promise.resolve(
        new Response(JSON.stringify({ clientId: orgName, orgName, curator: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await expect(resolvePublishScope()).resolves.toEqual({
      curator: false,
      orgName: 'alpha',
      scope: '@alpha',
    })

    invalidateRegistryIdentityCaches()

    await expect(resolvePublishScope()).resolves.toEqual({
      curator: false,
      orgName: 'bravo',
      scope: '@bravo',
    })
    expect(tokenCalls).toBe(2)
    expect(whoamiCalls).toBe(2)
  })

  it('does not reuse a connected scope after disconnect invalidation', async () => {
    let tokenCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth/token')) {
        tokenCalls += 1
        return Promise.resolve(fakeTokenResponse(tokenCalls === 1 ? 'tok-connected' : 'tok-open'))
      }
      const headers = init?.headers as Record<string, string> | undefined
      const connected = headers?.Authorization === 'Bearer tok-connected'
      return Promise.resolve(
        new Response(
          JSON.stringify({
            clientId: connected ? 'acme' : 'unbound',
            orgName: connected ? 'acme' : null,
            curator: false,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    expect(await resolvePublishScope()).toEqual({
      curator: false,
      orgName: 'acme',
      scope: '@acme',
    })

    invalidateRegistryIdentityCaches()

    expect(await resolvePublishScope()).toEqual({
      curator: false,
      orgName: null,
      scope: null,
    })
  })

  it('does not return an older pending publish-scope result after identity invalidation', async () => {
    const staleWhoami = deferred<Response>()
    let tokenCalls = 0
    let whoamiCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth/token')) {
        tokenCalls += 1
        return Promise.resolve(fakeTokenResponse(tokenCalls === 1 ? 'tok-alpha' : 'tok-bravo'))
      }
      whoamiCalls += 1
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization === 'Bearer tok-alpha') return staleWhoami.promise
      return Promise.resolve(
        new Response(JSON.stringify({ clientId: 'bravo', orgName: 'bravo', curator: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const staleRequest = resolvePublishScope()
    await waitUntil(() => whoamiCalls === 1, 'stale whoami request did not start')

    invalidateRegistryIdentityCaches()

    const freshScope = await resolvePublishScope()
    expect(freshScope).toEqual({ curator: false, orgName: 'bravo', scope: '@bravo' })

    staleWhoami.resolve(
      new Response(JSON.stringify({ clientId: 'alpha', orgName: 'alpha', curator: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    expect(await staleRequest).toEqual(freshScope)

    expect(await resolvePublishScope()).toEqual(freshScope)
    expect(tokenCalls).toBe(2)
    expect(whoamiCalls).toBe(2)
  })

  it('does not return an older pending token mint after identity invalidation', async () => {
    const staleToken = deferred<Response>()
    let tokenCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (!url.endsWith('/oauth/token')) throw new Error(`unexpected fetch: ${url}`)
      tokenCalls += 1
      if (tokenCalls === 1) return staleToken.promise
      return Promise.resolve(fakeTokenResponse('tok-bravo', 600))
    })
    vi.stubGlobal('fetch', fetchMock)

    const staleRequest = mintToken(ENV_OVERRIDE)
    await waitUntil(() => tokenCalls === 1, 'stale token request did not start')

    invalidateRegistryIdentityCaches()

    await expect(mintToken(ENV_OVERRIDE)).resolves.toBe('tok-bravo')
    staleToken.resolve(fakeTokenResponse('tok-alpha', 600))
    await expect(staleRequest).resolves.toBe('tok-bravo')

    await expect(mintToken(ENV_OVERRIDE)).resolves.toBe('tok-bravo')
    expect(tokenCalls).toBe(2)
  })

  it('fails closed when identity changes again during a stale token retry', async () => {
    const staleToken = deferred<Response>()
    const retryToken = deferred<Response>()
    let tokenCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (!url.endsWith('/oauth/token')) throw new Error(`unexpected fetch: ${url}`)
      tokenCalls += 1
      if (tokenCalls === 1) return staleToken.promise
      if (tokenCalls === 2) return retryToken.promise
      return Promise.resolve(fakeTokenResponse('tok-charlie', 600))
    })
    vi.stubGlobal('fetch', fetchMock)

    const staleRequest = mintToken(ENV_OVERRIDE)
    await waitUntil(() => tokenCalls === 1, 'stale token request did not start')

    invalidateRegistryIdentityCaches()
    staleToken.resolve(fakeTokenResponse('tok-alpha', 600))
    await waitUntil(() => tokenCalls === 2, 'stale token retry did not start')

    invalidateRegistryIdentityCaches()
    retryToken.resolve(fakeTokenResponse('tok-bravo', 600))

    await expect(staleRequest).rejects.toMatchObject({
      code: 'registry_unavailable',
      status: 503,
    })
    expect(tokenCalls).toBe(2)
  })
})

describe('registryClient — applyPublishScope', () => {
  const orgBound: PublishScope = { curator: false, orgName: 'newtenantwf', scope: '@newtenantwf' }
  const curator: PublishScope = { curator: true, orgName: 'clerum', scope: null }

  it('org-bound scope prefixes a bare name with @<org>/', () => {
    expect(applyPublishScope('my-connector', orgBound)).toBe('@newtenantwf/my-connector')
  })

  it('curator (null scope) leaves a bare name unchanged (→ @clerum bridge)', () => {
    expect(applyPublishScope('helpdesk', curator)).toBe('helpdesk')
  })

  it('leaves an already-@-scoped name unchanged even when org-bound', () => {
    expect(applyPublishScope('@newtenantwf/x', orgBound)).toBe('@newtenantwf/x')
  })

  it('returns a non-string / undefined name unchanged', () => {
    expect(applyPublishScope(undefined, orgBound)).toBeUndefined()
  })
})

describe('registryClient — stale-while-error cache', () => {
  it('serves last-good categories on a fresh registry error instead of throwing', async () => {
    // First call succeeds and is cached.
    const okCats = () => new Response(JSON.stringify({ data: ['ai', 'devtools'] }), { status: 200 })
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      // /categories: succeed once, then always 503 (and 503 also short-circuits
      // the GET retry to a second 503, still an error to fall back from).
      const catCalls = fetchMock.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/categories')
      ).length
      return Promise.resolve(catCalls <= 1 ? okCats() : new Response('down', { status: 503 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const first = await getCategories()
    expect(first).toEqual({ data: ['ai', 'devtools'] })

    // Registry now erroring — should serve the cached last-good value, not throw.
    const second = await getCategories()
    expect(second).toEqual({ data: ['ai', 'devtools'] })
  })

  it('throws registry_unavailable when the registry errors and there is NO cached value', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(new Response('down', { status: 503 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await getCategories().catch(e => e)) as Error & { status?: number; code?: string }
    expect(err.status).toBe(503)
    expect(err.code).toBe('registry_unavailable')
  })

  it('serves last-good default catalog search (limit:200) on error', async () => {
    const okSearch = () =>
      new Response(
        JSON.stringify({ data: [{ name: 'a' }], meta: { total: 1, limit: 200, offset: 0 } }),
        {
          status: 200,
        }
      )
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      const calls = fetchMock.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/entries')
      ).length
      return Promise.resolve(calls <= 1 ? okSearch() : new Response('down', { status: 503 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const first = await searchEntries({ limit: 200 })
    expect(first.data).toEqual([{ name: 'a' }])

    const second = await searchEntries({ limit: 200 })
    expect(second.data).toEqual([{ name: 'a' }])
  })
})

describe('registryClient — catalog read-through cache', () => {
  const okSearch = (name = 'a') =>
    new Response(JSON.stringify({ data: [{ name }], meta: { total: 1, limit: 200, offset: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('serves the default catalog (limit:200) from cache within TTL without a second registry GET', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(okSearch())
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const first = await searchEntries({ limit: 200 })
    const second = await searchEntries({ limit: 200 })

    expect(first.data).toEqual([{ name: 'a' }])
    expect(second.data).toEqual([{ name: 'a' }])
    // Read-through: the second load is served from process memory, so only ONE
    // cross-cluster registry round trip happens.
    const entryGets = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/entries')
    )
    expect(entryGets.length).toBe(1)
  })

  it('does not serve cached default catalog across registry identity invalidation', async () => {
    let entryCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      entryCalls += 1
      return Promise.resolve(okSearch(entryCalls === 1 ? 'alpha' : 'bravo'))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const first = await searchEntries({ limit: 200 })
    expect(first.data).toEqual([{ name: 'alpha' }])

    invalidateRegistryIdentityCaches()

    const second = await searchEntries({ limit: 200 })
    expect(second.data).toEqual([{ name: 'bravo' }])
    expect(entryCalls).toBe(2)
  })

  it('revalidates after the TTL expires and serves the fresh value', async () => {
    vi.useFakeTimers()
    let n = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 6000))
      const name = n === 0 ? 'old' : 'new'
      n += 1
      return Promise.resolve(okSearch(name))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const first = await searchEntries({ limit: 200 })
    expect(first.data).toEqual([{ name: 'old' }])

    // Advance well past the read-through TTL — the next load must revalidate.
    vi.setSystemTime(Date.now() + 60_000)

    const second = await searchEntries({ limit: 200 })
    expect(second.data).toEqual([{ name: 'new' }])
    const entryGets = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/entries')
    )
    expect(entryGets.length).toBe(2)
  })

  it('serves categories from cache within TTL without a second registry GET', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(new Response(JSON.stringify({ data: ['ai'] }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await getCategories()
    await getCategories()

    const catGets = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/categories')
    )
    expect(catGets.length).toBe(1)
  })

  it('does not serve cached categories across registry identity invalidation', async () => {
    let categoryCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      categoryCalls += 1
      return Promise.resolve(
        new Response(JSON.stringify({ data: categoryCalls === 1 ? ['alpha'] : ['bravo'] }), {
          status: 200,
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await expect(getCategories()).resolves.toEqual({ data: ['alpha'] })
    invalidateRegistryIdentityCaches()
    await expect(getCategories()).resolves.toEqual({ data: ['bravo'] })
    expect(categoryCalls).toBe(2)
  })

  it('does not serve stale-while-error catalog data across identity invalidation', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      const entryCalls = fetchMock.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/entries')
      ).length
      return Promise.resolve(
        entryCalls <= 1 ? okSearch('alpha') : new Response('down', { status: 503 })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await expect(searchEntries({ limit: 200 })).resolves.toMatchObject({
      data: [{ name: 'alpha' }],
    })
    invalidateRegistryIdentityCaches()

    await expect(searchEntries({ limit: 200 })).rejects.toMatchObject({
      code: 'registry_unavailable',
      status: 503,
    })
  })

  it('does not return or cache an older pending default catalog after invalidation', async () => {
    const staleCatalog = deferred<Response>()
    let entryCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      entryCalls += 1
      if (entryCalls === 1) return staleCatalog.promise
      return Promise.resolve(okSearch('bravo'))
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const staleRequest = searchEntries({ limit: 200 })
    await waitUntil(() => entryCalls === 1, 'stale catalog request did not start')

    invalidateRegistryIdentityCaches()

    const fresh = await searchEntries({ limit: 200 })
    expect(fresh.data).toEqual([{ name: 'bravo' }])

    staleCatalog.resolve(okSearch('alpha'))
    await expect(staleRequest).resolves.toEqual(fresh)
    await expect(searchEntries({ limit: 200 })).resolves.toEqual(fresh)
    expect(entryCalls).toBe(2)
  })

  it('invalidates the catalog cache after a publish so the next catalog load refetches', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      if (url.endsWith('/entries') && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 }))
      }
      return Promise.resolve(okSearch())
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    await searchEntries({ limit: 200 }) // caches the default catalog
    await publishEntry({ name: '@clerum/x', version: '0.0.1' }) // must bust the cache
    await searchEntries({ limit: 200 }) // must refetch, not serve stale

    const entryGets = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('/entries') &&
        (c[1] as RequestInit | undefined)?.method !== 'POST'
    )
    expect(entryGets.length).toBe(2)
  })
})

describe('registryClient — safe registry proxy errors', () => {
  it('keeps only an allowlisted JSON error code from an upstream error response', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'self_grant',
            message: 'untrusted diagnostic text',
            extra: { source: 'upstream' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const err = (await createOrgGrant('acme', {
      pluginName: '@acme/plugin',
      granteeOrg: 'other-org',
      actingUserId: 'operator-1',
    }).catch(error => error)) as RegistryProxyError

    expect(err).toBeInstanceOf(RegistryProxyError)
    expect(err.status).toBe(400)
    expect(err.body).toEqual({ error: 'self_grant' })
  })

  it('uses a synthetic code for unallowlisted JSON and non-JSON upstream errors', async () => {
    const upstreamResponses = [
      new Response(JSON.stringify({ error: 'unreviewed_code', detail: 'untrusted diagnostic' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response('<html><body>upstream diagnostic</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    ]
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/oauth/token')) return Promise.resolve(fakeTokenResponse('tok', 600))
      return Promise.resolve(upstreamResponses.shift()!)
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.assign(process.env, ENV_OVERRIDE)

    const jsonErr = (await createOrgGrant('acme', {
      pluginName: '@acme/plugin',
      granteeOrg: 'other-org',
      actingUserId: 'operator-1',
    }).catch(error => error)) as RegistryProxyError
    const htmlErr = (await createOrgGrant('acme', {
      pluginName: '@acme/plugin',
      granteeOrg: 'other-org',
      actingUserId: 'operator-1',
    }).catch(error => error)) as RegistryProxyError

    expect(jsonErr.body).toEqual({ error: 'registry_409' })
    expect(htmlErr.body).toEqual({ error: 'registry_502' })
  })
})

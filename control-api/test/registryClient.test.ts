import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PublishScope,
  __resetScopeCacheForTests,
  __resetTokenCacheForTests,
  applyPublishScope,
  getCategories,
  mintToken,
  publishEntry,
  resolvePublishScope,
  searchEntries,
} from '../src/services/registryClient.js'

// Controls the derived-auth path (Task 7): mintToken() with NO envOverride
// consults isRegistryAuthActive() for the authEnabled decision and
// resolveMachineCreds() for self-hosted credentials. Every OTHER test in this
// file drives mintToken via ENV_OVERRIDE or process.env id/secret directly,
// so it never reaches either mock — only the two derived-auth tests below do.
const connDb = vi.hoisted(() => ({
  isRegistryAuthActive: vi.fn(),
  resolveMachineCreds: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)

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

beforeEach(() => {
  __resetTokenCacheForTests()
  __resetScopeCacheForTests()
  // Deterministic defaults for the connDb mock (no creds, auth off) rather
  // than relying on an unconfigured vi.fn() resolving `undefined` (falsy, but
  // for the wrong reason). Only the derived-auth tests below reach these; every
  // other test in the file resolves id/secret from ENV_OVERRIDE/process.env
  // before this mock would ever be consulted.
  connDb.resolveMachineCreds.mockReset().mockResolvedValue(null)
  connDb.isRegistryAuthActive.mockReset().mockResolvedValue(false)
})

afterEach(() => {
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

    await expect(mintToken(ENV_OVERRIDE)).rejects.toThrow(/registry credential rejected: 401/)
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

describe('registryClient — mintToken derived auth (no envOverride)', () => {
  // Critical: no ENV_OVERRIDE here. An envOverride short-circuits authEnabled
  // to false by design (see mintToken), so these two tests must call
  // mintToken() bare to actually reach the isRegistryAuthActive()-derived path.
  // They also explicitly blank CLIENT_ID/SECRET: earlier tests in this file
  // mutate the REAL process.env via Object.assign(process.env, ENV_OVERRIDE)
  // and never reset it (only afterEach's unstubAllGlobals/useRealTimers run),
  // so without this, a leftover id/secret from a prior test would populate
  // `id`/`secret` and the credential-missing branch under test would never
  // trigger.
  beforeEach(() => {
    process.env = {
      ...process.env,
      CLERUM_REGISTRY_CLIENT_ID: '',
      CLERUM_REGISTRY_CLIENT_SECRET: '',
    }
  })

  it('returns an empty token when auth is inactive and no creds exist', async () => {
    connDb.resolveMachineCreds.mockResolvedValue(null)
    connDb.isRegistryAuthActive.mockResolvedValue(false)
    await expect(mintToken()).resolves.toBe('') // NO ENV_OVERRIDE — see above
  })

  it('throws when auth is active but credentials are unavailable', async () => {
    connDb.resolveMachineCreds.mockResolvedValue(null)
    connDb.isRegistryAuthActive.mockResolvedValue(true)
    await expect(mintToken()).rejects.toThrow(/machine credentials unavailable/)
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

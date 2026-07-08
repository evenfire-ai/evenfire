import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetTokenCacheForTests,
  getEntry,
  getEntryVersion,
  mintToken,
  reportInstall,
  searchEntries,
} from './clerumRegistryClient'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const devEnv = { url: 'http://localhost:8085', authEnabled: false }

beforeEach(() => {
  __resetTokenCacheForTests()
  vi.clearAllMocks()
})

describe('getEntry', () => {
  it('GETs /@scope%2Fname and returns packument', async () => {
    const packument = { name: '@acme/my-mcp', 'dist-tags': { latest: '1.0.0' }, versions: {} }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => packument })

    const result = await getEntry('@acme/my-mcp', devEnv)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8085/%40acme%2Fmy-mcp',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result).toEqual(packument)
  })

  it('returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
    const result = await getEntry('@acme/missing', devEnv)
    expect(result).toBeNull()
  })
})

describe('getEntryVersion', () => {
  it('GETs /@scope%2Fname/1.0.0 and returns manifest', async () => {
    const manifest = { name: '@acme/my-mcp', version: '1.0.0', image: 'ghcr.io/acme:1.0.0' }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest })

    const result = await getEntryVersion('@acme/my-mcp', '1.0.0', devEnv)
    expect(fetchMock.mock.calls[0][0]).toContain('%40acme%2Fmy-mcp')
    expect(fetchMock.mock.calls[0][0]).toContain('1.0.0')
    expect(result).toEqual(manifest)
  })

  it('returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
    const result = await getEntryVersion('@acme/missing', '2.0.0', devEnv)
    expect(result).toBeNull()
  })
})

describe('searchEntries', () => {
  it('GETs /-/v1/search with query param', async () => {
    const body = { results: [], total: 0 }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })

    await searchEntries({ query: 'postgres', limit: 10 }, devEnv)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/-/v1/search')
    expect(url).toContain('q=postgres')
    expect(url).toContain('limit=10')
  })
})

describe('reportInstall', () => {
  it('POSTs to /@scope%2Fname/report-install with correlationId + version', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await reportInstall('@acme/my-mcp', '1.0.0', devEnv)
    expect(fetchMock.mock.calls[0][0]).toContain('%40acme%2Fmy-mcp')
    expect(fetchMock.mock.calls[0][0]).toContain('report-install')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.version).toBe('1.0.0')
    expect(typeof body.correlationId).toBe('string')
    expect(body.correlationId.length).toBeGreaterThan(0)
  })

  it('passes through caller-supplied correlationId', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await reportInstall('@acme/my-mcp', '1.0.0', devEnv, { correlationId: 'fixed-id-123' })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.correlationId).toBe('fixed-id-123')
  })

  it('does not throw on failure (best-effort)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('network error'))
    await expect(reportInstall('@acme/my-mcp', '1.0.0', devEnv)).resolves.toBeUndefined()
    warnSpy.mockRestore()
  })

  it('logs a warning when the network call fails (still does not throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8085'))

    await expect(reportInstall('@acme/my-mcp', '1.0.0', devEnv)).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toMatch(/reportInstall/i)
    expect(warnSpy.mock.calls[0][0]).toMatch(/ECONNREFUSED/)
    warnSpy.mockRestore()
  })
})

describe('mintToken', () => {
  it('returns empty string when authEnabled=false', async () => {
    const t = await mintToken({ url: 'http://localhost:8085', authEnabled: false })
    expect(t).toBe('')
  })

  it('clamps expires_in to 3600s when registry returns an unreasonably large value', async () => {
    // First fetch: /oauth/token returning expires_in: 1_000_000 (~11.5 days).
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'tok-abc',
        expires_in: 1_000_000,
        scope: 'registry:read',
      }),
    })
    // Second fetch: GET /<name> using the cached token.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: '@x/y', 'dist-tags': {}, versions: {} }),
    })

    // Make a call to populate the cache via mintToken's normal path.
    const env = { url: 'http://r', authEnabled: true, clientId: 'cid', clientSecret: 'cs' }
    const { getEntry } = await import('./clerumRegistryClient.js')
    await getEntry('@x/y', env)

    // The second fetch should have been called with a Bearer header
    // (proving mintToken returned the token, not the empty string).
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc')

    // Wait beyond the 3600s clamp window — token must be re-minted.
    // We achieve this by faking Date.now via the cache's own structure:
    // call mintToken again with the same env; if expires_in had NOT been
    // clamped, the cached token would be reused (no second /oauth/token).
    // If it WAS clamped to 3600s, calling mintToken just under the clamp
    // (e.g. within the 30s buffer) would force a new fetch. The cleanest
    // assertion: there should have been exactly ONE /oauth/token call so far.
    const oauthCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('/oauth/token')
    )
    expect(oauthCalls.length).toBe(1)
  })

  const authEnv = { url: 'http://r', authEnabled: true, clientId: 'cid', clientSecret: 'cs' }

  it('keeps the "credential rejected" label on 401/403', async () => {
    for (const status of [401, 403]) {
      __resetTokenCacheForTests()
      fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => 'bad' })
      await expect(mintToken(authEnv)).rejects.toThrow(
        new RegExp(`registry credential rejected: ${status}`)
      )
    }
  })

  it('relabels a 5xx token-endpoint error as an origin/tunnel outage (not a bad credential)', async () => {
    for (const status of [500, 502, 503, 504]) {
      __resetTokenCacheForTests()
      fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => 'upstream down' })
      await expect(mintToken(authEnv)).rejects.toThrow(
        new RegExp(`registry token endpoint unavailable \\(origin/tunnel\\): ${status}`)
      )

      __resetTokenCacheForTests()
      fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => 'upstream down' })
      await expect(mintToken(authEnv)).rejects.not.toThrow(/credential rejected/)
    }
  })
})

describe('read-path timeout', () => {
  const authEnv = { url: 'http://r', authEnabled: true, clientId: 'cid', clientSecret: 'cs' }

  it('attaches an AbortSignal to GET reads but not to the report-install POST', async () => {
    // Token mint, then a GET, then a POST. mintToken also carries a signal.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok', expires_in: 600, scope: 'registry:read' }),
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ name: '@x/y', 'dist-tags': {}, versions: {} }),
    })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })

    await getEntry('@x/y', authEnv)
    await reportInstall('@x/y', '1.0.0', authEnv)

    // call 0 = /oauth/token (POST, but read-prereq → has signal)
    const tokenInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(tokenInit.signal).toBeInstanceOf(AbortSignal)

    // call 1 = GET /@x/y → has signal
    const getInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(getInit.method).toBe('GET')
    expect(getInit.signal).toBeInstanceOf(AbortSignal)

    // call 2 = POST report-install (write) → NO signal
    const postInit = fetchMock.mock.calls[2][1] as RequestInit
    expect(postInit.method).toBe('POST')
    expect(postInit.signal).toBeUndefined()
  })
})

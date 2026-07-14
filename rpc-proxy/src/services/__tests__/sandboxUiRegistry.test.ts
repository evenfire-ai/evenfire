import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../config.js'
import {
  _clearSandboxUiRegistryCache,
  listSandboxUiApps,
  lookupSandboxUiRegistry,
} from '../sandboxUiRegistry.js'

const fetchSpy = vi.fn()

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  _clearSandboxUiRegistryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const VALID_BODY = {
  appRef: 'sandbox-recipes/r1',
  service: { name: 'web', namespace: config.sandboxUiNamespace, port: 8080 },
  ready: true,
  title: 'My UI',
  defaultPath: '/dashboard',
}

describe('lookupSandboxUiRegistry', () => {
  it('forwards the request to control-api with the internal service-token headers', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/internal/sandbox-ui/registry/sandbox-recipes/r1')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${config.controlApiServiceToken}`)
    expect(headers['x-service-token']).toBe(config.controlApiServiceName)
  })

  it('parses a 200 response into an ok result', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.entry.appRef).toBe('sandbox-recipes/r1')
      expect(res.entry.service).toEqual({
        name: 'web',
        namespace: config.sandboxUiNamespace,
        port: 8080,
      })
      expect(res.entry.ready).toBe(true)
      expect(res.entry.title).toBe('My UI')
      expect(res.entry.defaultPath).toBe('/dashboard')
    }
    expect(res.cacheHit).toBe(false)
  })

  it('rejects a 200 response with a namespace other than sandbox-ui (defence-in-depth)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        ...VALID_BODY,
        service: { ...VALID_BODY.service, namespace: 'mcp-server' },
      })
    )
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.status).toBe(500)
  })

  it('rejects a 200 response with an out-of-range port', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        ...VALID_BODY,
        service: { ...VALID_BODY.service, port: 70000 },
      })
    )
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('error')
  })

  it('surfaces a port outside the allow-list as misconfigured/port_not_allowed (privileged port)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        ...VALID_BODY,
        service: { ...VALID_BODY.service, port: 22 },
      })
    )
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('misconfigured')
    if (res.kind === 'misconfigured') {
      expect(res.reason).toBe('port_not_allowed')
      expect(res.port).toBe(22)
    }
  })

  it('surfaces a control-plane-style port outside the allow-list as misconfigured/port_not_allowed', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        ...VALID_BODY,
        service: { ...VALID_BODY.service, port: 6443 },
      })
    )
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('misconfigured')
    if (res.kind === 'misconfigured') {
      expect(res.reason).toBe('port_not_allowed')
      expect(res.port).toBe(6443)
    }
  })

  it('accepts the default allow-listed port (8080)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('ok')
  })

  it('defaults defaultPath to "/" when missing', async () => {
    const body = { ...VALID_BODY }
    delete (body as { defaultPath?: string }).defaultPath
    fetchSpy.mockResolvedValue(jsonResponse(200, body))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') expect(res.entry.defaultPath).toBe('/')
  })

  it('surfaces a 404 as not_found', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'recipe_not_found' }))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'missing')
    expect(res.kind).toBe('not_found')
  })

  it('surfaces a 409 as not_ready and pulls reason from the body when present', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(409, { error: 'recipe_not_ready', reason: 'phase is "deploying"' })
    )
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('not_ready')
    if (res.kind === 'not_ready') expect(res.reason).toBe('phase is "deploying"')
  })

  it('coerces 401/403 from control-api into a 500-class error (auth misconfig)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.status).toBe(500)
  })

  it('surfaces a network error as a 502', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.status).toBe(502)
  })

  it('caches a positive result for the configured TTL window', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    const first = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    const second = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('also caches a 404 result (avoids hammering control-api on click-storms)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'recipe_not_found' }))
    await lookupSandboxUiRegistry('sandbox-recipes', 'missing')
    const second = await lookupSandboxUiRegistry('sandbox-recipes', 'missing')
    expect(second.kind).toBe('not_found')
    expect(second.cacheHit).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches after the TTL elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00Z'))
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))

    await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    vi.setSystemTime(new Date(Date.now() + config.sandboxUiRegistryCacheTtlMs + 1))
    const after = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(after.cacheHit).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('caches per-(ns,name) — different recipes do not share cache slots', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    await lookupSandboxUiRegistry('sandbox-recipes', 'r2')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed 200 bodies as 500-class errors', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { appRef: 'sandbox-recipes/r1' })) // missing service
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.status).toBe(500)
  })

  it('passes forUser as a query string to control-api', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1')
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('?forUser=u1')
  })

  it('passes forTeam with forUser so control-api can evaluate team grants', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1', 'team-1')
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('forUser=u1')
    expect(url).toContain('forTeam=team-1')
  })

  it('treats 403 as forbidden when forUser is set (user-ACL denial)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: 'recipe_acl_denied' }))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1')
    expect(res.kind).toBe('forbidden')
  })

  it('coerces 403 to a 500-class error when forUser is NOT set (service-token failure)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: 'forbidden' }))
    const res = await lookupSandboxUiRegistry('sandbox-recipes', 'r1')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.status).toBe(500)
  })

  it('caches user-bound and user-agnostic responses separately', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1') // user-agnostic
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1') // user-bound
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('caches different users on the same recipe in separate slots', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1')
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u2')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('caches different teams for the same user and recipe in separate slots', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_BODY))
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1', 'team-1')
    await lookupSandboxUiRegistry('sandbox-recipes', 'r1', 'u1', 'team-2')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('listSandboxUiApps', () => {
  it('rejects an empty userId without a network call', async () => {
    const result = await listSandboxUiApps('')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards the userId as the forUser query string', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { apps: [] }))
    await listSandboxUiApps('u1')
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('/internal/sandbox-ui/apps')
    expect(url).toContain('forUser=u1')
  })

  it('forwards the current team as forTeam when provided', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { apps: [] }))
    await listSandboxUiApps('u1', 'team-1')
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('forUser=u1')
    expect(url).toContain('forTeam=team-1')
  })

  it('parses a well-formed apps array', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        apps: [
          {
            appRef: 'sandbox-recipes/r1',
            title: 'My App',
            icon: 'data:image/png;base64,AAA',
            defaultPath: '/x',
            ready: true,
            phase: 'active',
            updatedAt: '2026-05-08T00:00:00Z',
          },
        ],
      })
    )
    const result = await listSandboxUiApps('u1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.apps).toHaveLength(1)
      expect(result.apps[0]).toEqual({
        appRef: 'sandbox-recipes/r1',
        title: 'My App',
        icon: 'data:image/png;base64,AAA',
        defaultPath: '/x',
        ready: true,
        phase: 'active',
        updatedAt: '2026-05-08T00:00:00Z',
      })
    }
  })

  it('defaults defaultPath to "/" when missing', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { apps: [{ appRef: 'sandbox-recipes/r1', ready: false }] })
    )
    const result = await listSandboxUiApps('u1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.apps[0].defaultPath).toBe('/')
  })

  it('drops apps that are missing appRef', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { apps: [{ ready: true }, { appRef: 'sandbox-recipes/r1', ready: true }] })
    )
    const result = await listSandboxUiApps('u1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.apps).toHaveLength(1)
      expect(result.apps[0].appRef).toBe('sandbox-recipes/r1')
    }
  })

  it('returns 500 when the body is not { apps: [...] }', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { not: 'apps' }))
    const result = await listSandboxUiApps('u1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.status).toBe(500)
  })

  it('returns 502 on transport error', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const result = await listSandboxUiApps('u1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.status).toBe(502)
  })

  it('coerces 401/403 from control-api into 500 (auth misconfig)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
    const result = await listSandboxUiApps('u1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.status).toBe(500)
  })
})

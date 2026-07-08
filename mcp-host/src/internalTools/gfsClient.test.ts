import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GFS_ACCESS_FILE, createGfscClient, hasGfsRuntimeAccess } from './gfsClient'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string, status: number, statusText = ''): Response {
  return new Response(body, { status, statusText })
}

describe('gfs runtime gfsc client', () => {
  it('detects mounted runtime access without exposing dead tools', () => {
    expect(
      hasGfsRuntimeAccess({
        get: () => undefined,
        fileExists: path => path === DEFAULT_GFS_ACCESS_FILE,
      })
    ).toBe(true)
    expect(
      hasGfsRuntimeAccess({
        get: () => undefined,
        fileExists: () => false,
      })
    ).toBe(false)
  })

  it('calls gfsc accessible with runtime bearer auth', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [] } })
    )
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })
    await client.accessible({ drive: 'main' })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://gfsc.gfs.svc.cluster.local:8087/v1/accessible?drive=main'
    )
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer gfs-access',
    })
  })

  it('routes writes to the gfsc writer service with conditional body', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { version: 3 } })
    )
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })
    await client.write({ drive: 'main', resourceId: 'rid', content: 'new', ifMatch: 2 })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/rid/content?drive=main'
    )
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ content: 'new', ifMatch: 2 }),
    })
  })

  it('fails loud when the mounted runtime token file is empty', async () => {
    const client = createGfscClient({
      get: () => undefined,
      readFile: async () => '  \n',
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
    })

    await expect(client.accessible({ drive: 'main' })).rejects.toThrow(
      /MCP_HOST_GFS_TOKEN_FILE is empty/
    )
  })

  it('surfaces gfsc authorization denials with the response body', async () => {
    const fetchFn = vi.fn(async () => textResponse('not authorized to write this resource', 403))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(
      client.write({ drive: 'main', resourceId: 'rid', content: 'new', ifMatch: 2 })
    ).rejects.toThrow(/gfsc 403: not authorized to write this resource/)
  })

  it('surfaces gfsc read denials with the response body', async () => {
    const fetchFn = vi.fn(async () => textResponse('not authorized to read this resource', 403))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.read({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 403: not authorized to read this resource/
    )
  })

  it('surfaces gfsc transient failures with the status text when the body is empty', async () => {
    const fetchFn = vi.fn(async () => textResponse('', 503, 'Service Unavailable'))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.stat({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 503: Service Unavailable/
    )
  })

  it('surfaces gfsc list transient failures with the status text when the body is empty', async () => {
    const fetchFn = vi.fn(async () => textResponse('', 503, 'Service Unavailable'))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.list({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 503: Service Unavailable/
    )
  })
})

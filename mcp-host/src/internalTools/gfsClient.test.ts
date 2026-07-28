import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GFS_ACCESS_FILE,
  createGfscClient,
  getGfsToolScopes,
  hasGfsRuntimeAccess,
} from './gfsClient'

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

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

  it('derives only recognized GFS tool scopes and fails closed', () => {
    expect([
      ...(getGfsToolScopes({ get: () => encodedClaims(['gfs.read', 'gfs.write']) }) ?? []),
    ]).toEqual(['gfs.read', 'gfs.write'])
    expect(getGfsToolScopes({ get: () => encodedClaims(['gfs.read', 'gfs.delete']) })).toBeNull()
    expect(getGfsToolScopes({ get: () => encodedClaims(['gfs.delete']) })).toBeNull()
    expect(getGfsToolScopes({ get: () => encodedClaims([]) })).toBeNull()
    expect(getGfsToolScopes({ get: () => encodedClaims('gfs.read') })).toBeNull()
    expect(getGfsToolScopes({ get: () => 'malformed' })).toBeNull()
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

  it('uses exact writer routes and bodies for create, rename, and copy', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: {} })
    )
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })
    await client.createFile({
      drive: 'main',
      parentResourceId: 'parent/id',
      name: 'note.txt',
      content: 'hello',
    })
    await client.createFolder({ drive: 'main', parentResourceId: 'parent/id', name: 'docs' })
    await client.rename({
      drive: 'main',
      resourceId: 'source/id',
      newName: 'renamed.txt',
      ifMatch: 4,
    })
    const copy = {
      drive: 'main',
      sourceResourceId: 'source',
      destinationParentId: 'destination',
      newName: 'source-copy',
      ifMatch: 7,
    }
    await client.copy(copy)

    expect(fetchFn.mock.calls.map(call => [call[0], call[1]?.method, call[1]?.body])).toEqual([
      [
        'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/parent%2Fid/children?drive=main',
        'POST',
        JSON.stringify({ name: 'note.txt', kind: 'file', content: 'hello' }),
      ],
      [
        'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/parent%2Fid/children?drive=main',
        'POST',
        JSON.stringify({ name: 'docs', kind: 'directory' }),
      ],
      [
        'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/source%2Fid',
        'PATCH',
        JSON.stringify({ drive: 'main', newName: 'renamed.txt', ifMatch: 4 }),
      ],
      ['http://gfsc-writer.gfs.svc.cluster.local:8087/v1/copy', 'POST', JSON.stringify(copy)],
    ])
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

  it('surfaces the fail-closed not_mounted envelope intact on resolve (issue #775)', async () => {
    // Regression guard: the Desktop App and the agent distinguish a permission
    // store outage (503 not_mounted) from an authorization denial (403) by the
    // ERROR BODY this client propagates. Softening or rewrapping it would turn
    // an infrastructure failure into an ambiguous tool error.
    const envelope = JSON.stringify({
      ok: false,
      error: {
        code: 'not_mounted',
        message:
          'permission store unavailable: password authentication failed for user "gfs_controller"',
      },
    })
    const fetchFn = vi.fn(async () => textResponse(envelope, 503))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.resolve({ uri: 'gfs://main/docs/report.md' })).rejects.toThrow(
      `gfsc 503: ${envelope}`
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

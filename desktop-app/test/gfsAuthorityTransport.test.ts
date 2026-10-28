import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AppService } from '../src/appService.js'
import { fetchBoundedBytes, streamBoundedBytes } from '../src/gfs/boundedDownload.js'
import { gfsUploadTransport, requestGfsJson } from '../src/gfs/transport.js'
import { GfsClient } from '../src/gfs/uriHandler.js'

afterEach(() => vi.unstubAllGlobals())

describe('Desktop Files user authority', () => {
  it('uses user authority for GFS requests composed by AppService', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const home = {
      state: 'ready',
      drive: 'main',
      path: '/Users/example',
      resourceId: 'home',
      heldPermissions: ['read'],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), headers: new Headers(init.headers) })
        const data = String(url).endsWith('/home')
          ? home
          : { ok: true, data: { items: [], nextCursor: null } }
        return new Response(JSON.stringify(data), { status: 200 })
      })
    )
    const service = new AppService()
    ;(service as unknown as { sessionToken: string }).sessionToken = randomUUID()

    expect(await service.getGfsHome()).toEqual(home)
    expect(await service.listGfsChildren('home', 'main')).toEqual({ items: [], nextCursor: null })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/api/v1/me/gfs/home')
    expect(calls[1]!.url).toContain('/api/v1/me/gfs/resources/home/children')
    for (const call of calls) {
      expect(call.headers.get('X-Evenfire-Gfs-Authority')).toBe('user')
    }
  })

  it('sends user authority on metadata, upload parts, downloads and streams', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        calls.push(init)
        return new Response(String(url).includes('/json') ? '{}' : 'file', { status: 200 })
      })
    )
    const credential = randomUUID()
    expect(
      await requestGfsJson('GET', 'https://example.test/json', {
        headers: { 'x-evenfire-gfs-authority': 'other' },
      })
    ).toEqual({})
    expect(
      await gfsUploadTransport.requestJson('POST', 'https://example.test/json', { body: {} })
    ).toEqual({})
    expect(
      (
        await gfsUploadTransport.requestPart(
          'https://example.test/part',
          credential,
          {},
          Buffer.from('file'),
          1000
        )
      ).status
    ).toBe(200)
    expect((await fetchBoundedBytes('https://example.test/file', credential)).byteLength).toBe(4)
    const chunks: Uint8Array[] = []
    expect(
      await streamBoundedBytes(
        'https://example.test/stream',
        credential,
        { maxBytes: 20 },
        async chunk => {
          chunks.push(chunk)
        }
      )
    ).toBe(4)
    expect(chunks).toHaveLength(1)
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(new Headers(call.headers).get('X-Evenfire-Gfs-Authority')).toBe('user')
    }
  })

  it('sends the authority selector on home and grant requests through the GFS client', async () => {
    const headers: Headers[] = []
    const home = {
      state: 'ready',
      drive: 'private',
      path: '/Users/example',
      resourceId: 'home',
      heldPermissions: ['read'],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        headers.push(new Headers(init.headers))
        return new Response(JSON.stringify(String(url).endsWith('/home') ? home : {}), {
          status: 200,
        })
      })
    )
    const client = new GfsClient({
      baseUrl: 'https://example.test',
      requestJson: requestGfsJson,
      fetchBytes: async () => new ArrayBuffer(0),
    })
    const credential = randomUUID()
    expect(await client.getHome(credential)).toEqual(home)
    await client.grant(
      {
        drive: 'private',
        resourceId: 'home',
        subjects: [{ type: 'user', id: 'other' }],
        permissions: ['read'],
      },
      credential
    )
    expect(headers).toHaveLength(2)
    for (const header of headers) expect(header.get('X-Evenfire-Gfs-Authority')).toBe('user')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMapperClient } from './contextMapperClient'

describe('ContextMapperClient readiness and discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the readiness endpoint before treating inventory as authoritative', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.healthCheck()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://context-mapper.test/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('rejects an HTTP 503 during initial discovery instead of returning an empty fleet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Service Unavailable',
            message: 'Context mapper provider inventory is not authoritative',
          }),
          { status: 503, statusText: 'Service Unavailable' }
        )
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.listServersByContext('production')).rejects.toThrow(
      'HTTP 503: Service Unavailable'
    )
  })

  it('rejects a network failure during initial discovery instead of returning an empty fleet', async () => {
    const networkError = new Error('connection reset')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError))
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.listServersByContext('production')).rejects.toBe(networkError)
  })

  it('accepts an HTTP 200 empty initial inventory as authoritative', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            servers: [],
            contextRef: 'production',
            timestamp: '2026-07-29T10:00:00.000Z',
          }),
          { status: 200 }
        )
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.listServersByContext('production')).resolves.toEqual([])
  })

  it('does not convert a failed all-server request into an authoritative empty fleet', async () => {
    const networkError = new Error('connection reset')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError))
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.listAllServers()).rejects.toBe(networkError)
  })

  it('does not convert an unavailable controller into an authoritative empty fleet', async () => {
    // The rejection case above never reaches the `!response.ok` branch, so a
    // 503 from an unready controller was uncovered: swapping that throw for
    // `return []` left the whole suite green while turning "I cannot tell you"
    // into an authoritative "there are none".
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('', { status: 503, statusText: 'Service Unavailable' }))
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.listAllServers()).rejects.toThrow(/503/)
  })
})

describe('ContextMapperClient.pollServers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rejects an HTTP 503 instead of fabricating an authoritative empty fleet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Service Unavailable',
            message: 'Context mapper provider inventory is not authoritative',
          }),
          { status: 503, statusText: 'Service Unavailable' }
        )
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.pollServers('production')).rejects.toThrow('HTTP 503: Service Unavailable')
  })

  it('rejects a network failure instead of fabricating an authoritative empty fleet', async () => {
    const networkError = new Error('connection reset')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError))
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.pollServers('production')).rejects.toBe(networkError)
  })

  it('bounds a silent HCC request so authoritative polling cannot stall indefinitely', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) return
          signal.addEventListener(
            'abort',
            () =>
              reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          )
        })
      })
    )
    const client = new ContextMapperClient('http://context-mapper.test', 10)

    await expect(client.pollServers('production')).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('accepts an HTTP 200 empty fleet as an authoritative deletion snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            servers: [],
            contextRef: 'production',
            timestamp: '2026-07-29T10:00:00.000Z',
          }),
          { status: 200 }
        )
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.pollServers('production')).resolves.toEqual({
      servers: [],
      timestamp: '2026-07-29T10:00:00.000Z',
    })
  })
})

describe('ContextMapperClient.getAuthToken', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rejects an HTTP failure instead of treating it as an unauthenticated server', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 503, statusText: 'Service Unavailable' }))
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.getAuthToken('secured-server')).rejects.toThrow(
      'HTTP 503: Service Unavailable'
    )
  })

  it('rejects a network failure instead of treating it as an unauthenticated server', async () => {
    const networkError = new Error('connection reset')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError))
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.getAuthToken('secured-server')).rejects.toBe(networkError)
  })

  it('rejects an authoritative missing token for a server that requested auth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }))
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.getAuthToken('secured-server')).rejects.toThrow('HTTP 404: Not Found')
  })

  it('retains HTTP 200 token:null as the explicit no-auth response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }))
    )
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.getAuthToken('open-server')).resolves.toBeUndefined()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { AuthClient } from '../authClient.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Desktop environment discovery request URL', () => {
  it('appends the route to the REST path while preserving its query', async () => {
    const restEndpoint = 'https://rest.customer.example.test/api?tenant=one'
    const expectedUrl =
      'https://rest.customer.example.test/api/api/v1/desktop/environment?tenant=one'
    const responseMock = new Response(
      JSON.stringify({
        externalRestApiBaseUrl: restEndpoint,
        rpcProxyBaseUrl: 'https://rpc.customer.example.test',
        profileUiBaseUrl: 'https://profile.customer.example.test',
        appName: 'Customer',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
    Object.defineProperty(responseMock, 'url', { value: expectedUrl })
    const fetchMock = vi.fn().mockResolvedValue(responseMock)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

    const response = await new AuthClient().getDesktopEnvironmentForEndpoint(restEndpoint)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl)
    expect(response.profileUiBaseUrl).toBe('https://profile.customer.example.test')
    expect(response.responseUrl).toBe(expectedUrl)
  })

  it('rejects a discovery response whose final URL differs from the selected REST endpoint', async () => {
    const restEndpoint = 'https://rest.customer.example.test'
    const responseMock = new Response('{}', { status: 200 })
    Object.defineProperty(responseMock, 'url', {
      value: 'https://other.customer.example.test/api/v1/desktop/environment',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseMock)

    await expect(new AuthClient().getDesktopEnvironmentForEndpoint(restEndpoint)).rejects.toThrow(
      'response URL mismatch'
    )
  })

  it('cancels discovery response reading when the 64 KiB bound is exceeded', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(64 * 1024 + 1) }),
      cancel,
    }
    const responseMock = new Response('{}', { status: 200 })
    Object.defineProperty(responseMock, 'body', { value: { getReader: () => reader } })
    Object.defineProperty(responseMock, 'text', { value: vi.fn().mockResolvedValue('{}') })
    Object.defineProperty(responseMock, 'url', {
      value: 'https://rest.customer.example.test/api/v1/desktop/environment',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseMock)

    await expect(
      new AuthClient().getDesktopEnvironmentForEndpoint('https://rest.customer.example.test')
    ).rejects.toThrow('response exceeded the size limit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects a redirect from the actual discovery endpoint', async () => {
    let discoveryRequests = 0
    let redirectedRequests = 0
    const server = createServer((request, response) => {
      if (request.url === '/api/v1/desktop/environment') {
        discoveryRequests++
        response.writeHead(302, { location: '/redirected-environment' })
        response.end()
        return
      }
      redirectedRequests++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server did not bind')

    try {
      await expect(
        new AuthClient().getDesktopEnvironmentForEndpoint(`http://127.0.0.1:${address.port}`)
      ).rejects.toThrow()
      expect(discoveryRequests).toBe(1)
      expect(redirectedRequests).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })
})

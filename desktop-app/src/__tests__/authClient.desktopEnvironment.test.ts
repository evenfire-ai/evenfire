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
    expect(response.responseUrl).toBe(expectedUrl)
    expect(response.profileUiBaseUrl).toBe('https://profile.customer.example.test')
  })

  it('rejects a discovery response larger than the bounded contract', async () => {
    const restEndpoint = 'https://rest.customer.example.test'
    const expectedUrl = `${restEndpoint}/api/v1/desktop/environment`
    const oversizedResponse = new Response(
      JSON.stringify({
        externalRestApiBaseUrl: restEndpoint,
        rpcProxyBaseUrl: 'https://rpc.customer.example.test',
        profileUiBaseUrl: 'https://profile.customer.example.test',
        appName: 'x'.repeat(70 * 1024),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
    Object.defineProperty(oversizedResponse, 'url', { value: expectedUrl })
    const fetchMock = vi.fn().mockResolvedValue(oversizedResponse)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

    await expect(new AuthClient().getDesktopEnvironmentForEndpoint(restEndpoint)).rejects.toThrow(
      'Desktop environment discovery response exceeded the size limit'
    )
  })

  it('rejects a redirect from the actual discovery endpoint', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/api/v1/desktop/environment') {
        response.writeHead(302, { location: '/redirected-environment' })
        response.end()
        return
      }
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
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })
})

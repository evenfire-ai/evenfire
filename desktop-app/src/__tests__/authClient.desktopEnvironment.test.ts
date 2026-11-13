import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          externalRestApiBaseUrl: 'https://rest.customer.example.test',
          rpcProxyBaseUrl: 'https://rpc.customer.example.test',
          profileUiBaseUrl: 'https://profile.customer.example.test',
          appName: 'x'.repeat(70 * 1024),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)

    await expect(
      new AuthClient().getDesktopEnvironmentForEndpoint('https://rest.customer.example.test')
    ).rejects.toThrow('Desktop environment discovery response exceeded the size limit')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../httpClient.js'
import { RpcProxyClient } from '../rpcProxyClient.js'

// Mock the config module so the module-level url() helper uses a fixed base URL
vi.mock('../config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

describe('RpcProxyClient.prewarmHost', () => {
  let client: RpcProxyClient

  beforeEach(() => {
    client = new RpcProxyClient()
    vi.restoreAllMocks()
  })

  it('POSTs to /api/v1/rpc/hosts/:hostRef/wake with bearer auth and parses 202 wake-requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'wake-requested' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client.prewarmHost('rpc-token', 'chatllm')

    expect(result).toEqual({ status: 'wake-requested' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/rpc/hosts/chatllm/wake',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer rpc-token',
        }),
      })
    )
  })

  it('parses the 200 active terminal response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'active' }),
      })
    )

    await expect(client.prewarmHost('rpc-token', 'chatllm')).resolves.toEqual({
      status: 'active',
    })
  })

  it('treats 409 not-stateless as a terminal response, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ status: 'not-stateless' }),
      })
    )

    await expect(client.prewarmHost('rpc-token', 'always-on')).resolves.toEqual({
      status: 'not-stateless',
    })
  })

  it('throws ApiError when a terminal response body violates the wake contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      })
    )

    await expect(client.prewarmHost('rpc-token', 'chatllm')).rejects.toThrow('contract-violating')
  })

  it('throws ApiError on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'host not found',
      })
    )

    const rejection = expect(client.prewarmHost('rpc-token', 'ghost')).rejects
    await rejection.toBeInstanceOf(ApiError)
    await rejection.toMatchObject({ status: 404 })
  })

  it('throws ApiError on 403 auth failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
      })
    )

    await expect(client.prewarmHost('rpc-token', 'chatllm')).rejects.toMatchObject({
      status: 403,
    })
  })

  it('URL-encodes the hostRef', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'active' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await client.prewarmHost('rpc-token', 'team/agent')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://proxy/api/v1/rpc/hosts/team%2Fagent/wake')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('RpcProxyClient.cancelTask', () => {
  let client: RpcProxyClient

  beforeEach(() => {
    client = new RpcProxyClient()
    vi.restoreAllMocks()
  })

  it('POSTs to /api/v1/rpc/hosts/:hostRef/tasks/:taskId/cancel with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    await client.cancelTask('rpc-token', 'myhost', 'abc')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/rpc/hosts/myhost/tasks/abc/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer rpc-token',
        }),
      })
    )
  })

  it('throws on non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server error',
      })
    )

    await expect(client.cancelTask('t', 'h', 'abc')).rejects.toThrow()
  })
})

describe('RpcProxyClient.requestSandboxUiOauthAuthorizeUrl', () => {
  let client: RpcProxyClient

  beforeEach(() => {
    client = new RpcProxyClient()
    vi.restoreAllMocks()
  })

  it('POSTs to /sandbox-ui/:ns/:name/oauth/authorize-url with bearer + JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ authorizeUrl: 'https://login.salesforce.com/...' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client.requestSandboxUiOauthAuthorizeUrl(
      'rpc-token',
      'sandbox-recipes',
      'crm',
      'salesforce'
    )

    expect(result.authorizeUrl).toBe('https://login.salesforce.com/...')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/sandbox-ui/sandbox-recipes/crm/oauth/authorize-url',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer rpc-token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ oauthClientId: 'salesforce', background: false }),
      })
    )
  })

  it('POSTs with background:true when the background flag is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ authorizeUrl: 'https://login.salesforce.com/...' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await client.requestSandboxUiOauthAuthorizeUrl(
      'rpc-token',
      'sandbox-recipes',
      'crm',
      'salesforce',
      true
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/sandbox-ui/sandbox-recipes/crm/oauth/authorize-url',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ oauthClientId: 'salesforce', background: true }),
      })
    )
  })

  it('throws when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"error":"recipe_not_found"}',
      })
    )
    await expect(client.requestSandboxUiOauthAuthorizeUrl('t', 'ns', 'r', 'cid')).rejects.toThrow(
      /authorize-url request failed \(404\)/
    )
  })

  it('throws when the JSON response is missing authorizeUrl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ wat: 'no key' }),
      })
    )
    await expect(client.requestSandboxUiOauthAuthorizeUrl('t', 'ns', 'r', 'cid')).rejects.toThrow(
      /missing authorizeUrl/
    )
  })

  it('URL-encodes ns / name / clientId path segments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ authorizeUrl: 'https://x' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await client.requestSandboxUiOauthAuthorizeUrl('t', 'weird/ns', 'odd name', 'cid')

    const firstCall = fetchMock.mock.calls[0]!
    const url = firstCall[0] as string
    expect(url).toContain('weird%2Fns')
    expect(url).toContain('odd%20name')
  })
})

describe('RpcProxyClient.listSandboxUiApps', () => {
  let client: RpcProxyClient

  beforeEach(() => {
    client = new RpcProxyClient()
    vi.restoreAllMocks()
  })

  it('GETs the Sandbox UI app catalog with the RPC bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          apps: [
            {
              appRef: 'sandbox-recipes/sales-crm',
              title: "Andy's Sales CRM",
              defaultPath: '/',
              ready: true,
              phase: 'active',
              updatedAt: '2026-05-25T00:00:00Z',
            },
            {
              appRef: 'sandbox-recipes/support-desk',
              title: 'Support Desk',
              defaultPath: '/tickets',
              ready: false,
              phase: 'deploying',
              updatedAt: null,
            },
          ],
        }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client.listSandboxUiApps('rpc-token')

    expect(result.apps).toHaveLength(2)
    expect(result.apps.map(app => app.title)).toEqual(["Andy's Sales CRM", 'Support Desk'])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/sandbox-ui/apps',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer rpc-token',
        }),
      })
    )
  })
})

describe('RpcProxyClient.getHostModels', () => {
  let client: RpcProxyClient

  beforeEach(() => {
    client = new RpcProxyClient()
    vi.restoreAllMocks()
  })

  it('GETs /hosts/:hostRef/models with chatId query and bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        provider: 'claude',
        hostDefault: 'claude-opus-4-8',
        sessionModel: 'claude-haiku-4-5',
        degraded: false,
        models: [
          { name: 'claude-opus-4-8', displayName: 'Opus 4.8' },
          { name: 'claude-haiku-4-5', displayName: 'Haiku 4.5', contextWindowTokens: 200000 },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client.getHostModels('rpc-token', 'my host', 'chat-1')

    expect(result).not.toBeNull()
    expect(result?.sessionModel).toBe('claude-haiku-4-5')
    expect(result?.models).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/rpc/hosts/my%20host/models?chatId=chat-1',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer rpc-token' }),
      })
    )
  })

  it('omits the chatId query entirely when no chatId is given (new-chat composer)', async () => {
    // The model LIST is host-level; a brand-new chat has no id, so the request
    // carries no `?chatId=` and the server projects `sessionModel: null`.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        provider: 'claude',
        hostDefault: 'claude-opus-4-8',
        sessionModel: null,
        degraded: false,
        models: [{ name: 'claude-opus-4-8', displayName: 'Opus 4.8' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client.getHostModels('rpc-token', 'my host', '')

    expect(result?.sessionModel).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/rpc/hosts/my%20host/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer rpc-token' }),
      })
    )
  })

  it('returns null when the host predates the endpoint (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' })
    )
    await expect(client.getHostModels('t', 'h', 'c')).resolves.toBeNull()
  })

  it('returns null when the route is not implemented (501)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 501, text: async () => 'not implemented' })
    )
    await expect(client.getHostModels('t', 'h', 'c')).resolves.toBeNull()
  })

  it('throws on a genuine server error (500)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    )
    await expect(client.getHostModels('t', 'h', 'c')).rejects.toThrow()
  })
})

describe('RpcProxyClient.setHostModel', () => {
  let client: RpcProxyClient

  beforeEach(() => {
    client = new RpcProxyClient()
    vi.restoreAllMocks()
  })

  it('POSTs /hosts/:hostRef/model with the chatId+model body and bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ effective: 'next-task', provider: 'claude', model: 'claude-haiku-4-5' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client.setHostModel('rpc-token', 'my host', 'chat-1', 'claude-haiku-4-5')

    expect(result).toEqual({
      effective: 'next-task',
      provider: 'claude',
      model: 'claude-haiku-4-5',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://proxy/api/v1/rpc/hosts/my%20host/model',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer rpc-token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ chatId: 'chat-1', model: 'claude-haiku-4-5' }),
      })
    )
  })

  it('re-throws a 403 with the model_not_allowed token in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'model_not_allowed' }),
      })
    )
    await expect(client.setHostModel('t', 'h', 'c', 'banned')).rejects.toThrow('model_not_allowed')
  })

  it('also detects model_not_allowed when mcp-host answers 400 (fail-closed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'model_not_allowed' }),
      })
    )
    await expect(client.setHostModel('t', 'h', 'c', 'banned')).rejects.toThrow('model_not_allowed')
  })

  it('does NOT map a host-access 403 to model_not_allowed (B3 regression guard)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'Forbidden: user cannot access this host' }),
      })
    )
    // An access denial must surface as a generic failure, not a policy rejection:
    // the message must not carry the model_not_allowed token the renderer keys on.
    await expect(client.setHostModel('t', 'h', 'c', 'm')).rejects.toThrow(/Set host model failed/)
    await expect(client.setHostModel('t', 'h', 'c', 'm')).rejects.not.toThrow('model_not_allowed')
  })

  it('throws on a generic non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    )
    await expect(client.setHostModel('t', 'h', 'c', 'm')).rejects.toThrow()
  })
})

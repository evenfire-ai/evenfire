import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_SECRET = process.env.INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET
const ORIGINAL_BASE_URL = process.env.CONTROL_API_BASE_URL

interface JwtClaims {
  iss: string
  aud: string
  sub: string
  iat: number
  exp: number
  jti: string
}

async function loadIssuerClient() {
  return await import('../../../src/workflow/mcpHostRuntimeTokenIssuerClient')
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function bearerJwt(headers: Record<string, string>): string {
  const authorization = headers.Authorization
  expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/)
  return authorization.slice('Bearer '.length)
}

function decodePayload(token: string): JwtClaims {
  const [, payload] = token.split('.')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims
}

function expectWrcJwt(headers: Record<string, string>): JwtClaims {
  expect(headers['x-service-token']).toBeUndefined()
  const claims = decodePayload(bearerJwt(headers))
  expect(claims).toMatchObject({
    iss: 'wrc',
    aud: 'control-api',
    sub: 'wrc-provisioner',
  })
  expect(claims.exp - claims.iat).toBe(60)
  expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  return claims
}

function canonicalIssueResponse(
  access = 'approval.access.token',
  refresh = 'approval.refresh.token',
  control = 'mcp.host.control.token'
) {
  return {
    mcpHostAccessToken: access,
    mcpHostRefreshToken: refresh,
    mcpHostControlToken: control,
    expiresInSeconds: { access: 600, refresh: 3600, control: 600 },
    hostRefs: ['sandbox-recipes/recipe-one'],
  }
}

describe('mcpHostRuntimeTokenIssuerClient (WRC)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET = 'test-wrc-internal-control-secret'
    process.env.CONTROL_API_BASE_URL = 'http://control-api.test:8090'
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv('INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET', ORIGINAL_SECRET)
    restoreEnv('CONTROL_API_BASE_URL', ORIGINAL_BASE_URL)
  })

  it('uses bearer InternalControl JWT for mcp-host-runtime-token issuance', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => canonicalIssueResponse(),
    } as Response)
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    const result = await issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe one', [
      'workflow:list',
      'workflow:read',
    ])

    expect(result.accessToken).toBe('approval.access.token')
    expect(result.refreshToken).toBe('approval.refresh.token')
    expect(result.mcpHostControlToken).toBe('mcp.host.control.token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'http://control-api.test:8090/api/v1/auth/mcp-host/sandbox-recipes/recipe%20one/tokens'
    )
    expect((init as RequestInit).body).toBe(
      '{"includeMcpHostControlToken":true,"workflowControlScopes":["workflow:list","workflow:read"]}'
    )
    expectWrcJwt((init as RequestInit).headers as Record<string, string>)
  })

  it('defaults direct control-api base URL when CONTROL_API_BASE_URL is unset', async () => {
    vi.resetModules()
    delete process.env.CONTROL_API_BASE_URL
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => canonicalIssueResponse(),
    } as Response)
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'http://control-api.control-plane.svc.cluster.local:8090/api/v1/auth/mcp-host/sandbox-recipes/recipe-one/tokens'
    )
  })

  it('uses bearer InternalControl JWT for mcpHost workflow control token issuance', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        canonicalIssueResponse(
          'approval.access.token',
          'approval.refresh.token',
          'workflow.control.token'
        ),
    } as Response)
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    const result = await issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe one', [
      'workflow:trigger',
    ])

    expect(result).toBe('workflow.control.token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(
      '{"includeMcpHostControlToken":true,"workflowControlScopes":["workflow:trigger"]}'
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'http://control-api.test:8090/api/v1/auth/mcp-host/sandbox-recipes/recipe%20one/tokens'
    )
    expectWrcJwt((init as RequestInit).headers as Record<string, string>)
  })

  it('signs each issuer call with a fresh jti', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => canonicalIssueResponse(),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          canonicalIssueResponse(
            'approval.access.token',
            'approval.refresh.token',
            'workflow.control.token'
          ),
      } as Response)
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens, issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')
    await issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')

    const approvalHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    const triggerHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>
    expect(expectWrcJwt(approvalHeaders).jti).not.toBe(expectWrcJwt(triggerHeaders).jti)
  })

  it('throws when INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET is empty', async () => {
    vi.resetModules()
    process.env.INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET = ''
    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()

    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      /INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET/
    )
  })

  it('surfaces non-2xx mcp-host-runtime-token responses without response body content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'mcpHost credential issuance failed: HTTP 401 for recipe "recipe-one"'
    )
  })

  it('surfaces non-2xx mcp-host-runtime-token responses without response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '',
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'mcpHost credential issuance failed: HTTP 403 for recipe "recipe-one"'
    )
  })

  it('surfaces mcp-host-runtime-token response-body read failures without leaking the read error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('body unavailable')
      },
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'mcpHost credential issuance failed: HTTP 500 for recipe "recipe-one"'
    )
  })

  it('rejects mcpHost credential responses missing required tokens', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mcpHostAccessToken: '', mcpHostRefreshToken: '' }),
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      /missing required fields/
    )
  })

  it('aborts hung mcp-host-runtime-token issuance requests after the request timeout', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as unknown as typeof globalThis.fetch

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    const result = issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')
    const expectation = expect(result).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_000)

    await expectation
  })

  it('propagates non-timeout mcp-host-runtime-token fetch failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'network down'
    )
  })

  it('propagates non-abort DOMException mcp-host-runtime-token failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Denied', 'SecurityError'))

    const { issueMcpHostRuntimeTokens } = await loadIssuerClient()
    await expect(issueMcpHostRuntimeTokens('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'Denied'
    )
  })

  it('surfaces non-2xx workflow-trigger responses without response body content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await expect(issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'mcpHost credential issuance failed: HTTP 401 for recipe "recipe-one"'
    )
  })

  it('surfaces non-2xx workflow-trigger responses without response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '',
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await expect(issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'mcpHost credential issuance failed: HTTP 403 for recipe "recipe-one"'
    )
  })

  it('surfaces workflow-trigger response-body read failures without leaking the read error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('body unavailable')
      },
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await expect(issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'mcpHost credential issuance failed: HTTP 500 for recipe "recipe-one"'
    )
  })

  it('rejects workflow-trigger responses missing mcpHostControlToken', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mcpHostAccessToken: 'a.b.c', mcpHostRefreshToken: 'd.e.f' }),
    } as Response) as unknown as typeof globalThis.fetch

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await expect(issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      /missing required fields/
    )
  })

  it('aborts hung workflow-trigger issuance requests after the request timeout', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as unknown as typeof globalThis.fetch

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    const result = issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')
    const expectation = expect(result).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_000)

    await expectation
  })

  it('propagates non-timeout workflow-trigger fetch failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await expect(issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'network down'
    )
  })

  it('propagates non-abort DOMException workflow-trigger failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Denied', 'SecurityError'))

    const { issueMcpHostWorkflowControlToken } = await loadIssuerClient()
    await expect(issueMcpHostWorkflowControlToken('sandbox-recipes', 'recipe-one')).rejects.toThrow(
      'Denied'
    )
  })
})

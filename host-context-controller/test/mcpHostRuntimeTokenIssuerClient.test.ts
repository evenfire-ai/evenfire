import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_SECRET = process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
const ORIGINAL_BASE_URL = process.env.CONTROL_API_BASE_URL
const ORIGINAL_TARGET_NAMESPACE = process.env.HCC_TARGET_NAMESPACE
const ORIGINAL_PUBLIC_KEY = process.env.HCC_MCP_HOST_JWT_PUBLIC_KEY

const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

interface JwtClaims {
  iss: string
  aud: string
  sub: string
  iat: number
  exp: number
  jti: string
}

async function loadIssuer() {
  const mod = await import('../src/mcpHostRuntimeTokenIssuerClient')
  return mod.issueMcpHostRuntimeTokens
}

function validAccessToken(hostName = 'chatllm', hostUid = 'host-uid'): string {
  return jwt.sign(
    {
      sub: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: [hostName],
      host_uid: hostUid,
      scope: 'workflow:approval:request',
      workflowControlScopes: [],
      mcpCapabilities: ['mcp:credential:read'],
    },
    keyPair.privateKey,
    {
      algorithm: 'RS256',
      issuer: 'control-api',
      audience: ['workflow-approvals', 'host-context-controller'],
      expiresIn: 300,
      jwtid: 'issuer-test-access',
    }
  )
}

function canonicalIssueResponse(access = validAccessToken(), refresh = 'd.e.f', control = 'g.h.i') {
  return {
    mcpHostAccessToken: access,
    mcpHostRefreshToken: refresh,
    mcpHostControlToken: control,
    expiresInSeconds: { access: 600, refresh: 3600, control: 600 },
    hostRefs: ['mcp-host/standalone'],
  }
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

describe('mcpHostRuntimeTokenIssuerClient (HCC)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET = 'test-hcc-internal-control-secret'
    process.env.CONTROL_API_BASE_URL = 'http://control-api.test:8090'
    process.env.HCC_MCP_HOST_JWT_PUBLIC_KEY = keyPair.publicKey
    delete process.env.HCC_TARGET_NAMESPACE
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv('INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET', ORIGINAL_SECRET)
    restoreEnv('CONTROL_API_BASE_URL', ORIGINAL_BASE_URL)
    restoreEnv('HCC_TARGET_NAMESPACE', ORIGINAL_TARGET_NAMESPACE)
    restoreEnv('HCC_MCP_HOST_JWT_PUBLIC_KEY', ORIGINAL_PUBLIC_KEY)
  })

  it('throws when INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET is empty', async () => {
    vi.resetModules()
    process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET = ''
    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      /INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET/
    )
  })

  it('throws when INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET still has the canary placeholder', async () => {
    vi.resetModules()
    process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET = 'replace-with-real-internal-control-secret'
    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      /placeholder value/
    )
  })

  it('rejects non-canonical Host identity before making an issuance request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const issueMcpHostRuntimeTokens = await loadIssuer()

    await expect(issueMcpHostRuntimeTokens(' chatllm ', 'host-uid')).rejects.toThrow(
      /canonical Host name/
    )
    await expect(issueMcpHostRuntimeTokens('chatllm', ' host-uid ')).rejects.toThrow(
      /live Host UID/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to the default sentinel issuance path with bearer InternalControl JWT', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => canonicalIssueResponse(),
    } as Response)
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    const result = await issueMcpHostRuntimeTokens('chatllm', 'host-uid', [
      'workflow:list',
      'workflow:read',
      'workflow:trigger',
    ])

    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(result.refreshToken).toBe('d.e.f')
    expect(result.mcpHostControlToken).toBe('g.h.i')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://control-api.test:8090/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
    expect((init as RequestInit).body).toBe(
      '{"includeMcpHostControlToken":true,"host":"chatllm","hostUid":"host-uid","workflowControlScopes":["workflow:list","workflow:read","workflow:trigger"]}'
    )
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-service-token']).toBeUndefined()

    const claims = decodePayload(bearerJwt(headers))
    expect(claims).toMatchObject({
      iss: 'hcc',
      aud: 'control-api',
      sub: 'hcc-provisioner',
    })
    expect(claims.exp - claims.iat).toBe(60)
    expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('rejects a target namespace that differs from the live Host namespace', async () => {
    vi.resetModules()
    process.env.HCC_TARGET_NAMESPACE = 'first-party-hosts'
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      /must equal CONTEXT_MAPPER_HOST_NAMESPACE/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces non-2xx responses with status code in the error message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(/HTTP 401/)
  })

  it('surfaces non-2xx responses without a response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '',
    } as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      'mcpHost runtime token issuance failed: HTTP 403'
    )
  })

  it('surfaces non-2xx responses when reading the response body fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('body unavailable')
      },
    } as unknown as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      'mcpHost runtime token issuance failed: HTTP 500'
    )
  })

  it('surfaces request aborts as issuance timeouts', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(/timed out/)
  })

  it('aborts hung issuance requests after the request timeout', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    const result = issueMcpHostRuntimeTokens('chatllm', 'host-uid')
    const expectation = expect(result).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_000)

    await expectation
  })

  it('rejects empty access/refresh/control JWTs in the response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => canonicalIssueResponse('', '', ''),
    } as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      /missing required fields/
    )
  })

  it('rejects non-positive or non-integer credential expiry fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...canonicalIssueResponse(),
        expiresInSeconds: { access: 0, refresh: 3600, control: 600 },
      }),
    } as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      /invalid expiry fields/
    )
  })

  it('rejects a cryptographically valid but differently bound access token', async () => {
    const mismatchedToken = validAccessToken('other-host', 'other-uid')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => canonicalIssueResponse(mismatchedToken),
    } as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(
      /identity does not match/
    )
  })

  it('rejects a workflow-only access token from an incompatible issuer rollout', async () => {
    const workflowOnlyToken = jwt.sign(
      {
        sub: 'mcp-host/standalone',
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        hostRefs: ['chatllm'],
        host_uid: 'host-uid',
        scope: 'workflow:approval:request',
        workflowControlScopes: [],
      },
      keyPair.privateKey,
      {
        algorithm: 'RS256',
        issuer: 'control-api',
        audience: 'workflow-approvals',
        expiresIn: 300,
        jwtid: 'issuer-test-workflow-only',
      }
    )
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => canonicalIssueResponse(workflowOnlyToken),
    } as Response) as unknown as typeof globalThis.fetch

    const issueMcpHostRuntimeTokens = await loadIssuer()
    await expect(issueMcpHostRuntimeTokens('chatllm', 'host-uid')).rejects.toThrow(/unauthorized/)
  })
})

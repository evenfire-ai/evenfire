import { describe, expect, it } from 'vitest'
import { hostServiceAccountName } from './hostServiceAccount'
import {
  buildMcpCallerResolver,
  createTokenReviewMcpCallerResolver,
  hostRefFromServiceAccountUser,
  parseBearerToken,
  tokenReviewResultFromResponse,
} from './mcpCallerAuth'
import type { HostCRD } from './types'

describe('parseBearerToken', () => {
  it('returns the token from a Bearer header', () => {
    expect(parseBearerToken('Bearer abc.def')).toBe('abc.def')
  })

  it('accepts a case-insensitive Bearer scheme', () => {
    expect(parseBearerToken('bearer abc')).toBe('abc')
  })

  it('rejects missing, empty, or non-Bearer credentials', () => {
    expect(parseBearerToken(undefined)).toBeNull()
    expect(parseBearerToken('')).toBeNull()
    expect(parseBearerToken('Bearer')).toBeNull()
    expect(parseBearerToken('Bearer ')).toBeNull()
    expect(parseBearerToken('Basic abc')).toBeNull()
    expect(parseBearerToken(['Bearer a', 'Bearer b'])).toBeNull()
  })
})

describe('hostRefFromServiceAccountUser', () => {
  it('maps a per-Host ServiceAccount username to the Host name', () => {
    expect(
      hostRefFromServiceAccountUser('system:serviceaccount:mcp-host:host-chatllm-sa', 'mcp-host')
    ).toBe('chatllm')
    expect(
      hostRefFromServiceAccountUser(
        'system:serviceaccount:mcp-host:host-chatllm-stateless-sa',
        'mcp-host'
      )
    ).toBe('chatllm-stateless')
  })

  it('rejects ServiceAccounts from another namespace or a non-Host name', () => {
    expect(
      hostRefFromServiceAccountUser('system:serviceaccount:default:host-chatllm-sa', 'mcp-host')
    ).toBeNull()
    expect(
      hostRefFromServiceAccountUser('system:serviceaccount:mcp-host:default', 'mcp-host')
    ).toBeNull()
    expect(
      hostRefFromServiceAccountUser('system:serviceaccount:mcp-host:host-sa', 'mcp-host')
    ).toBe(null)
  })

  it('round-trips the HostReconciler ServiceAccount name', () => {
    expect(hostServiceAccountName('chatllm')).toBe('host-chatllm-sa')
    expect(
      hostRefFromServiceAccountUser(
        `system:serviceaccount:mcp-host:${hostServiceAccountName('alpha')}`,
        'mcp-host'
      )
    ).toBe('alpha')
  })
})

describe('tokenReviewResultFromResponse', () => {
  it('reads client-node createTokenReview body shape', () => {
    expect(
      tokenReviewResultFromResponse({
        status: {
          authenticated: true,
          user: { username: 'system:serviceaccount:mcp-host:host-chatllm-sa' },
        },
      })
    ).toEqual({
      authenticated: true,
      username: 'system:serviceaccount:mcp-host:host-chatllm-sa',
    })
  })

  it('reads HttpInfo.data wrapping and rejects unauthenticated or empty username', () => {
    expect(
      tokenReviewResultFromResponse({
        data: {
          status: {
            authenticated: true,
            user: { username: 'system:serviceaccount:mcp-host:host-chatllm-sa' },
          },
        },
      })
    ).toEqual({
      authenticated: true,
      username: 'system:serviceaccount:mcp-host:host-chatllm-sa',
    })
    expect(tokenReviewResultFromResponse({ status: { authenticated: false } })).toEqual({
      authenticated: false,
    })
    expect(tokenReviewResultFromResponse({ status: { authenticated: true, user: {} } })).toEqual({
      authenticated: false,
    })
    expect(tokenReviewResultFromResponse(null)).toEqual({ authenticated: false })
  })
})

describe('createTokenReviewMcpCallerResolver', () => {
  const hosts = new Map<string, HostCRD>([
    [
      'chatllm',
      {
        name: 'chatllm',
        namespace: 'mcp-host',
        spec: { host: 'chatllm', contextRef: 'context1', secretRef: 'llm' },
      },
    ],
  ])

  it('returns the Host current Context from TokenReview, ignoring forged headers', async () => {
    const resolve = createTokenReviewMcpCallerResolver({
      hostNamespace: 'mcp-host',
      getHost: name => hosts.get(name),
      reviewToken: async token =>
        token === 'sa-token'
          ? {
              authenticated: true,
              username: 'system:serviceaccount:mcp-host:host-chatllm-sa',
            }
          : { authenticated: false },
    })

    const caller = await resolve({
      headers: {
        authorization: 'Bearer sa-token',
        'x-clerum-host-ref': 'other-host',
        'x-clerum-context': 'context2',
      },
    } as never)

    expect(caller).toEqual({ hostRef: 'chatllm', contextRef: 'context1' })
  })

  it('returns null when the bearer is missing, junk, or does not map to a live Host', async () => {
    const resolve = createTokenReviewMcpCallerResolver({
      hostNamespace: 'mcp-host',
      getHost: name => hosts.get(name),
      reviewToken: async () => ({ authenticated: false }),
    })

    expect(await resolve({ headers: {} } as never)).toBeNull()
    expect(await resolve({ headers: { authorization: 'Bearer junk' } } as never)).toBeNull()
  })

  it('returns null when TokenReview succeeds but the Host is gone from cache', async () => {
    const resolve = createTokenReviewMcpCallerResolver({
      hostNamespace: 'mcp-host',
      getHost: () => undefined,
      reviewToken: async () => ({
        authenticated: true,
        username: 'system:serviceaccount:mcp-host:host-chatllm-sa',
      }),
    })

    expect(await resolve({ headers: { authorization: 'Bearer sa-token' } } as never)).toBeNull()
  })

  it('does not fall back to forged headers when TokenReview fails', async () => {
    const resolve = createTokenReviewMcpCallerResolver({
      hostNamespace: 'mcp-host',
      getHost: name => hosts.get(name),
      reviewToken: async () => ({ authenticated: false }),
    })

    expect(
      await resolve({
        headers: {
          authorization: 'Bearer junk',
          'x-clerum-host-ref': 'chatllm',
          'x-clerum-context': 'context1',
        },
      } as never)
    ).toBeNull()
  })

  it('returns null when TokenReview throws', async () => {
    const resolve = createTokenReviewMcpCallerResolver({
      hostNamespace: 'mcp-host',
      getHost: name => hosts.get(name),
      reviewToken: async () => {
        throw new Error('apiserver unavailable')
      },
    })

    expect(await resolve({ headers: { authorization: 'Bearer sa-token' } } as never)).toBeNull()
  })
})

describe('buildMcpCallerResolver', () => {
  const hosts = new Map<string, HostCRD>([
    [
      'chatllm',
      {
        name: 'chatllm',
        namespace: 'mcp-host',
        spec: { host: 'chatllm', contextRef: 'context1', secretRef: 'llm' },
      },
    ],
  ])

  it('uses TokenReview in production and ignores forged headers', async () => {
    const resolve = buildMcpCallerResolver({
      devMode: false,
      hostNamespace: 'mcp-host',
      getHost: name => hosts.get(name),
      reviewToken: async token =>
        token === 'sa-token'
          ? {
              authenticated: true,
              username: 'system:serviceaccount:mcp-host:host-chatllm-sa',
            }
          : { authenticated: false },
      devContextRef: 'dev-context',
    })

    expect(
      await resolve({
        headers: {
          authorization: 'Bearer sa-token',
          'x-clerum-context': 'context2',
        },
      } as never)
    ).toEqual({ hostRef: 'chatllm', contextRef: 'context1' })
    expect(
      await resolve({
        headers: { authorization: 'Bearer junk', 'x-clerum-context': 'context1' },
      } as never)
    ).toBeNull()
  })

  it('binds to the configured Context only in devMode', async () => {
    const resolve = buildMcpCallerResolver({
      devMode: true,
      hostNamespace: 'mcp-host',
      getHost: () => undefined,
      reviewToken: async () => ({ authenticated: false }),
      devContextRef: 'dev-context',
    })

    expect(await resolve({ headers: {} } as never)).toEqual({
      hostRef: 'dev',
      contextRef: 'dev-context',
    })
  })
})

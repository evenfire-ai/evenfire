import { describe, expect, it, vi } from 'vitest'
import {
  McpProxyAuthenticationError,
  McpProxyAuthenticator,
  type HostBearerVerifier,
  type TokenReviewClient,
} from './mcpProxyAuthentication'

const scheme = ['Be', 'arer'].join('')
const systemValue = ['fixture', 'identity'].join('_')
const hostValue = ['fixture', 'host'].join('_')
const mcpValue = ['fixture', 'mcp'].join('_')
const headerFor = (value: string) => [scheme, value].join(' ')
const hostPrincipal = {
  subject: 'mcp-host/standalone',
  hostName: 'host-a',
  hostUid: 'host-uid-a',
  namespace: 'mcp-host',
  jti: 'jti-a',
  issuedAt: 100,
  expiresAt: 400,
  audiences: ['host-context-controller'],
} as const

function makeAuthenticator(
  review: TokenReviewClient['review'] = async () => ({
    status: {
      authenticated: true,
      user: {
        username: 'system:serviceaccount:mcp-server:mcp-proxy',
        uid: 'sa-uid',
      },
      audiences: ['host-context-controller'],
    },
  }),
  readServiceAccountUid = () => Promise.resolve('sa-uid'),
  hostVerifier: HostBearerVerifier = { authenticate: vi.fn(() => hostPrincipal) }
) {
  return new McpProxyAuthenticator({
    tokenReviewClient: { review },
    readServiceAccountUid,
    systemNamespace: 'mcp-server',
    systemServiceAccountName: 'mcp-proxy',
    hostVerifier,
  })
}

describe('McpProxyAuthenticator', () => {
  it('TokenReviews the system bearer with the exact HCC audience and live SA UID', async () => {
    const review = vi.fn(async () => ({
      status: {
        authenticated: true,
        user: {
          username: 'system:serviceaccount:mcp-server:mcp-proxy',
          uid: 'sa-uid',
        },
        audiences: ['host-context-controller'],
      },
    }))
    const authenticator = makeAuthenticator(review)

    await expect(
      authenticator.authenticateSystem(
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue)]
      )
    ).resolves.toMatchObject({
      subject: 'system:serviceaccount:mcp-server:mcp-proxy',
      uid: 'sa-uid',
    })
    expect(review).toHaveBeenCalledWith({
      token: systemValue,
      audiences: ['host-context-controller'],
      expirationSeconds: 600,
    })
  })

  it('accepts a TokenReview audience list containing the HCC audience', async () => {
    const authenticator = makeAuthenticator(async () => ({
      status: {
        authenticated: true,
        user: {
          username: ['system', 'serviceaccount', 'mcp-server', 'mcp-proxy'].join(':'),
          uid: 'sa-uid',
        },
        audiences: ['other-audience', 'host-context-controller'],
      },
    }))

    await expect(
      authenticator.authenticateSystem(
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue)]
      )
    ).resolves.toMatchObject({ uid: 'sa-uid' })
  })

  it.each([
    ['wrong username', 'system:serviceaccount:mcp-server:other', 'sa-uid', ['host-context-controller']],
    ['wrong UID', 'system:serviceaccount:mcp-server:mcp-proxy', 'old-uid', ['host-context-controller']],
    ['wrong audience', 'system:serviceaccount:mcp-server:mcp-proxy', 'sa-uid', ['other-audience']],
  ])('rejects %s as an opaque unauthorized result', async (_label, username, uid, audiences) => {
    const authenticator = makeAuthenticator(async () => ({
      status: { authenticated: true, user: { username, uid }, audiences },
    }))
    await expect(
      authenticator.authenticateSystem(
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue)]
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('rejects a TokenReview that is not authenticated', async () => {
    const authenticator = makeAuthenticator(async () => ({ status: { authenticated: false } }))
    await expect(
      authenticator.authenticateSystem(
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue)]
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('fails unavailable when TokenReview or live SA identity cannot be obtained', async () => {
    const reviewFailure = makeAuthenticator(async () => {
      throw new Error('apiserver unavailable')
    })
    await expect(
      reviewFailure.authenticateSystem(
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue)]
      )
    ).rejects.toMatchObject({ code: 'unavailable' })

    const identityFailure = makeAuthenticator(undefined, async () => {
      throw new Error('serviceaccount unavailable')
    })
    await expect(
      identityFailure.authenticateSystem(
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue)]
      )
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects duplicate or malformed system fields before TokenReview', async () => {
    const review = vi.fn(async () => ({
      status: {
        authenticated: true,
        user: {
          username: 'system:serviceaccount:mcp-server:mcp-proxy',
          uid: 'sa-uid',
        },
        audiences: ['host-context-controller'],
      },
    }))
    const authenticator = makeAuthenticator(review)
    const cases: Array<[Record<string, string | string[]>, string[]]> = [
      [
        { authorization: headerFor(systemValue) },
        ['Authorization', headerFor(systemValue), 'authorization', headerFor('fixture_second')],
      ],
      [{ authorization: ['one', 'two'] }, ['Authorization', 'one', 'authorization', 'two']],
      [{ authorization: 'Basic fixture_identity' }, ['Authorization', 'Basic fixture_identity']],
    ]
    for (const [headers, rawHeaders] of cases) {
      await expect(authenticator.authenticateSystem(headers, rawHeaders)).rejects.toMatchObject({
        code: 'unauthorized',
      })
    }
    expect(review).not.toHaveBeenCalled()
  })

  it('keeps Host bearer authentication on its private header', async () => {
    const hostVerifier = { authenticate: vi.fn(() => hostPrincipal) }
    const authenticator = makeAuthenticator(undefined, undefined, hostVerifier)
    expect(
      authenticator.authenticateHost(
        {
          'x-clerum-host-authorization': headerFor(hostValue),
          authorization: headerFor(mcpValue),
        },
        [
          'X-Clerum-Host-Authorization',
          headerFor(hostValue),
          'Authorization',
          headerFor(mcpValue),
        ]
      )
    ).toEqual(hostPrincipal)
    expect(hostVerifier.authenticate).toHaveBeenCalledWith(
      { authorization: headerFor(hostValue) },
      ['Authorization', headerFor(hostValue)]
    )
  })

  it('rejects duplicate Host bearer fields', async () => {
    const hostVerifier = { authenticate: vi.fn(() => hostPrincipal) }
    const authenticator = makeAuthenticator(undefined, undefined, hostVerifier)
    expect(() =>
      authenticator.authenticateHost(
        { 'x-clerum-host-authorization': headerFor(hostValue) },
        [
          'X-Clerum-Host-Authorization',
          headerFor(hostValue),
          'x-clerum-host-authorization',
          headerFor('fixture_second'),
        ]
      )
    ).toThrow(McpProxyAuthenticationError)
    expect(hostVerifier.authenticate).not.toHaveBeenCalled()
  })
})

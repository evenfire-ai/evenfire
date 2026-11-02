import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { loadOidcProviderConfiguration } from '../src/oidc/configuration.js'
import { isVerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import { OIDC_R5_PUBLIC_IP, createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  transport: vi.fn(),
}))

vi.mock('node:dns/promises', () => ({
  lookup: () => network.lookup(),
}))

vi.mock('../src/http/pinnedFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: PinnedFetchOptions = {}) =>
      actual.pinnedFetch(url, field, {
        ...options,
        transport: input => network.transport(input),
      }),
  }
})

beforeEach(() => {
  network.lookup.mockReset().mockResolvedValue([{ address: OIDC_R5_PUBLIC_IP, family: 4 }])
  network.transport.mockReset()
})

describe('R5 client_secret_post profile coverage', () => {
  it('completes a verified code exchange with credentials in the form body', async () => {
    const fixture = createOidcR5ProtocolFixture({
      clientAuthenticationMethod: 'client_secret_post',
    })
    network.transport.mockImplementation(input => fixture.transport(input as never))

    const attempt = await fixture.begin()
    const proof = await fixture.complete(attempt.state)

    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect(fixture.tokenRequests).toHaveLength(1)
    const request = fixture.tokenRequests[0]!
    const body = new URLSearchParams(request.body)
    expect(body.get('client_id')).toBe('r5-fixture-client')
    expect(body.get('client_secret')).toBe('r5-fixture-client-secret')
    expect(Object.keys(request.headers).some(name => name.toLowerCase() === 'authorization')).toBe(
      false
    )
  })

  it('rejects an advertised authentication-method mismatch without token fallback', async () => {
    const fixture = createOidcR5ProtocolFixture({
      clientAuthenticationMethod: 'client_secret_post',
      advertisedClientAuthenticationMethods: ['client_secret_basic'],
    })
    network.transport.mockImplementation(input => fixture.transport(input as never))

    await expect(fixture.engine.validateProvider()).resolves.toMatchObject({
      status: 'incompatible',
    })
    expect(fixture.tokenRequests).toHaveLength(0)
  })

  it('rejects unsupported configured client authentication methods', () => {
    expect(() =>
      loadOidcProviderConfiguration(
        {
          CONTROL_API_OIDC_REGISTRATION_ID: 'r5-unsupported',
          CONTROL_API_OIDC_DISPLAY_LABEL: 'R5 controlled provider',
          CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/tenant',
          CONTROL_API_OIDC_CLIENT_ID: 'r5-fixture-client',
          CONTROL_API_OIDC_CLIENT_SECRET: 'r5-fixture-client-secret',
          CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'none',
          CONTROL_API_OIDC_REDIRECT_URI: 'https://control.example.test/api/v1/oidc/callback',
          CONTROL_API_OIDC_RESPONSE_MODE: 'query',
          CONTROL_API_OIDC_TRUST_GENERATION: 'r5-test-generation',
        },
        'ab'.repeat(32)
      )
    ).toThrow(/Invalid OIDC provider configuration field/)
  })
})

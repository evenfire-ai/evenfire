import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { resolveValidatedOAuthEndpoint } from '../src/http/validateMcpServerSpec.js'
import { OidcProviderUnavailableError, isVerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import { OIDC_R5_PUBLIC_IP, createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

type LookupBarrier = {
  hostname: string
  callNumbers: Set<number>
  expectedArrivals: number
  arrivals: number
  gate: Promise<void>
  release: () => void
}

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  transport: vi.fn(),
  routes: new Map<string, (input: unknown) => Promise<unknown>>(),
  lookupCounts: new Map<string, number>(),
  failureAt: new Map<string, Map<number, string>>(),
  addresses: new Map<string, string[]>(),
  barrier: undefined as LookupBarrier | undefined,
}))

vi.mock('node:dns/promises', () => ({
  lookup: (hostname: string) => network.lookup(hostname),
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
  network.routes.clear()
  network.lookupCounts.clear()
  network.failureAt.clear()
  network.addresses.clear()
  network.barrier = undefined
  network.lookup.mockReset().mockImplementation(async (hostname: string) => {
    const calls = (network.lookupCounts.get(hostname) ?? 0) + 1
    network.lookupCounts.set(hostname, calls)
    const barrier = network.barrier
    if (barrier?.hostname === hostname && barrier.callNumbers.has(calls)) {
      barrier.arrivals += 1
      if (barrier.arrivals === barrier.expectedArrivals) barrier.release()
      await barrier.gate
    }
    const failure = network.failureAt.get(hostname)?.get(calls)
    if (failure) {
      const error = Object.assign(new Error(failure), { code: failure })
      throw error
    }
    const addresses = network.addresses.get(hostname) ?? [OIDC_R5_PUBLIC_IP]
    return addresses.map(address => ({ address, family: 4 }))
  })
  network.transport.mockReset().mockImplementation(async (input: { url: string }) => {
    const hostname = new URL(input.url).hostname
    const route = network.routes.get(hostname)
    if (!route) throw new Error(`No controlled OIDC route for ${hostname}`)
    return route(input)
  })
})

function registerFixture(fixture: ReturnType<typeof createOidcR5ProtocolFixture>): void {
  for (const endpoint of [
    fixture.issuer,
    fixture.authorizationEndpoint,
    fixture.tokenEndpoint,
    fixture.jwksUri,
  ]) {
    network.routes.set(new URL(endpoint).hostname, input => fixture.transport(input as never))
  }
}

function setFailure(host: string, callNumber: number, code: string): void {
  network.failureAt.set(host, new Map([[callNumber, code]]))
}

function setLookupBarrier(hostname: string, callNumbers: number[], expectedArrivals: number): void {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  network.barrier = {
    hostname,
    callNumbers: new Set(callNumbers),
    expectedArrivals,
    arrivals: 0,
    gate,
    release,
  }
}

describe('R5 OIDC transient DNS classification', () => {
  it.each(['EAI_AGAIN', 'ETIMEDOUT', 'ESERVFAIL', 'SERVFAIL'])(
    'preserves the existing transient DNS allowlist for %s',
    async code => {
      const result = await resolveValidatedOAuthEndpoint(
        'https://resolver.example.test/token',
        'OIDC token endpoint',
        {
          resolveDns: async () => {
            throw Object.assign(new Error(code), { code })
          },
        }
      )
      expect(result).toMatchObject({ ok: false, classification: 'transient_dns' })
    }
  )

  it('does not treat a permanent DNS code as transient because the hostname contains a marker', async () => {
    const result = await resolveValidatedOAuthEndpoint(
      'https://etimedout.example.test/token',
      'OIDC token endpoint',
      {
        resolveDns: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND etimedout.example.test'), {
            code: 'ENOTFOUND',
          })
        },
      }
    )

    expect(result).toMatchObject({ ok: false, classification: 'trust_rejected' })

    const messageOnlyHostname = await resolveValidatedOAuthEndpoint(
      'https://etimedout.example.test/token',
      'OIDC token endpoint',
      {
        resolveDns: async () => {
          throw new Error('getaddrinfo ENOTFOUND etimedout.example.test')
        },
      }
    )
    expect(messageOnlyHostname).toMatchObject({ ok: false, classification: 'trust_rejected' })
  })

  it('preserves the bounded message fallback when a resolver omits its error code', async () => {
    const result = await resolveValidatedOAuthEndpoint(
      'https://resolver.example.test/token',
      'OIDC token endpoint',
      {
        resolveDns: async () => {
          throw new Error('getaddrinfo: ETIMEDOUT')
        },
      }
    )

    expect(result).toMatchObject({ ok: false, classification: 'transient_dns' })
  })

  it('reports a discovery DNS outage as unavailable without issuing a network request', async () => {
    const fixture = createOidcR5ProtocolFixture()
    registerFixture(fixture)
    setFailure(new URL(fixture.issuer).hostname, 1, 'EAI_AGAIN')

    await expect(fixture.engine.validateProvider()).resolves.toMatchObject({
      status: 'unavailable',
    })
    expect(network.transport).not.toHaveBeenCalled()
  })

  it('reports token and JWKS request DNS outages as unavailable, then recovers cleanly', async () => {
    const fixture = createOidcR5ProtocolFixture()
    registerFixture(fixture)
    const tokenHost = new URL(fixture.tokenEndpoint).hostname
    const firstAttempt = await fixture.begin()
    setFailure(tokenHost, 2, 'EAI_AGAIN')
    await expect(fixture.complete(firstAttempt.state)).rejects.toBeInstanceOf(
      OidcProviderUnavailableError
    )
    expect([...fixture.db.rows.values()].map(row => row.status)).toEqual(['failed'])

    network.failureAt.clear()
    const recoveredAttempt = await fixture.begin()
    const proof = await fixture.complete(recoveredAttempt.state)
    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)

    const jwksFixture = createOidcR5ProtocolFixture({ hostPrefix: 'jwks-outage' })
    registerFixture(jwksFixture)
    setFailure(new URL(jwksFixture.jwksUri).hostname, 2, 'ESERVFAIL')
    await expect(jwksFixture.engine.validateProvider()).resolves.toMatchObject({
      status: 'unavailable',
    })
    network.failureAt.clear()
    await expect(jwksFixture.engine.validateProvider()).resolves.toMatchObject({
      status: 'metadata-and-jwks-valid',
    })
    expect(network.lookupCounts.get(new URL(jwksFixture.jwksUri).hostname)).toBeGreaterThan(0)
  })

  it('keeps permanent DNS errors and private-address controls incompatible', async () => {
    const permanent = createOidcR5ProtocolFixture({ hostPrefix: 'permanent-dns' })
    registerFixture(permanent)
    setFailure(new URL(permanent.tokenEndpoint).hostname, 1, 'ENOTFOUND')
    await expect(permanent.engine.validateProvider()).resolves.toMatchObject({
      status: 'incompatible',
    })

    const privateTarget = createOidcR5ProtocolFixture({ hostPrefix: 'private-address' })
    registerFixture(privateTarget)
    network.addresses.set(new URL(privateTarget.jwksUri).hostname, ['10.30.0.5'])
    await expect(privateTarget.engine.validateProvider()).resolves.toMatchObject({
      status: 'incompatible',
      reason: 'untrusted-endpoint',
    })
    expect(network.transport).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: privateTarget.jwksUri })
    )
  })

  it('keeps insecure metadata endpoints in the trusted-endpoint result category', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'insecure-metadata' })
    registerFixture(fixture)
    fixture.metadata.authorization_endpoint = 'http://authorization.example.test/authorize'

    await expect(fixture.engine.validateProvider()).resolves.toMatchObject({
      status: 'incompatible',
      reason: 'untrusted-endpoint',
    })
    expect(network.transport).toHaveBeenCalledTimes(1)
  })

  it('keeps permanent DNS errors incompatible when a hostname resembles a transient code', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'etimedout' })
    registerFixture(fixture)
    setFailure(new URL(fixture.tokenEndpoint).hostname, 1, 'ENOTFOUND')

    await expect(fixture.engine.validateProvider()).resolves.toMatchObject({
      status: 'incompatible',
    })
    expect(network.transport).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: fixture.tokenEndpoint })
    )
  })

  it('keeps concurrent provider outcomes isolated', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'concurrent' })
    registerFixture(fixture)
    const unavailableAttempt = await fixture.begin()
    const healthyAttempt = await fixture.begin()
    const tokenHost = new URL(fixture.tokenEndpoint).hostname
    setFailure(tokenHost, 2, 'EAI_AGAIN')
    setLookupBarrier(tokenHost, [2, 3], 2)

    const results = await Promise.allSettled([
      fixture.complete(unavailableAttempt.state),
      fixture.complete(healthyAttempt.state),
    ])
    expect(network.barrier?.arrivals).toBe(2)
    expect(results[0]?.status).toBe('rejected')
    expect(results[0]?.status === 'rejected' && results[0].reason).toBeInstanceOf(
      OidcProviderUnavailableError
    )
    expect(results[1]?.status).toBe('fulfilled')
    expect(
      results[1]?.status === 'fulfilled' && isVerifiedOidcIdentityProof(results[1].value)
    ).toBe(true)
    expect([...fixture.db.rows.values()].map(row => row.status).sort()).toEqual([
      'completed',
      'failed',
    ])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { OidcAttemptRejectedError, OidcCallerCancelledError } from '../src/oidc/protocolResult.js'
import { OIDC_R5_PUBLIC_IP, createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  transport: vi.fn(),
  routes: new Map<string, (input: unknown) => Promise<unknown>>(),
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

beforeEach(() => {
  network.routes.clear()
  network.lookup.mockReset().mockResolvedValue([{ address: OIDC_R5_PUBLIC_IP, family: 4 }])
  network.transport.mockReset().mockImplementation((input: { url: string }) => {
    const route = network.routes.get(new URL(input.url).hostname)
    if (!route) throw new Error('Unexpected OIDC fixture request')
    return route(input)
  })
})

describe('typed OIDC operation outcomes', () => {
  it('marks a consumed or replayed attempt as an attempt rejection', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-replay' })
    registerFixture(fixture)
    const attempt = await fixture.begin()
    await fixture.complete(attempt.state)

    await expect(fixture.complete(attempt.state)).rejects.toBeInstanceOf(OidcAttemptRejectedError)
    await expect(
      fixture.engine.completeIdentityProofAttempt({
        state: attempt.state,
        code: 'r5-fixture-code',
        issuer: fixture.issuer,
      })
    ).rejects.toMatchObject({ attemptReason: 'expired-or-replayed' })
  })

  it('propagates caller cancellation without contacting the provider', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-cancel' })
    registerFixture(fixture)
    const controller = new AbortController()
    controller.abort()

    await expect(
      fixture.engine.validateProvider({ signal: controller.signal })
    ).rejects.toBeInstanceOf(OidcCallerCancelledError)
    expect(network.transport).not.toHaveBeenCalled()
  })
})

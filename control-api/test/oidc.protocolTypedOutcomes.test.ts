import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import {
  OidcAttemptRejectedError,
  OidcCallerCancelledError,
  OidcPersistenceFailure,
} from '../src/oidc/protocolResult.js'
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
  it('defaults retryability only for non-consuming persistence operations', () => {
    expect(new OidcPersistenceFailure('insert').retrySameAttempt).toBe(true)
    expect(new OidcPersistenceFailure('preflight').retrySameAttempt).toBe(true)
    expect(new OidcPersistenceFailure('claim').retrySameAttempt).toBe(false)
    expect(new OidcPersistenceFailure('finalize').retrySameAttempt).toBe(false)
  })

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

  it('does not permit retrying an attempt when cancellation persistence is ambiguous', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-cancel-persist-failure' })
    registerFixture(fixture)
    const attempt = await fixture.begin()
    fixture.db.failCancellation = true

    const error = await fixture.engine
      .cancelIdentityProofAttempt({
        state: attempt.state,
        browserBinding: attempt.browserBinding,
      })
      .catch(value => value)

    expect(error).toBeInstanceOf(OidcPersistenceFailure)
    expect(error).toMatchObject({
      category: 'persistence-failure',
      operation: 'finalize',
      retrySameAttempt: false,
    })
    expect([...fixture.db.rows.values()][0]?.status).toBe('pending')
  })

  it('does not permit retrying an attempt when the successful claim reply is lost', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-claim-reply-loss' })
    registerFixture(fixture)
    const attempt = await fixture.begin()
    fixture.db.failAfterClaim = true

    const error = await fixture.complete(attempt.state).catch(value => value)

    expect(error).toBeInstanceOf(OidcPersistenceFailure)
    expect(error).toMatchObject({
      category: 'persistence-failure',
      operation: 'claim',
      retrySameAttempt: false,
    })
    const row = [...fixture.db.rows.values()][0]
    expect(row?.status).toBe('redeeming')
    expect(row?.verifierEncrypted).toBeNull()
    expect(row?.nonceEncrypted).toBeNull()
    expect(fixture.tokenRequests).toHaveLength(0)
  })

  it('preserves the safe primary cause when failed-attempt persistence also fails', async () => {
    const primaryFixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-primary-failure' })
    registerFixture(primaryFixture)
    const primaryAttempt = await primaryFixture.begin()
    primaryFixture.setKeys([])
    await expect(primaryFixture.complete(primaryAttempt.state)).rejects.toBeInstanceOf(
      OidcAttemptRejectedError
    )

    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-finalize-failure' })
    registerFixture(fixture)
    const attempt = await fixture.begin()
    fixture.setKeys([])
    fixture.db.failFinishStatus = 'failed'

    const error = await fixture.complete(attempt.state).catch(value => value)
    expect(error).toBeInstanceOf(OidcPersistenceFailure)
    expect(error).toMatchObject({
      category: 'persistence-failure',
      operation: 'finalize',
      primaryOutcome: 'attempt-rejected',
    })
    const row = [...fixture.db.rows.values()][0]
    expect(row?.status).toBe('redeeming')
    expect(row?.verifierEncrypted).toBeNull()
    expect(row?.nonceEncrypted).toBeNull()
    expect(fixture.tokenRequests).toHaveLength(1)
  })

  it('preserves an unavailable-provider cause when failed-attempt persistence also fails', async () => {
    const primaryFixture = createOidcR5ProtocolFixture({
      hostPrefix: 'typed-primary-unavailable',
      tokenStatus: 503,
    })
    registerFixture(primaryFixture)
    const primaryAttempt = await primaryFixture.begin()
    await expect(primaryFixture.complete(primaryAttempt.state)).rejects.toMatchObject({
      category: 'provider-unavailable',
      retrySameAttempt: false,
    })
    expect([...primaryFixture.db.rows.values()][0]?.status).toBe('failed')
    await expect(primaryFixture.complete(primaryAttempt.state)).rejects.toMatchObject({
      category: 'attempt-rejected',
    })
    expect(primaryFixture.tokenRequests).toHaveLength(1)

    const fixture = createOidcR5ProtocolFixture({
      hostPrefix: 'typed-finalize-unavailable',
      tokenStatus: 503,
    })
    registerFixture(fixture)
    const attempt = await fixture.begin()
    fixture.db.failFinishStatus = 'failed'

    const error = await fixture.complete(attempt.state).catch(value => value)

    expect(error).toBeInstanceOf(OidcPersistenceFailure)
    expect(error).toMatchObject({
      category: 'persistence-failure',
      operation: 'finalize',
      primaryOutcome: 'provider-unavailable',
      retrySameAttempt: false,
    })
    expect([...fixture.db.rows.values()][0]?.status).toBe('redeeming')
    expect(fixture.tokenRequests).toHaveLength(1)
  })

  it('does not return a verified proof when completed-state persistence fails', async () => {
    const fixture = createOidcR5ProtocolFixture({ hostPrefix: 'typed-complete-persist-failure' })
    registerFixture(fixture)
    const attempt = await fixture.begin()
    fixture.db.failFinishStatus = 'completed'

    const error = await fixture.complete(attempt.state).catch(value => value)

    expect(error).toBeInstanceOf(OidcPersistenceFailure)
    expect(error).toMatchObject({
      category: 'persistence-failure',
      operation: 'finalize',
      retrySameAttempt: false,
    })
    const row = [...fixture.db.rows.values()][0]
    expect(row?.status).toBe('failed')
    expect(row?.verifierEncrypted).toBeNull()
    expect(row?.nonceEncrypted).toBeNull()
    expect(fixture.tokenRequests).toHaveLength(1)
  })
})

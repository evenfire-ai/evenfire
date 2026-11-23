import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { loadOidcProviderConfiguration, readOidcClientSecret } from '../src/oidc/configuration.js'
import { OidcProtocolEngine, isVerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import { OidcAttemptRejectedError } from '../src/oidc/protocolResult.js'
import {
  OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP,
  createOidcMemberSignInFakeProvider,
  oidcMemberSignInFakeTransport,
} from './helpers/oidcMemberSignInFakeProvider.js'
import { OidcR5MemoryAttemptDb } from './helpers/oidcR5ProtocolFixture.js'

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
  network.lookup
    .mockReset()
    .mockResolvedValue([{ address: OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP, family: 4 }])
  network.transport.mockReset().mockImplementation(input => oidcMemberSignInFakeTransport(input))
})

const ENTRA_TENANT_ID = '3f2c1a9e-5b7d-4c8e-9a0b-1c2d3e4f5a6b'

describe('fake OIDC provider for member sign-in tests', () => {
  it('mints proofs with test-chosen claims through the real engine', async () => {
    const fake = createOidcMemberSignInFakeProvider()

    const proof = await fake.signIn({
      sub: 'fake-subject-claims',
      email: 'Member@Example.test',
      email_verified: true,
      tid: 'fake-tenant-claims',
      roles: ['Evenfire.Member'],
      acct: 0,
    })

    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect(proof.subject).toBe('fake-subject-claims')
    expect(proof.issuer).toBe(fake.provider.issuer)
    expect(proof.attributes).toMatchObject({
      email: 'Member@Example.test',
      emailVerified: true,
    })
    expect(proof.verifiedClaims.claims.tid).toEqual({
      status: 'present',
      value: 'fake-tenant-claims',
    })
    expect(proof.verifiedClaims.claims.roles).toEqual({
      status: 'present',
      value: ['Evenfire.Member'],
    })
    expect(proof.verifiedClaims.claims.acct).toEqual({ status: 'present', value: 0 })
    expect(proof.verifiedClaims.claims.idp).toEqual({ status: 'missing' })
    expect(fake.env.CONTROL_API_OIDC_MEMBER_SIGN_IN).toBe('enabled')
    expect(fake.env.CONTROL_API_OIDC_UNRELEASED).toBe('acknowledged')
    expect(fake.provider.memberSignIn).not.toBeNull()
    expect(fake.provider.memberAuthenticationActivated).toBe(true)
  })

  it('keeps two attempts independent', async () => {
    const fake = createOidcMemberSignInFakeProvider()
    // Hold each token request until both attempts reach the token endpoint, so
    // both attempts are authorized, with their nonces and PKCE challenges
    // outstanding, before either one is redeemed.
    let releaseTokenRequests!: () => void
    const bothTokenRequestsArrived = new Promise<void>(resolve => {
      releaseTokenRequests = resolve
    })
    let tokenRequests = 0
    network.transport.mockImplementation(async (input: { url: string }) => {
      if (input.url === `${fake.provider.issuer}/token`) {
        tokenRequests += 1
        if (tokenRequests === 2) releaseTokenRequests()
        await bothTokenRequestsArrived
      }
      return oidcMemberSignInFakeTransport(input as never)
    })

    const [first, second] = await Promise.all([
      fake.signIn({ sub: 'fake-subject-first', tid: 'fake-tenant-first' }),
      fake.signIn({ sub: 'fake-subject-second', tid: 'fake-tenant-second' }),
    ])

    expect(tokenRequests).toBe(2)
    expect(isVerifiedOidcIdentityProof(first)).toBe(true)
    expect(isVerifiedOidcIdentityProof(second)).toBe(true)
    expect(first.subject).toBe('fake-subject-first')
    expect(second.subject).toBe('fake-subject-second')
    expect(first.verifiedClaims.claims.tid).toEqual({
      status: 'present',
      value: 'fake-tenant-first',
    })
    expect(second.verifiedClaims.claims.tid).toEqual({
      status: 'present',
      value: 'fake-tenant-second',
    })
    expect(first.attemptId).not.toBe(second.attemptId)
  })

  it('rejects a token signed with an unpublished key', async () => {
    const fake = createOidcMemberSignInFakeProvider()
    const claims = { sub: 'fake-subject-keys', email: 'keys@example.test', email_verified: true }

    await expect(fake.signIn(claims, { signWith: 'unpublished' })).rejects.toBeInstanceOf(
      OidcAttemptRejectedError
    )

    const secondPublished = await fake.signIn(claims, { signWith: 'published-2' })
    const firstPublished = await fake.signIn(claims, { signWith: 'published-1' })
    expect(isVerifiedOidcIdentityProof(secondPublished)).toBe(true)
    expect(isVerifiedOidcIdentityProof(firstPublished)).toBe(true)
    expect(secondPublished.subject).toBe('fake-subject-keys')
  })

  it('projects an oversized roles array as unsupported', async () => {
    const fake = createOidcMemberSignInFakeProvider()
    const roles = (count: number) => Array.from({ length: count }, (_, index) => `role-${index}`)

    const oversized = await fake.signIn({ sub: 'fake-subject-roles', roles: roles(33) })
    const atLimit = await fake.signIn({ sub: 'fake-subject-roles', roles: roles(32) })

    expect(oversized.verifiedClaims.claims.roles).toEqual({ status: 'unsupported' })
    expect(atLimit.verifiedClaims.claims.roles).toEqual({ status: 'present', value: roles(32) })
  })

  it('mints a proof under an Entra issuer pinned to its tenant', async () => {
    const issuer = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`
    const fake = createOidcMemberSignInFakeProvider({
      issuer,
      memberSignInEnv: { CONTROL_API_OIDC_TENANT_ID: ENTRA_TENANT_ID },
    })

    const proof = await fake.signIn({
      sub: 'fake-subject-entra',
      email: 'entra@example.test',
      tid: ENTRA_TENANT_ID,
      idp: 'https://sts.windows.net/fake-home-tenant/',
    })

    expect(fake.provider.memberSignIn).toMatchObject({
      entraTenantId: ENTRA_TENANT_ID,
      accountCreation: 'entra',
    })
    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect(proof.issuer).toBe(issuer)
    expect(proof.verifiedClaims.claims.tid).toEqual({ status: 'present', value: ENTRA_TENANT_ID })
    expect(proof.verifiedClaims.claims.idp).toEqual({
      status: 'present',
      value: 'https://sts.windows.net/fake-home-tenant/',
    })
    expect(proof.verifiedClaims.claims.email_verified).toEqual({ status: 'missing' })
  })

  it('removes a default member sign-in variable passed as undefined', async () => {
    const fake = createOidcMemberSignInFakeProvider({
      memberSignInEnv: { CONTROL_API_OIDC_MEMBER_SIGN_IN: undefined },
    })

    const proof = await fake.signIn({ sub: 'fake-subject-switch-off' })

    expect('CONTROL_API_OIDC_MEMBER_SIGN_IN' in fake.env).toBe(false)
    expect(fake.env.CONTROL_API_OIDC_UNRELEASED).toBe('acknowledged')
    expect(fake.provider.memberSignIn).toBeNull()
    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
  })

  it('completes an attempt that an engine built from its env began, through authorize', async () => {
    const fake = createOidcMemberSignInFakeProvider()
    // Like a route's default engine: the provider is loaded from the fake's env
    // with a different generation key, and the attempts live in another store.
    const routeGenerationKey = 'ef'.repeat(32)
    const routeProvider = loadOidcProviderConfiguration(fake.env, routeGenerationKey)!
    const routeAttempts = new OidcR5MemoryAttemptDb()
    const routeEngine = new OidcProtocolEngine(routeProvider, {
      db: routeAttempts.client,
      getClientSecret: () => readOidcClientSecret(routeProvider, fake.env),
      encryptionKeyHex: routeGenerationKey,
    })
    const browserBinding = randomBytes(32).toString('base64url')

    const { authorizationUrl } = await routeEngine.beginIdentityProofAttempt({ browserBinding })
    const callback = fake.authorize(authorizationUrl, { sub: 'fake-subject-route' })
    const proof = await routeEngine.completeIdentityProofAttempt({ ...callback, browserBinding })

    expect(callback.issuer).toBe(fake.provider.issuer)
    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect(proof.subject).toBe('fake-subject-route')
    expect([...routeAttempts.rows.values()].map(row => [row.id, row.status])).toEqual([
      [proof.attemptId, 'completed'],
    ])
  })

  it('stores its attempts in the db it is given', async () => {
    const attempts = new OidcR5MemoryAttemptDb()
    const fake = createOidcMemberSignInFakeProvider({ db: attempts.client })

    const proof = await fake.signIn({ sub: 'fake-subject-db' })

    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect([...attempts.rows.values()].map(row => [row.id, row.status])).toEqual([
      [proof.attemptId, 'completed'],
    ])
  })
})

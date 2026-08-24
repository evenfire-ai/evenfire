import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { config } from '../src/config.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import {
  authenticateExternalUserSession,
  renewExternalUserSession,
} from '../src/services/auth/externalSessionAuthentication.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import { signUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'

const sessionMocks = vi.hoisted(() => ({
  validateLegacyUserSession: vi.fn(),
  validateUserSessionClaims: vi.fn(),
  renewUserSession: vi.fn(),
}))

vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return { ...actual, ...sessionMocks }
})

const userId = '11111111-1111-4111-8111-111111111111'
const nowSeconds = Math.floor(Date.now() / 1000)

function policy(overrides: Partial<EffectiveUserAccessPolicy> = {}): EffectiveUserAccessPolicy {
  return {
    policyVersion: '1',
    policyRevision: 'test-policy',
    acceptV1: true,
    issueV1: true,
    acceptV2: true,
    issueV2: false,
    renewV2: false,
    switchCompatibility: true,
    computeCatalogShadow: false,
    serveCatalog: false,
    actionContextV2: false,
    rpcDelegationV2: false,
    desktopAllTeamMode: false,
    profileV2Mode: false,
    minimumClientVersion: null,
    enforceMinimumClient: false,
    advertisedCatalogFamilies: [],
    ...overrides,
  }
}

function validIdentity(overrides: Record<string, unknown> = {}) {
  return {
    userId,
    email: 'user@example.com',
    sid: randomUUID(),
    jti: randomUUID(),
    sessionVersion: 1,
    expiresAt: new Date((nowSeconds + 3600) * 1000),
    absoluteExpiresAt: new Date((nowSeconds + 30 * 24 * 3600) * 1000),
    authenticationMethods: ['pwd'],
    ...overrides,
  }
}

function v1Token(): string {
  return signExternalSessionToken({
    userId,
    email: 'user@example.com',
    teamId: '22222222-2222-4222-8222-222222222222',
    role: 'member',
    authGeneration: 1,
  })
}

function preGenerationV1Token(): string {
  return jwt.sign(
    {
      userId,
      email: 'user@example.com',
      teamId: '22222222-2222-4222-8222-222222222222',
      role: 'member',
    },
    config.sessionJwtPrivateKey,
    {
      algorithm: 'RS256',
      expiresIn: 3600,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }
  )
}

function v2Token(identity = validIdentity()): string {
  return signUserSessionV2Token({
    sub: identity.userId,
    sid: identity.sid,
    jti: identity.jti,
    sv: identity.sessionVersion,
    email: identity.email,
    auth_time: nowSeconds,
    amr: ['pwd'],
  })
}

describe('external user-session authentication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('live-validates accepted v1 and rejects it when policy acceptance is off', async () => {
    const identity = validIdentity({ sid: '', sessionVersion: 0 })
    sessionMocks.validateLegacyUserSession.mockResolvedValue({ status: 'valid', identity })
    const token = v1Token()

    await expect(
      authenticateExternalUserSession(token, { purpose: 'protected', policy: policy() })
    ).resolves.toMatchObject({
      status: 'authenticated',
      contract: 'v1',
      claims: { authGeneration: 1 },
    })
    await expect(
      authenticateExternalUserSession(token, {
        purpose: 'verify',
        policy: policy({ acceptV1: false, issueV1: false }),
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'session_contract_not_accepted' })
  })

  it('subjects pre-generation v1 tokens to the same compatibility-drain gate', async () => {
    const identity = validIdentity({ sid: '', sessionVersion: 0 })
    sessionMocks.validateLegacyUserSession.mockResolvedValue({ status: 'valid', identity })
    const token = preGenerationV1Token()

    await expect(
      authenticateExternalUserSession(token, { purpose: 'protected', policy: policy() })
    ).resolves.toMatchObject({ status: 'authenticated', contract: 'v1' })
    await expect(
      authenticateExternalUserSession(token, {
        purpose: 'protected',
        policy: policy({ acceptV1: false, issueV1: false }),
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'session_contract_not_accepted' })
  })

  it('normalizes v2 without team authority and applies purpose-specific acceptance', async () => {
    const identity = validIdentity()
    sessionMocks.validateUserSessionClaims.mockResolvedValue({ status: 'valid', identity })
    const token = v2Token(identity)

    await expect(
      authenticateExternalUserSession(token, { purpose: 'protected', policy: policy() })
    ).resolves.toMatchObject({
      status: 'authenticated',
      contract: 'v2',
      claims: {
        userId,
        teamId: null,
        role: 'member',
        sessionContract: 'v2',
        sid: identity.sid,
      },
    })
    await expect(
      authenticateExternalUserSession(token, {
        purpose: 'switch',
        policy: policy({ switchCompatibility: false }),
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'session_contract_not_accepted' })
  })

  it('allows v2 self-cleanup during acceptance rollback but no protected work', async () => {
    const identity = validIdentity()
    sessionMocks.validateUserSessionClaims.mockResolvedValue({ status: 'valid', identity })
    const token = v2Token(identity)
    const rolledBack = policy({ acceptV2: false })

    await expect(
      authenticateExternalUserSession(token, { purpose: 'revoke_cleanup', policy: rolledBack })
    ).resolves.toMatchObject({ status: 'authenticated', contract: 'v2' })
    await expect(
      authenticateExternalUserSession(token, { purpose: 'protected', policy: rolledBack })
    ).resolves.toEqual({ status: 'invalid', reason: 'session_contract_not_accepted' })
  })

  it('enforces minimum client before live authority work', async () => {
    const token = v1Token()
    const minimum = policy({
      minimumClientVersion: '2.3.0',
      enforceMinimumClient: true,
    })

    await expect(
      authenticateExternalUserSession(token, {
        purpose: 'protected',
        policy: minimum,
        client: { version: '2.2.9' },
      })
    ).resolves.toEqual({ status: 'upgrade_required', reason: 'minimum_client_version' })
    expect(sessionMocks.validateLegacyUserSession).not.toHaveBeenCalled()
  })

  it('renews only when acceptance and issuance are both effective', async () => {
    const identity = validIdentity()
    const token = v2Token(identity)
    sessionMocks.renewUserSession.mockResolvedValue({
      token: 'successor',
      expiresInSeconds: 3600,
      identity,
    })

    await expect(renewExternalUserSession(token, { policy: policy() })).resolves.toEqual({
      status: 'invalid',
      reason: 'session_renewal_unavailable',
    })
    await expect(
      renewExternalUserSession(token, {
        policy: policy({ issueV2: true, renewV2: true }),
      })
    ).resolves.toMatchObject({ status: 'renewed', session: { token: 'successor' } })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ExternalGfsAuthorityError,
  resolveExternalGfsAuthority,
  signCurrentExternalGfsUserToken,
} from '../src/gfs/externalAuthority.js'
import { GfsDesktopOperatorLinkError } from '../src/services/gfsDesktopOperatorLinkService.js'

const dbMock = vi.hoisted(() => ({ withTransaction: vi.fn() }))
const gfsTokenMock = vi.hoisted(() => ({ signGfsToken: vi.fn() }))

vi.mock('../src/config.js', () => ({
  config: { desktopGfsOperatorLinkingEnabled: false },
}))
vi.mock('../src/db.js', () => ({ withTransaction: dbMock.withTransaction }))
vi.mock('../src/auth/gfsToken.js', () => ({ signGfsToken: gfsTokenMock.signGfsToken }))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => {
  class GfsDesktopOperatorLinkError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
      this.name = 'GfsDesktopOperatorLinkError'
    }
  }
  return {
    GfsDesktopOperatorLinkError,
    gfsDesktopOperatorLinkService: { resolveActiveLink: vi.fn() },
  }
})

const DESKTOP_USER_ID = '11111111-1111-4111-8111-111111111111'
const CONTROL_ADMIN_ID = '22222222-2222-4222-8222-222222222222'
const LINK = {
  desktopUserId: DESKTOP_USER_ID,
  controlAdminId: CONTROL_ADMIN_ID,
  source: 'initial_setup' as const,
  lineageId: '33333333-3333-4333-8333-333333333333',
  generation: 1,
  desktopUserGeneration: 1,
  controlAdminGeneration: 1,
  createdAt: new Date('2026-08-10T00:00:00.000Z'),
}

describe('resolveExternalGfsAuthority', () => {
  it('does not query links when the fail-closed feature flag is off', async () => {
    const resolveActiveLink = vi.fn()
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: false,
        resolveActiveLink,
      })
    ).resolves.toEqual({
      kind: 'user-session',
      desktopUserId: DESKTOP_USER_ID,
      tokenSubject: DESKTOP_USER_ID,
    })
    expect(resolveActiveLink).not.toHaveBeenCalled()
  })

  it('denies a retired Desktop user before the flag can fall back to user-session authority', async () => {
    const resolveActiveLink = vi.fn()
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: false,
        resolveActiveLink,
        isDesktopUserActive: vi.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject<Partial<ExternalGfsAuthorityError>>({
      status: 403,
      code: 'desktop_user_retired',
    })
    expect(resolveActiveLink).not.toHaveBeenCalled()
  })

  it('keeps an unlinked Desktop session on ordinary user authority', async () => {
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: true,
        resolveActiveLink: vi.fn().mockResolvedValue(null),
      })
    ).resolves.toEqual({
      kind: 'user-session',
      desktopUserId: DESKTOP_USER_ID,
      tokenSubject: DESKTOP_USER_ID,
    })
  })

  it('resolves an active initial-setup link to a distinct effective admin subject', async () => {
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: true,
        resolveActiveLink: vi.fn().mockResolvedValue(LINK),
      })
    ).resolves.toEqual({
      kind: 'linked-admin',
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      tokenSubject: CONTROL_ADMIN_ID,
      authoritySource: 'linked-admin',
      authGeneration: 1,
      linkLineageId: LINK.lineageId,
      linkGeneration: 1,
      desktopUserGeneration: 1,
      controlAdminGeneration: 1,
    })
  })

  it.each([
    'control_admin_inactive',
    'control_admin_not_found',
    'link_conflict',
    'malformed_link',
    'invalid_input',
  ] as const)('fails closed with one non-oracular denial for %s', async code => {
    const error = new GfsDesktopOperatorLinkError(code, 'sensitive link detail')
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: true,
        resolveActiveLink: vi.fn().mockRejectedValue(error),
      })
    ).rejects.toMatchObject<Partial<ExternalGfsAuthorityError>>({
      status: 403,
      code: 'gfs_operator_link_invalid',
    })
  })

  it('fails unavailable rather than falling back when link resolution fails', async () => {
    const error = new GfsDesktopOperatorLinkError('resolution_failed', 'database unavailable')
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: true,
        resolveActiveLink: vi.fn().mockRejectedValue(error),
      })
    ).rejects.toMatchObject<Partial<ExternalGfsAuthorityError>>({
      status: 503,
      code: 'gfs_authority_unavailable',
    })
  })

  it('rejects a mismatched or non-initial-setup row even if a dependency returns it', async () => {
    await expect(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: true,
        resolveActiveLink: vi.fn().mockResolvedValue({
          ...LINK,
          desktopUserId: '33333333-3333-4333-8333-333333333333',
        }),
      })
    ).rejects.toMatchObject({ status: 403, code: 'gfs_operator_link_invalid' })
  })
})

describe('signCurrentExternalGfsUserToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const policy = {
    policyVersion: '1' as const,
    policyRevision: 'gfs-external-authority-test',
    acceptV1: true,
    issueV1: true,
    acceptV2: false,
    issueV2: false,
    renewV2: false,
    switchCompatibility: true,
    actionContextV2: false,
    rpcDelegationV2: false,
    desktopAllTeamMode: false,
    profileV2Mode: false,
    minimumClientVersion: null,
    enforceMinimumClient: false,
  }
  const tokenClaims = {
    userId: DESKTOP_USER_ID,
    email: 'user@example.test',
    teamId: null,
    role: 'member' as const,
    authGeneration: 1,
    exp: Math.floor(Date.now() / 1000) + 600,
  }
  const authentication = {
    status: 'authenticated' as const,
    contract: 'v1' as const,
    claims: tokenClaims,
    authorityContext: {
      contract: 'v1' as const,
      userId: DESKTOP_USER_ID,
      tokenHash: 'token-hash',
      issuedAt: 1,
      authGeneration: 1,
    },
    tokenClaims,
    policy,
  }
  const input = { subject: DESKTOP_USER_ID, drive: 'user', scopes: ['read' as const] }

  it('signs with a single unlocked users read and no session revalidation', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ lifecycle_state: 'active', lifecycle_version: 3, db_now: new Date() }],
      rowCount: 1,
    })
    dbMock.withTransaction.mockImplementation(async work => work({ query }))
    gfsTokenMock.signGfsToken.mockReturnValue({ token: 'signed-gfs-token', expiresInSeconds: 600 })

    await expect(signCurrentExternalGfsUserToken(authentication, input)).resolves.toEqual({
      token: 'signed-gfs-token',
      expiresInSeconds: 600,
    })

    expect(query).toHaveBeenCalledOnce()
    expect(String(query.mock.calls[0]?.[0])).toContain('FROM users')
    expect(String(query.mock.calls[0]?.[0])).not.toContain('FOR UPDATE')
    expect(
      query.mock.calls.some(call =>
        String(call[0]).includes('external_user_session_security_epochs')
      )
    ).toBe(false)
    // Witness: the canonical generation reaches the signed claims.
    expect(gfsTokenMock.signGfsToken).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: DESKTOP_USER_ID,
        authGeneration: 3,
        principalType: 'user',
      })
    )
  })

  it('returns null for a retired user instead of signing', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ lifecycle_state: 'retired', lifecycle_version: 4, db_now: new Date() }],
      rowCount: 1,
    })
    dbMock.withTransaction.mockImplementation(async work => work({ query }))

    await expect(signCurrentExternalGfsUserToken(authentication, input)).resolves.toBeNull()
    expect(query).toHaveBeenCalledOnce()
    expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
  })
})

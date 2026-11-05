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
  const input = { subject: DESKTOP_USER_ID, drive: 'user', scopes: ['gfs.read' as const] }

  function mockSingleRowQuery(rows: Record<string, unknown>[]) {
    const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length })
    dbMock.withTransaction.mockImplementation(async work => work({ query }))
    gfsTokenMock.signGfsToken.mockReturnValue({
      token: 'synthetic-signed-gfs-token',
      expiresInSeconds: 600,
    })
    return query
  }

  // Only token_revoked === false (the EXISTS found no live revocation of this
  // token) lets a V1 mint proceed; any other value refuses.
  function expectV1RevocationRead(query: ReturnType<typeof vi.fn>) {
    expect(query).toHaveBeenCalledOnce()
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('FROM users')
    expect(sql).toContain('external_v1_session_revocations')
    expect(sql).toContain('AS token_revoked')
    expect(sql).not.toContain('FOR UPDATE')
    expect(query.mock.calls[0]?.[1]).toEqual([DESKTOP_USER_ID, 'token-hash'])
  }

  it('signs the authenticated V1 generation with a single unlocked users and revocation read', async () => {
    const query = mockSingleRowQuery([
      { lifecycle_state: 'active', lifecycle_version: 1, db_now: new Date(), token_revoked: false },
    ])

    await expect(signCurrentExternalGfsUserToken(authentication, input)).resolves.toEqual({
      token: 'synthetic-signed-gfs-token',
      expiresInSeconds: 600,
    })

    expectV1RevocationRead(query)
    expect(
      query.mock.calls.some(call =>
        String(call[0]).includes('external_user_session_security_epochs')
      )
    ).toBe(false)
    // Witness: the authenticated session's generation reaches the signed claims.
    expect(gfsTokenMock.signGfsToken).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: DESKTOP_USER_ID,
        authGeneration: 1,
        principalType: 'user',
      })
    )
  })

  it('refuses a V1 token revoked after authentication', async () => {
    const query = mockSingleRowQuery([
      { lifecycle_state: 'active', lifecycle_version: 1, db_now: new Date(), token_revoked: true },
    ])

    await expect(signCurrentExternalGfsUserToken(authentication, input)).resolves.toBeNull()

    // Witness: the one read carrying the revocation lookup ran before the refusal.
    expectV1RevocationRead(query)
    expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
  })

  it('refuses a V1 session whose generation was bumped after authentication', async () => {
    const query = mockSingleRowQuery([
      { lifecycle_state: 'active', lifecycle_version: 3, db_now: new Date(), token_revoked: false },
    ])

    await expect(signCurrentExternalGfsUserToken(authentication, input)).resolves.toBeNull()

    // Witness: the signing read ran before the refusal.
    expect(query).toHaveBeenCalledOnce()
    expect(String(query.mock.calls[0]?.[0])).toContain('FROM users')
    expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
  })

  describe('V2 session', () => {
    const SID = '44444444-4444-4444-8444-444444444444'
    const v2TokenClaims = {
      sub: DESKTOP_USER_ID,
      sid: SID,
      jti: '55555555-5555-4555-8555-555555555555',
      sv: 2,
      ver: 2 as const,
      typ: 'user_session' as const,
      auth_time: 1,
      amr: ['pwd'],
      iat: 1,
      exp: Math.floor(Date.now() / 1000) + 600,
    }
    const v2Authentication = {
      status: 'authenticated' as const,
      contract: 'v2' as const,
      claims: {
        userId: DESKTOP_USER_ID,
        email: 'user@example.test',
        teamId: null,
        role: 'member' as const,
        exp: v2TokenClaims.exp,
      },
      authorityContext: {
        contract: 'v2' as const,
        userId: DESKTOP_USER_ID,
        sid: SID,
        jti: v2TokenClaims.jti,
        sessionVersion: 2,
      },
      tokenClaims: v2TokenClaims,
      policy: { ...policy, acceptV2: true, issueV2: true, renewV2: true },
    }
    const DB_NOW = new Date()
    const currentRow = {
      lifecycle_state: 'active',
      lifecycle_version: 5,
      db_now: DB_NOW,
      revoked_at: null,
      session_version: 2,
      absolute_expires_at: new Date(DB_NOW.getTime() + 60 * 60 * 1000),
      idle_expires_at: new Date(DB_NOW.getTime() + 10 * 60 * 1000),
    }

    function expectSessionSnapshotRead(query: ReturnType<typeof vi.fn>) {
      expect(query).toHaveBeenCalledOnce()
      const sql = String(query.mock.calls[0]?.[0])
      expect(sql).toContain('FROM users')
      expect(sql).toContain('external_user_sessions')
      expect(sql).not.toContain('FOR UPDATE')
      expect(query.mock.calls[0]?.[1]).toEqual([DESKTOP_USER_ID, SID])
    }

    it('signs the current user generation for a live session', async () => {
      const query = mockSingleRowQuery([currentRow])

      await expect(signCurrentExternalGfsUserToken(v2Authentication, input)).resolves.toEqual({
        token: 'synthetic-signed-gfs-token',
        expiresInSeconds: 600,
      })

      expectSessionSnapshotRead(query)
      expect(gfsTokenMock.signGfsToken).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: DESKTOP_USER_ID,
          authGeneration: 5,
          principalType: 'user',
        })
      )
    })

    it('refuses a session revoked after authentication', async () => {
      const query = mockSingleRowQuery([{ ...currentRow, revoked_at: new Date() }])

      await expect(signCurrentExternalGfsUserToken(v2Authentication, input)).resolves.toBeNull()

      expectSessionSnapshotRead(query)
      expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
    })

    it('refuses a session whose version moved after authentication', async () => {
      const query = mockSingleRowQuery([{ ...currentRow, session_version: 3 }])

      await expect(signCurrentExternalGfsUserToken(v2Authentication, input)).resolves.toBeNull()

      expectSessionSnapshotRead(query)
      expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
    })

    function expectExpiryColumnsRead(query: ReturnType<typeof vi.fn>) {
      const sql = String(query.mock.calls[0]?.[0])
      expect(sql).toContain('s.absolute_expires_at')
      expect(sql).toContain('s.idle_expires_at')
    }

    it('refuses a session whose absolute expiry is the database time', async () => {
      const query = mockSingleRowQuery([
        { ...currentRow, absolute_expires_at: new Date(DB_NOW.getTime()) },
      ])

      await expect(signCurrentExternalGfsUserToken(v2Authentication, input)).resolves.toBeNull()

      // Witness: the one unlocked snapshot read, carrying both expiry columns,
      // ran before the refusal.
      expectSessionSnapshotRead(query)
      expectExpiryColumnsRead(query)
      expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
    })

    it('refuses a session whose idle expiry passed before the database time', async () => {
      const query = mockSingleRowQuery([
        { ...currentRow, idle_expires_at: new Date(DB_NOW.getTime() - 1000) },
      ])

      await expect(signCurrentExternalGfsUserToken(v2Authentication, input)).resolves.toBeNull()

      expectSessionSnapshotRead(query)
      expectExpiryColumnsRead(query)
      expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
    })

    it('refuses when the session row is gone', async () => {
      const query = mockSingleRowQuery([])

      await expect(signCurrentExternalGfsUserToken(v2Authentication, input)).resolves.toBeNull()

      expectSessionSnapshotRead(query)
      expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
    })
  })

  it('returns null for a retired user instead of signing', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          lifecycle_state: 'retired',
          lifecycle_version: 4,
          db_now: new Date(),
          token_revoked: false,
        },
      ],
      rowCount: 1,
    })
    dbMock.withTransaction.mockImplementation(async work => work({ query }))

    await expect(signCurrentExternalGfsUserToken(authentication, input)).resolves.toBeNull()
    expect(query).toHaveBeenCalledOnce()
    expect(gfsTokenMock.signGfsToken).not.toHaveBeenCalled()
  })
})

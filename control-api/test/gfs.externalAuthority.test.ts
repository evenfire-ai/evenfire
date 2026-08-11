import { describe, expect, it, vi } from 'vitest'
import {
  ExternalGfsAuthorityError,
  resolveExternalGfsAuthority,
} from '../src/gfs/externalAuthority.js'
import { GfsDesktopOperatorLinkError } from '../src/services/gfsDesktopOperatorLinkService.js'

vi.mock('../src/config.js', () => ({
  config: { desktopGfsOperatorLinkingEnabled: false },
}))
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

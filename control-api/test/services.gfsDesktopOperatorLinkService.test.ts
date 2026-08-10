import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  GfsDesktopOperatorLinkError,
  GfsDesktopOperatorLinkService,
} from '../src/services/gfsDesktopOperatorLinkService.js'

const DESKTOP_USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_DESKTOP_USER_ID = '22222222-2222-4222-8222-222222222222'
const CONTROL_ADMIN_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_CONTROL_ADMIN_ID = '44444444-4444-4444-8444-444444444444'
const OPERATOR_ID = '55555555-5555-4555-8555-555555555555'
const CREATED_AT = new Date('2026-08-10T12:00:00.000Z')

function storedLink(
  desktopUserId = DESKTOP_USER_ID,
  controlAdminId = CONTROL_ADMIN_ID,
  source: unknown = 'initial_setup'
) {
  return {
    user_id: desktopUserId,
    control_admin_id: controlAdminId,
    source,
    created_at: CREATED_AT,
  }
}

describe('GfsDesktopOperatorLinkService', () => {
  const txQuery = vi.fn()
  const readQuery = vi.fn()
  const appendPermissionEvents = vi.fn()
  const transaction = vi.fn(
    async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => work({ query: txQuery })
  )
  let service: GfsDesktopOperatorLinkService

  beforeEach(() => {
    vi.clearAllMocks()
    appendPermissionEvents.mockResolvedValue('operation-1')
    service = new GfsDesktopOperatorLinkService({
      transaction,
      readDb: { query: readQuery },
      appendPermissionEvents,
    })
  })

  it('locks both exact identities and atomically creates one governed initial-setup link', async () => {
    txQuery
      .mockResolvedValueOnce({ rows: [{ id: DESKTOP_USER_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: CONTROL_ADMIN_ID, status: 'active' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [storedLink()], rowCount: 1 })

    const result = await service.link({
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      operatorSub: OPERATOR_ID,
      source: 'initial_setup',
    })

    expect(result).toEqual({
      created: true,
      link: {
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        source: 'initial_setup',
        createdAt: CREATED_AT,
      },
    })
    expect(transaction).toHaveBeenCalledOnce()
    expect(txQuery.mock.calls[0]?.[0]).toContain('FROM users')
    expect(txQuery.mock.calls[0]?.[0]).toContain('FOR UPDATE')
    expect(txQuery.mock.calls[1]?.[0]).toContain('FROM control_admin_users')
    expect(txQuery.mock.calls[1]?.[0]).toContain('FOR UPDATE')
    expect(appendPermissionEvents).toHaveBeenCalledWith(expect.anything(), {
      operatorSub: OPERATOR_ID,
      operatorKind: 'control_admin',
      changes: [
        {
          action: 'grant',
          resourceClass: 'gfs_desktop_operator_link',
          resourceRef: `gfs_desktop_operator_link:${DESKTOP_USER_ID}:${CONTROL_ADMIN_ID}`,
          subject: { kind: 'user', id: DESKTOP_USER_ID },
          sourceAuditRef: 'gfs_desktop_operator_link_source:initial_setup',
          status: 'linked',
          detailRef: `desktop_user_id:${DESKTOP_USER_ID};control_admin_id:${CONTROL_ADMIN_ID};source:initial_setup`,
        },
      ],
    })
  })

  it('is idempotent for the exact pair and preserves original source/time without a second event', async () => {
    txQuery
      .mockResolvedValueOnce({ rows: [{ id: DESKTOP_USER_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: CONTROL_ADMIN_ID, status: 'active' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [storedLink()], rowCount: 1 })

    await expect(
      service.link({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
        source: 'initial_setup',
      })
    ).resolves.toEqual({
      created: false,
      link: {
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        source: 'initial_setup',
        createdAt: CREATED_AT,
      },
    })
    expect(txQuery).toHaveBeenCalledTimes(3)
    expect(appendPermissionEvents).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'Desktop user',
      row: storedLink(DESKTOP_USER_ID, OTHER_CONTROL_ADMIN_ID),
      conflictIdentity: 'desktop_user',
    },
    {
      label: 'Control Admin',
      row: storedLink(OTHER_DESKTOP_USER_ID, CONTROL_ADMIN_ID),
      conflictIdentity: 'control_admin',
    },
  ])(
    'rejects reassignment when the $label is already linked',
    async ({ row, conflictIdentity }) => {
      txQuery
        .mockResolvedValueOnce({ rows: [{ id: DESKTOP_USER_ID }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: CONTROL_ADMIN_ID, status: 'active' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 })

      const failure = service.link({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
        source: 'initial_setup',
      })
      await expect(failure).rejects.toMatchObject({
        code: 'link_conflict',
        conflictIdentity,
      })
      expect(appendPermissionEvents).not.toHaveBeenCalled()
      expect(txQuery).toHaveBeenCalledTimes(3)
    }
  )

  it('rejects a missing Desktop user before checking or mutating any link', async () => {
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(
      service.link({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
        source: 'initial_setup',
      })
    ).rejects.toMatchObject({ code: 'desktop_user_not_found' })
    expect(txQuery).toHaveBeenCalledTimes(1)
    expect(appendPermissionEvents).not.toHaveBeenCalled()
  })

  it.each([
    { rows: [], code: 'control_admin_not_found' },
    { rows: [{ id: CONTROL_ADMIN_ID, status: 'disabled' }], code: 'control_admin_inactive' },
  ])('rejects a missing/inactive Control Admin ($code)', async ({ rows, code }) => {
    txQuery
      .mockResolvedValueOnce({ rows: [{ id: DESKTOP_USER_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows, rowCount: rows.length })

    await expect(
      service.link({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
        source: 'initial_setup',
      })
    ).rejects.toMatchObject({ code })
    expect(appendPermissionEvents).not.toHaveBeenCalled()
  })

  it('propagates event failure through the transaction so current state cannot commit alone', async () => {
    const transactionOutcome = { committed: false, rolledBack: false }
    const rollbackAwareTransaction = vi.fn(
      async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
        try {
          const result = await work({ query: txQuery })
          transactionOutcome.committed = true
          return result
        } catch (error) {
          transactionOutcome.rolledBack = true
          throw error
        }
      }
    )
    service = new GfsDesktopOperatorLinkService({
      transaction: rollbackAwareTransaction,
      readDb: { query: readQuery },
      appendPermissionEvents,
    })
    txQuery
      .mockResolvedValueOnce({ rows: [{ id: DESKTOP_USER_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: CONTROL_ADMIN_ID, status: 'active' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [storedLink()], rowCount: 1 })
    appendPermissionEvents.mockRejectedValueOnce(new Error('event store unavailable'))

    await expect(
      service.link({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
        source: 'initial_setup',
      })
    ).rejects.toThrow('event store unavailable')
    expect(transactionOutcome).toEqual({ committed: false, rolledBack: true })
  })

  it('resolves only a structurally valid link backed by an active Control Admin', async () => {
    readQuery.mockResolvedValueOnce({
      rows: [
        {
          ...storedLink(),
          desktop_user_exists: true,
          control_admin_exists: true,
          control_admin_status: 'active',
        },
      ],
      rowCount: 1,
    })

    await expect(service.resolveActiveLink(DESKTOP_USER_ID)).resolves.toEqual({
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      source: 'initial_setup',
      createdAt: CREATED_AT,
    })
  })

  it('returns null only when no current-state link exists', async () => {
    readQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(service.resolveActiveLink(DESKTOP_USER_ID)).resolves.toBeNull()
  })

  it.each([
    {
      label: 'missing admin',
      row: {
        ...storedLink(),
        desktop_user_exists: true,
        control_admin_exists: false,
        control_admin_status: null,
      },
      code: 'control_admin_not_found',
    },
    {
      label: 'inactive admin',
      row: {
        ...storedLink(),
        desktop_user_exists: true,
        control_admin_exists: true,
        control_admin_status: 'disabled',
      },
      code: 'control_admin_inactive',
    },
    {
      label: 'unknown source',
      row: {
        ...storedLink(DESKTOP_USER_ID, CONTROL_ADMIN_ID, 'email_match'),
        desktop_user_exists: true,
        control_admin_exists: true,
        control_admin_status: 'active',
      },
      code: 'malformed_link',
    },
  ])('fails closed for $label link data', async ({ row, code }) => {
    readQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    await expect(service.resolveActiveLink(DESKTOP_USER_ID)).rejects.toMatchObject({ code })
  })

  it('wraps database resolution failures as a typed fail-closed error', async () => {
    const databaseError = new Error('connection lost')
    readQuery.mockRejectedValueOnce(databaseError)

    const failure = service.resolveActiveLink(DESKTOP_USER_ID)
    await expect(failure).rejects.toMatchObject({ code: 'resolution_failed' })
    await expect(failure).rejects.toBeInstanceOf(GfsDesktopOperatorLinkError)
  })

  it('reads the exact active pair by Control Admin for the future revoke surface', async () => {
    readQuery.mockResolvedValueOnce({
      rows: [
        {
          ...storedLink(),
          desktop_user_exists: true,
          control_admin_exists: true,
          control_admin_status: 'active',
        },
      ],
      rowCount: 1,
    })

    await expect(service.getLinkForControlAdmin(CONTROL_ADMIN_ID)).resolves.toEqual({
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      source: 'initial_setup',
      createdAt: CREATED_AT,
    })
    expect(readQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE links.control_admin_id = $1::uuid'),
      [CONTROL_ADMIN_ID]
    )
  })

  it('keeps a disabled-admin pair visible to the future revoke surface without granting authority', async () => {
    readQuery.mockResolvedValueOnce({
      rows: [
        {
          ...storedLink(),
          desktop_user_exists: true,
          control_admin_exists: true,
          control_admin_status: 'disabled',
        },
      ],
      rowCount: 1,
    })

    await expect(service.getLinkForControlAdmin(CONTROL_ADMIN_ID)).resolves.toMatchObject({
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
    })
  })

  it('returns null for an unlinked Control Admin and fails closed on a mismatched row', async () => {
    readQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(service.getLinkForControlAdmin(CONTROL_ADMIN_ID)).resolves.toBeNull()

    readQuery.mockResolvedValueOnce({
      rows: [
        {
          ...storedLink(DESKTOP_USER_ID, OTHER_CONTROL_ADMIN_ID),
          desktop_user_exists: true,
          control_admin_exists: true,
          control_admin_status: 'active',
        },
      ],
      rowCount: 1,
    })
    await expect(service.getLinkForControlAdmin(CONTROL_ADMIN_ID)).rejects.toMatchObject({
      code: 'malformed_link',
    })
  })

  it('appends the governed unlink evidence before deleting current state', async () => {
    txQuery
      .mockResolvedValueOnce({ rows: [storedLink()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await expect(
      service.unlink({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
      })
    ).resolves.toEqual({
      unlinked: true,
      link: {
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        source: 'initial_setup',
        createdAt: CREATED_AT,
      },
    })

    expect(appendPermissionEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operatorSub: OPERATOR_ID,
        changes: [
          expect.objectContaining({
            action: 'revoke',
            status: 'unlinked',
            resourceRef: `gfs_desktop_operator_link:${DESKTOP_USER_ID}:${CONTROL_ADMIN_ID}`,
            sourceAuditRef: 'gfs_desktop_operator_link_source:initial_setup',
          }),
        ],
      })
    )
    expect(appendPermissionEvents.mock.invocationCallOrder[0]).toBeLessThan(
      txQuery.mock.invocationCallOrder[1]!
    )
    expect(txQuery.mock.calls[1]?.[0]).toContain('DELETE FROM gfs_desktop_operator_links')
  })

  it('does not delete current state when governed unlink evidence fails', async () => {
    txQuery.mockResolvedValueOnce({ rows: [storedLink()], rowCount: 1 })
    appendPermissionEvents.mockRejectedValueOnce(new Error('event append failed'))

    await expect(
      service.unlink({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
      })
    ).rejects.toThrow('event append failed')
    expect(txQuery).toHaveBeenCalledTimes(1)
  })

  it('makes unlink idempotent without emitting evidence for a nonexistent lifecycle change', async () => {
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(
      service.unlink({
        desktopUserId: DESKTOP_USER_ID,
        controlAdminId: CONTROL_ADMIN_ID,
        operatorSub: OPERATOR_ID,
      })
    ).resolves.toEqual({ unlinked: false, link: null })
    expect(appendPermissionEvents).not.toHaveBeenCalled()
    expect(txQuery).toHaveBeenCalledTimes(1)
  })
})

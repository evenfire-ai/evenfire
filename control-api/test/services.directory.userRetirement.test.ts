import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { DbClient } from '../src/db.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_ID = '22222222-2222-4222-8222-222222222222'
const MANAGER_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => {
  const txQuery = vi.fn()
  return {
    txQuery,
    withTransaction: vi.fn(
      async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => work({ query: txQuery })
    ),
    retireParentInTransaction: vi.fn(),
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: mocks.withTransaction,
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
    gfsDesktopOperatorLinkService: {
      retireParentInTransaction: mocks.retireParentInTransaction,
    },
  }
})

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprint(actor: object, reason: string, idempotencyKey: string): string {
  const idempotencyKeyHash = hash(idempotencyKey)
  return hash(
    JSON.stringify({
      operation: 'retire_desktop_user',
      actor,
      targetUserId: USER_ID,
      reason,
      idempotencyKeyHash,
    })
  )
}

function activeUser(version = 1) {
  return {
    rows: [{ id: USER_ID, lifecycle_state: 'active', lifecycle_version: version }],
    rowCount: 1,
  }
}

describe('retireDesktopUser', () => {
  beforeEach(() => {
    mocks.txQuery.mockReset()
    mocks.retireParentInTransaction.mockReset()
    mocks.withTransaction.mockReset()
    mocks.withTransaction.mockImplementation(
      async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => work({ query: mocks.txQuery })
    )
  })

  it('retires an active linked user atomically with exact control-admin actor and audit correlation', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: OPERATION_ID }], rowCount: 1 })
      .mockResolvedValueOnce(activeUser())
      .mockResolvedValueOnce({ rows: [{ has_link_history: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ lifecycle_version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    mocks.retireParentInTransaction.mockResolvedValueOnce(true)

    await expect(
      retireDesktopUser(
        { kind: 'control_admin', controlAdminId: ADMIN_ID },
        USER_ID,
        'policy retirement',
        'idem-admin-1',
        'request-admin-1'
      )
    ).resolves.toEqual({
      id: USER_ID,
      outcome: 'retired',
      operationId: OPERATION_ID,
      lifecycleVersion: 2,
      replayed: false,
    })

    expect(mocks.retireParentInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'desktop_user',
        parentId: USER_ID,
        actor: { kind: 'control_admin', controlAdminId: ADMIN_ID },
        reason: 'policy retirement',
        requestId: 'request-admin-1',
        operationId: OPERATION_ID,
      })
    )
    const userUpdate = String(mocks.txQuery.mock.calls[3]?.[0])
    expect(userUpdate).toContain("lifecycle_state = 'retired'")
    expect(userUpdate).toContain('retired_by_control_admin_id = $4::uuid')
    expect(userUpdate).toContain('retired_by_desktop_user_id = $5::uuid')
    expect(userUpdate).toContain('lifecycle_version = $8')
    expect(mocks.txQuery.mock.calls[3]?.[1]).toEqual([
      USER_ID,
      'policy retirement',
      'control_admin',
      ADMIN_ID,
      null,
      'request-admin-1',
      OPERATION_ID,
      1,
    ])
  })

  it('keeps a platform-user actor distinct from a Control Admin', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: OPERATION_ID }], rowCount: 1 })
      .mockResolvedValueOnce(activeUser())
      .mockResolvedValueOnce({ rows: [{ has_link_history: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ lifecycle_version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    mocks.retireParentInTransaction.mockResolvedValueOnce(true)

    await retireDesktopUser(
      { kind: 'platform_user', desktopUserId: MANAGER_ID },
      USER_ID,
      'manager retirement',
      'idem-user-1',
      'request-user-1'
    )

    expect(mocks.retireParentInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { kind: 'platform_user', desktopUserId: MANAGER_ID },
      })
    )
    expect(mocks.txQuery.mock.calls[3]?.[1]).toEqual([
      USER_ID,
      'manager retirement',
      'platform_user',
      null,
      MANAGER_ID,
      'request-user-1',
      OPERATION_ID,
      1,
    ])
  })

  it('returns the stored terminal outcome for an identical idempotency retry without re-emitting events', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    const actor = { kind: 'control_admin' as const, controlAdminId: ADMIN_ID }
    mocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [
        {
          id: OPERATION_ID,
          request_fingerprint: fingerprint(actor, 'policy retirement', 'idem-retry-1'),
          status: 'completed',
          outcome: 'retired',
          lifecycle_version: 2,
        },
      ],
      rowCount: 1,
    })

    await expect(
      retireDesktopUser(actor, USER_ID, 'policy retirement', 'idem-retry-1', 'request-retry-2')
    ).resolves.toEqual({
      id: USER_ID,
      outcome: 'retired',
      operationId: OPERATION_ID,
      lifecycleVersion: 2,
      replayed: true,
    })
    expect(mocks.retireParentInTransaction).not.toHaveBeenCalled()
    expect(String(mocks.txQuery.mock.calls[0]?.[0])).toContain('ON CONFLICT DO NOTHING')
    expect(String(mocks.txQuery.mock.calls[1]?.[0])).toContain('FOR UPDATE')
  })

  it('fails a stale or conflicting replay closed before it can re-emit lifecycle evidence', async () => {
    const { retireDesktopUser, DesktopUserRetirementError } =
      await import('../src/services/directory/users.js')
    const actor = { kind: 'control_admin' as const, controlAdminId: ADMIN_ID }
    mocks.txQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [
        {
          id: OPERATION_ID,
          request_fingerprint: fingerprint(actor, 'first reason', 'idem-conflict-1'),
          status: 'completed',
          outcome: 'retired',
          lifecycle_version: 2,
        },
      ],
      rowCount: 1,
    })

    await expect(
      retireDesktopUser(actor, USER_ID, 'different reason', 'idem-conflict-1', 'request-conflict')
    ).rejects.toMatchObject<Partial<InstanceType<typeof DesktopUserRetirementError>>>({
      code: 'idempotency_conflict',
    })
    expect(mocks.retireParentInTransaction).not.toHaveBeenCalled()
  })

  it('keeps the legacy hard-delete only for users with no operator-link history and persists its replay result', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: OPERATION_ID }], rowCount: 1 })
      .mockResolvedValueOnce(activeUser())
      .mockResolvedValueOnce({ rows: [{ has_link_history: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await expect(
      retireDesktopUser(
        { kind: 'control_admin', controlAdminId: ADMIN_ID },
        USER_ID,
        'no link history',
        'idem-delete-1',
        'request-delete-1'
      )
    ).resolves.toEqual({
      id: USER_ID,
      outcome: 'deleted',
      operationId: OPERATION_ID,
      lifecycleVersion: null,
      replayed: false,
    })
    expect(mocks.retireParentInTransaction).not.toHaveBeenCalled()
    expect(String(mocks.txQuery.mock.calls[5]?.[0])).toContain('DELETE FROM users')
    expect(String(mocks.txQuery.mock.calls[6]?.[0])).toContain("outcome = 'deleted'")
  })

  it('fails closed for retained tombstone history with no active generation', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: OPERATION_ID }], rowCount: 1 })
      .mockResolvedValueOnce(activeUser())
      .mockResolvedValueOnce({ rows: [{ has_link_history: true }], rowCount: 1 })
    mocks.retireParentInTransaction.mockResolvedValueOnce(false)

    await expect(
      retireDesktopUser(
        { kind: 'control_admin', controlAdminId: ADMIN_ID },
        USER_ID,
        'tombstone cannot be retired twice',
        'idem-tombstone-1',
        'request-tombstone-1'
      )
    ).rejects.toMatchObject({ code: 'retirement_conflict' })
    expect(mocks.txQuery).toHaveBeenCalledTimes(3)
    expect(mocks.txQuery.mock.calls.map(([sql]) => String(sql))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("lifecycle_state = 'retired'")])
    )
  })

  it('rolls the whole operation back when governed evidence fails before the CAS user transition', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    const transactionState = { committed: false, rolledBack: false }
    mocks.withTransaction.mockImplementationOnce(
      async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
        try {
          const value = await work({ query: mocks.txQuery })
          transactionState.committed = true
          return value
        } catch (error) {
          transactionState.rolledBack = true
          throw error
        }
      }
    )
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: OPERATION_ID }], rowCount: 1 })
      .mockResolvedValueOnce(activeUser())
      .mockResolvedValueOnce({ rows: [{ has_link_history: true }], rowCount: 1 })
    mocks.retireParentInTransaction.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      retireDesktopUser(
        { kind: 'control_admin', controlAdminId: ADMIN_ID },
        USER_ID,
        'evidence must commit',
        'idem-rollback-1',
        'request-rollback-1'
      )
    ).rejects.toThrow('audit unavailable')
    expect(transactionState).toEqual({ committed: false, rolledBack: true })
    expect(mocks.txQuery.mock.calls.map(([sql]) => String(sql))).not.toContain(
      expect.stringContaining("lifecycle_state = 'retired'")
    )
  })

  it('fails closed on a stale lifecycle row version and does not complete the outcome record', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')
    mocks.txQuery
      .mockResolvedValueOnce({ rows: [{ id: OPERATION_ID }], rowCount: 1 })
      .mockResolvedValueOnce(activeUser(7))
      .mockResolvedValueOnce({ rows: [{ has_link_history: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mocks.retireParentInTransaction.mockResolvedValueOnce(true)

    await expect(
      retireDesktopUser(
        { kind: 'control_admin', controlAdminId: ADMIN_ID },
        USER_ID,
        'stale lifecycle',
        'idem-cas-1',
        'request-cas-1'
      )
    ).rejects.toMatchObject({ code: 'retirement_conflict' })
    expect(mocks.txQuery).toHaveBeenCalledTimes(4)
    expect(String(mocks.txQuery.mock.calls[3]?.[0])).toContain('lifecycle_version = $8')
  })

  it('rejects an actor with the wrong typed identity field before opening a transaction', async () => {
    const { retireDesktopUser } = await import('../src/services/directory/users.js')

    await expect(
      retireDesktopUser(
        { kind: 'control_admin', desktopUserId: ADMIN_ID } as never,
        USER_ID,
        'invalid actor',
        'idem-invalid-actor',
        null
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(mocks.withTransaction).not.toHaveBeenCalled()
  })
})

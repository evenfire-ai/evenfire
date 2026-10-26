import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
const withTransaction = vi.hoisted(() => vi.fn())

vi.mock('../src/config.js', () => ({
  config: { adminJwtIssuer: 'test-issuer', adminJwtAudience: 'test-audience' },
}))
vi.mock('../src/db.js', () => ({ pool: { query }, withTransaction }))
vi.mock('../src/observability/logger.js', () => ({ rootLogger: { warn: vi.fn() } }))
vi.mock('../src/services/directory/users.js', () => ({
  retireDesktopUserInTransaction: vi.fn(),
}))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => ({
  gfsDesktopOperatorLinkService: { retireParentInTransaction: vi.fn() },
}))
vi.mock('../src/services/tracing/adminOperationContext.js', () => ({
  currentAdministrativeRequestContext: vi.fn(() => null),
}))
vi.mock('../src/services/tracing/administrativeEvents.js', () => ({
  AdministrativeEventService: class {
    appendInTransaction = vi.fn()
  },
}))
vi.mock('../src/services/tracing/controlApiLocalAdministrativeBindingResolver.js', () => ({
  CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1: { kind: 'control_api_local' },
}))
vi.mock('../src/services/tracing/environment.js', () => ({
  canonicalTracingEnvironment: vi.fn(() => 'test'),
}))

describe('Control Admin invitation TTL SQL parameter', () => {
  beforeEach(() => {
    withTransaction
      .mockReset()
      .mockImplementation(async (work: (db: { query: typeof query }) => unknown) => work({ query }))
    query.mockReset().mockImplementation(async (text: string) => {
      if (text.includes('UPDATE control_admin_invitations')) {
        return { rows: [], rowCount: 0 }
      }
      if (text.includes('INSERT INTO control_admin_invitations')) {
        const now = new Date('2026-10-26T12:00:00.000Z')
        return {
          rows: [
            {
              id: 'invitation-1',
              email: 'member@example.test',
              status: 'pending',
              expires_at: new Date(now.getTime() + 168 * 60 * 60 * 1000),
              created_at: now,
              accepted_at: null,
              invited_by_admin_id: 'admin-1',
              replace_inviter: false,
            },
          ],
          rowCount: 1,
        }
      }
      if (text.includes('SELECT id') && text.includes('control_admin_users')) {
        return { rows: [{ id: 'admin-1' }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${text}`)
    })
  })

  it('binds the shared seven-day TTL instead of interpolating it into SQL', async () => {
    const { createControlAdminInvitation } = await import('../src/services/adminAuthService.js')

    await expect(
      createControlAdminInvitation(' Member@Example.Test ', 'admin-1')
    ).resolves.toMatchObject({ id: 'invitation-1' })

    const [insertSql, values] = query.mock.calls.find(([text]) =>
      String(text).includes('INSERT INTO control_admin_invitations')
    ) as [string, unknown[]]
    expect(insertSql).toContain("NOW() + ($4::int * INTERVAL '1 hour')")
    expect(values).toEqual(['member@example.test', 'admin-1', false, 168])
  })
})

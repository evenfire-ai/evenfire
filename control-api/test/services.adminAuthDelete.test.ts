import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  targetStatus: 'active' as 'active' | 'disabled',
  queries: [] as string[],
}))

const linkService = vi.hoisted(() => ({
  retireParentInTransaction: vi.fn(),
}))

const eventService = vi.hoisted(() => ({
  appendInTransaction: vi.fn(),
}))

const db = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  pool: { query: vi.fn() },
}))

vi.mock('../src/config.js', () => ({
  config: { adminJwtIssuer: 'test-issuer', adminJwtAudience: 'test-audience' },
}))
vi.mock('../src/db.js', () => db)
vi.mock('../src/observability/logger.js', () => ({ rootLogger: { warn: vi.fn() } }))
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', () => ({
  gfsDesktopOperatorLinkService: linkService,
}))
vi.mock('../src/services/tracing/adminOperationContext.js', () => ({
  currentAdministrativeRequestContext: vi.fn(() => null),
}))
vi.mock('../src/services/tracing/administrativeEvents.js', () => ({
  AdministrativeEventService: class {
    appendInTransaction = eventService.appendInTransaction
  },
}))
vi.mock('../src/services/tracing/controlApiLocalAdministrativeBindingResolver.js', () => ({
  CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1: { kind: 'control_api_local' },
}))
vi.mock('../src/services/tracing/environment.js', () => ({
  canonicalTracingEnvironment: vi.fn(() => 'test'),
}))

function queryResult(text: string) {
  state.queries.push(text)
  if (text.includes('FOR UPDATE') && text.includes('status')) {
    return {
      rows:
        state.targetStatus === 'active'
          ? [
              {
                id: 'target-admin',
                username: 'target',
                email: 'target@example.com',
                status: 'active',
              },
            ]
          : [
              {
                id: 'target-admin',
                username: 'target',
                email: 'target@example.com',
                status: 'disabled',
              },
            ],
      rowCount: 1,
    }
  }
  if (text.includes('SELECT id, username, email')) {
    return {
      rows: [{ id: 'actor-admin', username: 'actor', email: 'actor@example.com' }],
      rowCount: 1,
    }
  }
  if (text.includes('UPDATE control_admin_users')) {
    if (state.targetStatus === 'disabled') return { rows: [], rowCount: 0 }
    state.targetStatus = 'disabled'
    return {
      rows: [{ id: 'target-admin', username: 'target', email: 'target@example.com' }],
      rowCount: 1,
    }
  }
  if (text.includes('INSERT INTO control_admin_deletion_audit')) {
    return { rows: [{ id: 'audit-1' }], rowCount: 1 }
  }
  throw new Error(`unexpected query in test: ${text}`)
}

describe('deleteControlAdmin lifecycle transition', () => {
  beforeEach(() => {
    state.targetStatus = 'active'
    state.queries = []
    db.withTransaction.mockImplementation(
      async (callback: (tx: { query: typeof queryResult }) => unknown) =>
        callback({ query: async (text: string) => queryResult(text) })
    )
    linkService.retireParentInTransaction.mockReset().mockResolvedValue(true)
    eventService.appendInTransaction.mockReset().mockResolvedValue(undefined)
  })

  it('makes repeated retirement idempotent and emits one lifecycle side effect', async () => {
    const { deleteControlAdmin } = await import('../src/services/adminAuthService.js')

    await expect(deleteControlAdmin('actor-admin', 'target-admin')).resolves.toEqual({
      deleted: true,
    })
    await expect(deleteControlAdmin('actor-admin', 'target-admin')).resolves.toEqual({
      error: 'not_found',
    })

    expect(state.queries.filter(query => query.includes('FOR UPDATE'))).toHaveLength(2)
    expect(
      state.queries.some(query => query.includes("WHERE id = $1\n          AND status = 'active'"))
    ).toBe(true)
    expect(linkService.retireParentInTransaction).toHaveBeenCalledOnce()
    expect(eventService.appendInTransaction).toHaveBeenCalledOnce()
  })
})

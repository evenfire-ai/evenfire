import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listTeamWorkflowGrants,
  listWorkflowGrants,
  setTeamWorkflowGrants,
  setWorkflowGrants,
} from '../src/services/directory/workflowGrants.js'

const mockPoolQuery = vi.fn()
const mockDbQuery = vi.fn()
const permissionEvents = vi.hoisted(() => ({ append: vi.fn() }))

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  withTransaction: async <T>(cb: (db: { query: typeof mockDbQuery }) => Promise<T>): Promise<T> =>
    cb({ query: mockDbQuery }),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: permissionEvents.append,
}))

const NS = 'mcp-server'
const NAME = 'recipe-a'
const OPERATOR = '11111111-1111-4111-8111-111111111111'
const USER_A = '22222222-2222-4222-8222-222222222222'
const USER_B = '33333333-3333-4333-8333-333333333333'
const USER_C = '44444444-4444-4444-8444-444444444444'
const USER_D = '55555555-5555-4555-8555-555555555555'
const TEAM_A = '66666666-6666-4666-8666-666666666666'
const TEAM_B = '77777777-7777-4777-8777-777777777777'
const TEAM_C = '88888888-8888-4888-8888-888888888888'
const TEAM_D = '99999999-9999-4999-8999-999999999999'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('services/directory/workflowGrants — setWorkflowGrants', () => {
  beforeEach(() => {
    mockDbQuery.mockReset()
    mockPoolQuery.mockReset()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-1')
  })

  it('opens the SELECT with FOR UPDATE to serialize same-recipe PUTs', async () => {
    mockDbQuery.mockResolvedValueOnce({}) // advisory lock
    mockDbQuery.mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
    mockDbQuery.mockResolvedValueOnce({}) // DELETE
    mockDbQuery.mockResolvedValueOnce({}) // INSERT user_workflow_triggers
    mockDbQuery.mockResolvedValueOnce({}) // bulk audit grant

    await setWorkflowGrants(NS, NAME, [USER_A], OPERATOR)

    expect(mockDbQuery.mock.calls[0]).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      [`workflow_user_grants:${NS}:${NAME}`],
    ])
    const selectCall = mockDbQuery.mock.calls[1]
    expect(String(selectCall[0])).toMatch(/FOR UPDATE/)
  })

  it('regression(review-medium): emits ONE bulk audit INSERT per action, not one per user', async () => {
    // before = [A, B]; after = [B, C, D]. added = [C, D] (2 users), removed = [A] (1 user).
    // Per-user loop: 1 lock + 1 SELECT + 1 DELETE + 1 INSERT + 2 added + 1 removed = 7 queries.
    // Bulk:         1 lock + 1 SELECT + 1 DELETE + 1 INSERT + 1 added + 1 removed = 6 queries.
    mockDbQuery.mockResolvedValueOnce({}) // advisory lock
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ user_id: USER_A }, { user_id: USER_B }],
    })
    mockDbQuery.mockResolvedValueOnce({}) // DELETE
    mockDbQuery.mockResolvedValueOnce({}) // INSERT user_workflow_triggers
    mockDbQuery.mockResolvedValueOnce({}) // bulk audit grant
    mockDbQuery.mockResolvedValueOnce({}) // bulk audit revoke

    await setWorkflowGrants(NS, NAME, [USER_B, USER_C, USER_D], OPERATOR)

    expect(mockDbQuery).toHaveBeenCalledTimes(6)

    const grantCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("'grant'")
    )
    expect(grantCall, 'expected one bulk grant INSERT').toBeDefined()
    expect(String(grantCall![0])).toMatch(/unnest\(\$2::uuid\[\]\)/)
    // Params: [operatorUserId, addedUsers[], ns, name, payloadJson]
    expect(grantCall![1]).toEqual([OPERATOR, [USER_C, USER_D], NS, NAME, expect.any(String)])

    const revokeCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("'revoke'")
    )
    expect(revokeCall, 'expected one bulk revoke INSERT').toBeDefined()
    expect(String(revokeCall![0])).toMatch(/unnest\(\$2::uuid\[\]\)/)
    expect(revokeCall![1]).toEqual([OPERATOR, [USER_A], NS, NAME, expect.any(String)])
  })

  it('skips audit INSERTs entirely when before === after (no diff)', async () => {
    mockDbQuery.mockResolvedValueOnce({}) // advisory lock
    mockDbQuery.mockResolvedValueOnce({ rows: [{ user_id: USER_A }] }) // SELECT FOR UPDATE
    mockDbQuery.mockResolvedValueOnce({}) // DELETE
    mockDbQuery.mockResolvedValueOnce({}) // INSERT user_workflow_triggers

    const result = await setWorkflowGrants(NS, NAME, [USER_A], OPERATOR)

    // No audit INSERTs — nothing was added, nothing was removed.
    expect(mockDbQuery).toHaveBeenCalledTimes(4)
    expect(result).toEqual({ userIds: [USER_A], added: [], removed: [] })
  })

  it('clear-all produces a single bulk revoke + no user INSERT', async () => {
    mockDbQuery.mockResolvedValueOnce({}) // advisory lock
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ user_id: USER_A }, { user_id: USER_B }],
    })
    mockDbQuery.mockResolvedValueOnce({}) // DELETE
    mockDbQuery.mockResolvedValueOnce({}) // bulk audit revoke

    const result = await setWorkflowGrants(NS, NAME, [], OPERATOR)

    // Lock + SELECT + DELETE + 1 bulk revoke. No INSERT user_workflow_triggers (empty set).
    expect(mockDbQuery).toHaveBeenCalledTimes(4)
    expect(result).toEqual({ userIds: [], added: [], removed: [USER_A, USER_B] })

    const revokeCall = mockDbQuery.mock.calls[3]
    expect(String(revokeCall[0])).toMatch(/'revoke'/)
    expect(revokeCall[1]).toEqual([OPERATOR, [USER_A, USER_B], NS, NAME, expect.any(String)])
  })

  it('audit payload_json carries both before and after for correlation', async () => {
    mockDbQuery.mockResolvedValueOnce({}) // advisory lock
    mockDbQuery.mockResolvedValueOnce({ rows: [{ user_id: USER_A }] })
    mockDbQuery.mockResolvedValueOnce({}) // DELETE
    mockDbQuery.mockResolvedValueOnce({}) // INSERT user_workflow_triggers
    mockDbQuery.mockResolvedValueOnce({}) // grant
    mockDbQuery.mockResolvedValueOnce({}) // revoke

    await setWorkflowGrants(NS, NAME, [USER_B], OPERATOR)

    const grantCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("'grant'")
    )!
    const payload = JSON.parse(String(grantCall[1][4]))
    expect(payload).toEqual(
      expect.objectContaining({
        before: [USER_A],
        after: [USER_B],
        administrative_operation_id: expect.any(String),
      })
    )
  })

  it('records a bounded grant event with the caller transaction and server-derived operator', async () => {
    vi.stubEnv('TRACING_ENVIRONMENT', 'local')
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({ rows: [] })
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})

    await setWorkflowGrants(NS, NAME, [USER_A], OPERATOR)

    expect(permissionEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({ query: mockDbQuery }),
      expect.objectContaining({
        operatorSub: OPERATOR,
        operationId: expect.any(String),
        changes: [
          expect.objectContaining({
            action: 'grant',
            resourceClass: 'workflow_trigger_access',
            resourceRef: `workflow_recipe:${NS}/${NAME}`,
            subject: { kind: 'user', id: USER_A },
          }),
        ],
      })
    )
  })

  it('emits one target-bound change per affected platform user', async () => {
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({ rows: [] })
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})

    await setWorkflowGrants(NS, NAME, [USER_A, USER_B], OPERATOR)

    expect(permissionEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({ query: mockDbQuery }),
      expect.objectContaining({
        operatorSub: OPERATOR,
        changes: [
          expect.objectContaining({ subject: { kind: 'user', id: USER_A } }),
          expect.objectContaining({ subject: { kind: 'user', id: USER_B } }),
        ],
      })
    )
  })
})

describe('services/directory/workflowGrants — listWorkflowGrants', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('returns empty array for empty namespace or name (defensive)', async () => {
    expect(await listWorkflowGrants('', 'foo')).toEqual([])
    expect(await listWorkflowGrants('foo', '   ')).toEqual([])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('maps rows into the WorkflowGrantUser shape', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: USER_A,
          email: 'alice@example.com',
          name: 'Alice',
          display_name: 'Alice A.',
        },
        {
          id: USER_B,
          email: 'bob@example.com',
          name: null,
          display_name: null,
        },
      ],
    })

    const users = await listWorkflowGrants(NS, NAME)
    expect(users).toEqual([
      { id: USER_A, email: 'alice@example.com', name: 'Alice', displayName: 'Alice A.' },
      { id: USER_B, email: 'bob@example.com', name: null, displayName: null },
    ])
  })
})

describe('services/directory/workflowGrants — setTeamWorkflowGrants', () => {
  beforeEach(() => {
    mockDbQuery.mockReset()
    mockPoolQuery.mockReset()
    permissionEvents.append.mockReset()
    permissionEvents.append.mockResolvedValue('operation-1')
  })

  it('opens the SELECT with FOR UPDATE to serialize same-recipe team PUTs', async () => {
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({ rows: [] })
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})

    await setTeamWorkflowGrants(NS, NAME, [TEAM_A], OPERATOR)

    expect(mockDbQuery.mock.calls[0]).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      [`workflow_team_grants:${NS}:${NAME}`],
    ])
    const selectCall = mockDbQuery.mock.calls[1]
    expect(String(selectCall[0])).toMatch(/FROM team_workflow_triggers/)
    expect(String(selectCall[0])).toMatch(/FOR UPDATE/)
  })

  it('emits one bulk team audit INSERT per action with target_team_id', async () => {
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ team_id: TEAM_A }, { team_id: TEAM_B }],
    })
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})

    await setTeamWorkflowGrants(NS, NAME, [TEAM_B, TEAM_C, TEAM_D], OPERATOR)

    expect(mockDbQuery).toHaveBeenCalledTimes(6)

    const grantCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("'grant'")
    )
    expect(grantCall, 'expected one bulk team grant INSERT').toBeDefined()
    expect(String(grantCall![0])).toContain('team_workflow_grants_audit')
    expect(String(grantCall![0])).toContain('target_team_id')
    expect(String(grantCall![0])).toMatch(/unnest\(\$2::uuid\[\]\)/)
    expect(grantCall![1]).toEqual([OPERATOR, [TEAM_C, TEAM_D], NS, NAME, expect.any(String)])

    const revokeCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("'revoke'")
    )
    expect(revokeCall, 'expected one bulk team revoke INSERT').toBeDefined()
    expect(String(revokeCall![0])).toContain('team_workflow_grants_audit')
    expect(revokeCall![1]).toEqual([OPERATOR, [TEAM_A], NS, NAME, expect.any(String)])
  })

  it('clear-all produces a single bulk team revoke + no team INSERT', async () => {
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ team_id: TEAM_A }, { team_id: TEAM_B }],
    })
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})

    const result = await setTeamWorkflowGrants(NS, NAME, [], OPERATOR)

    expect(mockDbQuery).toHaveBeenCalledTimes(4)
    expect(result).toEqual({ teamIds: [], added: [], removed: [TEAM_A, TEAM_B] })

    const revokeCall = mockDbQuery.mock.calls[3]
    expect(String(revokeCall[0])).toMatch(/team_workflow_grants_audit/)
    expect(String(revokeCall[0])).toMatch(/'revoke'/)
    expect(revokeCall[1]).toEqual([OPERATOR, [TEAM_A, TEAM_B], NS, NAME, expect.any(String)])
  })

  it('audit payload_json carries both before and after for correlation', async () => {
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({ rows: [{ team_id: TEAM_A }] })
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})
    mockDbQuery.mockResolvedValueOnce({})

    await setTeamWorkflowGrants(NS, NAME, [TEAM_B], OPERATOR)

    const grantCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("'grant'")
    )!
    const payload = JSON.parse(String(grantCall[1][4]))
    expect(payload).toEqual(
      expect.objectContaining({
        before: [TEAM_A],
        after: [TEAM_B],
        administrative_operation_id: expect.any(String),
      })
    )
  })
})

describe('services/directory/workflowGrants — listTeamWorkflowGrants', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('returns empty array for empty namespace or name (defensive)', async () => {
    expect(await listTeamWorkflowGrants('', 'foo')).toEqual([])
    expect(await listTeamWorkflowGrants('foo', '   ')).toEqual([])
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('maps rows into the WorkflowGrantTeam shape', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: TEAM_A, name: 'Alpha' },
        { id: TEAM_B, name: 'Beta' },
      ],
    })

    const teams = await listTeamWorkflowGrants(NS, NAME)
    expect(teams).toEqual([
      { id: TEAM_A, name: 'Alpha' },
      { id: TEAM_B, name: 'Beta' },
    ])
  })
})

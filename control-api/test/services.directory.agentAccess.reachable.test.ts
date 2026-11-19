import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getUserReachableAgents } from '../src/services/directory/index.js'
import { membershipResult } from './fixtures/contextAllowlist.js'

const dbMocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: dbMocks.poolQuery,
  },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: vi.fn(),
}))

const USER = '77777777-7777-4777-8777-777777777777'
const OTHER = '88888888-8888-4888-8888-888888888888'

describe('getUserReachableAgents', () => {
  const query = vi.fn()

  beforeEach(() => {
    query.mockReset()
    dbMocks.poolQuery.mockReset()
  })

  it('one statement over user_agents and active team memberships; sorted distinct names', async () => {
    query.mockResolvedValue({
      rows: [{ agent_name: 'b' }, { agent_name: 'a' }, { agent_name: 'b' }],
      rowCount: 3,
    })
    await expect(getUserReachableAgents(USER, { query })).resolves.toEqual({
      agentNames: ['a', 'b'],
    })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(values).toEqual([USER])
    for (const token of [
      'FROM user_agents',
      'UNION',
      'FROM team_members',
      'JOIN team_agents',
      "tm.status = 'active'",
      "lifecycle_state = 'active'",
      'tm.user_id = $1::uuid',
      '$1::uuid',
    ]) {
      expect(sql).toContain(token)
    }
    expect(sql.match(/lifecycle_state = 'active'/g)).toHaveLength(2)
    expect(sql).not.toContain('$2')
  })

  it.each(['user-1', 'U024BE7LH', 'alice@example.test', `{${USER}}`, USER.replace(/-/g, '')])(
    'a non-canonical user id %s is an empty result without a query',
    async id => {
      await expect(getUserReachableAgents(id, { query })).resolves.toEqual({ agentNames: [] })
      expect(query).not.toHaveBeenCalled()
    }
  )

  it('an upper-case UUID is evaluated, not refused by format', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    await getUserReachableAgents(USER.toUpperCase(), { query })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('defaults to the shared pool when no db is passed', async () => {
    dbMocks.poolQuery.mockResolvedValue({ rows: [{ agent_name: 'x' }], rowCount: 1 })
    await expect(getUserReachableAgents(USER)).resolves.toEqual({ agentNames: ['x'] })
    expect(dbMocks.poolQuery).toHaveBeenCalledTimes(1)
  })
})

describe('membershipResult fixture', () => {
  it('answers the reachable-agents statement with direct ∪ team agents, sorted distinct', () => {
    // Carries lifecycle_state + team_agents like the real statement, so a branch
    // placed after the host branch would misroute it.
    const sql =
      "SELECT agent_name FROM (SELECT ... FROM user_agents ... u.lifecycle_state = 'active' UNION SELECT ... JOIN team_agents ... u.lifecycle_state = 'active') reachable"
    expect(
      membershipResult(sql, [USER], {
        agents: { [USER]: ['b'] },
        teamAgents: { [USER]: ['a', 'b'] },
      })
    ).toEqual({ rows: [{ agent_name: 'a' }, { agent_name: 'b' }], rowCount: 2 })
    expect(membershipResult(sql, [OTHER], { teamAgents: { [USER]: ['a'] } })).toEqual({
      rows: [],
      rowCount: 0,
    })
  })

  it('still answers the broker Host read from direct agents only', () => {
    const host =
      "SELECT 1 FROM users u WHERE u.id = $1::uuid AND u.lifecycle_state = 'active' AND (EXISTS (... user_agents ...) OR EXISTS (... team_agents ...))"
    expect(membershipResult(host, [USER, 'h1'], { agents: { [USER]: ['h1'] } })).toEqual({
      rows: [{ allowed: 1 }],
      rowCount: 1,
    })
  })
})

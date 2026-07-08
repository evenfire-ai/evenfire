import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTeamAgents,
  getUserAgents,
  listTeamsByAgent,
  listUsersByAgent,
  setAgentTeams,
  setAgentUsers,
  setTeamAgents,
  setUserAgents,
} from '../src/services/directory/index.js'

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

describe('services/directory agent-access unit tests', () => {
  beforeEach(() => {
    dbMocks.poolQuery.mockReset()
    dbMocks.txQuery.mockReset()
    dbMocks.txQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    dbMocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('setUserAgents normalizes and de-duplicates names', async () => {
    const result = await setUserAgents('user-1', [' agent-a ', 'agent-a', '', 'agent-b'])

    expect(result).toEqual({
      userId: 'user-1',
      agentNames: ['agent-a', 'agent-b'],
    })
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM user_agents WHERE user_id = $1::uuid',
      ['user-1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO user_agents(user_id, agent_name)
       SELECT $1::uuid, unnest($2::text[])
       ON CONFLICT (user_id, agent_name) DO NOTHING`,
      ['user-1', ['agent-a', 'agent-b']]
    )
  })

  it('getUserAgents returns ordered names', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [{ agent_name: 'agent-a' }, { agent_name: 'agent-c' }],
      rowCount: 2,
    })
    const result = await getUserAgents('user-1')
    expect(result).toEqual({
      userId: 'user-1',
      agentNames: ['agent-a', 'agent-c'],
    })
  })

  it('listUsersByAgent returns empty for blank name', async () => {
    const result = await listUsersByAgent('  ')
    expect(result).toEqual([])
    expect(dbMocks.poolQuery).not.toHaveBeenCalled()
  })

  it('setTeamAgents normalizes and de-duplicates names', async () => {
    const result = await setTeamAgents('team-1', [' agent-a ', 'agent-a', '', 'agent-b'])

    expect(result).toEqual({
      teamId: 'team-1',
      agentNames: ['agent-a', 'agent-b'],
    })
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM team_agents WHERE team_id = $1::uuid',
      ['team-1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO team_agents(team_id, agent_name)
       SELECT $1::uuid, unnest($2::text[])
       ON CONFLICT (team_id, agent_name) DO NOTHING`,
      ['team-1', ['agent-a', 'agent-b']]
    )
  })

  it('getTeamAgents returns ordered names', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [{ agent_name: 'agent-a' }, { agent_name: 'agent-c' }],
      rowCount: 2,
    })
    const result = await getTeamAgents('team-1')
    expect(result).toEqual({
      teamId: 'team-1',
      agentNames: ['agent-a', 'agent-c'],
    })
  })

  it('listTeamsByAgent maps team rows', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [
        { id: 'team-1', name: 'Ops' },
        { id: 'team-2', name: 'Research' },
      ],
      rowCount: 2,
    })
    const result = await listTeamsByAgent('agent-a')
    expect(result).toEqual([
      { id: 'team-1', name: 'Ops' },
      { id: 'team-2', name: 'Research' },
    ])
  })

  it('setAgentUsers normalizes and de-duplicates userIds', async () => {
    const result = await setAgentUsers('agent-a', [' user-1 ', 'user-1', '', 'user-2'])

    expect(result).toEqual({
      agentName: 'agent-a',
      userIds: ['user-1', 'user-2'],
    })
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM user_agents WHERE agent_name = $1',
      ['agent-a']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO user_agents(agent_name, user_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT (agent_name, user_id) DO NOTHING`,
      ['agent-a', ['user-1', 'user-2']]
    )
  })

  it('setAgentTeams normalizes and de-duplicates teamIds', async () => {
    const result = await setAgentTeams('agent-a', [' team-1 ', 'team-1', '', 'team-2'])

    expect(result).toEqual({
      agentName: 'agent-a',
      teamIds: ['team-1', 'team-2'],
    })
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM team_agents WHERE agent_name = $1',
      ['agent-a']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO team_agents(agent_name, team_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT (agent_name, team_id) DO NOTHING`,
      ['agent-a', ['team-1', 'team-2']]
    )
  })
})

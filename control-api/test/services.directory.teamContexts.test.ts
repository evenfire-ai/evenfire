import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTeamContexts,
  listTeamsByContext,
  setTeamContexts,
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

describe('services/directory team-context association unit tests', () => {
  beforeEach(() => {
    dbMocks.poolQuery.mockReset()
    dbMocks.txQuery.mockReset()
    dbMocks.txQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    dbMocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('setTeamContexts normalizes, de-duplicates and persists context ids', async () => {
    const result = await setTeamContexts('team-1', [' context-a ', 'context-a', '', 'context-b'])

    expect(result).toEqual({
      teamId: 'team-1',
      contextIds: ['context-a', 'context-b'],
    })

    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM team_contexts WHERE team_id = $1::uuid',
      ['team-1']
    )
    expect(dbMocks.txQuery).toHaveBeenNthCalledWith(
      2,
      `INSERT INTO team_contexts(team_id, context_id)
       SELECT $1::uuid, unnest($2::text[])
       ON CONFLICT (team_id, context_id) DO NOTHING`,
      ['team-1', ['context-a', 'context-b']]
    )
  })

  it('getTeamContexts returns ordered context ids for a team', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [{ context_id: 'context-a' }, { context_id: 'context-c' }],
      rowCount: 2,
    })

    const result = await getTeamContexts('team-1')

    expect(result).toEqual({
      teamId: 'team-1',
      contextIds: ['context-a', 'context-c'],
    })
    expect(dbMocks.poolQuery).toHaveBeenCalledTimes(1)
  })

  it('listTeamsByContext returns empty result for blank context id', async () => {
    const result = await listTeamsByContext('   ')
    expect(result).toEqual([])
    expect(dbMocks.poolQuery).not.toHaveBeenCalled()
  })

  it('listTeamsByContext maps team rows', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [
        { id: 'team-1', name: 'Ops' },
        { id: 'team-2', name: 'Research' },
      ],
      rowCount: 2,
    })

    const result = await listTeamsByContext('context-a')

    expect(result).toEqual([
      { id: 'team-1', name: 'Ops' },
      { id: 'team-2', name: 'Research' },
    ])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTeamContexts,
  listTeamsByContext,
  setTeamContexts,
} from '../src/services/directory/index.js'

const dbMocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
  appendPermissionEvents: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: dbMocks.poolQuery,
  },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: dbMocks.appendPermissionEvents,
}))

describe('services/directory team-context association unit tests', () => {
  beforeEach(() => {
    dbMocks.poolQuery.mockReset()
    dbMocks.txQuery.mockReset()
    dbMocks.appendPermissionEvents.mockReset()
    dbMocks.appendPermissionEvents.mockResolvedValue('operation-1')
    dbMocks.txQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    dbMocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('setTeamContexts normalizes, de-duplicates and persists context ids', async () => {
    const result = await setTeamContexts(
      'team-1',
      [' context-a ', 'context-a', '', 'context-b'],
      'admin-1'
    )

    expect(result).toEqual({
      teamId: 'team-1',
      contextIds: ['context-a', 'context-b'],
    })

    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      'DELETE FROM team_contexts WHERE team_id = $1::uuid',
      ['team-1']
    )
    expect(dbMocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO team_contexts(team_id, context_id)'),
      ['team-1', ['context-a', 'context-b']]
    )
    expect(dbMocks.appendPermissionEvents).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.txQuery }),
      expect.objectContaining({
        operatorSub: 'admin-1',
        changes: expect.arrayContaining([
          expect.objectContaining({
            action: 'grant',
            resourceRef: 'context:context-a',
            subject: { kind: 'team', id: 'team-1' },
          }),
        ]),
      })
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

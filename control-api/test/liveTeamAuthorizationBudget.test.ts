import { describe, expect, it, vi } from 'vitest'
import { AccessBudgetExceededError } from '../src/services/access/accessExecutionBudget.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { getLiveTeamMembership } from '../src/services/access/liveTeamAuthorization.js'

describe('live team authorization request budget', () => {
  it('charges the request database-statement budget for each live membership lookup', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ team_id: 'team-1', role: 'member' }],
      rowCount: 1,
    })
    const budget = AccessExecutionBudget.create('action', {
      limits: { databaseStatements: 1 },
    })

    try {
      await expect(
        getLiveTeamMembership('user-1', 'team-1', { db: { query }, budget })
      ).resolves.toEqual({ teamId: 'team-1', role: 'member' })
      expect(budget.remaining('databaseStatements')).toBe(0)

      await expect(
        getLiveTeamMembership('user-1', 'team-1', { db: { query }, budget })
      ).rejects.toEqual(
        expect.objectContaining<Partial<AccessBudgetExceededError>>({
          name: 'AccessBudgetExceededError',
          limit: 'databaseStatements',
        })
      )
      expect(query).toHaveBeenCalledTimes(1)
    } finally {
      budget.close()
    }
  })
})

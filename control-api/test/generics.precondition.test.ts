import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ query: vi.fn() }))
const withTransaction = vi.hoisted(() => vi.fn(async work => work(db)))

vi.mock('../src/db.js', () => ({ withTransaction }))

import { LinkedItemsPreconditionError, bulkSetLinkedItems } from '../src/shared/generics.js'

describe('bulkSetLinkedItems optimistic concurrency', () => {
  it('locks the table and rejects a stale expected set before mutation', async () => {
    db.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT agent_name::text AS item')) {
        return { rows: [{ item: 'agent-current' }] }
      }
      return { rows: [] }
    })

    await expect(
      bulkSetLinkedItems('user_agents', 'user_id', 'user-1', 'agent_name', ['agent-next'], undefined, {
        expectedItems: ['agent-stale'],
      })
    ).rejects.toBeInstanceOf(LinkedItemsPreconditionError)

    const statements = db.query.mock.calls.map(([statement]) => String(statement))
    expect(statements).toContain('LOCK TABLE user_agents IN SHARE ROW EXCLUSIVE MODE')
    expect(statements.some(statement => statement.startsWith('DELETE FROM user_agents'))).toBe(false)
  })
})

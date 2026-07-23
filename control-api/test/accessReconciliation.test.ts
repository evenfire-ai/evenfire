import { describe, expect, it } from 'vitest'
import {
  DeletedAgentHistoryLimitError,
  MAX_DELETED_ACCESS_HISTORY,
  accessValueSetsEqual,
  filterAccessValues,
  mergeActiveUpdateWithDeletedHistory,
  mergeActiveAgentUpdateWithDeletedHistory,
  normalizeUnique,
} from '../src/services/directory/accessReconciliation.js'

describe('access reconciliation helpers', () => {
  it('normalizes and filters access values through a shared helper', () => {
    expect(normalizeUnique([' ctx-a ', '', 'ctx-a', 'ctx-b'])).toEqual(['ctx-a', 'ctx-b'])
    expect(filterAccessValues(['ctx-a', 'ctx-old', 'ctx-a'], new Set(['ctx-a']))).toEqual(['ctx-a'])
  })

  it('caps retained deleted grant history and drops names that became active again', () => {
    const deletedHistory = Array.from(
      { length: MAX_DELETED_ACCESS_HISTORY + 5 },
      (_value, index) => `deleted-${index}`
    )
    const merged = mergeActiveUpdateWithDeletedHistory(
      ['active-a', 'deleted-1', 'stale-submit'],
      ['active-a', 'deleted-1'],
      deletedHistory
    )

    expect(merged).toHaveLength(MAX_DELETED_ACCESS_HISTORY + 2)
    expect(merged.slice(0, 2)).toEqual(['active-a', 'deleted-1'])
    expect(merged).not.toContain('stale-submit')
    expect(merged.at(-1)).toBe(`deleted-${MAX_DELETED_ACCESS_HISTORY}`)
    expect(merged).not.toContain(`deleted-${MAX_DELETED_ACCESS_HISTORY + 1}`)
  })

  it('compares complete snapshots as normalized sets', () => {
    expect(accessValueSetsEqual([' agent-a ', 'agent-b', 'agent-a'], ['agent-b', 'agent-a'])).toBe(
      true
    )
    expect(accessValueSetsEqual(['agent-a'], ['agent-b'])).toBe(false)
  })

  it('retains all deleted agent history at the limit and rejects overflow', () => {
    const atLimit = Array.from(
      { length: MAX_DELETED_ACCESS_HISTORY },
      (_value, index) => `deleted-${index}`
    )
    expect(mergeActiveAgentUpdateWithDeletedHistory(['agent-live'], ['agent-live'], atLimit)).toEqual([
      'agent-live',
      ...atLimit,
    ])
    expect(() =>
      mergeActiveAgentUpdateWithDeletedHistory(['agent-live'], ['agent-live'], [...atLimit, 'overflow'])
    ).toThrow(DeletedAgentHistoryLimitError)
  })
})

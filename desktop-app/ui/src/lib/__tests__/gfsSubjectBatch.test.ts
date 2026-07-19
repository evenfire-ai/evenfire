import { describe, expect, it, vi } from 'vitest'
import { GfsSubjectBatchError, runGfsSubjectBatch } from '@lib/gfsSubjectBatch'

describe('runGfsSubjectBatch', () => {
  it('reports per-subject outcomes without stopping after the first failure', async () => {
    const action = vi.fn(async (subjectKey: string) => {
      if (subjectKey === 'team:blocked') throw new Error('escalation_rejected')
    })

    const error = await runGfsSubjectBatch(
      'Grant access',
      ['user:ok', 'team:blocked', 'user:also-ok'],
      action
    ).catch(caught => caught)

    expect(action).toHaveBeenCalledTimes(3)
    expect(error).toBeInstanceOf(GfsSubjectBatchError)
    expect(error.failedSubjectKeys).toEqual(['team:blocked'])
    expect(error.succeededSubjectKeys).toEqual(['user:ok', 'user:also-ok'])
    expect(error.message).toContain('team:blocked (escalation_rejected)')
    expect(error.message).toContain('Succeeded: user:ok, user:also-ok')
  })
})

import { describe, expect, it } from 'vitest'
import {
  type ApplyCountStats,
  type ResourceApplyResult,
  accumulateApplyResult,
  applyResultIsWrite,
} from '../utils'

const ALL_RESULTS: readonly ResourceApplyResult[] = [
  'created',
  'replaced',
  'up_to_date',
  'missing',
  'not_allowed',
]

describe('applyResultIsWrite / accumulateApplyResult', () => {
  it('treats only created and replaced as writes', () => {
    expect(ALL_RESULTS.filter(applyResultIsWrite)).toEqual(['created', 'replaced'])
  })

  it('keeps writes + skips === objects for every ResourceApplyResult', () => {
    const stats: ApplyCountStats = { objects: 0, writes: 0, skips: 0 }
    for (const result of ALL_RESULTS) accumulateApplyResult(stats, result)
    expect(stats.writes + stats.skips).toBe(stats.objects)
    expect(stats.objects).toBe(ALL_RESULTS.length)
    expect(stats.writes).toBe(2)
    expect(stats.skips).toBe(3)
  })

  it('keeps the invariant for an arbitrary mixed sequence', () => {
    const sequence: ResourceApplyResult[] = [
      'up_to_date',
      'replaced',
      'missing',
      'created',
      'not_allowed',
      'up_to_date',
    ]
    const stats: ApplyCountStats = { objects: 0, writes: 0, skips: 0 }
    for (const result of sequence) accumulateApplyResult(stats, result)
    expect(stats.objects).toBe(sequence.length)
    expect(stats.writes + stats.skips).toBe(stats.objects)
    expect(stats.writes).toBe(2)
    expect(stats.skips).toBe(4)
  })
})

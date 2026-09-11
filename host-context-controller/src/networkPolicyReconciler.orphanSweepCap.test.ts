import { describe, expect, it } from 'vitest'
import { evaluateNetPolOrphanSweepCap } from './networkPolicyReconciler'

describe('evaluateNetPolOrphanSweepCap', () => {
  it.each([
    {
      name: 'exact absolute cap still deletes',
      orphan: 10,
      listed: 100,
      abs: 10,
      pct: 20,
      want: null,
    },
    {
      name: 'absolute wins when both rules would fire',
      orphan: 11,
      listed: 40,
      abs: 10,
      pct: 20,
      want: 'absolute' as const,
    },
    {
      name: 'percent fires when under the absolute cap',
      orphan: 5,
      listed: 20,
      abs: 10,
      pct: 20,
      want: 'percent' as const,
    },
    {
      name: 'percent is inert when percent*listed < 1',
      orphan: 1,
      listed: 2,
      abs: 10,
      pct: 20,
      want: null,
    },
    {
      name: 'absolute 0 refuses a single orphan',
      orphan: 1,
      listed: 100,
      abs: 0,
      pct: 20,
      want: 'absolute' as const,
    },
    {
      name: 'absolute 0 with zero orphans does not trip',
      orphan: 0,
      listed: 100,
      abs: 0,
      pct: 20,
      want: null,
    },
    {
      name: 'negative absolute trips even at zero orphans',
      orphan: 0,
      listed: 10,
      abs: -1,
      pct: 20,
      want: 'absolute' as const,
    },
    {
      name: 'percent above 100 never fires',
      orphan: 11,
      listed: 10,
      abs: 100,
      pct: 150,
      want: null,
    },
  ])('$name', ({ orphan, listed, abs, pct, want }) => {
    expect(evaluateNetPolOrphanSweepCap(orphan, listed, abs, pct)).toBe(want)
  })
})

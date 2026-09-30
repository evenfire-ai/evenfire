import { describe, expect, it } from 'vitest'
import { isCurrentGfsLoad } from '../gfsLoadArbitration'

describe('GFS list-load arbitration', () => {
  it('does not let a later background revalidation invalidate a foreground load', () => {
    const foreground = {
      kind: 'foreground' as const,
      navigationSequence: 8,
      backgroundSequenceAtStart: 3,
    }

    expect(isCurrentGfsLoad(foreground, 8, 4)).toBe(true)
  })

  it('lets foreground navigation supersede background work and newer background work supersede older', () => {
    expect(
      isCurrentGfsLoad({ kind: 'background', navigationSequence: 8, backgroundSequence: 4 }, 9, 4)
    ).toBe(false)
    expect(
      isCurrentGfsLoad({ kind: 'background', navigationSequence: 8, backgroundSequence: 3 }, 8, 4)
    ).toBe(false)
  })
})

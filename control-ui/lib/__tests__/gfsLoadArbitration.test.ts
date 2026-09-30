import { describe, expect, it } from 'vitest'
import { GfsLoadArbiter, isCurrentGfsLoad } from '../gfsLoadArbitration'

describe('GFS list-load arbitration', () => {
  it('retires stale background reads without superseding foreground work', () => {
    const arbiter = new GfsLoadArbiter()
    const background = arbiter.beginBackground()
    const foreground = arbiter.beginForeground()

    expect(arbiter.isCurrent(background)).toBe(false)
    expect(arbiter.isCurrent(foreground)).toBe(true)

    const newerBackground = arbiter.beginBackground()
    arbiter.beginStreamRevalidation()

    expect(arbiter.isCurrent(newerBackground)).toBe(false)
    expect(arbiter.isCurrent(foreground)).toBe(true)
  })

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

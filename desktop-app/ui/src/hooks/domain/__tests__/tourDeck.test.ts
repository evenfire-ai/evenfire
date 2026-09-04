import { describe, expect, it } from 'vitest'
import { TOUR_STEPS } from '../tourDeck'

describe('TOUR_STEPS', () => {
  it('is the same deck for every user', () => {
    // Pinned, not derived. Each card carries commissioned artwork, so adding,
    // reordering or dropping one is a decision that should have to change this
    // line — not something an environment can do at runtime.
    expect([...TOUR_STEPS]).toEqual(['welcome', 'agents', 'files', 'mcpServers', 'apps', 'handoff'])
  })

  it('opens on Welcome and ends on Handoff', () => {
    expect(TOUR_STEPS[0]).toBe('welcome')
    expect(TOUR_STEPS[TOUR_STEPS.length - 1]).toBe('handoff')
  })

  it('shows each card once', () => {
    expect(new Set(TOUR_STEPS).size).toBe(TOUR_STEPS.length)
  })
})

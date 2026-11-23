import { describe, expect, it } from 'vitest'
import { createHostEventGate } from '../hostEventGate'

describe('createHostEventGate', () => {
  it('treats only the newest begin() as latest', () => {
    const gate = createHostEventGate()
    const first = gate.begin()
    const second = gate.begin()

    expect(second).not.toBe(first)
    expect(gate.isLatest(second)).toBe(true)
    expect(gate.isLatest(first)).toBe(false)
    expect(gate.isLatest(second + 1)).toBe(false)
  })
})

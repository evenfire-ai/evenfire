import { describe, expect, it, vi } from 'vitest'
import { createSandboxFindResultGate } from '../sandboxFindSession.js'

describe('sandbox native find result gate', () => {
  it('keeps a provisional final zero pending when a real final result follows', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const gate = createSandboxFindResultGate(deliver)
    gate.accept({ requestId: 1, activeMatchOrdinal: 0, matches: 0, finalUpdate: true })
    expect(deliver).not.toHaveBeenCalled()
    gate.accept({ requestId: 1, activeMatchOrdinal: 1, matches: 2, finalUpdate: true })
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeMatchOrdinal: 1, matches: 2 })
    )
    vi.runAllTimers()
    expect(deliver).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('delivers a genuine final zero after the producer settling window', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const gate = createSandboxFindResultGate(deliver)
    gate.accept({ requestId: 2, activeMatchOrdinal: 0, matches: 0, finalUpdate: true })
    vi.advanceTimersByTime(49)
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 2, matches: 0, finalUpdate: true })
    )
    vi.useRealTimers()
  })

  it('drops a pending zero when the session is disposed', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const gate = createSandboxFindResultGate(deliver)
    gate.accept({ requestId: 3, activeMatchOrdinal: 0, matches: 0, finalUpdate: true })
    gate.dispose()
    vi.runAllTimers()
    expect(deliver).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

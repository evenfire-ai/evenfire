import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveMaxStepTimeoutSeconds } from '../workflowService'

describe('resolveMaxStepTimeoutSeconds', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns the fallback when env is undefined', () => {
    expect(resolveMaxStepTimeoutSeconds(undefined)).toBe(5400)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns the fallback when env is an empty string or whitespace', () => {
    expect(resolveMaxStepTimeoutSeconds('')).toBe(5400)
    expect(resolveMaxStepTimeoutSeconds('   ')).toBe(5400)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns the parsed integer when env is a valid in-range number', () => {
    expect(resolveMaxStepTimeoutSeconds('1800')).toBe(1800)
    expect(resolveMaxStepTimeoutSeconds('60')).toBe(60) // min boundary
    expect(resolveMaxStepTimeoutSeconds('604800')).toBe(604800) // CRD max
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns and falls back when env is below the min (60s)', () => {
    expect(resolveMaxStepTimeoutSeconds('30')).toBe(5400)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toMatch(/Ignoring .*="30"/)
  })

  it('warns and falls back when env is above the CRD hard ceiling (7 days)', () => {
    expect(resolveMaxStepTimeoutSeconds('604801')).toBe(5400)
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('warns and falls back on non-integer inputs (floats, NaN, text)', () => {
    expect(resolveMaxStepTimeoutSeconds('300.5')).toBe(5400)
    expect(resolveMaxStepTimeoutSeconds('abc')).toBe(5400)
    expect(resolveMaxStepTimeoutSeconds('NaN')).toBe(5400)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  it('accepts custom fallback + boundaries (explicit args)', () => {
    // Proves the parser is a reusable pure function; nothing is hardcoded.
    expect(resolveMaxStepTimeoutSeconds(undefined, 900, 30, 3600)).toBe(900)
    expect(resolveMaxStepTimeoutSeconds('3000', 900, 30, 3600)).toBe(3000)
    expect(resolveMaxStepTimeoutSeconds('5000', 900, 30, 3600)).toBe(900) // over ceiling
  })
})

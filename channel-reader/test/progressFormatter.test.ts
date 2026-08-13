import { describe, expect, it } from 'vitest'
import { describeToolError } from '../src/progressFormatter'

describe('describeToolError', () => {
  it('classifies an authentication failure without leaking the envelope', () => {
    const out = describeToolError('MCP error -32603: Authentication Failed: Bad credentials')
    expect(out).toBe('unavailable (authentication problem). Ask your administrator.')
    expect(out).not.toContain('-32603')
    expect(out).not.toContain('Bad credentials')
  })

  it('classifies a timeout', () => {
    expect(describeToolError('request timed out after 30000ms')).toBe('unavailable (timed out).')
  })

  it('falls back to generic for anything unrecognised', () => {
    expect(describeToolError('kaboom {"secret":"hunter2"}')).toBe('unavailable.')
  })

  it('falls back to generic for undefined', () => {
    expect(describeToolError(undefined)).toBe('unavailable.')
  })
})

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

  it('does not misclassify "author" as an authentication problem', () => {
    // Bare `auth` matched inside "author"; anchoring on unauthoriz/authenticat/etc
    // must not catch it.
    expect(describeToolError('search_issues failed: no results for author:jose')).toBe(
      'unavailable.'
    )
  })

  it('does not let a millisecond count containing 401/403 win over a real timeout', () => {
    // Bare `401`/`403` matched inside "4031ms"; \b401\b and \b403\b must not.
    expect(describeToolError('request timed out after 4031ms')).toBe('unavailable (timed out).')
  })

  it('falls back to generic for anything unrecognised', () => {
    expect(describeToolError('kaboom {"secret":"hunter2"}')).toBe('unavailable.')
  })

  it('falls back to generic for undefined', () => {
    expect(describeToolError(undefined)).toBe('unavailable.')
  })
})

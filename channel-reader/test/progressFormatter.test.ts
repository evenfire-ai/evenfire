import { describe, expect, it } from 'vitest'
import {
  describeToolError,
  formatFinalMessage,
  formatProgressUpdate,
} from '../src/progressFormatter'
import type { ProgressStep } from '../src/types'

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

  it('classifies a payload-too-large failure', () => {
    expect(describeToolError('Error: request payload too large')).toBe('unavailable (too large).')
  })

  it('classifies an HTTP 413 as too large', () => {
    expect(describeToolError('HTTP/1.1 413 Payload Too Large')).toBe('unavailable (too large).')
  })

  it('does not misclassify a duration containing 413 as too large', () => {
    // Bare `413` matched inside "4132ms"; \b413\b must not.
    expect(describeToolError('operation finished in 4132ms')).toBe('unavailable.')
  })

  it('does not misclassify "a large number of results" as too large', () => {
    // The literal phrase "too large" is required; a bare "large" must not match.
    expect(describeToolError('search returned a large number of matches')).toBe('unavailable.')
  })

  it('classifies an invalid-argument failure', () => {
    expect(describeToolError('Invalid argument: field "id" is required')).toBe(
      'unavailable (invalid input).'
    )
  })

  it('classifies a malformed-input failure', () => {
    expect(describeToolError('malformed JSON in request body')).toBe('unavailable (invalid input).')
  })

  it('does not misclassify "invalidated" as invalid input', () => {
    // Bare `invalid` matched inside "invalidated"; \binvalid\b must not.
    expect(describeToolError('session invalidated, please retry')).toBe('unavailable.')
  })

  it('classifies a message matching both new categories as the more specific one, deterministically', () => {
    // "invalid" and "too large" both appear here; too large is checked first
    // because it is the more specific diagnosis, so it must win every time.
    expect(describeToolError('invalid request: payload too large (413)')).toBe(
      'unavailable (too large).'
    )
  })

  it('classifies a rate limit', () => {
    expect(describeToolError('429 Too Many Requests')).toBe('unavailable (rate limited).')
  })

  it('falls back to generic for anything unrecognised', () => {
    expect(describeToolError('kaboom {"secret":"hunter2"}')).toBe('unavailable.')
  })

  it('falls back to generic for undefined', () => {
    expect(describeToolError(undefined)).toBe('unavailable.')
  })
})

const step = (overrides: Partial<ProgressStep> = {}): ProgressStep => ({
  toolCallId: 'c1',
  toolName: 'mongodb-server__find',
  displayName: 'Mongodb-server',
  intentSummary: 'Using Mongodb-server...',
  iteration: 0,
  stepIndex: 0,
  totalSteps: 1,
  state: 'completed',
  durationMs: 340,
  ...overrides,
})

describe('formatProgressUpdate', () => {
  it('shows running step with spinner', () => {
    const result = formatProgressUpdate([step({ state: 'running', durationMs: undefined })])
    expect(result).toContain('Processing')
    expect(result).toContain('●')
    expect(result).toContain('running...')
  })

  it('shows completed step with checkmark and duration', () => {
    const result = formatProgressUpdate([step()])
    expect(result).toContain('✓')
    expect(result).toContain('Mongodb-server')
    expect(result).toContain('find')
    expect(result).toContain('340ms')
  })

  it('shows error step with cross', () => {
    const result = formatProgressUpdate([step({ state: 'error', errorSummary: 'HTTP 404' })])
    expect(result).toContain('✗')
    expect(result).toContain('unavailable (not found).')
    expect(result).not.toContain('HTTP 404')
  })

  it('shows iteration divider when iteration changes', () => {
    const steps = [step({ iteration: 0 }), step({ toolCallId: 'c2', iteration: 1, stepIndex: 0 })]
    const result = formatProgressUpdate(steps)
    expect(result).toContain('Thinking further')
  })

  it('shows tool function name for MCP tools', () => {
    const result = formatProgressUpdate([step()])
    expect(result).toContain('find')
  })

  it('shows tool name for native tools with shared display name', () => {
    const result = formatProgressUpdate([step({ toolName: 'memory_read', displayName: 'Memory' })])
    expect(result).toContain('memory_read')
  })
})

describe('formatFinalMessage', () => {
  it('prefixes response with compact summary', () => {
    const steps = [
      step(),
      step({
        toolCallId: 'c2',
        toolName: 'mongodb-server__aggregate',
        stepIndex: 1,
        totalSteps: 2,
      }),
    ]
    const result = formatFinalMessage(steps, 'Here is your data.')
    expect(result).toContain('✓ 2 tools used')
    expect(result).toContain('Here is your data.')
  })

  it('returns just the response for zero-tool tasks', () => {
    const result = formatFinalMessage([], 'Just a text response.')
    expect(result).toBe('Just a text response.')
  })

  it('shows warning icon when errors occurred', () => {
    const result = formatFinalMessage([step({ state: 'error' })], 'Partial response.')
    expect(result).toContain('⚠')
  })

  it('truncates summary if total exceeds 4096 chars', () => {
    const longResponse = 'A'.repeat(4090)
    const result = formatFinalMessage([step()], longResponse)
    expect(result.length).toBeLessThanOrEqual(4096)
  })
})

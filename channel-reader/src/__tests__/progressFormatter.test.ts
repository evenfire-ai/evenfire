import { describe, expect, it } from 'vitest'
import { formatFinalMessage, formatProgressUpdate } from '../progressFormatter'
import type { ProgressStep } from '../types'

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
    expect(result).toContain('HTTP 404')
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

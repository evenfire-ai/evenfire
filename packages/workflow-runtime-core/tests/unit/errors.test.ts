import { describe, expect, it } from 'vitest'
import {
  CycleDetectedError,
  McpHostNotConfiguredError,
  WorkflowSDKInitError,
} from '../../src/errors'

describe('WorkflowSDKInitError', () => {
  it('includes env var name in message', () => {
    const err = new WorkflowSDKInitError('CLERUM_WRC_URL')
    expect(err.message).toContain('CLERUM_WRC_URL')
    expect(err.name).toBe('WorkflowSDKInitError')
  })
})

describe('CycleDetectedError', () => {
  it('includes cycle path in message', () => {
    const err = new CycleDetectedError(['a', 'b', 'c'])
    expect(err.message).toContain('a')
    expect(err.message).toContain('b')
    expect(err.message).toContain('c')
    expect(err.cyclePath).toEqual(['a', 'b', 'c'])
  })

  it('has correct name', () => {
    const err = new CycleDetectedError(['x'])
    expect(err.name).toBe('CycleDetectedError')
  })
})

describe('McpHostNotConfiguredError', () => {
  it('mentions required env vars', () => {
    const err = new McpHostNotConfiguredError()
    expect(err.message).toContain('CLERUM_MCPHOST_URL')
    expect(err.message).toContain('MCP_HOST_TOKEN_FILE')
    expect(err.name).toBe('McpHostNotConfiguredError')
  })
})

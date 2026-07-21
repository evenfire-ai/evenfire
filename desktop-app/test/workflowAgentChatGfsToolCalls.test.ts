import { describe, expect, it } from 'vitest'
import { singleSuccessfulToolCall } from './e2e-playwright/workflowAgentChatGfsToolCalls'

describe('singleSuccessfulToolCall', () => {
  const success = { result: { success: true }, toolName: 'gfs_write' }
  const rejected = {
    result: { error: 'precondition_failed', success: false },
    toolName: 'gfs_write',
  }

  it('returns one successful call and preserves rejected retries', () => {
    expect(singleSuccessfulToolCall([success, rejected])).toEqual({
      rejected: [rejected],
      successful: success,
    })
  })

  it('rejects multiple successful calls', () => {
    expect(() => singleSuccessfulToolCall([success, success])).toThrow(
      'expected exactly one successful tool call, received 2'
    )
  })

  it('rejects a result without one successful call', () => {
    expect(() => singleSuccessfulToolCall([rejected])).toThrow(
      'expected exactly one successful tool call, received 0'
    )
  })

  it('rejects ambiguous tool results', () => {
    expect(() => singleSuccessfulToolCall([success, { toolName: 'gfs_write' }])).toThrow(
      'every recorded tool call must have an explicit success result'
    )
  })
})

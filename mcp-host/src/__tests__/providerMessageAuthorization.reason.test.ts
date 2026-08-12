import { describe, expect, it, vi } from 'vitest'
import { WorkflowBrokerRequestError } from '../core/tools/workflowBrokerClient'
import { classifyAuthorizationFailure } from '../main'

describe('classifyAuthorizationFailure', () => {
  it('maps a 404 medium_account_not_found to unresolved', () => {
    const err = new WorkflowBrokerRequestError(404, 'medium_account_not_found', 'not found')
    expect(classifyAuthorizationFailure(err)).toBe('unresolved')
  })

  it('maps a 403 communication_channel_access_denied to unresolved', () => {
    const err = new WorkflowBrokerRequestError(403, 'communication_channel_access_denied', 'denied')
    expect(classifyAuthorizationFailure(err)).toBe('unresolved')
  })

  it('maps a 500 to error', () => {
    expect(classifyAuthorizationFailure(new WorkflowBrokerRequestError(500, null, 'boom'))).toBe(
      'error'
    )
  })

  it('maps a 429 to error', () => {
    expect(classifyAuthorizationFailure(new WorkflowBrokerRequestError(429, null, 'slow'))).toBe(
      'error'
    )
  })

  it('maps a network throw to error', () => {
    expect(classifyAuthorizationFailure(new Error('fetch failed'))).toBe('error')
  })

  it('maps a 404 with an unrecognized code to error', () => {
    const err = new WorkflowBrokerRequestError(404, 'something_else', 'nope')
    expect(classifyAuthorizationFailure(err)).toBe('error')
  })
})

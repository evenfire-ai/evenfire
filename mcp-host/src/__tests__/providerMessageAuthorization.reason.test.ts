import { describe, expect, it } from 'vitest'
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

  // The status check carries its own weight: a whitelisted code can ride along on
  // a non-404/403 body (a control-api 5xx error wrapper, a gateway 502 echoing
  // upstream). Without the status guard those classify 'unresolved' and tell
  // linked users they are unlinked for the length of an outage.
  it('maps a 500 carrying a whitelisted code to error', () => {
    const err = new WorkflowBrokerRequestError(500, 'medium_account_not_found', 'boom')
    expect(classifyAuthorizationFailure(err)).toBe('error')
  })

  it('maps a 502 carrying a whitelisted code to error', () => {
    const err = new WorkflowBrokerRequestError(
      502,
      'communication_channel_access_denied',
      'gateway'
    )
    expect(classifyAuthorizationFailure(err)).toBe('error')
  })

  // Each code is bound to its ONE status. Both statuses below are themselves
  // whitelisted, and both codes are themselves whitelisted, so only the
  // code-to-status BINDING can reject these pairs. A plain set of codes checked
  // against `status === 404 || status === 403` classifies both 'unresolved'.
  it('maps a 403 medium_account_not_found to error', () => {
    const err = new WorkflowBrokerRequestError(403, 'medium_account_not_found', 'denied')
    expect(classifyAuthorizationFailure(err)).toBe('error')
  })

  it('maps a 404 communication_channel_access_denied to error', () => {
    const err = new WorkflowBrokerRequestError(404, 'communication_channel_access_denied', 'nope')
    expect(classifyAuthorizationFailure(err)).toBe('error')
  })
})

import { describe, expect, it } from 'vitest'
import type { Request } from 'express'
import {
  WORKFLOW_ACTION_DELEGATION_HEADER,
  WORKFLOW_ACTION_DELEGATION_MAX_LENGTH,
  workflowActionDelegationForRequest,
} from '../src/workflowActionDelegation.js'

function requestWith(rawHeaders: string[], sessionContract?: 'v2'): Request {
  return {
    rawHeaders,
    auth: sessionContract ? { sessionContract } : undefined,
  } as unknown as Request
}

describe('workflow action delegation transport', () => {
  it('forwards the exact opaque delegation for an identified v2 request', () => {
    const delegation = 'opaque-v2-delegation'
    expect(
      workflowActionDelegationForRequest(
        requestWith([WORKFLOW_ACTION_DELEGATION_HEADER, delegation], 'v2')
      )
    ).toBe(delegation)
  })

  it.each([
    ['missing', []],
    ['empty', [WORKFLOW_ACTION_DELEGATION_HEADER, '']],
    ['trimmed', [WORKFLOW_ACTION_DELEGATION_HEADER, ' token']],
    ['comma joined', [WORKFLOW_ACTION_DELEGATION_HEADER, 'one,two']],
    [
      'duplicate',
      [WORKFLOW_ACTION_DELEGATION_HEADER, 'one', WORKFLOW_ACTION_DELEGATION_HEADER, 'two'],
    ],
    [
      'oversized',
      [WORKFLOW_ACTION_DELEGATION_HEADER, 'x'.repeat(WORKFLOW_ACTION_DELEGATION_MAX_LENGTH + 1)],
    ],
  ])('rejects %s v2 transport without downgrading', (_name, rawHeaders) => {
    expect(() =>
      workflowActionDelegationForRequest(requestWith(rawHeaders as string[], 'v2'))
    ).toThrow('invalid_action_delegation_transport')
  })

  it('preserves explicit legacy requests and rejects credential smuggling into them', () => {
    expect(workflowActionDelegationForRequest(requestWith([]))).toBeUndefined()
    expect(() =>
      workflowActionDelegationForRequest(
        requestWith([WORKFLOW_ACTION_DELEGATION_HEADER, 'opaque-v2-delegation'])
      )
    ).toThrow('invalid_action_delegation_transport')
  })
})

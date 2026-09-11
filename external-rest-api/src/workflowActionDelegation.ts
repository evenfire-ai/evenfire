import type { Request } from 'express'

export const WORKFLOW_ACTION_DELEGATION_HEADER = 'x-evenfire-action-delegation'
export const WORKFLOW_ACTION_DELEGATION_MAX_LENGTH = 4096

export class WorkflowActionDelegationTransportError extends Error {
  constructor() {
    super('invalid_action_delegation_transport')
    this.name = 'WorkflowActionDelegationTransportError'
  }
}

function rawHeaderValues(req: Request): string[] {
  const values: string[] = []
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === WORKFLOW_ACTION_DELEGATION_HEADER) {
      values.push(req.rawHeaders[index + 1] ?? '')
    }
  }
  return values
}

/**
 * Extract the opaque v2 action delegation without interpreting its JWT claims.
 * A v2 user-session is the canonical discriminator; the header never selects
 * the security contract and a missing v2 header cannot fall back to legacy.
 */
export function workflowActionDelegationForRequest(req: Request): string | undefined {
  const isV2 =
    (req as Request & { auth?: { sessionContract?: string } }).auth?.sessionContract === 'v2'
  const values = rawHeaderValues(req)

  if (!isV2) {
    if (values.length > 0) throw new WorkflowActionDelegationTransportError()
    return undefined
  }
  if (values.length !== 1) throw new WorkflowActionDelegationTransportError()

  const value = values[0]
  if (
    !value ||
    value !== value.trim() ||
    value.length > WORKFLOW_ACTION_DELEGATION_MAX_LENGTH ||
    value.includes(',') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkflowActionDelegationTransportError()
  }
  return value
}

export function workflowActionDelegationHeaders(req: Request): Record<string, string> {
  const delegation = workflowActionDelegationForRequest(req)
  return delegation ? { [WORKFLOW_ACTION_DELEGATION_HEADER]: delegation } : {}
}

import { createHash } from 'node:crypto'
import { getMcpHostCallerKey } from '../../utils/auth/mcpHostJwtToken.js'
import type { TriggerAllowedActor, WorkflowCaller, WorkflowRouteCaller } from './types.js'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function stableUuidForPrincipal(value: string): string {
  if (isUuid(value)) return value
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function getWorkflowPrincipalId(caller: WorkflowRouteCaller): string {
  switch (caller.kind) {
    case 'user-session':
      return stableUuidForPrincipal(caller.claims.userId)
    case 'admin-ui':
      return stableUuidForPrincipal(caller.userId)
    case 'mcp-host-control':
      return getMcpHostWorkflowPrincipalId(getMcpHostCallerKey(caller.claims))
  }
}

export function getMcpHostWorkflowPrincipalId(callerKey: string): string {
  return stableUuidForPrincipal(`mcp-host-control:${callerKey}`)
}

export function getCallerDisplayId(caller: WorkflowCaller): string {
  switch (caller.kind) {
    case 'user-session':
      return caller.claims.userId
    case 'admin-ui':
      return caller.userId
    case 'mcp-host-control':
      return getMcpHostCallerKey(caller.claims)
  }
}

export function getTriggerActorForCaller(caller: WorkflowRouteCaller): TriggerAllowedActor {
  switch (caller.kind) {
    case 'mcp-host-control':
      return 'autonomous'
    case 'user-session':
    case 'admin-ui':
      return 'user'
  }
}

import type { AuthClaims } from '../../profileTypes.js'
import type { McpHostControlClaims } from '../../utils/auth/mcpHostJwtToken.js'

export type WorkflowCaller =
  | { kind: 'user-session'; claims: AuthClaims }
  | { kind: 'admin-ui'; userId: string }
  | { kind: 'mcp-host-control'; claims: McpHostControlClaims }

export type WorkflowRouteCaller = WorkflowCaller

export type CanonicalRunActor = {
  type: string
  userId?: string
  adminUserId?: string
  hostRef?: string
}

export type CanonicalRunExecutionRef = {
  namespace: string
  name: string
}

export type WorkflowRunArtifactDto = {
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}

export type CanonicalRunDto = {
  id: string
  source: 'live' | 'audit'
  approvalRequestId: string | null
  phase: string
  triggeredAt: string | null
  startedAt: string | null
  completedAt: string | null
  message: string | null
  actor: CanonicalRunActor | null
  executionRef: CanonicalRunExecutionRef | null
}

export type RuntimeWorkflowDto = {
  namespace: string
  name: string
  hostRef: string
  phase: unknown
  workflowPhase: unknown
  triggers: unknown
  inputContract: unknown
}

export type RuntimeWorkflowStatusDto = RuntimeWorkflowDto & {
  latestRun: CanonicalRunDto | null
}

export interface TriggerBody {
  approvalRequestId?: string
  inputs?: Record<string, unknown>
  outputOverrides?: Record<string, unknown>
  intermediateParameters?: Record<string, unknown>
}

export type TriggerAllowedActor = 'user' | 'autonomous' | 'scheduled'

export interface WorkflowLeaderDto {
  held: boolean
  leader_pid: number | null
  leader_instance_id: string | null
  acquired_at: string | null
  last_query: string | null
}

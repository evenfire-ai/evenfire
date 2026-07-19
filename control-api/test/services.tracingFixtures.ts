import { vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type {
  AdministrativeEventSubmitterPrincipalV1,
  AgentRunEventSubmitterPrincipalV1,
  InfrastructureTelemetrySubmitterPrincipalV1,
} from '../src/middleware/tracingSubmitterAuth.js'
import type {
  AdministrativeEventInputV1,
  AdministrativeServerBindingV1,
  AgentRunEventInputV1,
  AgentRunServerBindingV1,
  InfrastructureTelemetryEventInputV1,
  InfrastructureTelemetryServerBindingV1,
  TracingTransactionRunner,
} from '../src/services/tracing/contracts.js'

export const NOW = '2026-07-10T10:00:00.000Z'
export const EVENT_ID = '11111111-1111-4111-8111-111111111111'

export const agentPrincipal: AgentRunEventSubmitterPrincipalV1 = {
  kind: 'mcp_host_runtime',
  sourceService: 'mcp-host',
  serviceSub: 'host:sandbox-recipes/chatllm',
  credentialId: 'credential-agent-1',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'chatllm',
  hostRefs: ['sandbox-recipes/chatllm'],
  allowedEventTypes: ['run_start', 'llm_call', 'tool_call', 'approval', 'token_usage', 'run_end'],
}

export const agentBinding: AgentRunServerBindingV1 = {
  runId: '11111111-1111-4111-8111-111111111112',
  sessionId: 'session-1',
  spanId: 'span-root',
  parentSpanId: null,
  origin: 'direct_chat',
  identityIssuer: 'https://issuer.example',
  actorHumanSub: 'user-1',
  agentSub: 'agent-1',
  actorMedium: 'desktop',
  resourceAud: null,
  effectiveScopes: ['tools:read', 'tools:read'],
  decision: 'not_applicable',
  decisionSourceKind: null,
  decisionSourceRef: null,
  approvalRequestId: null,
  tokenExchangeId: null,
  environment: 'test',
  tenantId: 'tenant-1',
  teamId: 'team-1',
  userId: 'user-1',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'chatllm',
  hostRef: 'sandbox-recipes/chatllm',
  outcome: 'started',
  durationMs: null,
}

export const agentInput: AgentRunEventInputV1 = {
  sourceEventId: 'activity-1',
  occurredAt: '2026-07-10T09:59:59.000Z',
  eventType: 'run_start',
  payload: { detail_ref: 'task-1' },
}

export const adminPrincipal: AdministrativeEventSubmitterPrincipalV1 = {
  kind: 'wrc_internal_control',
  sourceService: 'workflow-recipes',
  serviceSub: 'wrc-provisioner',
  credentialId: 'credential-admin-1',
  allowedKinds: ['linked_outcome', 'service_action'],
}

export const adminBinding: AdministrativeServerBindingV1 = {
  action: 'agent_mutation',
  outcome: 'committed',
  operatorSub: 'admin-1',
  operationId: '11111111-1111-4111-8111-111111111113',
  relatedRunId: null,
  requestId: 'request-1',
  targetType: 'agent',
  targetRef: 'sandbox-recipes/chatllm',
  environment: 'test',
  tenantId: 'tenant-1',
  teamId: 'team-1',
  namespace: 'sandbox-recipes',
  sourceAuditRef: 'agent-audit-1',
}

export const adminInput: AdministrativeEventInputV1 = {
  kind: 'linked_outcome',
  sourceEventId: 'admin-event-1',
  occurredAt: '2026-07-10T09:59:59.000Z',
  payload: { detail_ref: 'agent-audit-1', config_hash: 'abc123' },
}

export const infraPrincipal: InfrastructureTelemetrySubmitterPrincipalV1 = {
  kind: 'hcc_internal_control',
  sourceService: 'host-context-controller',
  serviceSub: 'hcc-provisioner',
  credentialId: 'credential-infra-1',
  resourceAuthority: 'hcc_managed',
  allowedTelemetryTypes: [
    'reconcile_outcome',
    'health_transition',
    'lifecycle_transition',
    'capacity_sample',
    'usage_sample',
    'controller_error',
  ],
}

export const infraBinding: InfrastructureTelemetryServerBindingV1 = {
  triggerKind: 'controller_reconcile',
  outcome: 'healthy',
  reasonCode: 'ready',
  environment: 'test',
  clusterName: 'clerum-test',
  namespace: 'mcp-server',
  workloadKind: 'Deployment',
  workloadRef: 'mcp-server/chatllm',
  kubernetesKind: 'Host',
  kubernetesName: 'chatllm',
  kubernetesUid: 'uid-1',
  metadataGeneration: 3,
  relatedOperationId: null,
  relatedRunId: null,
}

export const infraInput: InfrastructureTelemetryEventInputV1 = {
  sourceEventId: 'health-transition-1',
  occurredAt: '2026-07-10T09:59:59.000Z',
  telemetryType: 'health_transition',
  payload: { transition: 'Pending->Ready' },
}

export type Harness = {
  db: DbClient
  query: ReturnType<typeof vi.fn>
  transaction: TracingTransactionRunner
  transactionSpy: ReturnType<typeof vi.fn>
}

export function harness(): Harness {
  const query = vi.fn()
  const db = { query } as DbClient
  const transactionSpy = vi.fn(async (work: (client: DbClient) => Promise<unknown>) => work(db))
  return {
    db,
    query,
    transaction: transactionSpy as TracingTransactionRunner,
    transactionSpy,
  }
}

export function acceptedDb(query: ReturnType<typeof vi.fn>): void {
  query
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          event_id: EVENT_ID,
          payload_sha256: 'a'.repeat(64),
          ingested_at: NOW,
          stream_sequence: '41',
        },
      ],
      rowCount: 1,
    })
}

import type { TraceColumnFilterDefinition } from './types'

const OUTCOME_OPTIONS = [
  { label: 'Started', value: 'started' },
  { label: 'Succeeded', value: 'succeeded' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'Unknown', value: 'unknown' },
] as const

const ADMINISTRATIVE_OUTCOME_OPTIONS = [
  { label: 'Attempted', value: 'attempted' },
  { label: 'Committed', value: 'committed' },
  { label: 'Succeeded', value: 'succeeded' },
  { label: 'Failed', value: 'failed' },
  { label: 'Rejected', value: 'rejected' },
] as const

const INFRASTRUCTURE_OUTCOME_OPTIONS = [
  { label: 'Started', value: 'started' },
  { label: 'Succeeded', value: 'succeeded' },
  { label: 'Failed', value: 'failed' },
  { label: 'Healthy', value: 'healthy' },
  { label: 'Unhealthy', value: 'unhealthy' },
  { label: 'Stopped', value: 'stopped' },
  { label: 'Unknown', value: 'unknown' },
] as const

export const SESSION_FILTERS: readonly TraceColumnFilterDefinition[] = [
  {
    id: 'session',
    label: 'Session',
    fields: [
      { key: 'sessionId', label: 'Session ID', placeholder: 'Exact session ID', type: 'text' },
      { key: 'hostRef', label: 'MCP host', placeholder: 'Host reference', type: 'text' },
      {
        key: 'origin',
        label: 'Origin',
        type: 'enum',
        options: [
          { label: 'Direct chat', value: 'direct_chat' },
          { label: 'Channel event', value: 'channel_event' },
          { label: 'API', value: 'api' },
          { label: 'Workflow runtime', value: 'workflow_runtime' },
        ],
      },
    ],
  },
  {
    id: 'human',
    label: 'Human',
    fields: [{ key: 'humanUserId', label: 'Platform user', type: 'user' }],
  },
  {
    id: 'agent',
    label: 'Agent',
    fields: [
      {
        key: 'agentSub',
        label: 'Agent subject',
        placeholder: 'Verified agent subject',
        type: 'text',
      },
      {
        key: 'sourceService',
        label: 'Source service',
        placeholder: 'Source service',
        type: 'text',
      },
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    fields: [{ key: 'outcome', label: 'Latest outcome', options: OUTCOME_OPTIONS, type: 'enum' }],
  },
  {
    id: 'tools',
    label: 'Tools',
    fields: [
      { key: 'toolName', label: 'Tool name', placeholder: 'Governed tool name', type: 'text' },
    ],
  },
  {
    id: 'approvals',
    label: 'Approvals',
    fields: [
      {
        key: 'approvalState',
        label: 'Approval state',
        type: 'enum',
        options: [
          { label: 'Requested', value: 'requested' },
          { label: 'Approved', value: 'approved' },
          { label: 'Denied', value: 'denied' },
        ],
      },
    ],
  },
]

export const ADMINISTRATIVE_FILTERS: readonly TraceColumnFilterDefinition[] = [
  {
    id: 'action',
    label: 'Action',
    fields: [
      {
        key: 'action',
        label: 'Action',
        type: 'enum',
        options: [
          { label: 'Agent mutation', value: 'agent_mutation' },
          { label: 'Host mutation', value: 'host_mutation' },
          { label: 'Permission grant', value: 'permission_grant' },
          { label: 'Permission revoke', value: 'permission_revoke' },
          { label: 'Delegated resource mutation', value: 'delegated_resource_mutation' },
          { label: 'Folder mutation', value: 'folder_mutation' },
          { label: 'Resource mutation', value: 'resource_mutation' },
          { label: 'Configuration mutation', value: 'configuration_mutation' },
          { label: 'Service maintenance', value: 'service_maintenance' },
          { label: 'Control administrator deleted', value: 'control_admin_deleted' },
        ],
      },
    ],
  },
  {
    id: 'operator',
    label: 'Operator',
    fields: [{ key: 'operatorUserId', label: 'Operator identity', type: 'operator' }],
  },
  {
    id: 'actor',
    label: 'Acting service / agent',
    fields: [
      {
        key: 'delegatedActorSub',
        label: 'Delegated actor',
        placeholder: 'Validated act.sub',
        type: 'text',
      },
      {
        key: 'sourceService',
        label: 'Source service',
        placeholder: 'Source service',
        type: 'text',
      },
    ],
  },
  {
    id: 'target',
    label: 'Target',
    fields: [
      {
        key: 'targetType',
        label: 'Target type',
        type: 'enum',
        options: [
          { label: 'Agent', value: 'agent' },
          { label: 'Host', value: 'host' },
          { label: 'Permission', value: 'permission' },
          { label: 'Delegated resource', value: 'delegated_resource' },
          { label: 'Folder', value: 'folder' },
          { label: 'Resource', value: 'resource' },
          { label: 'Configuration', value: 'configuration' },
          { label: 'Service', value: 'service' },
          { label: 'Control administrator', value: 'control_admin' },
        ],
      },
      {
        key: 'targetRef',
        label: 'Target reference',
        placeholder: 'Resource reference',
        type: 'text',
      },
      { key: 'targetUserId', label: 'Target platform user', type: 'user' },
      {
        key: 'teamId',
        label: 'Target team ID',
        placeholder: 'Exact team ID',
        type: 'text',
      },
    ],
  },
  {
    id: 'outcome',
    label: 'Outcome',
    fields: [
      {
        key: 'outcome',
        label: 'Outcome',
        options: ADMINISTRATIVE_OUTCOME_OPTIONS,
        type: 'enum',
      },
    ],
  },
]

export const INFRASTRUCTURE_FILTERS: readonly TraceColumnFilterDefinition[] = [
  {
    id: 'workload',
    label: 'Workload / event',
    fields: [
      {
        key: 'workloadKind',
        label: 'Workload kind',
        type: 'enum',
        options: [
          { label: 'Host', value: 'Host' },
          { label: 'MCP server', value: 'McpServer' },
          { label: 'Workflow recipe', value: 'WorkflowRecipe' },
          { label: 'Deployment', value: 'Deployment' },
          { label: 'Service', value: 'Service' },
          { label: 'Network policy', value: 'NetworkPolicy' },
        ],
      },
      {
        key: 'workloadRef',
        label: 'Workload reference',
        placeholder: 'Workload reference',
        type: 'text',
      },
    ],
  },
  {
    id: 'scope',
    label: 'Scope',
    fields: [
      { key: 'namespace', label: 'Namespace', placeholder: 'Kubernetes namespace', type: 'text' },
      { key: 'clusterName', label: 'Cluster', placeholder: 'Cluster name', type: 'text' },
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    fields: [
      {
        key: 'telemetryType',
        label: 'Telemetry type',
        type: 'enum',
        options: [
          { label: 'Reconcile outcome', value: 'reconcile_outcome' },
          { label: 'Health transition', value: 'health_transition' },
          { label: 'Lifecycle transition', value: 'lifecycle_transition' },
          { label: 'Capacity sample', value: 'capacity_sample' },
          { label: 'Usage sample', value: 'usage_sample' },
          { label: 'Controller error', value: 'controller_error' },
        ],
      },
      { key: 'reasonCode', label: 'Reason code', placeholder: 'Diagnostic reason', type: 'text' },
    ],
  },
  {
    id: 'source',
    label: 'Controller',
    fields: [
      {
        key: 'controller',
        label: 'Controller',
        type: 'enum',
        options: [
          { label: 'Host context controller', value: 'host-context-controller' },
          { label: 'Workflow recipes', value: 'workflow-recipes' },
          { label: 'Control API', value: 'control-api' },
        ],
      },
      {
        key: 'sourceService',
        label: 'Source service',
        placeholder: 'Source service',
        type: 'text',
      },
    ],
  },
  {
    id: 'outcome',
    label: 'Outcome',
    fields: [
      {
        key: 'outcome',
        label: 'Outcome',
        options: INFRASTRUCTURE_OUTCOME_OPTIONS,
        type: 'enum',
      },
    ],
  },
]

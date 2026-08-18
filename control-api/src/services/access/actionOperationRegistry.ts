import {
  ACTION_OPERATION_IDS,
  type ActionOperationId,
  type ActionOperationWireDefinition,
  type CanonicalActionTarget,
  type ExactOperationTargetSchemaWire,
  getActionOperationWireDefinition,
  validateActionOperationTarget as validateSharedActionOperationTarget,
} from '@clerum/action-context-contracts'
import type { AccessPathBehavior } from './accessPath.js'
import { type AccessCapability, isAccessCapability } from './capabilityRegistry.js'
import type { AccessResourceType, CanonicalResourceIdentity } from './resourceIdentity.js'

export { ActionOperationTargetError } from '@clerum/action-context-contracts'
export type { ActionOperationId, CanonicalActionTarget }

export type ActionOperationFamily =
  | 'host_read'
  | 'host_wake'
  | 'host_management'
  | 'mcp_discovery'
  | 'mcp_read'
  | 'mcp_invocation'
  | 'context_action'
  | 'chat_read'
  | 'chat_message'
  | 'task_read'
  | 'task_management'
  | 'model_read'
  | 'model_selection'
  | 'runtime_session_read'
  | 'runtime_session_management'
  | 'activity_read'
  | 'workflow_read'
  | 'workflow_trigger'
  | 'workflow_run_management'
  | 'workflow_artifact_read'
  | 'workflow_artifact_delete'
  | 'workflow_approval'
  | 'gfs_read'
  | 'gfs_write'
  | 'gfs_delete'
  | 'gfs_acl'
  | 'gfs_share'
  | 'shared_filesystem_read'
  | 'shared_filesystem_write'
  | 'sandbox_discovery'
  | 'sandbox_view'
  | 'sandbox_oauth'
  | 'remote_desktop_read'
  | 'remote_desktop_view'
  | 'notification_read'

export type BehaviorDimensionName = Exclude<keyof AccessPathBehavior, 'capabilities'>

export type ActionOperationDefinition = Readonly<{
  operationId: ActionOperationId
  family: ActionOperationFamily
  resourceTypes: readonly AccessResourceType[]
  requiredCapabilities: readonly AccessCapability[]
  requiredBehaviorDimensions: readonly BehaviorDimensionName[]
  targetSchema: ExactOperationTargetSchemaWire
  pathMode: 'resource_only' | 'selected_path' | 'explicit_team'
  delegation: 'none' | 'exact' | 'bounded_family'
  checkpoint:
    | 'catalog_production'
    | 'request'
    | 'request_and_reconnect'
    | 'request_and_retry'
    | 'before_effect'
    | 'before_every_effect'
    | 'before_provider_contact'
    | 'stream'
    | 'transaction'
    | 'queued_start_and_effect'
    | 'every_controller_request'
    | 'active_lease'
  downstreamVerifiers: readonly (
    | 'control_api'
    | 'rpc_proxy'
    | 'mcp_host'
    | 'workflow_runtime'
    | 'gfs_controller'
    | 'workspace_files_controller'
    | 'oauth_broker'
    | 'host_context_controller'
  )[]
  auditMode: 'read' | 'effect' | 'stream'
}>

export const BEHAVIOR_DIMENSIONS: readonly BehaviorDimensionName[] = Object.freeze([
  'budget',
  'credentialPolicy',
  'approvalPolicy',
  'filesystemScope',
  'runtime',
  'providerModelPolicy',
  'audit',
])

const audit = Object.freeze(['audit'] as const)
const runtime = Object.freeze(['runtime', 'audit'] as const)
const mcpInvoke = Object.freeze([
  'credentialPolicy',
  'approvalPolicy',
  'filesystemScope',
  'runtime',
  'audit',
] as const)
const mcpRead = Object.freeze(['credentialPolicy', 'runtime', 'audit'] as const)
const context = Object.freeze([
  'credentialPolicy',
  'approvalPolicy',
  'filesystemScope',
  'runtime',
  'audit',
] as const)
const approval = Object.freeze(['approvalPolicy', 'audit'] as const)
const provider = Object.freeze(['providerModelPolicy', 'audit'] as const)
const providerRuntime = Object.freeze(['runtime', 'providerModelPolicy', 'audit'] as const)
const filesystem = Object.freeze(['filesystemScope', 'audit'] as const)
const sandboxView = Object.freeze([
  'credentialPolicy',
  'filesystemScope',
  'runtime',
  'audit',
] as const)
const credential = Object.freeze(['credentialPolicy', 'audit'] as const)

function operation(
  operationId: ActionOperationId,
  family: ActionOperationFamily,
  requiredCapabilities: readonly AccessCapability[],
  requiredBehaviorDimensions: readonly BehaviorDimensionName[],
  options: Pick<
    ActionOperationDefinition,
    'pathMode' | 'delegation' | 'checkpoint' | 'downstreamVerifiers' | 'auditMode'
  >
): ActionOperationDefinition {
  if (requiredCapabilities.length === 0 || !requiredCapabilities.every(isAccessCapability)) {
    throw new Error('action_operation_capability_invalid')
  }
  if (
    requiredBehaviorDimensions.some(dimension => !BEHAVIOR_DIMENSIONS.includes(dimension)) ||
    new Set(requiredBehaviorDimensions).size !== requiredBehaviorDimensions.length ||
    (options.pathMode === 'selected_path' && !requiredBehaviorDimensions.includes('audit')) ||
    (options.pathMode === 'resource_only' && requiredBehaviorDimensions.length > 0)
  ) {
    throw new Error('action_operation_behavior_dimensions_invalid')
  }
  const wire: ActionOperationWireDefinition = getActionOperationWireDefinition(operationId)
  return Object.freeze({
    operationId,
    family,
    resourceTypes: wire.resourceTypes as readonly AccessResourceType[],
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    requiredBehaviorDimensions: Object.freeze([...requiredBehaviorDimensions]),
    targetSchema: wire.targetSchema,
    pathMode: options.pathMode,
    delegation: options.delegation,
    checkpoint: options.checkpoint,
    downstreamVerifiers: Object.freeze([...options.downstreamVerifiers]),
    auditMode: options.auditMode,
  })
}

const read = (checkpoint: ActionOperationDefinition['checkpoint'] = 'request') =>
  ({
    pathMode: 'selected_path',
    delegation: 'bounded_family',
    checkpoint,
    downstreamVerifiers: ['rpc_proxy', 'mcp_host'],
    auditMode: checkpoint === 'stream' ? 'stream' : 'read',
  }) as const

const effect = (
  checkpoint: ActionOperationDefinition['checkpoint'] = 'before_effect',
  downstreamVerifiers: ActionOperationDefinition['downstreamVerifiers'] = ['control_api']
) =>
  ({
    pathMode: 'selected_path',
    delegation: 'exact',
    checkpoint,
    downstreamVerifiers,
    auditMode: checkpoint === 'active_lease' ? 'stream' : 'effect',
  }) as const

const resourceOnly = Object.freeze({
  pathMode: 'resource_only' as const,
  delegation: 'none' as const,
  checkpoint: 'catalog_production' as const,
  downstreamVerifiers: ['control_api'] as const,
  auditMode: 'read' as const,
})

const definitions: ActionOperationDefinition[] = [
  operation('host.status.read', 'host_read', ['host.read'], runtime, read()),
  operation('host.health.read', 'host_read', ['host.read'], runtime, read('request_and_reconnect')),
  operation(
    'host.wake',
    'host_wake',
    ['host.use'],
    runtime,
    effect('before_effect', ['rpc_proxy', 'control_api'])
  ),
  operation(
    'host.manage',
    'host_management',
    ['host.manage'],
    runtime,
    effect('before_effect', ['rpc_proxy', 'host_context_controller'])
  ),
  operation('mcp.catalog.read', 'mcp_discovery', ['mcp_server.read'], [], resourceOnly),
  operation(
    'mcp.invoke',
    'mcp_invocation',
    ['mcp_server.use'],
    mcpInvoke,
    effect('request_and_retry', ['rpc_proxy', 'mcp_host'])
  ),
  operation('mcp.tools.read', 'mcp_read', ['mcp_server.read'], mcpRead, {
    ...read('request_and_retry'),
    delegation: 'exact',
  }),
  operation(
    'context.use',
    'context_action',
    ['context.use'],
    context,
    effect('before_every_effect')
  ),
  operation(
    'context.manage',
    'context_action',
    ['context.manage'],
    context,
    effect('before_every_effect')
  ),
  operation('chat.read', 'chat_read', ['chat.read'], audit, read()),
  operation(
    'chat.message.invoke',
    'chat_message',
    ['chat.message.invoke'],
    BEHAVIOR_DIMENSIONS,
    effect('before_every_effect', ['rpc_proxy', 'mcp_host', 'control_api'])
  ),
  operation('task.read', 'task_read', ['task.read'], audit, read('request_and_reconnect')),
  operation(
    'task.manage',
    'task_management',
    ['task.manage'],
    approval,
    effect('before_effect', ['rpc_proxy', 'mcp_host'])
  ),
  operation('model.read', 'model_read', ['model.read'], provider, read()),
  operation(
    'model.select',
    'model_selection',
    ['model.select'],
    providerRuntime,
    effect('before_provider_contact', ['mcp_host', 'control_api'])
  ),
  operation(
    'session.read',
    'runtime_session_read',
    ['session.read'],
    audit,
    read('request_and_reconnect')
  ),
  operation(
    'session.manage',
    'runtime_session_management',
    ['session.manage'],
    audit,
    effect('before_effect', ['mcp_host'])
  ),
  operation('host.activity.read', 'activity_read', ['host.activity.read'], audit, read('stream')),
  operation('host.activity.read_all', 'activity_read', ['host.activity.read_all'], audit, {
    ...read('request_and_reconnect'),
    downstreamVerifiers: ['control_api', 'mcp_host'],
  }),
  operation('workflow.read', 'workflow_read', ['workflow.read'], audit, {
    ...read(),
    downstreamVerifiers: ['control_api'],
  }),
  operation(
    'workflow.trigger',
    'workflow_trigger',
    ['workflow.trigger'],
    BEHAVIOR_DIMENSIONS,
    effect('queued_start_and_effect', ['control_api', 'workflow_runtime'])
  ),
  operation(
    'workflow.run.manage',
    'workflow_run_management',
    ['workflow.run.manage'],
    BEHAVIOR_DIMENSIONS,
    effect('before_effect', ['control_api', 'workflow_runtime'])
  ),
  operation(
    'workflow.artifact.read',
    'workflow_artifact_read',
    ['workflow.artifact.read'],
    filesystem,
    { ...read(), delegation: 'exact', downstreamVerifiers: ['control_api', 'workflow_runtime'] }
  ),
  operation(
    'workflow.artifact.delete',
    'workflow_artifact_delete',
    ['workflow.artifact.delete'],
    filesystem,
    effect('before_effect', ['control_api', 'workflow_runtime'])
  ),
  operation(
    'workflow.approval.decide',
    'workflow_approval',
    ['workflow.approval.decide'],
    approval,
    effect('transaction')
  ),
  operation(
    'workflow.approval.consume',
    'workflow_approval',
    ['workflow.approval.decide'],
    approval,
    effect('transaction')
  ),
  operation('gfs.read', 'gfs_read', ['gfs.read'], filesystem, {
    ...read('every_controller_request'),
    delegation: 'exact',
    downstreamVerifiers: ['control_api', 'gfs_controller'],
  }),
  operation(
    'gfs.write',
    'gfs_write',
    ['gfs.write'],
    filesystem,
    effect('every_controller_request', ['control_api', 'gfs_controller'])
  ),
  operation(
    'gfs.delete',
    'gfs_delete',
    ['gfs.delete'],
    filesystem,
    effect('every_controller_request', ['control_api', 'gfs_controller'])
  ),
  operation(
    'gfs.manage_acl',
    'gfs_acl',
    ['gfs.manage_acl'],
    filesystem,
    effect('transaction', ['control_api', 'gfs_controller'])
  ),
  operation(
    'gfs.share',
    'gfs_share',
    ['gfs.share'],
    filesystem,
    effect('transaction', ['control_api', 'gfs_controller'])
  ),
  operation(
    'shared_filesystem.read',
    'shared_filesystem_read',
    ['shared_filesystem.read'],
    filesystem,
    {
      ...read('every_controller_request'),
      delegation: 'exact',
      downstreamVerifiers: ['control_api', 'workspace_files_controller'],
    }
  ),
  operation(
    'shared_filesystem.write',
    'shared_filesystem_write',
    ['shared_filesystem.write'],
    filesystem,
    effect('every_controller_request', ['control_api', 'workspace_files_controller'])
  ),
  operation('sandbox.catalog.read', 'sandbox_discovery', ['sandbox_app.read'], [], resourceOnly),
  operation(
    'sandbox.open',
    'sandbox_view',
    ['sandbox_app.use'],
    sandboxView,
    effect('active_lease', ['rpc_proxy', 'control_api'])
  ),
  operation(
    'sandbox.reconnect',
    'sandbox_view',
    ['sandbox_app.use'],
    sandboxView,
    effect('active_lease', ['rpc_proxy', 'control_api'])
  ),
  operation(
    'sandbox.oauth.vend',
    'sandbox_oauth',
    ['sandbox_oauth.vend'],
    credential,
    effect('before_provider_contact', ['rpc_proxy', 'control_api', 'oauth_broker'])
  ),
  operation(
    'sandbox.oauth.disconnect',
    'sandbox_oauth',
    ['sandbox_app.use'],
    credential,
    effect('before_effect', ['rpc_proxy', 'control_api'])
  ),
  operation('remote_desktop.status', 'remote_desktop_read', ['host.read'], runtime, {
    ...read(),
    delegation: 'exact',
    downstreamVerifiers: ['rpc_proxy', 'host_context_controller'],
  }),
  operation(
    'remote_desktop.open',
    'remote_desktop_view',
    ['remote_desktop.use'],
    runtime,
    effect('active_lease', ['rpc_proxy', 'control_api'])
  ),
  operation(
    'remote_desktop.reconnect',
    'remote_desktop_view',
    ['remote_desktop.use'],
    runtime,
    effect('active_lease', ['rpc_proxy', 'control_api'])
  ),
  operation('notification.read', 'notification_read', ['notification.read'], [], {
    ...resourceOnly,
    checkpoint: 'request',
  }),
]

const registry = new Map(definitions.map(definition => [definition.operationId, definition]))
if (
  registry.size !== ACTION_OPERATION_IDS.length ||
  ACTION_OPERATION_IDS.some(operationId => !registry.has(operationId))
) {
  throw new Error('action_operation_registry_incomplete')
}

export const ACTION_OPERATION_REGISTRY = Object.freeze([...definitions])

export function getActionOperationDefinition(
  operationId: ActionOperationId
): ActionOperationDefinition {
  const definition = registry.get(operationId)
  if (!definition) throw new Error('action_operation_unknown')
  return definition
}

export function validateActionOperationTarget(input: {
  operationId: ActionOperationId
  resource: CanonicalResourceIdentity
  operationTarget?: unknown
}): CanonicalActionTarget {
  return validateSharedActionOperationTarget(input)
}

export function selectedPathSupportsActionOperation(
  definition: ActionOperationDefinition,
  selectedPathCapabilities: readonly AccessCapability[]
): boolean {
  const selected = new Set(selectedPathCapabilities)
  return definition.requiredCapabilities.every(capability => selected.has(capability))
}

export function selectedPathHasRequiredBehavior(
  definition: ActionOperationDefinition,
  behavior: AccessPathBehavior
): boolean {
  return definition.requiredBehaviorDimensions.every(
    dimension => behavior[dimension].state === 'known'
  )
}

export declare const ACTION_CONTEXT_VERSION: 2
export declare const ACTION_OPERATION_SCOPE_PREFIX: 'action:'
export declare const ACTION_TARGET_HASH_PREFIX: 'ath2_'
export declare const ACTION_BEHAVIOR_HASH_PREFIX: 'bh2_'
export declare const ACTION_AUTHORITY_CHECKPOINT_PATH: '/api/v1/internal/action-authority/checkpoint'
export declare const ACTION_AUTHORITY_DESTINATION_KINDS: readonly ['host', 'mcp_server']
export declare const ACCESS_RESOURCE_TYPES: readonly [
  'user',
  'team',
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'workflow_run',
  'workflow_artifact',
  'workflow_approval',
  'gfs_resource',
  'shared_filesystem',
  'sandbox_app',
  'chat',
  'runtime_session',
  'notification',
]

export declare const ACTION_OPERATION_IDS: readonly [
  'host.status.read',
  'host.health.read',
  'host.wake',
  'host.manage',
  'mcp.catalog.read',
  'mcp.invoke',
  'mcp.tools.read',
  'context.use',
  'context.manage',
  'chat.read',
  'chat.message.invoke',
  'task.read',
  'task.manage',
  'model.read',
  'model.select',
  'session.read',
  'session.manage',
  'host.activity.read',
  'host.activity.read_all',
  'workflow.read',
  'workflow.trigger',
  'workflow.run.manage',
  'workflow.artifact.read',
  'workflow.artifact.delete',
  'workflow.approval.decide',
  'workflow.approval.consume',
  'gfs.read',
  'gfs.write',
  'gfs.delete',
  'gfs.manage_acl',
  'gfs.share',
  'shared_filesystem.read',
  'shared_filesystem.write',
  'sandbox.catalog.read',
  'sandbox.open',
  'sandbox.reconnect',
  'sandbox.oauth.vend',
  'sandbox.oauth.disconnect',
  'remote_desktop.status',
  'remote_desktop.open',
  'remote_desktop.reconnect',
  'notification.read',
]

export type ActionOperationId = (typeof ACTION_OPERATION_IDS)[number]
export type ActionOperationScope = `action:${ActionOperationId}`
export type CanonicalActionTarget = Readonly<Record<string, string>> | null
export declare const ACTION_OPERATION_SCOPES: readonly ActionOperationScope[]

export type ExactOperationTargetSchemaWire = Readonly<{
  mode: 'none' | 'object' | 'optional_object'
  required: readonly string[]
  optional: readonly string[]
  enums: Readonly<Record<string, readonly string[]>>
  resourceBinding?:
    | Readonly<{ mode: 'field'; field: string }>
    | Readonly<{ mode: 'namespaced_fields'; namespaceField: string; nameField: string }>
}>

export type ActionOperationWireDefinition = Readonly<{
  operationId: ActionOperationId
  resourceTypes: readonly string[]
  targetSchema: ExactOperationTargetSchemaWire
}>

export declare const ACTION_OPERATION_WIRE_DEFINITIONS: readonly ActionOperationWireDefinition[]

export type AccessResourceTypeWire = (typeof ACCESS_RESOURCE_TYPES)[number]
export type CanonicalResourceIdentityWire = Readonly<{
  environmentId: string
  type: AccessResourceTypeWire
  canonicalId: string
  logicalId: string
  displayName: string
  providerUid?: string
}>

export type BehaviorDimensionWire =
  | Readonly<{ state: 'known'; value: string | null }>
  | Readonly<{ state: 'unknown' }>

export type SelectedPathBehaviorWire = Readonly<{
  budget: BehaviorDimensionWire
  credentialPolicy: BehaviorDimensionWire
  approvalPolicy: BehaviorDimensionWire
  filesystemScope: BehaviorDimensionWire
  runtime: BehaviorDimensionWire
  providerModelPolicy: BehaviorDimensionWire
  audit: BehaviorDimensionWire
}>

export type AccessPathBehaviorWire = SelectedPathBehaviorWire &
  Readonly<{ capabilities: readonly string[] }>

export type TrustedEdgeActionContextV2 = Readonly<{
  version: 2
  userId: string
  sid: string
  sessionVersion: number
  delegationJti: string
  operationId: ActionOperationId
  resource: CanonicalResourceIdentityWire
  target: CanonicalActionTarget
  targetHash: string
  accessPathId: string
  authorizationRevision: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
  behaviorBindingHash: string
  behavior: SelectedPathBehaviorWire
  checkedAt: string
  expiresAt: string
}>

export type AuthorityBindingV2 = Readonly<{
  version: 2
  userId: string
  sid: string
  sessionVersion: number
  delegationJti: string
  operationId: ActionOperationId
  resource: CanonicalResourceIdentityWire
  target: CanonicalActionTarget
  targetHash: string
  accessPathId: string
  authorizationRevision: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
  behaviorBindingHash: string
}>

export type DelegationV2IssuanceResponse = Readonly<{
  delegationToken: string
  messageId?: string
}>

export type ActionAuthorityCheckpointRequestV2 = Readonly<{
  version: 2
  principal: Readonly<{ sub: string; sid: string; sessionVersion: number }>
  delegationJti: string
  resource: CanonicalResourceIdentityWire
  operationId: ActionOperationId
  target: CanonicalActionTarget
  targetHash: string
  accessPathId: string
  authorizationRevision: string
  behaviorBindingHash: string
  domain: Readonly<{
    service: string
    resource: CanonicalResourceIdentityWire
    targetHash: string
  }>
}>

export type ActionAuthorityCheckpointResponseV2 =
  | Readonly<{
      version: 2
      status: 'allowed'
      authorizationRevision: string
      behaviorBindingHash: string
      behavior: SelectedPathBehaviorWire
      checkedAt: string
      validUntil: string | null
      attribution: Readonly<{
        userId: string
        sid: string
        sessionVersion: number
        accessPathId: string
        pathKind: 'direct' | 'team'
        effectiveTeamId: string | null
      }>
      destination: null | Readonly<{ kind: 'host' | 'mcp_server'; ref: string; url: string }>
    }>
  | Readonly<{ version: 2; status: 'denied'; code: 'forbidden' }>
  | Readonly<{ version: 2; status: 'not_found'; code: 'not_found' }>
  | Readonly<{
      version: 2
      status: 'access_path_stale'
      code: 'access_path_stale'
      currentAuthorizationRevision: string
    }>
  | Readonly<{
      version: 2
      status: 'authority_unavailable'
      code: 'authority_unavailable'
      retryable: true
    }>
  | Readonly<{ version: 2; status: 'invalid_binding'; code: 'invalid_binding' }>

export declare class ActionTargetWireError extends Error {
  readonly code: 'invalid'
}

export declare class ActionOperationTargetError extends Error {
  readonly code: 'missing' | 'invalid' | 'unsupported' | 'resource_mismatch'
}

export declare class ActionAuthorityCheckpointWireError extends Error {
  readonly code: 'invalid'
}

export declare function validateActionAuthorityCheckpointResponse(
  value: unknown
): ActionAuthorityCheckpointResponseV2

export declare function isActionOperationId(value: unknown): value is ActionOperationId
export declare function requireActionOperationId(value: unknown): ActionOperationId
export declare function actionOperationScope(operationId: ActionOperationId): ActionOperationScope
export declare function parseActionOperationScope(value: unknown): ActionOperationId | null
export declare function parseActionOperationScopes(value: unknown): Readonly<{
  scopes: readonly ActionOperationScope[]
  operationIds: readonly ActionOperationId[]
}>
export declare function canonicalActionTarget(value: unknown): CanonicalActionTarget
export declare function canonicalActionTargetJson(value: unknown): string
export declare function hashActionTarget(value: unknown): string
export declare function canonicalActionBehaviorBinding(input: {
  accessPathId: string
  authorizationRevision: string
  behavior: AccessPathBehaviorWire
}): string
export declare function actionBehaviorBindingHash(input: {
  accessPathId: string
  authorizationRevision: string
  behavior: AccessPathBehaviorWire
}): string
export declare function isAccessResourceType(value: unknown): value is AccessResourceTypeWire
export declare function requireAccessResourceType(value: unknown): AccessResourceTypeWire
export declare function validateLogicalResourceId(
  type: AccessResourceTypeWire,
  logicalId: string
): void
export declare function canonicalResourceIdentity(input: {
  environmentId: unknown
  type: unknown
  logicalId: unknown
  displayName?: unknown
  providerUid?: unknown
}): CanonicalResourceIdentityWire
export declare function validateCanonicalResourceIdentity(
  value: unknown
): CanonicalResourceIdentityWire
export declare function getActionOperationWireDefinition(
  operationId: ActionOperationId
): ActionOperationWireDefinition
export declare function validateActionOperationTarget(input: {
  operationId: ActionOperationId
  resource: Readonly<{ type: string; logicalId: string }>
  operationTarget?: unknown
}): CanonicalActionTarget

export type McpCallerOperationClassification =
  | Readonly<{
      status: 'classified'
      operationId: 'mcp.invoke'
      target: Readonly<{ serverNamespace: string; serverName: string; toolName: string }>
    }>
  | Readonly<{
      status: 'classified'
      operationId: 'mcp.tools.read'
      target: Readonly<{ serverNamespace: string; serverName: string }>
    }>
  | Readonly<{
      status: 'denied'
      code: 'invalid_mcp_request' | 'internal_protocol_method' | 'unclassified_mcp_method'
    }>

export declare function classifyMcpCallerOperation(input: {
  serverNamespace: unknown
  serverName: unknown
  method: unknown
  params?: unknown
}): McpCallerOperationClassification

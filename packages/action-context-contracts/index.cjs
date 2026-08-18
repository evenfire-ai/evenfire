'use strict'

const { createHash } = require('node:crypto')

const ACTION_CONTEXT_VERSION = 2
const ACTION_OPERATION_SCOPE_PREFIX = 'action:'
const ACTION_TARGET_HASH_PREFIX = 'ath2_'
const ACTION_BEHAVIOR_HASH_PREFIX = 'bh2_'
const ACTION_AUTHORITY_CHECKPOINT_PATH = '/api/v1/internal/action-authority/checkpoint'
const ACTION_AUTHORITY_DESTINATION_KINDS = Object.freeze(['host', 'mcp_server'])
const MAX_TARGET_FIELDS = 12
const MAX_TARGET_VALUE_LENGTH = 1024
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const TARGET_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NAMESPACED_REF_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const DNS_COMPONENT_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const UUID_FIELDS = new Set([
  'approvalId',
  'approvalRequestId',
  'grantId',
  'messageId',
  'notificationId',
  'parentResourceId',
  'resourceId',
  'runId',
  'shareId',
  'uploadId',
])
const DNS_COMPONENT_FIELDS = new Set([
  'contextName',
  'contextNamespace',
  'recipeName',
  'recipeNamespace',
  'serverName',
  'serverNamespace',
  'sharedFileSystemName',
  'sharedFileSystemNamespace',
])
const BOOLEAN_FIELDS = new Set(['includeDescendants', 'inherit'])
const AUTHORIZATION_REVISION_PATTERN = /^ar1_[A-Za-z0-9_-]{43}$/
const ACCESS_PATH_ID_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/
const BEHAVIOR_BINDING_HASH_PATTERN = /^bh2_[A-Za-z0-9_-]{43}$/

const ACCESS_RESOURCE_TYPES = Object.freeze([
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
])
const accessResourceTypes = new Set(ACCESS_RESOURCE_TYPES)

// This is the one wire-level operation identifier source. Control API's
// exhaustive policy registry is checked bijectively against it at module load.
const ACTION_OPERATION_IDS = Object.freeze([
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
])

const operationIds = new Set(ACTION_OPERATION_IDS)
const ACTION_OPERATION_SCOPES = Object.freeze(
  ACTION_OPERATION_IDS.map(operationId => `${ACTION_OPERATION_SCOPE_PREFIX}${operationId}`)
)

class ActionTargetWireError extends Error {
  constructor() {
    super('action_target_invalid')
    this.name = 'ActionTargetWireError'
    this.code = 'invalid'
  }
}

class ActionOperationTargetError extends Error {
  constructor(code) {
    super(`Action operation target ${code}`)
    this.name = 'ActionOperationTargetError'
    this.code = code
  }
}

function isActionOperationId(value) {
  return typeof value === 'string' && operationIds.has(value)
}

function requireActionOperationId(value) {
  if (!isActionOperationId(value)) throw new Error('action_operation_unknown')
  return value
}

function actionOperationScope(operationId) {
  return `${ACTION_OPERATION_SCOPE_PREFIX}${requireActionOperationId(operationId)}`
}

function parseActionOperationScope(value) {
  if (typeof value !== 'string' || !value.startsWith(ACTION_OPERATION_SCOPE_PREFIX)) return null
  const operationId = value.slice(ACTION_OPERATION_SCOPE_PREFIX.length)
  if (!isActionOperationId(operationId) || value !== actionOperationScope(operationId)) return null
  return operationId
}

function parseActionOperationScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > ACTION_OPERATION_IDS.length) {
    throw new Error('action_operation_scopes_invalid')
  }
  const scopes = []
  const parsedOperationIds = []
  const seen = new Set()
  for (const raw of value) {
    const operationId = parseActionOperationScope(raw)
    if (!operationId || seen.has(operationId)) throw new Error('action_operation_scopes_invalid')
    seen.add(operationId)
    scopes.push(actionOperationScope(operationId))
    parsedOperationIds.push(operationId)
  }
  return Object.freeze({
    scopes: Object.freeze(scopes),
    operationIds: Object.freeze(parsedOperationIds),
  })
}

function canonicalActionTarget(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionTargetWireError()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new ActionTargetWireError()
  const entries = Object.entries(value)
  if (entries.length > MAX_TARGET_FIELDS) throw new ActionTargetWireError()
  const canonical = Object.create(null)
  for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!TARGET_KEY_PATTERN.test(key) || typeof raw !== 'string') throw new ActionTargetWireError()
    const normalized = raw.trim()
    if (
      !normalized ||
      normalized.length > MAX_TARGET_VALUE_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(normalized)
    ) {
      throw new ActionTargetWireError()
    }
    canonical[key] = normalized
  }
  return Object.freeze(canonical)
}

function canonicalActionTargetJson(value) {
  return JSON.stringify(canonicalActionTarget(value))
}

function hashActionTarget(value) {
  return (
    ACTION_TARGET_HASH_PREFIX +
    createHash('sha256').update(canonicalActionTargetJson(value), 'utf8').digest('base64url')
  )
}

const BEHAVIOR_DIMENSION_KEYS = Object.freeze([
  'budget',
  'credentialPolicy',
  'approvalPolicy',
  'filesystemScope',
  'runtime',
  'providerModelPolicy',
  'audit',
])

function canonicalBehaviorDimension(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('behavior_dimension_invalid')
  }
  if (value.state === 'unknown' && Object.keys(value).length === 1) return ['unknown']
  if (
    value.state === 'known' &&
    Object.keys(value).length === 2 &&
    (value.value === null ||
      (typeof value.value === 'string' &&
        value.value.length <= 4096 &&
        !CONTROL_CHARACTER_PATTERN.test(value.value)))
  ) {
    return ['known', value.value]
  }
  throw new Error('behavior_dimension_invalid')
}

function canonicalActionBehaviorBinding(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.accessPathId !== 'string' ||
    !/^ap1_[A-Za-z0-9_-]{43}$/.test(input.accessPathId) ||
    typeof input.authorizationRevision !== 'string' ||
    !/^ar1_[A-Za-z0-9_-]{43}$/.test(input.authorizationRevision) ||
    !input.behavior ||
    typeof input.behavior !== 'object' ||
    !Array.isArray(input.behavior.capabilities)
  ) {
    throw new Error('behavior_binding_invalid')
  }
  const capabilities = []
  for (const capability of input.behavior.capabilities) {
    if (
      typeof capability !== 'string' ||
      !capability ||
      capability.length > 128 ||
      CONTROL_CHARACTER_PATTERN.test(capability)
    ) {
      throw new Error('behavior_binding_invalid')
    }
    capabilities.push(capability)
  }
  const canonicalCapabilities = [...new Set(capabilities)].sort()
  const dimensions = BEHAVIOR_DIMENSION_KEYS.map(key =>
    canonicalBehaviorDimension(input.behavior[key])
  )
  return JSON.stringify([
    'action_behavior_binding_v2',
    input.accessPathId,
    input.authorizationRevision,
    canonicalCapabilities,
    dimensions,
  ])
}

function actionBehaviorBindingHash(input) {
  return (
    ACTION_BEHAVIOR_HASH_PREFIX +
    createHash('sha256').update(canonicalActionBehaviorBinding(input), 'utf8').digest('base64url')
  )
}

class ActionAuthorityCheckpointWireError extends Error {
  constructor() {
    super('action_authority_checkpoint_invalid')
    this.name = 'ActionAuthorityCheckpointWireError'
    this.code = 'invalid'
  }
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function checkpointString(value, maximum = 512) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  )
}

function validateCheckpointTimestamp(value) {
  return checkpointString(value, 64) && Number.isFinite(Date.parse(value))
}

function validateSelectedPathBehavior(value) {
  if (!hasExactKeys(value, BEHAVIOR_DIMENSION_KEYS)) return false
  try {
    for (const key of BEHAVIOR_DIMENSION_KEYS) canonicalBehaviorDimension(value[key])
    return true
  } catch {
    return false
  }
}

function validateCheckpointDestination(value) {
  if (value === null) return null
  if (!hasExactKeys(value, ['kind', 'ref', 'url'])) throw new ActionAuthorityCheckpointWireError()
  if (!ACTION_AUTHORITY_DESTINATION_KINDS.includes(value.kind)) {
    throw new ActionAuthorityCheckpointWireError()
  }
  if (
    !checkpointString(value.ref, 507) ||
    !NAMESPACED_REF_PATTERN.test(value.ref) ||
    !checkpointString(value.url, 2048)
  ) {
    throw new ActionAuthorityCheckpointWireError()
  }
  let url
  try {
    url = new URL(value.url)
  } catch {
    throw new ActionAuthorityCheckpointWireError()
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new ActionAuthorityCheckpointWireError()
  }
  return Object.freeze({ kind: value.kind, ref: value.ref, url: value.url })
}

function validateActionAuthorityCheckpointResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2) {
    throw new ActionAuthorityCheckpointWireError()
  }
  if (value.status === 'allowed') {
    if (
      !hasExactKeys(value, [
        'version',
        'status',
        'authorizationRevision',
        'behaviorBindingHash',
        'behavior',
        'checkedAt',
        'validUntil',
        'attribution',
        'destination',
      ]) ||
      !AUTHORIZATION_REVISION_PATTERN.test(value.authorizationRevision) ||
      !BEHAVIOR_BINDING_HASH_PATTERN.test(value.behaviorBindingHash) ||
      !validateSelectedPathBehavior(value.behavior) ||
      !validateCheckpointTimestamp(value.checkedAt) ||
      (value.validUntil !== null && !validateCheckpointTimestamp(value.validUntil)) ||
      (value.validUntil !== null && Date.parse(value.validUntil) < Date.parse(value.checkedAt)) ||
      !hasExactKeys(value.attribution, [
        'userId',
        'sid',
        'sessionVersion',
        'accessPathId',
        'pathKind',
        'effectiveTeamId',
      ]) ||
      !UUID_PATTERN.test(value.attribution.userId) ||
      !UUID_PATTERN.test(value.attribution.sid) ||
      !Number.isSafeInteger(value.attribution.sessionVersion) ||
      value.attribution.sessionVersion < 1 ||
      !ACCESS_PATH_ID_PATTERN.test(value.attribution.accessPathId) ||
      (value.attribution.pathKind !== 'direct' && value.attribution.pathKind !== 'team') ||
      (value.attribution.effectiveTeamId !== null &&
        !UUID_PATTERN.test(value.attribution.effectiveTeamId)) ||
      (value.attribution.pathKind === 'direct' && value.attribution.effectiveTeamId !== null) ||
      (value.attribution.pathKind === 'team' && value.attribution.effectiveTeamId === null)
    ) {
      throw new ActionAuthorityCheckpointWireError()
    }
    const destination = validateCheckpointDestination(value.destination)
    return Object.freeze({
      ...value,
      behavior: Object.freeze(value.behavior),
      attribution: Object.freeze(value.attribution),
      destination,
    })
  }
  const exactOutcomes = {
    denied: { keys: ['version', 'status', 'code'], code: 'forbidden' },
    not_found: { keys: ['version', 'status', 'code'], code: 'not_found' },
    invalid_binding: { keys: ['version', 'status', 'code'], code: 'invalid_binding' },
    access_path_stale: {
      keys: ['version', 'status', 'code', 'currentAuthorizationRevision'],
      code: 'access_path_stale',
    },
    authority_unavailable: {
      keys: ['version', 'status', 'code', 'retryable'],
      code: 'authority_unavailable',
    },
  }
  const expected = exactOutcomes[value.status]
  if (
    !expected ||
    !hasExactKeys(value, expected.keys) ||
    value.code !== expected.code ||
    (value.status === 'access_path_stale' &&
      !AUTHORIZATION_REVISION_PATTERN.test(value.currentAuthorizationRevision)) ||
    (value.status === 'authority_unavailable' && value.retryable !== true)
  ) {
    throw new ActionAuthorityCheckpointWireError()
  }
  return Object.freeze({ ...value })
}

function boundedResourceText(value, code, maximum) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new Error(code)
  }
  return normalized
}

function isAccessResourceType(value) {
  return typeof value === 'string' && accessResourceTypes.has(value)
}

function requireAccessResourceType(value) {
  if (!isAccessResourceType(value)) throw new Error('resource_type_invalid')
  return value
}

function validateLogicalResourceId(type, logicalId) {
  if (
    ['user', 'team', 'workflow_run', 'workflow_approval', 'gfs_resource', 'notification'].includes(
      type
    )
  ) {
    if (!UUID_PATTERN.test(logicalId)) throw new Error('resource_logical_id_invalid')
    return
  }
  if (
    [
      'host',
      'context',
      'mcp_server',
      'workflow_recipe',
      'shared_filesystem',
      'sandbox_app',
    ].includes(type) &&
    (!NAMESPACED_REF_PATTERN.test(logicalId) || logicalId.length > 507)
  ) {
    throw new Error('resource_logical_id_invalid')
  }
}

function canonicalResourceIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('resource_invalid')
  }
  const environmentId = boundedResourceText(input.environmentId, 'environment_id_invalid', 512)
  const type = requireAccessResourceType(input.type)
  const logicalId = boundedResourceText(input.logicalId, 'resource_logical_id_invalid', 1024)
  validateLogicalResourceId(type, logicalId)
  const displayName =
    input.displayName === undefined
      ? logicalId
      : boundedResourceText(input.displayName, 'resource_display_name_invalid', 512)
  const providerUid =
    input.providerUid === undefined || input.providerUid === null
      ? undefined
      : boundedResourceText(input.providerUid, 'resource_provider_uid_invalid', 256)
  return Object.freeze({
    environmentId,
    type,
    canonicalId: `${type}:${logicalId}`,
    logicalId,
    displayName,
    ...(providerUid ? { providerUid } : {}),
  })
}

function validateCanonicalResourceIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('resource_invalid')
  }
  const allowed = new Set([
    'environmentId',
    'type',
    'canonicalId',
    'logicalId',
    'displayName',
    'providerUid',
  ])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('resource_invalid')
  const canonical = canonicalResourceIdentity(value)
  if (
    value.canonicalId !== canonical.canonicalId ||
    value.environmentId !== canonical.environmentId ||
    value.logicalId !== canonical.logicalId ||
    value.displayName !== canonical.displayName ||
    value.type !== canonical.type ||
    (value.providerUid ?? undefined) !== canonical.providerUid
  ) {
    throw new Error('resource_noncanonical')
  }
  return canonical
}

function targetSchema(required, optional = [], enums = {}, resourceBinding, mode = 'object') {
  return Object.freeze({
    mode,
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
    enums: Object.freeze(
      Object.fromEntries(
        Object.entries(enums).map(([field, values]) => [field, Object.freeze([...values])])
      )
    ),
    ...(resourceBinding ? { resourceBinding: Object.freeze(resourceBinding) } : {}),
  })
}

const noTarget = targetSchema([], [], {}, undefined, 'none')
const hostBinding = Object.freeze({ mode: 'field', field: 'hostRef' })
const recipeBinding = Object.freeze({
  mode: 'namespaced_fields',
  namespaceField: 'recipeNamespace',
  nameField: 'recipeName',
})

const wireDefinitions = []
function targets(operationIdsForSchema, resourceTypes, schema) {
  for (const operationId of operationIdsForSchema) {
    wireDefinitions.push(
      Object.freeze({
        operationId: requireActionOperationId(operationId),
        resourceTypes: Object.freeze([...resourceTypes]),
        targetSchema: schema,
      })
    )
  }
}

targets(
  [
    'host.status.read',
    'host.health.read',
    'remote_desktop.status',
    'remote_desktop.open',
    'remote_desktop.reconnect',
  ],
  ['host'],
  targetSchema(['hostRef'], [], {}, hostBinding)
)
targets(
  ['host.wake'],
  ['host'],
  targetSchema(
    ['hostRef', 'wakeReason'],
    [],
    { wakeReason: ['explicit', 'message_retry', 'task_retry', 'session_retry'] },
    hostBinding
  )
)
targets(['host.manage'], ['host'], targetSchema(['hostRef', 'action'], [], {}, hostBinding))
targets(['mcp.catalog.read'], ['mcp_server'], noTarget)
targets(
  ['mcp.invoke'],
  ['mcp_server'],
  targetSchema(
    ['serverNamespace', 'serverName', 'toolName'],
    [],
    {},
    { mode: 'namespaced_fields', namespaceField: 'serverNamespace', nameField: 'serverName' }
  )
)
targets(
  ['mcp.tools.read'],
  ['mcp_server'],
  targetSchema(
    ['serverNamespace', 'serverName'],
    [],
    {},
    { mode: 'namespaced_fields', namespaceField: 'serverNamespace', nameField: 'serverName' }
  )
)
targets(
  ['context.use', 'context.manage'],
  ['context'],
  targetSchema(
    ['contextNamespace', 'contextName', 'action'],
    ['relatedResourceType', 'relatedResourceId'],
    {},
    { mode: 'namespaced_fields', namespaceField: 'contextNamespace', nameField: 'contextName' }
  )
)
targets(['chat.read'], ['chat'], targetSchema(['hostRef', 'agent', 'chatId']))
targets(
  ['chat.message.invoke'],
  ['host'],
  targetSchema(
    ['hostRef', 'channelType', 'channelId', 'messageId'],
    [],
    { channelType: ['rpc'] },
    hostBinding
  )
)
targets(['task.read'], ['runtime_session'], targetSchema(['hostRef', 'taskId'], ['artifactName']))
targets(
  ['task.manage'],
  ['runtime_session'],
  targetSchema(['hostRef', 'taskId', 'action'], ['approvalRequestId'], {
    action: ['cancel', 'approve', 'deny'],
  })
)
targets(['model.read'], ['runtime_session'], targetSchema(['hostRef', 'agent', 'chatId']))
targets(
  ['model.select'],
  ['runtime_session'],
  targetSchema(['hostRef', 'agent', 'chatId', 'provider', 'model'])
)
targets(['session.read'], ['runtime_session'], targetSchema(['hostRef'], ['agent', 'chatId']))
targets(
  ['session.manage'],
  ['runtime_session'],
  targetSchema(['hostRef', 'agent', 'chatId', 'action'])
)
targets(
  ['host.activity.read'],
  ['host'],
  targetSchema(['hostRef', 'visibility'], [], { visibility: ['caller_path'] }, hostBinding)
)
targets(
  ['host.activity.read_all'],
  ['host'],
  targetSchema(['hostRef', 'visibility'], [], { visibility: ['host_all'] }, hostBinding)
)
targets(
  ['workflow.read'],
  ['workflow_recipe', 'workflow_run'],
  targetSchema(['recipeNamespace', 'recipeName'], ['runId'])
)
targets(
  ['workflow.trigger'],
  ['workflow_recipe'],
  targetSchema(['recipeNamespace', 'recipeName'], [], {}, recipeBinding)
)
targets(
  ['workflow.run.manage'],
  ['workflow_run'],
  targetSchema(
    ['runId', 'action'],
    [],
    { action: ['cancel', 'resume', 'retry'] },
    { mode: 'field', field: 'runId' }
  )
)
targets(
  ['workflow.artifact.read', 'workflow.artifact.delete'],
  ['workflow_artifact'],
  targetSchema(['runId', 'artifactName'])
)
targets(
  ['workflow.approval.decide'],
  ['workflow_approval'],
  targetSchema(
    ['approvalId', 'decision'],
    [],
    { decision: ['approve', 'deny'] },
    { mode: 'field', field: 'approvalId' }
  )
)
targets(
  ['workflow.approval.consume'],
  ['workflow_approval'],
  targetSchema(
    ['approvalId', 'decision', 'recipeNamespace', 'recipeName'],
    [],
    { decision: ['approve'] },
    { mode: 'field', field: 'approvalId' }
  )
)
targets(
  ['gfs.read'],
  ['gfs_resource'],
  targetSchema(
    ['drive', 'resourceId'],
    ['canonicalPath'],
    {},
    { mode: 'field', field: 'resourceId' }
  )
)
targets(
  ['gfs.write'],
  ['gfs_resource'],
  targetSchema(
    ['drive', 'resourceId', 'action'],
    ['parentResourceId', 'canonicalPath', 'uploadId'],
    { action: ['create', 'update', 'upload', 'upload_part', 'finalize', 'copy', 'move'] },
    { mode: 'field', field: 'resourceId' }
  )
)
targets(
  ['gfs.delete'],
  ['gfs_resource'],
  targetSchema(['drive', 'resourceId'], [], {}, { mode: 'field', field: 'resourceId' })
)
targets(
  ['gfs.manage_acl'],
  ['gfs_resource'],
  targetSchema(
    ['drive', 'resourceId', 'action', 'subjectKey', 'permissions', 'inherit'],
    [],
    { action: ['grant', 'revoke'] },
    { mode: 'field', field: 'resourceId' }
  )
)
targets(
  ['gfs.share'],
  ['gfs_resource'],
  targetSchema(
    ['drive', 'resourceId', 'action'],
    ['shareId', 'permissions', 'includeDescendants'],
    { action: ['create', 'revoke'] },
    { mode: 'field', field: 'resourceId' }
  )
)
targets(
  ['shared_filesystem.read'],
  ['shared_filesystem'],
  targetSchema(
    [
      'sharedFileSystemNamespace',
      'sharedFileSystemName',
      'relationshipInstanceId',
      'canonicalRelativePath',
    ],
    [],
    {},
    {
      mode: 'namespaced_fields',
      namespaceField: 'sharedFileSystemNamespace',
      nameField: 'sharedFileSystemName',
    }
  )
)
targets(
  ['shared_filesystem.write'],
  ['shared_filesystem'],
  targetSchema(
    [
      'sharedFileSystemNamespace',
      'sharedFileSystemName',
      'relationshipInstanceId',
      'action',
      'canonicalRelativePath',
    ],
    ['destinationPath'],
    { action: ['upload', 'replace', 'mkdir', 'move', 'delete'] },
    {
      mode: 'namespaced_fields',
      namespaceField: 'sharedFileSystemNamespace',
      nameField: 'sharedFileSystemName',
    }
  )
)
targets(['sandbox.catalog.read'], ['sandbox_app'], noTarget)
targets(
  ['sandbox.open', 'sandbox.reconnect'],
  ['sandbox_app'],
  targetSchema(['recipeNamespace', 'recipeName'], [], {}, recipeBinding)
)
targets(
  ['sandbox.oauth.vend'],
  ['sandbox_app'],
  targetSchema(['recipeNamespace', 'recipeName', 'provider'], ['grantId'], {}, recipeBinding)
)
targets(
  ['sandbox.oauth.disconnect'],
  ['sandbox_app'],
  targetSchema(['recipeNamespace', 'recipeName', 'provider', 'grantId'], [], {}, recipeBinding)
)
targets(
  ['notification.read'],
  ['notification'],
  targetSchema([], ['notificationId'], {}, undefined, 'optional_object')
)

const wireRegistry = new Map(
  wireDefinitions.map(definition => [definition.operationId, definition])
)
if (
  wireRegistry.size !== ACTION_OPERATION_IDS.length ||
  ACTION_OPERATION_IDS.some(operationId => !wireRegistry.has(operationId))
) {
  throw new Error('action_operation_wire_registry_incomplete')
}

const ACTION_OPERATION_WIRE_DEFINITIONS = Object.freeze(
  ACTION_OPERATION_IDS.map(operationId => wireRegistry.get(operationId))
)

function getActionOperationWireDefinition(operationId) {
  const definition = wireRegistry.get(requireActionOperationId(operationId))
  if (!definition) throw new Error('action_operation_unknown')
  return definition
}

function validateOperationField(field, value) {
  if (UUID_FIELDS.has(field) && !UUID_PATTERN.test(value)) {
    throw new ActionOperationTargetError('invalid')
  }
  if (field === 'hostRef' && !NAMESPACED_REF_PATTERN.test(value)) {
    throw new ActionOperationTargetError('invalid')
  }
  if (DNS_COMPONENT_FIELDS.has(field) && !DNS_COMPONENT_PATTERN.test(value)) {
    throw new ActionOperationTargetError('invalid')
  }
  if (BOOLEAN_FIELDS.has(field) && value !== 'true' && value !== 'false') {
    throw new ActionOperationTargetError('invalid')
  }
}

function validateActionOperationTarget(input) {
  const definition = getActionOperationWireDefinition(input.operationId)
  if (
    !input.resource ||
    typeof input.resource !== 'object' ||
    typeof input.resource.type !== 'string' ||
    typeof input.resource.logicalId !== 'string' ||
    !definition.resourceTypes.includes(input.resource.type)
  ) {
    throw new ActionOperationTargetError('resource_mismatch')
  }
  const schema = definition.targetSchema
  if (schema.mode === 'none') {
    if (input.operationTarget !== undefined && input.operationTarget !== null) {
      throw new ActionOperationTargetError('unsupported')
    }
    return null
  }
  if (input.operationTarget === undefined || input.operationTarget === null) {
    if (schema.mode === 'optional_object') return null
    throw new ActionOperationTargetError('missing')
  }
  let target
  try {
    target = canonicalActionTarget(input.operationTarget)
  } catch {
    throw new ActionOperationTargetError('invalid')
  }
  if (!target) throw new ActionOperationTargetError('missing')
  const allowed = new Set([...schema.required, ...schema.optional])
  if (
    schema.required.some(field => !(field in target)) ||
    Object.keys(target).some(field => !allowed.has(field))
  ) {
    throw new ActionOperationTargetError('invalid')
  }
  for (const [field, value] of Object.entries(target)) {
    validateOperationField(field, value)
    const accepted = schema.enums[field]
    if (accepted && !accepted.includes(value)) throw new ActionOperationTargetError('invalid')
  }
  const binding = schema.resourceBinding
  if (binding) {
    const identity =
      binding.mode === 'field'
        ? target[binding.field]
        : `${target[binding.namespaceField]}/${target[binding.nameField]}`
    if (identity !== input.resource.logicalId) {
      throw new ActionOperationTargetError('resource_mismatch')
    }
  }
  return target
}

function boundedMcpComponent(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    !normalized ||
    normalized.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
  ) {
    return null
  }
  return normalized
}

function classifyMcpCallerOperation(input) {
  const serverNamespace = boundedMcpComponent(input && input.serverNamespace)
  const serverName = boundedMcpComponent(input && input.serverName)
  if (!serverNamespace || !serverName || typeof input.method !== 'string') {
    return Object.freeze({ status: 'denied', code: 'invalid_mcp_request' })
  }
  if (input.method === 'initialize' || input.method === 'notifications/initialized') {
    return Object.freeze({ status: 'denied', code: 'internal_protocol_method' })
  }
  if (input.method === 'tools/list') {
    return Object.freeze({
      status: 'classified',
      operationId: 'mcp.tools.read',
      target: Object.freeze({ serverName, serverNamespace }),
    })
  }
  if (input.method === 'tools/call') {
    const params = input.params
    const toolName =
      params &&
      typeof params === 'object' &&
      !Array.isArray(params) &&
      typeof params.name === 'string'
        ? params.name.trim()
        : ''
    if (
      !toolName ||
      toolName.length > MAX_TARGET_VALUE_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(toolName)
    ) {
      return Object.freeze({ status: 'denied', code: 'invalid_mcp_request' })
    }
    return Object.freeze({
      status: 'classified',
      operationId: 'mcp.invoke',
      target: Object.freeze({ serverName, serverNamespace, toolName }),
    })
  }
  return Object.freeze({ status: 'denied', code: 'unclassified_mcp_method' })
}

module.exports = {
  ACTION_CONTEXT_VERSION,
  ACTION_AUTHORITY_CHECKPOINT_PATH,
  ACTION_AUTHORITY_DESTINATION_KINDS,
  ACTION_BEHAVIOR_HASH_PREFIX,
  ACCESS_RESOURCE_TYPES,
  ACTION_OPERATION_IDS,
  ACTION_OPERATION_SCOPES,
  ACTION_OPERATION_SCOPE_PREFIX,
  ACTION_OPERATION_WIRE_DEFINITIONS,
  ACTION_TARGET_HASH_PREFIX,
  ActionTargetWireError,
  ActionOperationTargetError,
  ActionAuthorityCheckpointWireError,
  actionBehaviorBindingHash,
  actionOperationScope,
  canonicalActionBehaviorBinding,
  canonicalResourceIdentity,
  canonicalActionTarget,
  canonicalActionTargetJson,
  classifyMcpCallerOperation,
  getActionOperationWireDefinition,
  hashActionTarget,
  isActionOperationId,
  parseActionOperationScope,
  parseActionOperationScopes,
  isAccessResourceType,
  requireAccessResourceType,
  requireActionOperationId,
  validateActionOperationTarget,
  validateActionAuthorityCheckpointResponse,
  validateCanonicalResourceIdentity,
  validateLogicalResourceId,
}

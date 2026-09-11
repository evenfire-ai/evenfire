import { createHash, createHmac } from 'node:crypto'
import type { ClerumResourceType } from '../../types.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'

export const OPERATIONAL_SOURCE_FAMILIES = [
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'shared_filesystem',
] as const

export type OperationalSourceFamily = (typeof OPERATIONAL_SOURCE_FAMILIES)[number]
export type OperationalResourceType = OperationalSourceFamily | 'sandbox_app'

export type OperationalResourceRecord = Readonly<{
  environmentId: string
  resourceType: OperationalResourceType
  logicalId: string
  sourceFamily: OperationalSourceFamily
  providerUid: string
  providerResourceVersion: string
  displayName: string | null
  enabled: boolean
  deletedAt: string | null
  observedGeneration: number | null
  contentBytes: number
}>

export type OperationalRelationshipRecord = Readonly<{
  environmentId: string
  sourceType: OperationalResourceType
  sourceId: string
  relationshipType:
    | 'uses_context'
    | 'includes_mcp_server'
    | 'mounts_shared_filesystem'
    | 'exposes_sandbox_app'
  targetType: OperationalResourceType
  targetId: string
  relationshipInstanceId: string
  behaviorAttributes: Readonly<Record<string, string | number | boolean>>
  sourceFamily: OperationalSourceFamily
  sourceProviderUid: string
  sourceResourceVersion: string
  observedGeneration: number | null
  contentBytes: number
}>

export type OperationalObjectProjection = Readonly<{
  family: OperationalSourceFamily
  namespace: string
  rootType: OperationalResourceType
  rootId: string
  providerUid: string
  providerResourceVersion: string
  contentBytes: number
  resources: readonly OperationalResourceRecord[]
  relationships: readonly OperationalRelationshipRecord[]
}>

export class OperationalProjectionError extends Error {
  constructor(readonly code: string) {
    super(`Invalid operational resource projection: ${code}`)
    this.name = 'OperationalProjectionError'
  }
}

type ResourceObject = {
  metadata?: {
    name?: unknown
    namespace?: unknown
    uid?: unknown
    resourceVersion?: unknown
    generation?: unknown
    deletionTimestamp?: unknown
  }
  spec?: unknown
  status?: unknown
}

type ProjectionInput = Readonly<{
  environmentId: string
  plural: Extract<
    ClerumResourceType,
    'hosts' | 'contexts' | 'mcpservers' | 'workflowrecipes' | 'sharedfilesystems'
  >
  namespace: string
  object: unknown
  behaviorFingerprintKey: string
  maxObjectBytes?: number
  relationshipNamespaces: Readonly<{
    context: string
    mcpServer: string
    sharedFilesystem: string
  }>
}>

const FAMILY_BY_PLURAL: Readonly<Record<ProjectionInput['plural'], OperationalSourceFamily>> = {
  hosts: 'host',
  contexts: 'context',
  mcpservers: 'mcp_server',
  workflowrecipes: 'workflow_recipe',
  sharedfilesystems: 'shared_filesystem',
}

function requiredBoundedString(value: unknown, code: string, max = 512): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max || result.includes('\0')) {
    throw new OperationalProjectionError(code)
  }
  return result
}

function optionalBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result && result.length <= max && !result.includes('\0') ? result : null
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalUtf8Text(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function behaviorFingerprint(key: string, value: unknown): string {
  return createHmac('sha256', key).update(canonicalJson(value)).digest('base64url')
}

function relationshipInstanceId(parts: readonly string[]): string {
  return `rel1_${createHash('sha256').update(parts.join('\0')).digest('base64url')}`
}

function logicalId(family: OperationalSourceFamily, namespace: string, name: string): string {
  return `${namespace}/${name}`
}

function assertBoundedObjectShape(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const visited = new Set<object>()
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > 10_000 || current.depth > 32) {
      throw new OperationalProjectionError('object_shape_exceeded')
    }
    if (!current.value || typeof current.value !== 'object') continue
    if (visited.has(current.value)) throw new OperationalProjectionError('object_not_serializable')
    visited.add(current.value)
    const entries = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    if (entries.length > 2_048) throw new OperationalProjectionError('object_shape_exceeded')
    for (const child of entries) pending.push({ value: child, depth: current.depth + 1 })
  }
}

function contentBytes(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  try {
    assertBoundedObjectShape(value)
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > maximum) throw new OperationalProjectionError('object_bytes_exceeded')
    return bytes
  } catch (error) {
    if (error instanceof OperationalProjectionError) throw error
    throw new OperationalProjectionError('object_not_serializable')
  }
}

function displayName(family: OperationalSourceFamily, name: string, spec: Record<string, unknown>) {
  if (family === 'host') return optionalBoundedString(spec.host, 200) ?? name
  return optionalBoundedString(spec.displayName, 200) ?? name
}

function relationship(input: {
  environmentId: string
  sourceType: OperationalResourceType
  sourceId: string
  relationshipType: OperationalRelationshipRecord['relationshipType']
  targetType: OperationalResourceType
  targetId: string
  behaviorAttributes?: Record<string, string | number | boolean>
  instanceParts: readonly string[]
  family: OperationalSourceFamily
  providerUid: string
  providerResourceVersion: string
  observedGeneration: number | null
}): OperationalRelationshipRecord {
  const behaviorAttributes = Object.freeze({ ...(input.behaviorAttributes ?? {}) })
  return Object.freeze({
    environmentId: input.environmentId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    relationshipType: input.relationshipType,
    targetType: input.targetType,
    targetId: input.targetId,
    relationshipInstanceId: relationshipInstanceId(input.instanceParts),
    behaviorAttributes,
    sourceFamily: input.family,
    sourceProviderUid: input.providerUid,
    sourceResourceVersion: input.providerResourceVersion,
    observedGeneration: input.observedGeneration,
    contentBytes: contentBytes(behaviorAttributes),
  })
}

function stringArray(value: unknown, maxItems = 256): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    if (Array.isArray(value)) throw new OperationalProjectionError('relationship_fanout_exceeded')
    return []
  }
  return value.map((item, index) => requiredBoundedString(item, `relationship_${index}_invalid`))
}

function contextRelationships(params: {
  environmentId: string
  rootId: string
  spec: Record<string, unknown>
  family: OperationalSourceFamily
  providerUid: string
  providerResourceVersion: string
  observedGeneration: number | null
  relationshipNamespaces: ProjectionInput['relationshipNamespaces']
}): OperationalRelationshipRecord[] {
  const relationships = stringArray(params.spec.mcpServers).map(server =>
    relationship({
      ...params,
      sourceType: 'context',
      sourceId: params.rootId,
      relationshipType: 'includes_mcp_server',
      targetType: 'mcp_server',
      targetId: `${params.relationshipNamespaces.mcpServer}/${server}`,
      instanceParts: [
        'context',
        params.rootId,
        'mcp',
        `${params.relationshipNamespaces.mcpServer}/${server}`,
      ],
    })
  )
  const mounts = Array.isArray(params.spec.sharedFileSystems) ? params.spec.sharedFileSystems : []
  if (mounts.length > 256) throw new OperationalProjectionError('relationship_fanout_exceeded')
  for (const [index, value] of mounts.entries()) {
    const mount = objectRecord(value)
    const name = requiredBoundedString(mount.name, `shared_filesystem_${index}_name_invalid`)
    const mountPath = requiredBoundedString(
      mount.mountPath,
      `shared_filesystem_${index}_mount_path_invalid`,
      1_024
    )
    relationships.push(
      relationship({
        ...params,
        sourceType: 'context',
        sourceId: params.rootId,
        relationshipType: 'mounts_shared_filesystem',
        targetType: 'shared_filesystem',
        targetId: `${params.relationshipNamespaces.sharedFilesystem}/${name}`,
        behaviorAttributes: { mountPath, readOnly: true },
        instanceParts: [
          'context',
          params.rootId,
          'sfs',
          `${params.relationshipNamespaces.sharedFilesystem}/${name}`,
          mountPath,
        ],
      })
    )
  }
  return relationships
}

export function projectOperationalObject(input: ProjectionInput): OperationalObjectProjection {
  const raw = objectRecord(input.object) as ResourceObject
  const metadata = objectRecord(raw.metadata)
  const spec = objectRecord(raw.spec)
  const name = requiredBoundedString(metadata.name, 'metadata_name_invalid', 253)
  const namespace =
    optionalBoundedString(metadata.namespace, 253) ??
    requiredBoundedString(input.namespace, 'namespace_invalid', 253)
  if (namespace !== input.namespace) throw new OperationalProjectionError('namespace_mismatch')
  const providerUid = requiredBoundedString(metadata.uid, 'metadata_uid_invalid', 256)
  const providerResourceVersion = requiredBoundedString(
    metadata.resourceVersion,
    'metadata_resource_version_invalid',
    256
  )
  const family = FAMILY_BY_PLURAL[input.plural]
  const rootId = logicalId(family, namespace, name)
  const observedGeneration = boundedInteger(metadata.generation, 0, Number.MAX_SAFE_INTEGER)
  const deletedAt = optionalBoundedString(metadata.deletionTimestamp, 128)
  const encodedBytes = contentBytes(input.object, input.maxObjectBytes ?? 512 * 1024)
  const enabled = !deletedAt && spec.enabled !== false
  const root: OperationalResourceRecord = Object.freeze({
    environmentId: requiredBoundedString(input.environmentId, 'environment_id_invalid', 512),
    resourceType: family,
    logicalId: rootId,
    sourceFamily: family,
    providerUid,
    providerResourceVersion,
    displayName: displayName(family, name, spec),
    enabled,
    deletedAt,
    observedGeneration,
    contentBytes: encodedBytes,
  })
  const common = {
    environmentId: root.environmentId,
    rootId,
    family,
    providerUid,
    providerResourceVersion,
    observedGeneration,
  }
  const relationships: OperationalRelationshipRecord[] = []
  const resources: OperationalResourceRecord[] = [root]

  if (family === 'host' || family === 'mcp_server') {
    const contextRef = optionalBoundedString(spec.contextRef, 253)
    if (contextRef) {
      const model = objectRecord(spec.model)
      const behavior: Record<string, string | number | boolean> =
        family === 'host'
          ? {
              modelProvider: optionalBoundedString(model.provider, 100) ?? '',
              modelName: optionalBoundedString(model.name, 200) ?? '',
              executionPolicyFingerprint: behaviorFingerprint(input.behaviorFingerprintKey, {
                secretRef: optionalBoundedString(spec.secretRef, 253),
                allowedModels: spec.allowedModels ?? null,
              }),
            }
          : {}
      relationships.push(
        relationship({
          ...common,
          sourceType: family,
          sourceId: rootId,
          relationshipType: 'uses_context',
          targetType: 'context',
          targetId: `${input.relationshipNamespaces.context}/${contextRef}`,
          behaviorAttributes: behavior,
          instanceParts: [
            family,
            rootId,
            'context',
            `${input.relationshipNamespaces.context}/${contextRef}`,
          ],
        })
      )
    }
  } else if (family === 'context') {
    relationships.push(
      ...contextRelationships({
        ...common,
        spec,
        relationshipNamespaces: input.relationshipNamespaces,
      })
    )
  } else if (family === 'workflow_recipe') {
    const contextRef = optionalBoundedString(spec.contextRef, 253)
    if (contextRef) {
      relationships.push(
        relationship({
          ...common,
          sourceType: 'workflow_recipe',
          sourceId: rootId,
          relationshipType: 'uses_context',
          targetType: 'context',
          targetId: `${input.relationshipNamespaces.context}/${contextRef}`,
          behaviorAttributes: {
            runtimePolicyFingerprint: behaviorFingerprint(input.behaviorFingerprintKey, {
              runtimeEgress: spec.runtimeEgress ?? null,
            }),
          },
          instanceParts: [
            'workflow_recipe',
            rootId,
            'context',
            `${input.relationshipNamespaces.context}/${contextRef}`,
          ],
        })
      )
    }
    const ui = objectRecord(spec.ui)
    const workloadRef = optionalBoundedString(ui.workloadRef, 63)
    const port = boundedInteger(ui.port, 1, 65_535)
    if (workloadRef && port !== null) {
      const appId = rootId
      resources.push(
        Object.freeze({
          ...root,
          resourceType: 'sandbox_app',
          logicalId: appId,
          providerUid: `${providerUid}:ui`,
          displayName: optionalBoundedString(ui.title, 100) ?? name,
        })
      )
      relationships.push(
        relationship({
          ...common,
          sourceType: 'workflow_recipe',
          sourceId: rootId,
          relationshipType: 'exposes_sandbox_app',
          targetType: 'sandbox_app',
          targetId: appId,
          behaviorAttributes: {
            workloadRef,
            port,
            defaultPath: optionalBoundedString(ui.defaultPath, 1_024) ?? '/',
            runtimePolicyFingerprint: behaviorFingerprint(input.behaviorFingerprintKey, {
              workloadRef,
              port,
              runtimeEgress: spec.runtimeEgress ?? null,
              oauthClients: spec.oauthClients ?? null,
            }),
          },
          instanceParts: ['workflow_recipe', rootId, 'sandbox_app', appId, workloadRef],
        })
      )
    }
  }

  return Object.freeze({
    family,
    namespace,
    rootType: family,
    rootId,
    providerUid,
    providerResourceVersion,
    contentBytes: encodedBytes,
    resources: Object.freeze(resources),
    relationships: Object.freeze(relationships),
  })
}

export function canonicalEnvironmentId(env: NodeJS.ProcessEnv = process.env): string {
  const environment = env.TRACING_ENVIRONMENT?.trim() || 'development'
  const cluster =
    env.TRACING_CLUSTER_NAME?.trim() || env.KUBERNETES_CLUSTER_NAME?.trim() || 'local-cluster'
  return `${requiredBoundedString(environment, 'environment_name_invalid', 253)}:${requiredBoundedString(
    cluster,
    'cluster_name_invalid',
    253
  )}`
}

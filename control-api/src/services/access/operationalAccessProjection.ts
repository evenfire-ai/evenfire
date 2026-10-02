import { createHash, createHmac } from 'node:crypto'
import { enumerateHostModelReferences } from '../../routes/admin/hostModelReferences.js'
import type { ClerumResourceType } from '../../types.js'
import { readHostCodexConnectionRef } from '../codexSubscriptionConnection.js'
import { readHostGrokConnectionRef } from '../grokSubscriptionConnection.js'
import {
  collectHostOauthBrokerProviders,
  collectRecipeOauthBrokerProviders,
  readSubscriptionConnectionRef,
} from '../subscriptionGrantIdentity.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'

export type OperationalPolicySource = Readonly<{
  state: 'known' | 'unknown'
  fingerprint: string | null
}>

export type OperationalBehaviorSources = Readonly<{
  version: 1
  credentialPolicy: OperationalPolicySource
  credentialMode: string | null
  credentialPolicyConfigured: boolean | null
  credentialReferenceNames: readonly string[]
  credentialReferenceFingerprints: readonly string[]
  providerModelPolicy: OperationalPolicySource
  providerModelTargets: readonly Readonly<{ provider: string; model: string }>[]
  approvalPolicy: OperationalPolicySource
  approvalPolicyConfigured: boolean | null
  requiresApproval: boolean | null
  runtimePolicy: OperationalPolicySource
}>

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
  behaviorSources: OperationalBehaviorSources
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
    annotations?: unknown
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

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalProjectionError(code)
  }
  return value as Record<string, unknown>
}

function optionalArray(value: unknown, code: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new OperationalProjectionError(code)
  return value
}

function optionalRecord(value: unknown, code: string): Record<string, unknown> {
  return value === undefined ? {} : requiredRecord(value, code)
}

function optionalSpecString(
  spec: Record<string, unknown>,
  key: string,
  code: string
): string | null {
  if (spec[key] === undefined) return null
  const value = optionalBoundedString(spec[key], 253)
  if (!value) throw new OperationalProjectionError(code)
  return value
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

function referenceFingerprint(key: string, value: string): string {
  return behaviorFingerprint(key, ['secret-reference-v1', value])
}

export function secretReferenceFingerprint(key: string, value: string): string {
  return referenceFingerprint(key, value)
}

function secretReferenceIdentity(value: unknown): { name: string; identity: unknown } | null {
  if (typeof value === 'string') {
    const name = optionalBoundedString(value, 253)
    if (!name) throw new OperationalProjectionError('secret_reference_invalid')
    return { name, identity: { name } }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalProjectionError('secret_reference_invalid')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['name', 'namespace', 'key'].includes(key))) {
    throw new OperationalProjectionError('secret_reference_invalid')
  }
  const name = optionalBoundedString(record.name, 253)
  if (!name) throw new OperationalProjectionError('secret_reference_invalid')
  const identity: Record<string, string> = { name }
  for (const key of ['namespace', 'key']) {
    if (record[key] !== undefined) {
      const value = optionalBoundedString(record[key], 253)
      if (!value) throw new OperationalProjectionError('secret_reference_invalid')
      identity[key] = value
    }
  }
  return { name, identity }
}

function collectRecipeSecretReferences(
  spec: Record<string, unknown>
): Array<{ name: string; identity: unknown }> {
  const references: Array<{ name: string; identity: unknown }> = []
  const agent = objectRecord(spec.agent)
  const agentSecret =
    agent.secretRef === undefined ? null : secretReferenceIdentity(agent.secretRef)
  if (agentSecret) references.push(agentSecret)
  const steps = optionalArray(spec.steps, 'workflow_steps_invalid')
  for (const stepValue of steps) {
    const step = requiredRecord(stepValue, 'workflow_step_invalid')
    const run = objectRecord(step.run)
    const capabilities = objectRecord(run.capabilities)
    const secrets = optionalArray(capabilities.secrets, 'workflow_secrets_invalid')
    for (const secretValue of secrets) {
      const secret = requiredRecord(secretValue, 'workflow_secret_invalid')
      if (secret.secretRef !== undefined) {
        const reference = secretReferenceIdentity(secret.secretRef)
        if (reference) references.push(reference)
      }
    }
  }
  const clients = optionalArray(spec.oauthClients, 'workflow_oauth_clients_invalid')
  for (const clientValue of clients) {
    const client = requiredRecord(clientValue, 'workflow_oauth_client_invalid')
    for (const field of ['clientIdRef', 'clientSecretRef']) {
      if (client[field] !== undefined) {
        const reference = secretReferenceIdentity(client[field])
        if (reference) references.push(reference)
      }
    }
  }
  const unique = new Map(
    references.map(reference => [canonicalJson(reference.identity), reference])
  )
  return [...unique.entries()]
    .sort(([left], [right]) => compareCanonicalUtf8Text(left, right))
    .map(([, reference]) => reference)
}

function recipeModelTargets(
  spec: Record<string, unknown>
): Array<{ provider: string; model: string }> {
  const targets: Array<{ provider: string; model: string }> = []
  const addTarget = (value: unknown) => {
    const target = requiredRecord(value, 'workflow_model_target_invalid')
    const provider = optionalBoundedString(target.provider, 200)
    const model = optionalBoundedString(target.model, 400)
    if (!provider || !model) throw new OperationalProjectionError('workflow_model_target_invalid')
    targets.push({ provider, model })
  }
  if (spec.agent !== undefined) addTarget(spec.agent)
  const steps = optionalArray(spec.steps, 'workflow_steps_invalid')
  for (const stepValue of steps) {
    const step = requiredRecord(stepValue, 'workflow_step_invalid')
    if (step.agent !== undefined) addTarget(step.agent)
  }
  const unique = new Map(
    targets.map(target => [JSON.stringify([target.provider, target.model]), target])
  )
  return [...unique.entries()]
    .sort(([left], [right]) => compareCanonicalUtf8Text(left, right))
    .map(([, target]) => target)
}

function behaviorSources(input: {
  family: OperationalSourceFamily
  spec: Record<string, unknown>
  annotations: Record<string, string>
  behaviorFingerprintKey: string
}): OperationalBehaviorSources {
  const { family, spec, annotations, behaviorFingerprintKey: key } = input
  let credentialState: OperationalPolicySource['state'] = 'known'
  let authMode: string | null = null
  let references: string[] = []
  let referenceIdentities: unknown[] = []
  let credentialPolicyConfigured = true
  optionalSpecString(spec, 'contextRef', `${family}_context_ref_invalid`)
  if (family === 'host') {
    const secret = spec.secretRef === undefined ? null : optionalBoundedString(spec.secretRef, 253)
    if (spec.secretRef !== undefined && !secret) {
      throw new OperationalProjectionError('host_secret_ref_invalid')
    }
    if (secret) {
      references = [secret]
      referenceIdentities = [{ name: secret }]
    }
    authMode = secret ? 'host-secret-ref' : 'host-configured-no-secret-ref'
    const brokerProviders = collectHostOauthBrokerProviders(spec)
    if (brokerProviders.length > 1) credentialState = 'unknown'
    if (brokerProviders.length === 1) {
      const model = objectRecord(spec.model)
      const rawConnectionRef = model.connectionRef
      if (rawConnectionRef !== undefined && typeof rawConnectionRef !== 'string') {
        credentialState = 'unknown'
      } else {
        const provider = brokerProviders[0]!
        const connectionKey =
          provider === 'grok-subscription'
            ? readHostGrokConnectionRef(rawConnectionRef as string | undefined)
            : readHostCodexConnectionRef(rawConnectionRef as string | undefined)
        referenceIdentities.push({ kind: 'oauth-broker-grant', provider, connectionKey })
      }
    }
  } else if (family === 'mcp_server') {
    const auth = spec.auth === undefined ? {} : requiredRecord(spec.auth, 'mcp_auth_invalid')
    authMode = optionalBoundedString(auth.type, 64)
    if (!authMode) credentialState = 'unknown'
    if (auth.secretRef !== undefined) {
      if (typeof auth.secretRef !== 'string')
        throw new OperationalProjectionError('mcp_secret_ref_invalid')
      references.push(auth.secretRef)
      referenceIdentities.push({ name: auth.secretRef, key: auth.secretKey ?? null })
    }
    const oauth = optionalRecord(spec.oauth, 'mcp_oauth_invalid')
    if (auth.secretKey !== undefined && !optionalBoundedString(auth.secretKey, 253)) {
      throw new OperationalProjectionError('mcp_secret_key_invalid')
    }
    for (const field of ['clientIdRef', 'clientSecretRef']) {
      if (oauth[field] !== undefined) {
        const reference = secretReferenceIdentity(oauth[field])
        if (reference) {
          references.push(reference.name)
          referenceIdentities.push(reference.identity)
        }
      }
    }
    credentialPolicyConfigured = authMode === 'none' && references.length === 0 ? false : true
  } else if (family === 'workflow_recipe') {
    const recipeReferences = collectRecipeSecretReferences(spec)
    references = recipeReferences.map(reference => reference.name)
    referenceIdentities = recipeReferences.map(reference => reference.identity)
    for (const provider of collectRecipeOauthBrokerProviders(spec)) {
      const relevantKeys =
        provider === 'codex-subscription'
          ? ['clerum.io/codex-connection-ref', 'clerum.io/subscription-connection-ref']
          : ['clerum.io/subscription-connection-ref', 'clerum.io/codex-connection-ref']
      if (
        relevantKeys.some(
          key => annotations[key] !== undefined && typeof annotations[key] !== 'string'
        )
      ) {
        credentialState = 'unknown'
        continue
      }
      const grant = readSubscriptionConnectionRef({ provider, annotations })
      if (!grant.ok) {
        credentialState = 'unknown'
        continue
      }
      referenceIdentities.push({
        kind: 'oauth-broker-grant',
        provider,
        connectionKey: grant.connectionKey,
      })
    }
    authMode = 'workflow-recipe-config'
    optionalRecord(spec.gfs, 'workflow_gfs_policy_invalid')
  } else {
    authMode = 'no-resource-credential-policy'
    credentialPolicyConfigured = false
  }
  references = [...new Set(references)].sort(compareCanonicalUtf8Text)
  referenceIdentities = [...new Set(referenceIdentities.map(canonicalJson))].sort(
    compareCanonicalUtf8Text
  )

  if (family === 'host') {
    if (spec.model !== undefined) {
      const model = requiredRecord(spec.model, 'host_model_invalid')
      if (!optionalBoundedString(model.provider, 100) || !optionalBoundedString(model.name, 200)) {
        throw new OperationalProjectionError('host_model_invalid')
      }
    }
    const allowedModels = optionalArray(spec.allowedModels, 'host_allowed_models_invalid')
    for (const value of allowedModels) {
      const model = requiredRecord(value, 'host_allowed_model_invalid')
      if (!optionalBoundedString(model.provider, 100) || !optionalBoundedString(model.model, 200)) {
        throw new OperationalProjectionError('host_allowed_model_invalid')
      }
    }
    if (spec.llmPolicy !== undefined) {
      const llmPolicy = requiredRecord(spec.llmPolicy, 'host_llm_policy_invalid')
      const fallbacks = optionalArray(llmPolicy.fallbacks, 'host_llm_fallbacks_invalid')
      for (const value of fallbacks) {
        const fallback = requiredRecord(value, 'host_llm_fallback_invalid')
        if (
          !optionalBoundedString(fallback.provider, 100) ||
          !optionalBoundedString(fallback.model, 200)
        ) {
          throw new OperationalProjectionError('host_llm_fallback_invalid')
        }
      }
    }
  }
  const hostTargets = family === 'host' ? enumerateHostModelReferences(spec) : []
  const providerModelTargets =
    family === 'host'
      ? hostTargets.map(({ provider, model }) => ({ provider, model }))
      : family === 'workflow_recipe'
        ? recipeModelTargets(spec)
        : []
  const approvalRequired =
    family === 'workflow_recipe'
      ? optionalRecord(
          optionalRecord(spec.triggers, 'workflow_triggers_invalid').onDemand,
          'workflow_on_demand_invalid'
        ).requiresApproval === true
      : null
  let approvalPolicyConfigured = false
  let approvalPolicyValue: unknown = null
  if (family === 'host' && spec.approval !== undefined) {
    approvalPolicyValue = requiredRecord(spec.approval, 'host_approval_policy_invalid')
    approvalPolicyConfigured = true
  } else if (family === 'workflow_recipe') {
    const triggers = optionalRecord(spec.triggers, 'workflow_triggers_invalid')
    const onDemand = optionalRecord(triggers.onDemand, 'workflow_on_demand_invalid')
    const steps = optionalArray(spec.steps, 'workflow_steps_invalid')
    approvalPolicyConfigured =
      Object.prototype.hasOwnProperty.call(onDemand, 'requiresApproval') ||
      steps.some(value =>
        Object.prototype.hasOwnProperty.call(
          requiredRecord(value, 'workflow_step_invalid'),
          'requiresApproval'
        )
      )
    approvalPolicyValue = {
      onDemandRequiresApproval: approvalRequired,
      stepApprovalPolicies: steps.map(value => objectRecord(value).requiresApproval ?? null),
    }
  }
  const approvalPolicyFingerprint = approvalPolicyConfigured
    ? behaviorFingerprint(key, {
        family,
        policy: approvalPolicyValue,
      })
    : behaviorFingerprint(key, ['source-proven-no-general-approval-policy', family])
  const runtimePolicy = {
    family,
    contextRef: spec.contextRef ?? null,
    ...(family === 'host'
      ? {
          model: spec.model ?? null,
          allowedModels: spec.allowedModels ?? null,
          llmPolicy: spec.llmPolicy ?? null,
        }
      : {}),
    ...(family === 'context'
      ? { mcpServers: spec.mcpServers ?? null, sharedFileSystems: spec.sharedFileSystems ?? null }
      : {}),
    ...(family === 'mcp_server'
      ? {
          enabled: spec.enabled ?? null,
          transport: spec.transport ?? null,
          egressBindings: spec.egressBindings ?? null,
        }
      : {}),
    ...(family === 'workflow_recipe'
      ? { runtimeEgress: spec.runtimeEgress ?? null, ui: spec.ui ?? null, gfs: spec.gfs ?? null }
      : {}),
  }
  return Object.freeze({
    version: 1,
    credentialPolicy: Object.freeze({
      state: credentialState,
      fingerprint:
        credentialState === 'known'
          ? behaviorFingerprint(key, { family, authMode, referenceIdentities })
          : null,
    }),
    credentialMode: authMode,
    credentialPolicyConfigured,
    credentialReferenceNames: Object.freeze(references),
    credentialReferenceFingerprints: Object.freeze(
      referenceIdentities.map(reference => referenceFingerprint(key, canonicalJson(reference)))
    ),
    providerModelPolicy: Object.freeze({
      state: 'known',
      fingerprint: behaviorFingerprint(key, { family, providerModelTargets }),
    }),
    providerModelTargets: Object.freeze(providerModelTargets),
    approvalPolicy: Object.freeze({ state: 'known', fingerprint: approvalPolicyFingerprint }),
    approvalPolicyConfigured,
    requiresApproval: approvalRequired,
    runtimePolicy: Object.freeze({
      state: 'known',
      fingerprint: behaviorFingerprint(key, runtimePolicy),
    }),
  })
}

export function relationshipInstanceId(parts: readonly string[]): string {
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
  if (!Array.isArray(value)) throw new OperationalProjectionError('relationship_array_invalid')
  if (value.length > maxItems) throw new OperationalProjectionError('relationship_fanout_exceeded')
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
  const relationships = stringArray(
    params.spec.mcpServers === undefined ? [] : params.spec.mcpServers
  ).map(server =>
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
  const mounts = optionalArray(params.spec.sharedFileSystems, 'shared_filesystems_invalid')
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
  const spec = requiredRecord(raw.spec, 'spec_invalid')
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
  const rawAnnotations = metadata.annotations
  if (
    rawAnnotations !== undefined &&
    (!rawAnnotations || typeof rawAnnotations !== 'object' || Array.isArray(rawAnnotations))
  ) {
    throw new OperationalProjectionError('metadata_annotations_invalid')
  }
  const annotations: Record<string, string> = {}
  for (const [key, value] of Object.entries(objectRecord(rawAnnotations))) {
    if (typeof value !== 'string') {
      throw new OperationalProjectionError('metadata_annotation_value_invalid')
    }
    annotations[key] = value
  }
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
    behaviorSources: behaviorSources({
      family,
      spec,
      annotations,
      behaviorFingerprintKey: input.behaviorFingerprintKey,
    }),
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

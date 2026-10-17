import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { ClerumResourceType } from '../../types.js'
import type { OperationalPathBinding } from './accessAuthorityStore.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { projectOperationalObject } from './operationalAccessProjection.js'

type ExactGateway = Pick<K8sGateway, 'getResourceExact'>

type ExactBindingSpec = Readonly<{
  plural: Extract<
    ClerumResourceType,
    'hosts' | 'contexts' | 'mcpservers' | 'workflowrecipes' | 'sharedfilesystems'
  >
  namespace: string
}>

const BINDING_SPECS: Readonly<Record<OperationalPathBinding['resourceType'], ExactBindingSpec>> =
  Object.freeze({
    host: { plural: 'hosts', namespace: config.hostsNamespace },
    context: { plural: 'contexts', namespace: config.contextsNamespace },
    mcp_server: { plural: 'mcpservers', namespace: config.mcpServersNamespace },
    workflow_recipe: { plural: 'workflowrecipes', namespace: config.sandboxNamespace },
    shared_filesystem: {
      plural: 'sharedfilesystems',
      namespace: config.sharedFilesystemsNamespace,
    },
  })

function scopedName(logicalId: string): { namespace: string; name: string } | null {
  const separator = logicalId.indexOf('/')
  if (separator < 1 || separator === logicalId.length - 1) return null
  return { namespace: logicalId.slice(0, separator), name: logicalId.slice(separator + 1) }
}

function canonicalBehavior(value: Readonly<Record<string, string | number | boolean>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  )
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as Record<string, unknown>
  return value.httpStatus === 404 || value.statusCode === 404 || value.code === 404
}

export type ExactOperationalAuthorizationResult =
  | Readonly<{ status: 'current' }>
  | Readonly<{ status: 'stale' | 'not_found' }>
  | Readonly<{ status: 'unavailable' }>

export async function validateExactOperationalBindings(input: {
  gateway: ExactGateway | undefined
  budget: AccessExecutionBudget
  bindings: readonly OperationalPathBinding[]
}): Promise<ExactOperationalAuthorizationResult> {
  if (input.bindings.length === 0) return { status: 'current' }
  if (!input.gateway) return { status: 'unavailable' }
  const unique = new Map<string, OperationalPathBinding>()
  for (const binding of input.bindings) {
    unique.set(JSON.stringify([binding.resourceType, binding.logicalId]), binding)
  }
  if (unique.size > input.budget.limits.exactKubernetesGets) {
    return { status: 'unavailable' }
  }
  for (const binding of unique.values()) {
    const identity = scopedName(binding.logicalId)
    const spec = BINDING_SPECS[binding.resourceType]
    if (!identity || identity.namespace !== spec.namespace) return { status: 'stale' }
    input.budget.charge({ kind: 'exactKubernetesGets' })
    try {
      const timeoutSeconds = Math.max(
        1,
        Math.min(60, Math.ceil(input.budget.remainingMs() / 1_000))
      )
      const object = await input.budget.runProducer(signal =>
        input.gateway!.getResourceExact(spec.plural, identity.name, identity.namespace, {
          timeoutSeconds,
          signal,
        })
      )
      const projection = projectOperationalObject({
        environmentId: 'exact-validation',
        plural: spec.plural,
        namespace: identity.namespace,
        object,
        behaviorFingerprintKey: config.sessionJwtPrivateKey,
        maxObjectBytes: input.budget.limits.objectBytes,
        relationshipNamespaces: {
          context: config.contextsNamespace,
          mcpServer: config.mcpServersNamespace,
          sharedFilesystem: config.sharedFilesystemsNamespace,
        },
      })
      input.budget.chargeOperationalObject(projection.contentBytes, true)
      const root = projection.resources.find(
        resource =>
          resource.resourceType === binding.resourceType && resource.logicalId === binding.logicalId
      )
      if (!root || !root.enabled || root.deletedAt) return { status: 'not_found' }
      if (root.providerUid !== binding.providerUid) return { status: 'stale' }
      for (const expected of binding.relationships) {
        const current = projection.relationships.find(
          relationship => relationship.relationshipInstanceId === expected.instanceId
        )
        if (
          !current ||
          canonicalBehavior(current.behaviorAttributes) !==
            canonicalBehavior(expected.behaviorAttributes)
        ) {
          return { status: 'stale' }
        }
      }
    } catch (error) {
      return isNotFound(error) ? { status: 'not_found' } : { status: 'unavailable' }
    }
  }
  return { status: 'current' }
}

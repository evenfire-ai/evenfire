import { config } from '../config.js'
import type { ClerumResourceType } from '../types.js'

export type SecretReferenceState = 'referenced' | 'not-referenced' | 'unknown'

export type SecretReferenceReader = {
  listResource: (plural: ClerumResourceType, namespace?: string) => Promise<unknown[]>
}

export const SECRET_REFERENCE_CONTRACT_ANNOTATION = 'clerum.io/secret-reference-contract'
export const SECRET_REFERENCE_CONTRACT_VERSION = 1

/**
 * Namespace resolution is part of a Secret reference's meaning. A matching
 * name in another namespace is not a dependency and must not block a safe
 * rollback.
 */
export type SecretReferenceNamespaceBinding =
  | 'resource'
  | 'host-secret'
  | 'reference-value'
  | 'workflow-recipe'
  | 'workflow-workload'

export type SecretReferenceFieldContract = {
  path: string
  namespaceBinding: SecretReferenceNamespaceBinding
}

export type SecretReferenceCrdContract = {
  plural: string
  fields: readonly SecretReferenceFieldContract[]
}

/**
 * Runtime source of truth for Secret consumers. Each CRD carries the same
 * versioned contract in metadata.annotations so schema changes cannot silently
 * expand or shrink this cleanup boundary.
 *
 * Do not add a generic `*Ref` traversal here. Some CRDs expose ordinary
 * resource references with the same shape, and treating those as Secret
 * consumers would retain unrelated objects during compensation.
 */
export const SECRET_REFERENCE_CRD_CONTRACTS = [
  {
    plural: 'communicationchannels',
    fields: [{ path: 'spec.credentialsSecretRef', namespaceBinding: 'resource' }],
  },
  { plural: 'contexts', fields: [] },
  { plural: 'globalfilesystems', fields: [] },
  {
    plural: 'hosts',
    fields: [{ path: 'spec.secretRef', namespaceBinding: 'host-secret' }],
  },
  {
    plural: 'llmhooks',
    fields: [
      { path: 'spec.target.image.imagePullSecrets', namespaceBinding: 'resource' },
      { path: 'spec.target.image.envSecret', namespaceBinding: 'resource' },
      { path: 'spec.target.remote.authHeadersSecret', namespaceBinding: 'resource' },
    ],
  },
  {
    plural: 'mcpservers',
    fields: [
      { path: 'spec.auth.secretRef', namespaceBinding: 'resource' },
      { path: 'spec.envSecret', namespaceBinding: 'resource' },
      { path: 'spec.imagePullSecrets', namespaceBinding: 'resource' },
    ],
  },
  { plural: 'sharedfilesystems', fields: [] },
  { plural: 'workflowrecipepolicies', fields: [] },
  {
    plural: 'workflowrecipes',
    fields: [
      {
        path: 'spec.agent.secretRef',
        namespaceBinding: 'reference-value',
      },
      {
        path: 'spec.steps[].run.capabilities.secrets[].secretRef',
        namespaceBinding: 'workflow-recipe',
      },
      { path: 'spec.workloads[].envSecret', namespaceBinding: 'workflow-workload' },
      {
        path: 'spec.workloads[].imagePullSecrets',
        namespaceBinding: 'workflow-workload',
      },
      {
        path: 'spec.oauthClients[].clientIdRef',
        namespaceBinding: 'workflow-recipe',
      },
      {
        path: 'spec.oauthClients[].clientSecretRef',
        namespaceBinding: 'workflow-recipe',
      },
      {
        path: 'spec.webhooks[].verification.secretRef',
        namespaceBinding: 'workflow-recipe',
      },
      {
        path: 'spec.webhooks[].verification.setupHandshake.secretRef',
        namespaceBinding: 'workflow-recipe',
      },
    ],
  },
] as const satisfies readonly SecretReferenceCrdContract[]

type ReferenceScope = {
  plural: ClerumResourceType
  resourceNamespace: string
  fields: readonly SecretReferenceFieldContract[]
}

function fieldsFor(plural: string): readonly SecretReferenceFieldContract[] {
  const contract = SECRET_REFERENCE_CRD_CONTRACTS.find(candidate => candidate.plural === plural)
  if (!contract) throw new Error(`Missing Secret reference contract for CRD plural "${plural}"`)
  return contract.fields
}

export const SECRET_REFERENCE_SCOPES = [
  {
    plural: 'mcpservers',
    resourceNamespace: config.mcpServersNamespace,
    fields: fieldsFor('mcpservers'),
  },
  {
    plural: 'llmhooks',
    resourceNamespace: config.llmHooksNamespace,
    fields: fieldsFor('llmhooks'),
  },
  {
    plural: 'workflowrecipes',
    resourceNamespace: config.sandboxNamespace,
    fields: fieldsFor('workflowrecipes'),
  },
  {
    plural: 'hosts',
    resourceNamespace: config.hostsNamespace,
    fields: fieldsFor('hosts'),
  },
  {
    plural: 'communicationchannels',
    resourceNamespace: config.communicationChannelsNamespace,
    fields: fieldsFor('communicationchannels'),
  },
] as const satisfies readonly ReferenceScope[]

const WORKFLOW_WORKLOAD_PATH_PREFIX = 'spec.workloads[].'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valuesAtPath(value: unknown, path: string): unknown[] {
  let values: unknown[] = [value]

  for (const token of path.split('.')) {
    const isArray = token.endsWith('[]')
    const key = isArray ? token.slice(0, -2) : token

    values = values.flatMap(current => {
      if (!isRecord(current) || !Object.hasOwn(current, key)) return []
      const child = current[key]
      if (isArray) return Array.isArray(child) ? child : []
      return [child]
    })
  }

  return values
}

function referenceValueMatches(value: unknown, name: string): boolean {
  if (typeof value === 'string') return value === name
  if (Array.isArray(value)) return value.some(item => referenceValueMatches(item, name))
  return isRecord(value) && value.name === name
}

function workflowWorkloadNamespace(
  workload: Record<string, unknown>,
  uiWorkloadRef: string | undefined
): string {
  // Keep this three-way split aligned with the WorkflowRecipe runtime's
  // resolveWorkloadNamespace contract: transport → mcp-server, UI →
  // sandbox-ui, all other workloads → sandbox-recipes.
  if (workload.transport !== undefined && workload.transport !== null) {
    return config.mcpServersNamespace
  }
  if (uiWorkloadRef && workload.id === uiWorkloadRef) return config.sandboxUiNamespace
  return config.sandboxNamespace
}

function workflowWorkloadReferenceMatches(
  resource: unknown,
  field: SecretReferenceFieldContract,
  name: string,
  namespace: string
): boolean {
  if (!field.path.startsWith(WORKFLOW_WORKLOAD_PATH_PREFIX)) {
    throw new Error(`Invalid workflow-workload Secret reference path "${field.path}"`)
  }

  const [uiWorkloadRef] = valuesAtPath(resource, 'spec.ui.workloadRef')
  const uiRef = typeof uiWorkloadRef === 'string' ? uiWorkloadRef : undefined
  const relativePath = field.path.slice(WORKFLOW_WORKLOAD_PATH_PREFIX.length)

  return valuesAtPath(resource, 'spec.workloads[]').some(workload => {
    if (!isRecord(workload) || workflowWorkloadNamespace(workload, uiRef) !== namespace)
      return false
    return valuesAtPath(workload, relativePath).some(value => referenceValueMatches(value, name))
  })
}

function namespaceBindingApplies(
  binding: SecretReferenceNamespaceBinding,
  resourceNamespace: string,
  namespace: string
): boolean {
  switch (binding) {
    case 'resource':
      return resourceNamespace === namespace
    case 'host-secret':
      return config.secretsNamespace === namespace
    case 'reference-value':
      return [
        config.secretsNamespace,
        config.sandboxNamespace,
        config.mcpServersNamespace,
        config.sandboxUiNamespace,
        config.llmHooksNamespace,
        config.communicationChannelsNamespace,
      ].includes(namespace)
    case 'workflow-recipe':
      return config.sandboxNamespace === namespace
    case 'workflow-workload':
      return (
        namespace === config.sandboxNamespace ||
        namespace === config.mcpServersNamespace ||
        namespace === config.sandboxUiNamespace
      )
  }
}

function fieldReferencesSecret(
  resource: unknown,
  field: SecretReferenceFieldContract,
  name: string,
  namespace: string
): boolean {
  if (field.namespaceBinding === 'reference-value') {
    return valuesAtPath(resource, field.path).some(value => {
      if (typeof value === 'string') {
        return value === name && namespace === config.secretsNamespace
      }
      if (!isRecord(value) || value.name !== name) return false
      const referencedNamespace =
        typeof value.namespace === 'string' && value.namespace.trim()
          ? value.namespace
          : config.secretsNamespace
      return referencedNamespace === namespace
    })
  }
  if (field.namespaceBinding === 'workflow-workload') {
    return workflowWorkloadReferenceMatches(resource, field, name, namespace)
  }
  return valuesAtPath(resource, field.path).some(value => referenceValueMatches(value, name))
}

function validateRuntimeContract(): void {
  const declaredPlurals = new Set<string>()
  for (const contract of SECRET_REFERENCE_CRD_CONTRACTS) {
    if (declaredPlurals.has(contract.plural)) {
      throw new Error(`Duplicate Secret reference contract for CRD plural "${contract.plural}"`)
    }
    declaredPlurals.add(contract.plural)
  }

  for (const scope of SECRET_REFERENCE_SCOPES) {
    for (const field of scope.fields) {
      if (
        field.namespaceBinding === 'workflow-workload' &&
        !field.path.startsWith(WORKFLOW_WORKLOAD_PATH_PREFIX)
      ) {
        throw new Error(`Invalid workflow-workload Secret reference path "${field.path}"`)
      }
    }
  }
}

validateRuntimeContract()

/**
 * Check every CRD family that can consume a namespaced Secret. A failed list is
 * deliberately `unknown`: compensation must preserve the object when the
 * reference graph cannot be observed completely.
 */
export async function findSecretReferenceState(
  reader: SecretReferenceReader,
  name: string,
  namespace: string
): Promise<SecretReferenceState> {
  const applicableScopes = SECRET_REFERENCE_SCOPES.map(scope => ({
    ...scope,
    fields: scope.fields.filter(field =>
      namespaceBindingApplies(field.namespaceBinding, scope.resourceNamespace, namespace)
    ),
  })).filter(scope => scope.fields.length > 0)

  if (applicableScopes.length === 0) return 'unknown'

  try {
    const resourceLists = await Promise.all(
      applicableScopes.map(scope => reader.listResource(scope.plural, scope.resourceNamespace))
    )
    for (const [index, resources] of resourceLists.entries()) {
      const { fields } = applicableScopes[index]
      if (
        resources.some(resource =>
          fields.some(field => fieldReferencesSecret(resource, field, name, namespace))
        )
      ) {
        return 'referenced'
      }
    }
    return 'not-referenced'
  } catch {
    return 'unknown'
  }
}

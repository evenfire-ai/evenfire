import { config } from '../config.js'
import type { ClerumResourceType } from '../types.js'

export type SecretReferenceState = 'referenced' | 'not-referenced' | 'unknown'

export type SecretReferenceReader = {
  listResource: (plural: ClerumResourceType, namespace?: string) => Promise<unknown[]>
}

type ReferenceScope = {
  plural: ClerumResourceType
  resourceNamespace: string
  secretNamespace: string
}

const REFERENCE_SCOPES: ReferenceScope[] = [
  {
    plural: 'mcpservers',
    resourceNamespace: config.mcpServersNamespace,
    secretNamespace: config.mcpServersNamespace,
  },
  {
    plural: 'llmhooks',
    resourceNamespace: config.llmHooksNamespace,
    secretNamespace: config.llmHooksNamespace,
  },
  {
    plural: 'workflowrecipes',
    resourceNamespace: config.sandboxNamespace,
    secretNamespace: config.sandboxNamespace,
  },
  {
    plural: 'hosts',
    resourceNamespace: config.hostsNamespace,
    secretNamespace: config.secretsNamespace,
  },
  {
    plural: 'communicationchannels',
    resourceNamespace: config.communicationChannelsNamespace,
    secretNamespace: config.communicationChannelsNamespace,
  },
]

const REFERENCE_KEYS = new Set(['credentialsSecretRef', 'envSecret', 'secretRef'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function referenceValueMatches(value: unknown, name: string): boolean {
  if (typeof value === 'string') return value === name
  if (!isRecord(value)) return false
  return value.name === name
}

function containsSecretReference(value: unknown, name: string, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) {
    return value.some(item => containsSecretReference(item, name, seen))
  }

  return Object.entries(value).some(([key, child]) => {
    if (REFERENCE_KEYS.has(key) && referenceValueMatches(child, name)) return true
    return containsSecretReference(child, name, seen)
  })
}

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
  const scopes = REFERENCE_SCOPES.filter(scope => scope.secretNamespace === namespace)
  if (scopes.length === 0) return 'unknown'

  try {
    const resourceLists = await Promise.all(
      scopes.map(scope => reader.listResource(scope.plural, scope.resourceNamespace))
    )
    for (const resources of resourceLists) {
      if (
        resources.some(resource =>
          containsSecretReference((resource as { spec?: unknown }).spec, name)
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

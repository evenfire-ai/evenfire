import type { DbClient } from '../db.js'
import { pool } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import {
  CODEX_CONNECTION_REF_ANNOTATION,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  getSafeCodexSubscriptionConnection,
  isCodexUnassignedConnectionKey,
  readHostCodexConnectionRef,
} from './codexSubscriptionConnection.js'
import { K8sConflictError } from './resourceService.js'

export class RecipeCodexGrantIdentityError extends Error {
  constructor(
    readonly status: 409 | 422 | 503,
    readonly error: string,
    message: string
  ) {
    super(message)
    this.name = 'RecipeCodexGrantIdentityError'
  }
}

export function readRecipeGrantIdentity(annotations?: Record<string, string> | null): string {
  return readHostCodexConnectionRef(annotations?.[CODEX_CONNECTION_REF_ANNOTATION])
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

export async function publishRecipeGrantIdentity(input: {
  gateway: Pick<K8sGateway, 'getResource' | 'updateResource'>
  namespace: string
  name: string
  next: string
  db?: DbClient
}): Promise<{ published: string; resourceVersion?: string; noop: boolean }> {
  const next = isCodexUnassignedConnectionKey(input.next)
    ? CODEX_UNASSIGNED_CONNECTION_KEY
    : input.next.trim()
  if (next !== CODEX_UNASSIGNED_CONNECTION_KEY) {
    const live = await getSafeCodexSubscriptionConnection(input.db ?? pool, next)
    if (!live) {
      throw new RecipeCodexGrantIdentityError(
        422,
        'codex_connection_not_allowed',
        'Codex grant is not a live connection'
      )
    }
  }

  let current: {
    metadata?: { annotations?: unknown; resourceVersion?: string; labels?: unknown }
    spec?: unknown
  }
  try {
    current = (await input.gateway.getResource('workflowrecipes', input.name, input.namespace)) as {
      metadata?: { annotations?: unknown; resourceVersion?: string; labels?: unknown }
      spec?: unknown
    }
  } catch (err) {
    throw new RecipeCodexGrantIdentityError(
      503,
      'recipe_annotation_publish_failed',
      err instanceof Error ? err.message : 'failed to read WorkflowRecipe'
    )
  }

  const annotations = stringMap(current.metadata?.annotations)
  const previous = readRecipeGrantIdentity(annotations)
  if (previous === next) {
    return { published: next, resourceVersion: current.metadata?.resourceVersion, noop: true }
  }

  const nextAnnotations = {
    ...annotations,
    [CODEX_CONNECTION_REF_ANNOTATION]: next === CODEX_UNASSIGNED_CONNECTION_KEY ? '' : next,
  }
  const spec = asRecord(current.spec) ?? {}
  try {
    await input.gateway.updateResource(
      'workflowrecipes',
      input.name,
      {
        metadata: {
          ...(stringMap(current.metadata?.labels)
            ? { labels: stringMap(current.metadata?.labels) }
            : {}),
          annotations: nextAnnotations,
          ...(current.metadata?.resourceVersion
            ? { resourceVersion: current.metadata.resourceVersion }
            : {}),
        },
        spec,
      },
      input.namespace
    )
  } catch (err) {
    if (err instanceof K8sConflictError) {
      throw new RecipeCodexGrantIdentityError(
        409,
        'conflict',
        'WorkflowRecipe was modified while publishing the Codex grant'
      )
    }
    throw new RecipeCodexGrantIdentityError(
      503,
      'recipe_annotation_publish_failed',
      err instanceof Error ? err.message : 'failed to publish Codex grant annotation'
    )
  }
  return { published: next, resourceVersion: current.metadata?.resourceVersion, noop: false }
}

import type { DbClient } from '../db.js'
import { pool } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import {
  CODEX_CONNECTION_REF_ANNOTATION,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  getSafeCodexSubscriptionConnection,
  isCodexUnassignedConnectionKey,
} from './codexSubscriptionConnection.js'
import {
  GROK_UNASSIGNED_CONNECTION_KEY,
  getSafeGrokSubscriptionConnection,
  isGrokUnassignedConnectionKey,
} from './grokSubscriptionConnection.js'
import { K8sConflictError } from './resourceService.js'
import {
  SUBSCRIPTION_CONNECTION_REF_ANNOTATION,
  collectRecipeOauthBrokerProviders,
  readSubscriptionConnectionRef,
} from './subscriptionGrantIdentity.js'

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
  const result = readSubscriptionConnectionRef({
    provider: 'codex-subscription',
    annotations,
  })
  if (!result.ok) {
    throw new RecipeCodexGrantIdentityError(
      422,
      'subscription_annotations_disagree',
      result.message
    )
  }
  return result.connectionKey
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
  provider?: string
}): Promise<{ published: string; resourceVersion?: string; noop: boolean }> {
  const grok = input.provider === 'grok-subscription'
  const unassignedKey = grok ? GROK_UNASSIGNED_CONNECTION_KEY : CODEX_UNASSIGNED_CONNECTION_KEY
  const next = grok
    ? isGrokUnassignedConnectionKey(input.next) || !input.next.trim()
      ? GROK_UNASSIGNED_CONNECTION_KEY
      : input.next.trim()
    : isCodexUnassignedConnectionKey(input.next)
      ? CODEX_UNASSIGNED_CONNECTION_KEY
      : input.next.trim()
  if (next !== unassignedKey) {
    const live = grok
      ? await getSafeGrokSubscriptionConnection(input.db ?? pool, next)
      : await getSafeCodexSubscriptionConnection(input.db ?? pool, next)
    if (!live) {
      throw new RecipeCodexGrantIdentityError(
        422,
        grok ? 'grok_connection_not_allowed' : 'codex_connection_not_allowed',
        grok ? 'Grok grant is not a live connection' : 'Codex grant is not a live connection'
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

  const provider = grok ? 'grok-subscription' : 'codex-subscription'
  // The recipe's agent / step agents own the grant annotations when they name
  // an oauth-broker. Publishing another broker's identity would rewrite the
  // agent grant (e.g. a Grok SDK key read back as the Codex agent's key).
  const agentBrokers = collectRecipeOauthBrokerProviders(asRecord(current.spec) ?? {})
  if (agentBrokers.length > 0 && !agentBrokers.includes(provider)) {
    throw new RecipeCodexGrantIdentityError(
      409,
      'oauth_broker_provider_conflict',
      `WorkflowRecipe agent uses ${agentBrokers.join(', ')}; cannot publish a ${provider} grant`
    )
  }

  const annotations = stringMap(current.metadata?.annotations)
  const previous = readSubscriptionConnectionRef({ provider, annotations })
  if (previous.ok && previous.connectionKey === next) {
    return { published: next, resourceVersion: current.metadata?.resourceVersion, noop: true }
  }

  const cleared = next === unassignedKey ? '' : next
  const nextAnnotations = grok
    ? {
        ...annotations,
        [CODEX_CONNECTION_REF_ANNOTATION]: '',
        [SUBSCRIPTION_CONNECTION_REF_ANNOTATION]: cleared,
      }
    : {
        ...annotations,
        [CODEX_CONNECTION_REF_ANNOTATION]: cleared,
        [SUBSCRIPTION_CONNECTION_REF_ANNOTATION]: cleared,
      }
  const spec = asRecord(current.spec) ?? {}
  const labels = stringMap(current.metadata?.labels)
  try {
    await input.gateway.updateResource(
      'workflowrecipes',
      input.name,
      {
        metadata: {
          ...(Object.keys(labels).length > 0 ? { labels } : {}),
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

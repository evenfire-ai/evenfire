import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { resolveMcpServerUrl } from './mcpInvocable.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export type ActionDestination = Readonly<{
  kind: 'host' | 'mcp_server'
  ref: string
  url: string
}>

export type ActionDestinationResult =
  | Readonly<{ status: 'resolved'; destination: ActionDestination | null }>
  | Readonly<{ status: 'not_found' | 'unavailable' }>

function scopedRef(logicalId: string): { namespace: string; name: string } | null {
  const separator = logicalId.indexOf('/')
  if (separator < 1 || separator === logicalId.length - 1) return null
  return { namespace: logicalId.slice(0, separator), name: logicalId.slice(separator + 1) }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as Record<string, unknown>
  return value.httpStatus === 404 || value.statusCode === 404 || value.code === 404
}

export async function resolveActionDestination(input: {
  resource: CanonicalResourceIdentity
  gateway: Pick<K8sGateway, 'getResourceExact'>
  budget: AccessExecutionBudget
}): Promise<ActionDestinationResult> {
  if (input.resource.type !== 'host' && input.resource.type !== 'mcp_server') {
    return { status: 'resolved', destination: null }
  }
  const scoped = scopedRef(input.resource.logicalId)
  if (!scoped) return { status: 'not_found' }
  if (input.resource.type === 'host') {
    if (scoped.namespace !== config.hostsNamespace) return { status: 'not_found' }
    return {
      status: 'resolved',
      destination: Object.freeze({
        kind: 'host',
        ref: input.resource.logicalId,
        url: `http://${scoped.name}.${scoped.namespace}.svc.cluster.local:8080`,
      }),
    }
  }
  if (scoped.namespace !== config.mcpServersNamespace) return { status: 'not_found' }
  try {
    input.budget.charge({ kind: 'exactKubernetesGets' })
    const timeoutSeconds = Math.max(1, Math.min(60, Math.ceil(input.budget.remainingMs() / 1_000)))
    const object = (await input.budget.runProducer(signal =>
      input.gateway.getResourceExact('mcpservers', scoped.name, scoped.namespace, {
        timeoutSeconds,
        signal,
      })
    )) as {
      metadata?: { name?: string; namespace?: string; deletionTimestamp?: string | null }
      spec?: {
        enabled?: boolean
        auth?: { type?: string }
        transport?: { type?: string; url?: string }
      }
    }
    if (
      object.metadata?.name !== scoped.name ||
      (object.metadata.namespace !== undefined && object.metadata.namespace !== scoped.namespace) ||
      object.metadata?.deletionTimestamp ||
      object.spec?.enabled === false ||
      (object.spec?.auth?.type && object.spec.auth.type !== 'none')
    ) {
      return { status: 'not_found' }
    }
    const url = resolveMcpServerUrl(object, scoped.namespace)
    if (!url) return { status: 'not_found' }
    return {
      status: 'resolved',
      destination: Object.freeze({
        kind: 'mcp_server',
        ref: input.resource.logicalId,
        url,
      }),
    }
  } catch (error) {
    return { status: isNotFound(error) ? 'not_found' : 'unavailable' }
  }
}

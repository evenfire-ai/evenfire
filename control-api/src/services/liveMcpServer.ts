import { extractK8sError } from '../http/k8sError.js'
import type { K8sGateway } from '../k8s.js'
import { K8sNotFoundError } from './resourceService.js'

/** The server-assigned `metadata.uid`, or undefined when the response carried none. */
export function resourceUidFrom(resource: unknown): string | undefined {
  const uid = (resource as { metadata?: { uid?: unknown } } | null)?.metadata?.uid
  return typeof uid === 'string' && uid ? uid : undefined
}

/**
 * The uid of a live McpServer with this name, or undefined when none exists. A CR
 * that is being deleted is still readable and still counts as live. A 404 is "no
 * live CR"; any other read error propagates, so a caller fails closed instead of
 * assuming the name is free.
 */
export async function readLiveMcpServerUid(
  gateway: Pick<K8sGateway, 'getResource'>,
  name: string,
  namespace: string
): Promise<string | undefined> {
  try {
    return resourceUidFrom(await gateway.getResource('mcpservers', name, namespace))
  } catch (err) {
    if (err instanceof K8sNotFoundError || extractK8sError(err)?.status === 404) return undefined
    throw err
  }
}

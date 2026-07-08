import * as k8s from '@kubernetes/client-node'
import { getErrorCode } from '../reconciler/k8sErrors'

export type McpHostPodDriftState = {
  image?: string
  deleting: boolean
}

/**
 * Read the drift-relevant state of the recipe mcp-host Pod, or undefined when
 * the Pod does not exist. The mcp-host container is selected by name so future
 * sidecars cannot accidentally drive the platform-image comparison.
 */
export async function readMcpHostPodDriftStateIfExists(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string
): Promise<McpHostPodDriftState | undefined> {
  try {
    const pod = await coreApi.readNamespacedPod({ name, namespace })
    const mcpHostContainer = pod.spec?.containers?.find(container => container.name === 'mcp-host')
    return {
      image: mcpHostContainer?.image,
      deleting: Boolean(pod.metadata?.deletionTimestamp),
    }
  } catch (error: unknown) {
    if (getErrorCode(error) === 404) return undefined
    throw error
  }
}

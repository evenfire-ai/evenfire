/**
 * Shared K8s API client for WorkflowRecipePolicy CRD queries.
 * Used by both the reconciler (enforcement) and MCP handlers (listing).
 */
import * as k8s from '@kubernetes/client-node'
import { WorkflowRecipePolicyCRD } from '../types'
import { CRD_GROUP, CRD_VERSION } from './crdConstants'
import { getErrorCode } from './k8sErrors'

const WRP_PLURAL = 'workflowrecipepolicies'

/**
 * List all WorkflowRecipePolicies in a namespace.
 * Propagates errors to let callers decide fail-open vs fail-closed.
 * Returns [] only when the CRD is not installed (404).
 */
export async function listWorkflowRecipePolicies(
  customApi: k8s.CustomObjectsApi,
  namespace: string
): Promise<WorkflowRecipePolicyCRD[]> {
  try {
    const response = await customApi.listNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: WRP_PLURAL,
    })
    return (response as { items: WorkflowRecipePolicyCRD[] }).items
  } catch (error: unknown) {
    // 404 = CRD not installed yet → no policies exist, safe to return []
    if (getErrorCode(error) === 404) {
      return []
    }
    throw error
  }
}

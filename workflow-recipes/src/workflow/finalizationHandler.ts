/**
 * WRC Finalization Protocol — cross-namespace resource cleanup.
 *
 * Guarantees that McpServer CRDs in mcp-server namespace and
 * NetworkPolicies in control-plane are cleaned up before the
 * WorkflowRecipe CRD is allowed to disappear.
 * */
import * as k8s from '@kubernetes/client-node'
import * as path from 'path'
import { Logger } from '../observability/logger'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from '../reconciler/crdConstants'
import { getErrorCode } from '../reconciler/k8sErrors'
import {
  buildArtifactReaderServiceName,
  buildMcpHostRouteAliasServiceName,
  buildMcpHostServiceName,
} from './resourceNames'

export const WORKFLOW_FINALIZER = 'clerum.io/workflow-finalizer'

const MAX_RETRIES = 5
const BASE_DELAY_MS = 1000

// ─── Retry with Exponential Backoff ────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
  baseDelay = BASE_DELAY_MS
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)))
      }
    }
  }
  throw lastError!
}

// ─── Output Path Validation ────────────────────────────────────────────

const SYSTEM_PATHS = ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run']

export function validateOutputPath(resolvedPath: string, mountPath: string): void {
  if (!resolvedPath) {
    throw new Error('Output path is empty')
  }
  if (resolvedPath.includes('..')) {
    throw new Error(`Output path contains traversal sequence: ${resolvedPath}`)
  }
  // Check system paths BEFORE the general "outside mount" check
  for (const sys of SYSTEM_PATHS) {
    if (resolvedPath.startsWith(sys)) {
      throw new Error(`Output path ${resolvedPath} targets system directory`)
    }
  }
  if (path.isAbsolute(resolvedPath) && !resolvedPath.startsWith(mountPath)) {
    throw new Error(`Output path ${resolvedPath} is outside declared mount ${mountPath}`)
  }
  const resolved = path.resolve(mountPath, resolvedPath)
  if (!resolved.startsWith(path.resolve(mountPath))) {
    throw new Error(`Output path resolves outside mount boundary: ${resolved}`)
  }
  if (resolvedPath.includes('{{')) {
    throw new Error(`Output path contains unresolved template variable: ${resolvedPath}`)
  }
}

// ─── Cleanup Functions ─────────────────────────────────────────────────

export interface FinalizationDeps {
  coreApi: k8s.CoreV1Api
  customApi: k8s.CustomObjectsApi
  networkingApi: k8s.NetworkingV1Api
  log: Logger
}

async function safeK8sDelete(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (getErrorCode(err) === 404) return // Already gone — success
    throw err
  }
}

export async function cleanupWorkflowResources(
  recipeName: string,
  sandboxNamespace: string,
  mcpServerNamespace: string,
  deps: FinalizationDeps
): Promise<void> {
  const { coreApi, customApi, networkingApi, log } = deps
  const labelSelector = `clerum.io/recipe=${recipeName},clerum.io/managed-by=wrc`

  // Steps 1-4 + 7: Delete independent sandbox-namespace resources in parallel
  // Use allSettled so one failure doesn't orphan remaining resources
  log.info('Cleanup steps 1-4,7: deleting Pods, Secret, ConfigMaps, Service', { recipeName })
  const coreResults = await Promise.allSettled([
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedPod({
          name: `${recipeName}-coordinator`,
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedPod({ name: `${recipeName}-mcp-host`, namespace: sandboxNamespace })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedPod({
          name: `${recipeName}-artifact-reader`,
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedSecret({
          name: `wf-${recipeName}-coordinator-token`,
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedSecret({
          name: `wf-${recipeName}-mcp-host-runtime-tokens`,
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedConfigMap({
          name: `${recipeName}-workflow-config`,
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedConfigMap({
          name: `wf-${recipeName}-soul-md`,
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedService({
          name: buildMcpHostServiceName(recipeName),
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedService({
          name: buildMcpHostRouteAliasServiceName(recipeName, sandboxNamespace),
          namespace: sandboxNamespace,
        })
      )
    ),
    withRetry(() =>
      safeK8sDelete(() =>
        coreApi.deleteNamespacedService({
          name: buildArtifactReaderServiceName(recipeName),
          namespace: sandboxNamespace,
        })
      )
    ),
  ])
  const coreFailures = coreResults.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected'
  )
  if (coreFailures.length > 0) {
    for (const f of coreFailures) {
      log.warn('Core resource cleanup failed', { recipeName, error: String(f.reason) })
    }
    // Intentionally non-blocking: sandbox Pods/Secrets/ConfigMaps/Services are best-effort.
    // K8s TTL-after-finished + resource quotas handle orphaned sandbox resources.
    // Unlike NPs (step 5) and McpServer CRDs (step 6), these do NOT block finalizer removal —
    // a failed Pod delete does not leave cross-namespace isolation holes.
  }

  // Step 5: Delete NetworkPolicies in both namespaces (parallel list, then parallel delete)
  log.info('Cleanup step 5: deleting cross-namespace NetworkPolicies', { recipeName })
  const [cpNpList, sbNpList] = await Promise.all([
    withRetry(() =>
      networkingApi.listNamespacedNetworkPolicy({ namespace: 'control-plane', labelSelector })
    ),
    withRetry(() =>
      networkingApi.listNamespacedNetworkPolicy({ namespace: sandboxNamespace, labelSelector })
    ),
  ])
  const npResults = await Promise.allSettled([
    ...cpNpList.items.map(np =>
      safeK8sDelete(() =>
        networkingApi.deleteNamespacedNetworkPolicy({
          name: np.metadata!.name!,
          namespace: 'control-plane',
        })
      )
    ),
    ...sbNpList.items.map(np =>
      safeK8sDelete(() =>
        networkingApi.deleteNamespacedNetworkPolicy({
          name: np.metadata!.name!,
          namespace: sandboxNamespace,
        })
      )
    ),
  ])
  const npFailures = npResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (npFailures.length > 0) {
    for (const f of npFailures) {
      log.warn('NetworkPolicy cleanup failed', { recipeName, error: String(f.reason) })
    }
    // Throw so the reconciler retries — do NOT remove finalizer with NPs still live
    throw new Error(
      `NetworkPolicy cleanup failed for ${npFailures.length} item(s) — reconciler will retry`
    )
  }

  // Step 6: Delete McpServer CRDs in mcp-server namespace (cross-namespace)
  log.info('Cleanup step 6: deleting McpServer CRDs', { recipeName })
  await withRetry(async () => {
    const mcpList = (await customApi.listNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: mcpServerNamespace,
      plural: 'mcpservers',
      labelSelector,
    })) as { items?: Array<{ metadata?: { name?: string } }> }
    const mcpResults = await Promise.allSettled(
      (mcpList.items ?? []).map(mcp =>
        safeK8sDelete(() =>
          customApi.deleteNamespacedCustomObject({
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace: mcpServerNamespace,
            plural: 'mcpservers',
            name: mcp.metadata!.name!,
          })
        )
      )
    )
    const mcpFailures = mcpResults.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    )
    if (mcpFailures.length > 0) {
      for (const f of mcpFailures) {
        log.warn('McpServer CRD cleanup failed', { recipeName, error: String(f.reason) })
      }
      // Throw so withRetry retries — do NOT allow finalizer removal with McpServers still live
      throw new Error(
        `McpServer cleanup failed for ${mcpFailures.length} server(s) — withRetry will retry`
      )
    }
  })

  log.info('Cleanup complete', { recipeName })
}

// ─── Finalizer Management ──────────────────────────────────────────────

export async function addFinalizer(
  customApi: k8s.CustomObjectsApi,
  recipeName: string,
  namespace: string
): Promise<void> {
  // Read current finalizers first — op:"add" on /metadata/finalizers REPLACES
  // the whole array if it exists, destroying any finalizers set by other controllers
  // (e.g. Kubernetes GC's kubernetes.io/pvc-protection). We must append instead.
  const current = (await customApi.getNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    name: recipeName,
  })) as { metadata?: { finalizers?: string[] } }

  const existing = current.metadata?.finalizers ?? []
  if (existing.includes(WORKFLOW_FINALIZER)) return // Idempotent

  await customApi.patchNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    name: recipeName,
    body: [
      {
        op: 'add',
        path: '/metadata/finalizers',
        value: [...existing, WORKFLOW_FINALIZER],
      },
    ],
  })
}

export async function removeFinalizer(
  customApi: k8s.CustomObjectsApi,
  recipeName: string,
  namespace: string
): Promise<void> {
  // Fetch current resource to get exact finalizers array before patching.
  // op: "remove" on /metadata/finalizers would delete ALL finalizers — other
  // controllers (e.g. garbage-collector) may have added their own. We only
  // remove WORKFLOW_FINALIZER and leave the rest intact.
  const current = (await customApi.getNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    name: recipeName,
  })) as { metadata?: { finalizers?: string[] } }

  const remaining = (current.metadata?.finalizers ?? []).filter(f => f !== WORKFLOW_FINALIZER)

  await customApi.patchNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    name: recipeName,
    body: [
      {
        // Use "add" instead of "replace": RFC 6902 "add" creates the path if absent
        // and replaces if present. "replace" would fail with 422 if the finalizers
        // field was never set (null in etcd), permanently orphaning the resource.
        op: 'add',
        path: '/metadata/finalizers',
        value: remaining,
      },
    ],
  })
}

export function hasFinalizer(metadata: { finalizers?: string[] }): boolean {
  return metadata.finalizers?.includes(WORKFLOW_FINALIZER) ?? false
}

export function hasDeletionTimestamp(metadata: { deletionTimestamp?: string }): boolean {
  return !!metadata.deletionTimestamp
}

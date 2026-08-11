import * as k8s from '@kubernetes/client-node'
import { config } from './config.js'
import { HostEnvService } from './services/hostEnvService.js'
import { HostOverviewService } from './services/hostOverviewService.js'
import {
  type AllowedModelsConfigMapMaterializer,
  LlmAllowedModelsConfigMapWriter,
} from './services/llmAllowedModelsConfigMap.js'
import {
  type ResourceListPage,
  ResourceService,
  mergeAnnotationsForReplace,
} from './services/resourceService.js'
import { SecretService } from './services/secretService.js'
import {
  CLERUM_GROUP,
  CLERUM_VERSION,
  ClerumResourceType,
  HostOverview,
  SecretPreconditions,
  SecretUpsertRequest,
} from './types.js'

/**
 * Namespaces where exec operations are permitted.
 * control-api is the master control — RBAC stays cluster-wide,
 * but the code-level API only allows exec in these namespaces.
 */
export const ALLOWED_EXEC_NAMESPACES: ReadonlySet<string> = new Set(['mcp-host', 'sandbox-recipes'])

/**
 * Directory prefixes where file reads are permitted.
 * Prevents reading arbitrary files like /etc/shadow or /var/run/secrets.
 */
export const ALLOWED_READ_DIRS: readonly string[] = Object.freeze([
  '/tmp/clerum-output/',
  '/output/',
])

// Keep this aligned with mcp-host/src/workflow/artifactPaths.ts until the
// artifact policy is promoted to a shared runtime dependency consumed by both
// services. @clerum/workflow-sdk exists, but it is currently a coordinator SDK,
// not a control-api/mcp-host artifact policy package.
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
export const MAX_ARTIFACT_LISTING_BYTES = 1 * 1024 * 1024

export class ExecOutputLimitError extends Error {
  constructor(
    readonly maxBytes: number,
    message = 'Exec output too large'
  ) {
    super(`${message}: output exceeded ${maxBytes} bytes`)
    this.name = 'ExecOutputLimitError'
  }
}

const SAFE_READ_FILE_SCRIPT = `
set -eu
path="$1"
max_bytes="$2"
if [ -L "$path" ]; then
  echo "Exec rejected: symlink artifacts are not allowed" >&2
  exit 66
fi
resolved="$(readlink -f -- "$path")" || {
  echo "File not found: $path" >&2
  exit 66
}
case "$resolved" in
  /tmp/clerum-output/*|/output/*) ;;
  *)
    echo "Exec rejected: resolved path is not under an allowed directory" >&2
    exit 66
    ;;
esac
if [ ! -f "$resolved" ]; then
  echo "File not found or not a regular file: $path" >&2
  exit 66
fi
initial_meta="$(stat -Lc '%d:%i:%s' -- "$resolved")" || {
  echo "Exec rejected: failed to stat artifact" >&2
  exit 66
}
exec 3< "$resolved" || {
  echo "File not found: $path" >&2
  exit 66
}
opened_resolved="$(readlink -f -- "/proc/$$/fd/3")" || {
  echo "Exec rejected: failed to resolve opened artifact" >&2
  exit 66
}
case "$opened_resolved" in
  /tmp/clerum-output/*|/output/*) ;;
  *)
    echo "Exec rejected: opened artifact is not under an allowed directory" >&2
    exit 66
    ;;
esac
opened_meta="$(stat -Lc '%d:%i:%s' -- "/proc/$$/fd/3")" || {
  echo "Exec rejected: failed to determine artifact size" >&2
  exit 66
}
if [ "$opened_meta" != "$initial_meta" ]; then
  echo "Exec rejected: artifact changed during validation" >&2
  exit 66
fi
size="\${opened_meta##*:}"
case "$size" in
  ''|*[!0-9]*)
    echo "Exec rejected: invalid artifact size" >&2
    exit 66
    ;;
esac
if [ "$size" -gt "$max_bytes" ]; then
  echo "Artifact too large to download: $size bytes" >&2
  exit 67
fi
cat <&3
`.trim()

export function buildSafeReadFileCommand(filePath: string): string[] {
  return [
    'sh',
    '-c',
    SAFE_READ_FILE_SCRIPT,
    'clerum-read-artifact',
    filePath,
    String(MAX_ARTIFACT_BYTES),
  ]
}

export function buildListFilesWithMetadataCommand(directory: string): string[] {
  return ['find', directory, '-maxdepth', '1', '-type', 'f', '-printf', '%f\\t%s\\t%T@\\n']
}

export function buildListRegularFileNamesCommand(directory: string): string[] {
  return ['find', directory, '-maxdepth', '1', '-type', 'f', '-exec', 'basename', '{}', ';']
}

function isExecOutputLimitError(err: unknown): boolean {
  return err instanceof ExecOutputLimitError
}

/**
 * Validate that an exec operation targets an allowed namespace and path.
 * Exported for testability — the security policy is enforced here.
 */
export function validateExecParams(namespace: string, pathOrDir: string): void {
  if (!ALLOWED_EXEC_NAMESPACES.has(namespace)) {
    throw new Error('Exec rejected: namespace is not in the exec allowlist')
  }
  if (!pathOrDir) {
    throw new Error('Exec rejected: empty path')
  }
  if (pathOrDir.includes('\0')) {
    throw new Error('Exec rejected: null byte in path')
  }
  if (pathOrDir.includes('..')) {
    throw new Error('Exec rejected: path traversal detected')
  }
  if (!ALLOWED_READ_DIRS.some(prefix => pathOrDir.startsWith(prefix))) {
    throw new Error('Exec rejected: path is not under an allowed directory')
  }
}

export class K8sGateway {
  private readonly namespace: string
  private readonly resources: ResourceService
  private readonly secrets: SecretService
  private readonly hostOverviews: HostOverviewService
  private readonly hostEnvSvc: HostEnvService
  private readonly llmAllowedModelsCmWriter: LlmAllowedModelsConfigMapWriter
  private readonly secretsNamespace: string
  private readonly kc: k8s.KubeConfig
  private readonly coreApi: k8s.CoreV1Api
  private readonly customApi: k8s.CustomObjectsApi

  constructor(namespace = config.namespace) {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    this.kc = kc
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi)
    const coreApi = kc.makeApiClient(k8s.CoreV1Api)
    this.customApi = customApi
    this.coreApi = coreApi
    this.namespace = namespace
    this.resources = new ResourceService(customApi, this.namespace, {
      hosts: config.hostsNamespace,
      contexts: config.contextsNamespace,
      communicationchannels: config.communicationChannelsNamespace,
      mcpservers: config.mcpServersNamespace,
      // Design invariant: WorkflowRecipe CRDs always live in sandbox-recipes,
      // co-located with the workflow coordinator and recipe mcp-host pods.
      // The mcp-server namespace is reserved for McpServer transport children
      // and their network policies; it is not a WorkflowRecipe storage lane.
      workflowrecipes: config.sandboxNamespace,
      workflowrecipepolicies: config.sandboxNamespace,
      // SharedFileSystem CRDs and their workspace-files-controller workloads
      // live with the Hosts that mount their PVCs read-only at runtime.
      sharedfilesystems: config.sharedFilesystemsNamespace,
    })
    this.secrets = new SecretService(coreApi, config.secretsNamespace)
    this.secretsNamespace = config.secretsNamespace
    this.hostOverviews = new HostOverviewService(this.resources, this.namespace)
    // Per-Host env CM/Secret CRUD lives in the same namespace as the Host pods.
    this.hostEnvSvc = new HostEnvService(coreApi, config.hostsNamespace)
    // The LLM allowlist ConfigMap is materialized alongside the Host pods that
    // consume it (mcp-host namespace).
    this.llmAllowedModelsCmWriter = new LlmAllowedModelsConfigMapWriter(
      coreApi,
      config.hostsNamespace
    )
  }

  hostEnv(): HostEnvService {
    return this.hostEnvSvc
  }

  llmAllowedModelsConfigMap(): AllowedModelsConfigMapMaterializer {
    return this.llmAllowedModelsCmWriter
  }

  getNamespace(): string {
    return this.namespace
  }

  async listResource(plural: ClerumResourceType, namespace = '*'): Promise<unknown[]> {
    return this.resources.listResource(plural, namespace)
  }

  async listResourcePage(
    plural: ClerumResourceType,
    namespace: string,
    options: {
      limit: number
      continueToken?: string
      resourceVersion?: string
      timeoutSeconds: number
      signal: AbortSignal
    }
  ): Promise<ResourceListPage> {
    return this.resources.listResourcePage(plural, namespace, options)
  }

  async getResourceExact(
    plural: ClerumResourceType,
    name: string,
    namespace: string,
    options: { timeoutSeconds: number; signal: AbortSignal }
  ): Promise<unknown> {
    return this.resources.getResourceExact(plural, name, namespace, options)
  }

  async watchResource(
    plural: ClerumResourceType,
    namespace: string,
    resourceVersion: string,
    signal: AbortSignal,
    onEvent: (phase: string, object: unknown) => void | Promise<void>
  ): Promise<void> {
    this.resources.assertNamespaceAllowed(namespace)
    const watch = new k8s.Watch(this.kc)
    const path = `/apis/${CLERUM_GROUP}/${CLERUM_VERSION}/namespaces/${encodeURIComponent(
      namespace
    )}/${plural}`
    await new Promise<void>((resolve, reject) => {
      let controller: AbortController | null = null
      let settled = false
      let eventQueue = Promise.resolve()
      let handlerError: unknown
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        void eventQueue.then(
          () => {
            const finalError = handlerError ?? error
            if (finalError && !signal.aborted) reject(finalError)
            else resolve()
          },
          queueError => {
            if (!signal.aborted) reject(queueError)
            else resolve()
          }
        )
      }
      const onAbort = () => {
        controller?.abort()
        finish()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      void watch
        .watch(
          path,
          { resourceVersion, allowWatchBookmarks: true },
          (phase, object) => {
            if (signal.aborted || handlerError) return
            eventQueue = eventQueue
              .then(() => onEvent(phase, object))
              .catch(error => {
                handlerError = error
                controller?.abort()
                finish(error)
              })
          },
          error => finish(error)
        )
        .then(value => {
          controller = value
          if (settled || signal.aborted || handlerError) controller.abort()
        })
        .catch(finish)
    })
  }

  async getResource(
    plural: ClerumResourceType,
    name: string,
    namespace?: string
  ): Promise<unknown> {
    return this.resources.getResource(plural, name, namespace)
  }

  async createResource(
    plural: ClerumResourceType,
    body: {
      metadata: {
        name: string
        labels?: Record<string, string>
        annotations?: Record<string, string>
      }
      spec: Record<string, unknown>
    },
    namespace?: string
  ): Promise<unknown> {
    return this.resources.createResource(plural, body, namespace)
  }

  async updateResource(
    plural: ClerumResourceType,
    name: string,
    body: {
      // metadata.resourceVersion is the AP-6 reader's-version precondition —
      // see ResourceService.updateResource for the conflict semantics.
      metadata?: {
        labels?: Record<string, string>
        annotations?: Record<string, string>
        resourceVersion?: string
      }
      spec: Record<string, unknown>
    },
    namespace?: string
  ): Promise<unknown> {
    return this.resources.updateResource(plural, name, body, namespace)
  }

  /**
   * Write-only annotation projection via JSON merge patch. See
   * ResourceService.patchResourceAnnotations for the concurrency rationale.
   */
  async patchResourceAnnotations(
    plural: ClerumResourceType,
    name: string,
    annotations: Record<string, string>,
    namespace?: string
  ): Promise<unknown> {
    return this.resources.patchResourceAnnotations(plural, name, annotations, namespace)
  }

  /**
   * Non-regressing (monotonic) projection of a numeric annotation. See
   * ResourceService.patchAnnotationMonotonic for the ordering invariant and
   * why a blind merge patch is unsafe for the wake-generation projection.
   */
  async patchAnnotationMonotonic(
    plural: ClerumResourceType,
    name: string,
    annotationKey: string,
    generation: number,
    namespace?: string
  ): Promise<unknown> {
    return this.resources.patchAnnotationMonotonic(
      plural,
      name,
      annotationKey,
      generation,
      namespace
    )
  }

  async mutateResource(
    plural: ClerumResourceType,
    name: string,
    mutate: Parameters<ResourceService['mutateResource']>[2],
    namespace?: string
  ): Promise<unknown> {
    return this.resources.mutateResource(plural, name, mutate, namespace)
  }

  async patchResourceStatus(
    plural: ClerumResourceType,
    name: string,
    statusPatch: Record<string, unknown>,
    namespace?: string
  ): Promise<unknown> {
    return this.resources.patchResourceStatus(plural, name, statusPatch, namespace)
  }

  /**
   * Replace a Host with the supplied spec and explicit metadata.resourceVersion.
   * This sends the caller's resourceVersion through so K8s enforces optimistic
   * concurrency and returns 409 on stale updates.
   *
   * AP-6 invariant (shared with ResourceService.updateResource/mutateResource):
   * platform-owned `clerum.io/*` annotations are write-only projections
   * (e.g. `clerum.io/wake-requested`, see hostWakeService.ts). Before replacing,
   * this reads the CURRENT server object's annotations and routes them through
   * `mergeAnnotationsForReplace`, so any `clerum.io/*` key present on the live
   * object survives the replace unless the caller EXPLICITLY sets that exact
   * key — regardless of what annotations map the caller sends (or omits). The
   * internal read harvests annotations only; the caller's resourceVersion
   * remains the optimistic-concurrency precondition. Personalization (the sole
   * caller today) sends no writable-annotation contract, so its behavior is
   * unchanged; this is defense-in-depth so a future annotations-bearing caller
   * cannot silently drop the platform projection.
   */
  async replaceHost(body: {
    metadata: {
      annotations?: Record<string, string>
      labels?: Record<string, string>
      name: string
      namespace: string
      resourceVersion: string
    }
    spec: Record<string, unknown>
  }): Promise<{ metadata?: { resourceVersion?: string } }> {
    const current = (await this.customApi.getNamespacedCustomObject({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: body.metadata.namespace,
      plural: 'hosts',
      name: body.metadata.name,
    })) as { metadata?: { annotations?: Record<string, string> } }

    const annotations = mergeAnnotationsForReplace(
      current.metadata?.annotations,
      body.metadata.annotations
    )

    return (await this.customApi.replaceNamespacedCustomObject({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: body.metadata.namespace,
      plural: 'hosts',
      name: body.metadata.name,
      body: {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: {
          ...body.metadata,
          ...(annotations && { annotations }),
        },
        spec: body.spec,
      },
    })) as { metadata?: { resourceVersion?: string } }
  }

  async deleteResource(
    plural: ClerumResourceType,
    name: string,
    namespace?: string
  ): Promise<unknown> {
    return this.resources.deleteResource(plural, name, namespace)
  }

  async listSecrets(namespace = this.secretsNamespace): Promise<unknown[]> {
    return this.secrets.listSecrets(namespace)
  }

  /**
   * Read a single Secret. Propagates 404 (and other) errors from the K8s
   * client so callers can branch on statusCode. Used by admin POST handlers
   * to validate envSecret references before creating broken CRDs.
   */
  async getSecret(name: string, namespace?: string): Promise<unknown> {
    return this.secrets.getSecret(name, namespace)
  }

  async createSecret(req: SecretUpsertRequest): Promise<unknown> {
    return this.secrets.createSecret(req)
  }

  /** `precondition` makes the replace ownership-bound; see `SecretPreconditions`. */
  async updateSecret(
    req: SecretUpsertRequest,
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    return this.secrets.updateSecret(req, precondition)
  }

  async mergeSecret(req: SecretUpsertRequest): Promise<unknown> {
    return this.secrets.mergeSecret(req)
  }

  async removeSecretKey(req: { name: string; namespace?: string; key: string }): Promise<unknown> {
    return this.secrets.removeSecretKey(req)
  }

  /** `precondition` binds the delete to a specific object; see `SecretPreconditions`. */
  async deleteSecret(
    name: string,
    namespace?: string,
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    return this.secrets.deleteSecret(name, namespace, precondition)
  }

  async getHostOverview(hostName: string, namespace?: string): Promise<HostOverview> {
    return this.hostOverviews.getHostOverview(hostName, namespace)
  }

  /**
   * Count Ready endpoint addresses for a Service. Returns `null` when no
   * Endpoints object exists for the given (name, namespace) — that means
   * either the Service was never created or its Endpoints controller hasn't
   * produced the resource yet. A return of `0` means the Endpoints object
   * exists but no pod address is currently in the Ready state. Any non-404
   * apiserver error propagates so the caller surfaces a 500.
   *
   * Sandbox UI registry uses this to gate `ready: true` on actual
   * routability rather than relying solely on the recipe's `phase=active`,
   * which only proves WRC reconciled — not that the upstream pod is alive.
   */
  async getServiceReadyAddressCount(name: string, namespace: string): Promise<number | null> {
    try {
      const endpoints = await this.coreApi.readNamespacedEndpoints({ name, namespace })
      let count = 0
      for (const subset of endpoints.subsets ?? []) {
        count += (subset.addresses ?? []).length
      }
      return count
    } catch (err) {
      if (extractHttpStatus(err) === 404) return null
      throw err
    }
  }

  /**
   * Read a file from a pod via K8s Exec API (cat).
   * Only allows reads from paths under ALLOWED_READ_DIRS in ALLOWED_EXEC_NAMESPACES.
   */
  async readFileFromPod(
    podName: string,
    namespace: string,
    containerName: string | undefined,
    filePath: string
  ): Promise<Buffer> {
    validateExecParams(namespace, filePath)
    try {
      return await this.execBytes(
        podName,
        namespace,
        containerName,
        buildSafeReadFileCommand(filePath),
        MAX_ARTIFACT_BYTES
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw msg.includes('No such file') ? new Error(`File not found: ${filePath}`) : err
    }
  }

  /**
   * Find a running pod by label selector in a namespace.
   */
  async findPodByLabel(namespace: string, labelSelector: string): Promise<string | null> {
    const res = await this.coreApi.listNamespacedPod({ namespace, labelSelector })
    const pods = res.items ?? []
    const running = pods.find(p => p.status?.phase === 'Running' && p.metadata?.name)
    return running?.metadata?.name ?? null
  }

  /**
   * List all running pod names matching a label selector in a namespace.
   */
  async listPodsByLabel(namespace: string, labelSelector: string): Promise<string[]> {
    const res = await this.coreApi.listNamespacedPod({ namespace, labelSelector })
    return (res.items ?? [])
      .filter(p => p.status?.phase === 'Running' && p.metadata?.name)
      .map(p => p.metadata!.name!)
  }

  /**
   * List every pod belonging to a recipe across every namespace WRC splits
   * workloads into (sandbox-recipes / sandbox-ui / mcp-server). Returns pods
   * in every phase — including the failing-to-start cases (`Pending` with
   * `CreateContainerConfigError`, `ImagePullBackOff`, `CrashLoopBackOff`)
   * that the recipe's own `.status.workloads[].ready` does NOT surface (the
   * "reconcile applied" vs "kubelet is happy" gap).
   *
   * Listed per-namespace, NOT via listPodForAllNamespaces: a cluster-wide
   * list needs cluster-scoped RBAC that managed shared tenants do not (and must
   * not) grant, and the recipe label carries no tenant scoping — an
   * all-namespaces list on a shared cluster would return other tenants'
   * pods for a same-named recipe.
   */
  async listPodsForRecipe(recipeName: string): Promise<RecipePodInfo[]> {
    return listRecipePodsAcrossNamespaces(
      this.coreApi,
      [config.sandboxNamespace, config.sandboxUiNamespace, config.mcpServersNamespace],
      recipeName
    )
  }

  /**
   * List regular files in a directory inside a pod. Returns raw output from
   * find -printf (name\tsize\tepoch) with a BusyBox-compatible find fallback.
   * Only allows directories under ALLOWED_READ_DIRS in ALLOWED_EXEC_NAMESPACES.
   */
  async listFilesInDirectory(
    podName: string,
    namespace: string,
    containerName: string | undefined,
    directory: string
  ): Promise<string> {
    validateExecParams(namespace, directory)
    // Use array arguments instead of sh -c string interpolation to prevent shell injection.
    try {
      return await this.execRaw(
        podName,
        namespace,
        containerName,
        buildListFilesWithMetadataCommand(directory),
        MAX_ARTIFACT_LISTING_BYTES,
        'Artifact listing too large to return'
      )
    } catch (findError) {
      if (isExecOutputLimitError(findError)) throw findError
      // BusyBox find (Alpine/node images) lacks -printf. Keep -type f in the
      // fallback so directories and symlinks do not become downloadable entries.
      console.warn(
        'find -printf failed, falling back to find -type f:',
        findError instanceof Error ? findError.message : String(findError)
      )
      return this.execRaw(
        podName,
        namespace,
        containerName,
        buildListRegularFileNamesCommand(directory),
        MAX_ARTIFACT_LISTING_BYTES,
        'Artifact listing too large to return'
      )
    }
  }

  /**
   * Internal: execute a command in a pod and return stdout bytes.
   * Private — no route handler should call this directly.
   * Use readFileFromPod or listFilesInDirectory instead.
   */
  private async execBytes(
    podName: string,
    namespace: string,
    containerName: string | undefined,
    command: string[],
    maxBytes?: number,
    maxBytesExceededMessage = 'Exec output too large'
  ): Promise<Buffer> {
    const { PassThrough } = await import('stream')
    const exec = new k8s.Exec(this.kc)

    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let totalBytes = 0

    stderr.on('data', (d: Buffer) => errChunks.push(d))

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false
      let connRef: { close: () => void } | null = null
      const destroyStreams = (): void => {
        stdout.destroy()
        stderr.destroy()
      }
      const rejectOnce = (err: unknown): void => {
        if (settled) return
        settled = true
        destroyStreams()
        reject(err)
      }
      stdout.on('data', (d: Buffer) => {
        totalBytes += d.length
        if (maxBytes !== undefined && totalBytes > maxBytes) {
          chunks.length = 0
          rejectOnce(new ExecOutputLimitError(maxBytes, maxBytesExceededMessage))
          try {
            connRef?.close()
          } catch {
            /* ignore close failure while rejecting the oversized exec output */
          }
          return
        }
        chunks.push(d)
      })
      exec
        .exec(namespace, podName, containerName ?? '', command, stdout, stderr, null, false)
        .then(conn => {
          connRef = conn
          conn.on('close', () => {
            if (settled) return
            settled = true
            const errMsg = Buffer.concat(errChunks).toString('utf-8').trim()
            destroyStreams()
            if (errMsg && chunks.length === 0) {
              reject(new Error(errMsg))
            } else {
              resolve(Buffer.concat(chunks))
            }
          })
          conn.on('error', rejectOnce)
        })
        .catch(rejectOnce)
    })
  }

  private async execRaw(
    podName: string,
    namespace: string,
    containerName: string | undefined,
    command: string[],
    maxBytes?: number,
    maxBytesExceededMessage?: string
  ): Promise<string> {
    const output = await this.execBytes(
      podName,
      namespace,
      containerName,
      command,
      maxBytes,
      maxBytesExceededMessage
    )
    return output.toString('utf-8')
  }
}

export type RecipePodInfo = {
  name: string
  namespace: string
  workloadId: string | null
  phase: string
  reason: string | null
  message: string | null
  restarts: number
  createdAt: string | null
  containers: Array<{
    name: string
    ready: boolean
    state: string
    reason: string | null
    message: string | null
    restartCount: number
  }>
}

export function extractHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as {
    statusCode?: number
    code?: number | string
    response?: { statusCode?: number; status?: number }
  }
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (typeof maybe.code === 'string' && /^\d+$/.test(maybe.code)) return Number(maybe.code)
  if (maybe.response && typeof maybe.response.statusCode === 'number')
    return maybe.response.statusCode
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  return null
}

/**
 * List a recipe's pods in each given namespace and merge the results.
 *
 * A namespace answering 403/404 is skipped: per-tenant deployments grant
 * control-api namespaced pod RBAC, and a namespace with a missing grant (or
 * one that simply does not exist on this cluster) must degrade to "no pods
 * from there", not fail the whole endpoint. Anything else propagates.
 */
export async function listRecipePodsAcrossNamespaces(
  coreApi: Pick<k8s.CoreV1Api, 'listNamespacedPod'>,
  namespaces: readonly string[],
  recipeName: string
): Promise<RecipePodInfo[]> {
  // The universal label across every workload pod is `clerum.io/recipe`
  // (set by `standardLabels` in workflow-recipes). `clerum.io/recipe-name`
  // is ALSO stamped on UI + webhook-gateway pods (sandboxUiLabels), but
  // not on plain workload pods — so selecting on it would miss db /
  // followup / api / etc. Use the universal label here.
  const labelSelector = `clerum.io/recipe=${recipeName}`
  const results = await Promise.all(
    [...new Set(namespaces)].map(async namespace => {
      try {
        const res = await coreApi.listNamespacedPod({ namespace, labelSelector })
        return (res.items ?? []).map(summarizePod)
      } catch (err) {
        const status = extractHttpStatus(err)
        if (status === 403 || status === 404) {
          console.warn(
            `listPodsForRecipe: skipping namespace "${namespace}" (HTTP ${status}) — ` +
              'control-api lacks pod list RBAC there or the namespace does not exist'
          )
          return []
        }
        throw err
      }
    })
  )
  return results.flat()
}

function summarizePod(p: k8s.V1Pod): RecipePodInfo {
  const meta = p.metadata ?? {}
  const status = p.status ?? {}
  const containers = (status.containerStatuses ?? []).map(c => {
    const stateKey = c.state?.waiting ? 'waiting' : c.state?.terminated ? 'terminated' : 'running'
    const stateObj = c.state?.waiting ?? c.state?.terminated ?? null
    return {
      name: c.name,
      ready: Boolean(c.ready),
      state: stateKey,
      reason: stateObj && 'reason' in stateObj ? (stateObj.reason ?? null) : null,
      message: stateObj && 'message' in stateObj ? (stateObj.message ?? null) : null,
      restartCount: c.restartCount ?? 0,
    }
  })
  // Surface the most informative reason: a waiting/terminated container reason
  // usually carries the real failure (`CreateContainerConfigError`,
  // `ImagePullBackOff`, etc.), while `status.reason` is often empty or generic.
  const firstWaitingReason = containers.find(c => c.state !== 'running' && c.reason)?.reason ?? null
  const firstWaitingMessage =
    containers.find(c => c.state !== 'running' && c.message)?.message ?? null
  const restarts = containers.reduce((acc, c) => acc + (c.restartCount ?? 0), 0)
  return {
    name: meta.name ?? '',
    namespace: meta.namespace ?? '',
    workloadId: meta.labels?.['clerum.io/workload'] ?? null,
    phase: status.phase ?? 'Unknown',
    reason: firstWaitingReason ?? status.reason ?? null,
    message: firstWaitingMessage ?? status.message ?? null,
    restarts,
    createdAt: meta.creationTimestamp ? new Date(meta.creationTimestamp).toISOString() : null,
    containers,
  }
}

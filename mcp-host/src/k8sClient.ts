/**
 * Kubernetes client for reading Host CRD and secrets.
 *
 * Note: McpServer CRD access is now handled via the skill-mapper service.
 */
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { HostCRD, HostSpec } from './types'

const kc = new k8s.KubeConfig()
kc.loadFromDefault()

const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi)

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const HOSTS_PLURAL = 'hosts'
const LLMHOOKS_PLURAL = 'llmhooks'

/**
 * Raw LlmHook CR (spec §8) as read by mcp-host. mcp-host READS these to resolve
 * `Host.spec.guardrails.hooks` references into runtime hook descriptors; it never
 * writes them (the status subresource is controller-owned).
 */
export interface LlmHookCR {
  metadata?: { name?: string }
  spec?: {
    target?: {
      image?: {
        ref?: string
        port?: number
        envSecret?: string
        egressBindings?: Array<{ cidr?: string; toFQDN?: string; ports?: number[] }>
        security?: { addCapabilities?: string[] }
      }
      service?: { name?: string; namespace?: string; port?: number }
      remote?: { baseUrl?: string }
    }
    path?: string
    lifecyclePoints?: string[]
    contentAccess?: 'metadata' | 'content'
    order?: number
    failMode?: 'open' | 'closed'
    onUnavailable?: {
      mode?: 'strict' | 'breaker'
      failureThreshold?: number
      cooldownMs?: number
    }
    capabilities?: string[]
  }
  status?: { observedDigest?: string }
}

/**
 * Get an LlmHook CR by name from the llm-hooks namespace (spec §8.2). Returns
 * null on 404 so a dangling `Host.spec.guardrails.hooks` reference resolves to
 * "skip", not a hard failure.
 */
export async function getLlmHook(name: string): Promise<LlmHookCR | null> {
  try {
    const response = await customObjectsApi.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.llmHooksNamespace,
      plural: LLMHOOKS_PLURAL,
      name,
    })
    return response as LlmHookCR
  } catch (error) {
    if ((error as { response?: { statusCode?: number } }).response?.statusCode === 404) {
      console.warn(`[K8s] LlmHook not found: ${name} (ns=${config.llmHooksNamespace})`)
      return null
    }
    throw error
  }
}

/**
 * Get a Host CRD by name.
 */
export async function getHost(name: string): Promise<HostCRD | null> {
  try {
    console.log(`[K8s] Getting Host CRD: ${name} in namespace ${config.namespace}`)

    const response = await customObjectsApi.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.namespace,
      plural: HOSTS_PLURAL,
      name: name,
    })

    const obj = response as {
      metadata: { name: string; namespace?: string }
      spec: HostSpec
    }

    return {
      name: obj.metadata.name,
      namespace: obj.metadata.namespace || config.namespace,
      spec: obj.spec,
    }
  } catch (error) {
    if ((error as { response?: { statusCode?: number } }).response?.statusCode === 404) {
      console.log(`[K8s] Host CRD not found: ${name}`)
      return null
    }
    throw error
  }
}

/**
 * Watch for changes to a specific Host CRD.
 */
export class HostWatcher {
  private name: string
  private watch: k8s.Watch
  private watchRequest: { abort: () => void } | null = null

  constructor(name: string) {
    this.name = name
    this.watch = new k8s.Watch(kc)
  }

  /**
   * Start watching for changes.
   * @param onChange Called when the Host CRD changes
   * @param onDelete Called when the Host CRD is deleted
   */
  async start(onChange: (host: HostCRD) => void, onDelete: () => void): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.namespace}/${HOSTS_PLURAL}`

    console.log(`[K8s] Starting watch on Host: ${this.name}`)

    const watchCallback = (
      type: string,
      apiObj: { metadata: { name: string; namespace?: string }; spec: HostSpec }
    ) => {
      if (apiObj.metadata.name !== this.name) {
        return
      }

      console.log(`[K8s] Watch event: ${type} for Host ${this.name}`)

      if (type === 'ADDED' || type === 'MODIFIED') {
        onChange({
          name: apiObj.metadata.name,
          namespace: apiObj.metadata.namespace || config.namespace,
          spec: apiObj.spec,
        })
      } else if (type === 'DELETED') {
        onDelete()
      }
    }

    const doneCallback = (err: Error | null) => {
      if (err) {
        console.error('[K8s] Watch error:', err)
        // Restart watch after a delay
        setTimeout(() => this.start(onChange, onDelete), 5000)
      }
    }

    this.watchRequest = await this.watch.watch(
      path,
      { fieldSelector: `metadata.name=${this.name}` },
      watchCallback,
      doneCallback
    )
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.watchRequest) {
      console.log('[K8s] Stopping Host watch')
      this.watchRequest.abort()
      this.watchRequest = null
    }
  }
}

/**
 * Watch LlmHook CRs in the (tenant-scoped) llm-hooks namespace so a hook-CR edit
 * (capabilities/path/failMode/target) is re-resolved live (§8.2), without a pod
 * restart. Namespace-scoped, so it only surfaces this tenant's own hooks.
 */
export class LlmHookWatcher {
  private watch: k8s.Watch
  private watchRequest: { abort: () => void } | null = null

  constructor() {
    this.watch = new k8s.Watch(kc)
  }

  async start(onChange: (name: string) => void): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.llmHooksNamespace}/${LLMHOOKS_PLURAL}`
    console.log(`[K8s] Starting watch on LlmHooks (namespace ${config.llmHooksNamespace})`)

    const watchCallback = (type: string, apiObj: { metadata?: { name?: string } }) => {
      const name = apiObj?.metadata?.name
      if (!name) return
      if (type === 'ADDED' || type === 'MODIFIED' || type === 'DELETED') {
        console.log(`[K8s] LlmHook watch event: ${type} for ${name}`)
        onChange(name)
      }
    }

    const doneCallback = (err: Error | null) => {
      if (err) {
        console.error('[K8s] LlmHook watch error:', err)
        setTimeout(() => this.start(onChange), 5000)
      }
    }

    this.watchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
  }

  stop(): void {
    if (this.watchRequest) {
      console.log('[K8s] Stopping LlmHook watch')
      this.watchRequest.abort()
      this.watchRequest = null
    }
  }
}

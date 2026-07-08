/**
 * Kubernetes client for reading Host CRD and secrets.
 *
 * Note: McpServer CRD access is now handled via the skill-mapper service.
 */
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { ALL_PROVIDERS, descriptorFor } from './llm/registryCore'
import { ApiKeys, HostCRD, HostSpec } from './types'

const kc = new k8s.KubeConfig()
kc.loadFromDefault()

const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi)
const coreApi = kc.makeApiClient(k8s.CoreV1Api)

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const HOSTS_PLURAL = 'hosts'

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
 * Get API keys from the secret referenced by the Host.
 */
export async function getApiKeys(secretName: string): Promise<ApiKeys> {
  try {
    console.log(`[K8s] Getting Secret: ${secretName} in namespace ${config.namespace}`)

    const response = await coreApi.readNamespacedSecret({
      name: secretName,
      namespace: config.namespace,
    })

    const secret = response
    const keys: ApiKeys = {}

    // K8s API returns secret.data values as base64-encoded strings.
    // We decode them to get the plain-text API keys.
    const data = secret.data || {}

    function decodeSecretValue(raw: string): string {
      // If the value looks base64-encoded (re-encoding the decoded value matches),
      // decode it. Otherwise return as-is (already plain text).
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf-8')
        const reEncoded = Buffer.from(decoded).toString('base64')
        if (reEncoded === raw && decoded !== raw) {
          console.log('[K8s]   (decoded from base64)')
          return decoded
        }
      } catch {
        // Not valid base64, return as-is
      }
      return raw
    }

    // Registry-driven: read each provider's key by its Secret dataKey. Log only
    // the dataKey NAME (never the value, never keys[id]) to preserve redaction.
    for (const provider of ALL_PROVIDERS) {
      const { dataKey } = descriptorFor(provider)
      if (data[dataKey]) {
        console.log(`[K8s] Found ${dataKey} in secret`)
        keys[provider] = decodeSecretValue(data[dataKey])
      }
    }

    return keys
  } catch (error) {
    if ((error as { response?: { statusCode?: number } }).response?.statusCode === 404) {
      console.error(`[K8s] Secret not found: ${secretName}`)
      return {}
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

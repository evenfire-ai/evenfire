/**
 * issue #299 Phase 2 — reader/writer for the cluster ConfigMap
 * `clerum-provider-netblocks` (mirror of llmAllowedModelsConfigMap). control-api
 * is the ONLY writer; HCC/WRC read it. Create-or-replace with a short retry; the
 * content hash is stamped as an annotation for the consumer no-op gate.
 */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'

export const PROVIDER_NETBLOCKS_CONFIGMAP_NAME = 'clerum-provider-netblocks'
export const CONTENT_HASH_ANNOTATION = 'clerum.io/content-hash'
const MANAGED_BY_LABEL = 'clerum.io/managed-by'

/** Deterministic sha256 over the non-`_meta` data keys (sorted). Stable for a
 * given set of ranges regardless of `_meta` timestamps. */
export function contentHashOf(data: Record<string, string>): string {
  const entries = Object.entries(data)
    .filter(([k]) => k !== '_meta')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export interface ProviderNetblocksCmStore {
  /** null when the ConfigMap does not exist yet (404). */
  read(): Promise<{ data: Record<string, string>; annotations: Record<string, string> } | null>
  write(data: Record<string, string>, contentHash: string): Promise<void>
}

function isErrorCode(err: unknown, code: number): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } }
  return e.code === code || e.statusCode === code || e.response?.statusCode === code
}
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class K8sProviderNetblocksCmStore implements ProviderNetblocksCmStore {
  constructor(
    private readonly coreApi: Pick<
      k8s.CoreV1Api,
      'createNamespacedConfigMap' | 'readNamespacedConfigMap' | 'replaceNamespacedConfigMap'
    >,
    private readonly namespace: string,
    private readonly maxAttempts = 3
  ) {}

  async read(): Promise<{
    data: Record<string, string>
    annotations: Record<string, string>
  } | null> {
    try {
      const cm = await this.coreApi.readNamespacedConfigMap({
        namespace: this.namespace,
        name: PROVIDER_NETBLOCKS_CONFIGMAP_NAME,
      })
      return { data: cm.data ?? {}, annotations: cm.metadata?.annotations ?? {} }
    } catch (err) {
      if (isErrorCode(err, 404)) return null
      throw err
    }
  }

  async write(data: Record<string, string>, contentHash: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.writeOnce(data, contentHash)
        return
      } catch (err) {
        lastError = err
        if (attempt < this.maxAttempts) await sleep(100 * attempt)
      }
    }
    throw lastError
  }

  private async writeOnce(data: Record<string, string>, contentHash: string): Promise<void> {
    const body: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: PROVIDER_NETBLOCKS_CONFIGMAP_NAME,
        namespace: this.namespace,
        labels: { [MANAGED_BY_LABEL]: 'control-api' },
        annotations: { [CONTENT_HASH_ANNOTATION]: contentHash },
      },
      data,
    }
    try {
      await this.coreApi.createNamespacedConfigMap({ namespace: this.namespace, body })
      return
    } catch (err) {
      if (!isErrorCode(err, 409)) throw err
    }
    const existing = await this.coreApi.readNamespacedConfigMap({
      namespace: this.namespace,
      name: PROVIDER_NETBLOCKS_CONFIGMAP_NAME,
    })
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion
    // Preserve foreign annotations (e.g. an operator's netblocks-accept-shrink),
    // only (re)stamping our content-hash — never wipe operator-set metadata.
    body.metadata!.annotations = {
      ...(existing.metadata?.annotations ?? {}),
      [CONTENT_HASH_ANNOTATION]: contentHash,
    }
    await this.coreApi.replaceNamespacedConfigMap({
      namespace: this.namespace,
      name: PROVIDER_NETBLOCKS_CONFIGMAP_NAME,
      body,
    })
  }
}

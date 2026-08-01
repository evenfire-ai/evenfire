import * as k8s from '@kubernetes/client-node'
import { SecretUpsertRequest } from '../types.js'

// A write-side summary of a Secret — NEVER carries `.data` values. Every admin
// secret-write route echoes this, so secret values cannot leave the Secret store
// via an HTTP response body (mirrors the names-only policy in
// routes/admin/secrets.ts). Reads that legitimately need values use `getSecret`,
// which deliberately stays full-fat.
export interface SecretSummary {
  name: string
  namespace: string
  keys: string[]
}

// Trim a k8s write response to a names-only summary. `name`/`namespace` come from
// the request (always defined); `keys` from the returned Secret's data — for a
// merge-patch this is the merged WHOLE keyset, but still only NAMES, never values.
function summarizeSecret(result: unknown, name: string, namespace: string): SecretSummary {
  const data = (result as k8s.V1Secret | undefined)?.data
  return {
    name,
    namespace,
    keys: Object.keys(data ?? {}).sort((a, b) => a.localeCompare(b)),
  }
}

export class SecretService {
  constructor(
    private readonly coreApi: k8s.CoreV1Api,
    private readonly defaultNamespace: string
  ) {}

  async listSecrets(namespace = this.defaultNamespace): Promise<unknown[]> {
    const res = await this.coreApi.listNamespacedSecret({ namespace })
    return (res.items || []).map(s => ({
      metadata: {
        name: s.metadata?.name,
        namespace: s.metadata?.namespace,
        labels: s.metadata?.labels || {},
        annotations: s.metadata?.annotations || {},
      },
      type: s.type,
      keys: Object.keys(s.data || {}).sort((a, b) => a.localeCompare(b)),
    }))
  }

  /**
   * Read a single Secret by name. Throws the underlying K8s client error
   * (including 404) so callers can branch on statusCode.
   */
  async getSecret(name: string, namespace = this.defaultNamespace): Promise<unknown> {
    return this.coreApi.readNamespacedSecret({ namespace, name })
  }

  async createSecret(req: SecretUpsertRequest): Promise<SecretSummary> {
    const ns = req.namespace || this.defaultNamespace
    const body: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: req.name,
        namespace: ns,
        labels: req.labels,
        annotations: req.annotations,
      },
      type: req.type || 'Opaque',
      data: req.data,
      stringData: req.stringData,
    }

    // Names-only return: never surface the created Secret's `.data` to callers.
    const created = await this.coreApi.createNamespacedSecret({ namespace: ns, body })
    return summarizeSecret(created, req.name, ns)
  }

  /**
   * Update a Secret using full-replacement semantics. Stale keys are removed,
   * and the labels/type/data of the previous Secret are overwritten by the
   * payload (with labels/type falling back to the existing Secret's values
   * when the request omits them).
   *
   * Use this for single-owner Secrets where the caller is the source of
   * truth for the whole Secret body — admin /secrets, registry credentials,
   * inter-service token rotation. For multi-owner Secrets where individual
   * keys must survive a partial update, use `mergeSecret` instead.
   */
  async updateSecret(req: SecretUpsertRequest): Promise<SecretSummary> {
    const ns = req.namespace || this.defaultNamespace
    const existing = await this.coreApi.readNamespacedSecret({ namespace: ns, name: req.name })

    const body: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: req.name,
        namespace: ns,
        resourceVersion: existing.metadata?.resourceVersion,
        labels: req.labels || existing.metadata?.labels,
        annotations: req.annotations || existing.metadata?.annotations,
      },
      type: req.type || existing.type || 'Opaque',
      data: req.data,
      stringData: req.stringData,
    }

    // Names-only return: never surface the replaced Secret's `.data` to callers.
    const updated = await this.coreApi.replaceNamespacedSecret({
      namespace: ns,
      name: req.name,
      body,
    })
    return summarizeSecret(updated, req.name, ns)
  }

  /**
   * Update a Secret using merge-patch semantics (RFC 7396). Keys present in
   * `req.stringData`/`req.data` are added or replaced; keys NOT in the patch
   * are preserved on the server side.
   *
   * Use this for multi-owner Secrets where one owner must update its keys
   * without wiping another owner's keys. Concrete case: per-Host channel-
   * reader credentials Secrets — the admin "save channel credentials" flow
   * writes provider keys (telegram-bot-token, slack app keys, email-*) and
   * other owners may add adjacent keys; a full `replaceNamespacedSecret`
   * from one owner would wipe the other owner's keys.
   *
   * Requires `secrets: patch` RBAC verb on the target namespace's Role —
   * currently granted only in `deploy/base/channels/rbac.yaml` for the
   * `control-api-communication-channels` Role. Do NOT call this from
   * routes that target other namespaces unless their Role has been updated.
   */
  async mergeSecret(req: SecretUpsertRequest): Promise<SecretSummary> {
    const ns = req.namespace || this.defaultNamespace

    const body: Partial<k8s.V1Secret> = {}
    if (req.stringData !== undefined) body.stringData = req.stringData
    if (req.data !== undefined) body.data = req.data
    // NOTE: merge-patch on metadata.labels REPLACES the whole labels map (it's
    // a leaf merge — the map IS the leaf). Do not pass req.labels for
    // multi-owner Secrets where another owner (e.g. HCC) writes labels.
    if (req.labels !== undefined) body.metadata = { labels: req.labels }
    if (req.type !== undefined) body.type = req.type

    // Names-only return: the patch response is the merged WHOLE Secret (all keys,
    // including ones the caller did not send) — return only the key NAMES.
    const merged = await this.coreApi.patchNamespacedSecret(
      {
        namespace: ns,
        name: req.name,
        body,
      },
      {
        middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
      }
    )
    return summarizeSecret(merged, req.name, ns)
  }

  async removeSecretKey(req: {
    name: string
    namespace?: string
    key: string
  }): Promise<SecretSummary> {
    const ns = req.namespace || this.defaultNamespace
    const body = { data: { [req.key]: null } } as unknown as Partial<k8s.V1Secret>

    // Names-only return: never surface the patched Secret's remaining `.data`.
    const patched = await this.coreApi.patchNamespacedSecret(
      {
        namespace: ns,
        name: req.name,
        body,
      },
      {
        middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
      }
    )
    return summarizeSecret(patched, req.name, ns)
  }

  async deleteSecret(
    name: string,
    namespace?: string
  ): Promise<{ name: string; namespace: string; deleted: true }> {
    const ns = namespace || this.defaultNamespace
    await this.coreApi.deleteNamespacedSecret({ namespace: ns, name })
    return { name, namespace: ns, deleted: true }
  }
}

import * as k8s from '@kubernetes/client-node'
import { SecretPreconditions, SecretUpsertRequest } from '../types.js'
import { assertValidSecretDataKey, assertValidSecretWriteKeys } from './secretKeys.js'

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

  async createSecret(req: SecretUpsertRequest): Promise<unknown> {
    assertValidSecretWriteKeys(req)
    const body: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: req.name,
        namespace: req.namespace || this.defaultNamespace,
        labels: req.labels,
        annotations: req.annotations,
      },
      type: req.type || 'Opaque',
      data: req.data,
      stringData: req.stringData,
    }

    return this.coreApi.createNamespacedSecret({
      namespace: req.namespace || this.defaultNamespace,
      body,
    })
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
   *
   * Pass `precondition` to make the replace ownership-bound rather than
   * last-writer-wins (see `SecretPreconditions`). When it carries a
   * `resourceVersion` the pre-read is SKIPPED and that version is sent as-is,
   * so the API server rejects the write with 409 if anything touched the
   * object since the caller read it. Re-reading here would defeat the entire
   * point, by refreshing away the staleness we are trying to detect.
   *
   * Because that read is skipped, a precondition caller must supply everything
   * it wants persisted: the `labels`/`annotations`/`type` fallbacks to the
   * existing object are not available on this path.
   */
  async updateSecret(
    req: SecretUpsertRequest,
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    assertValidSecretWriteKeys(req)
    const ns = req.namespace || this.defaultNamespace
    const existing = precondition?.resourceVersion
      ? undefined
      : await this.coreApi.readNamespacedSecret({ namespace: ns, name: req.name })

    const body: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: req.name,
        namespace: ns,
        resourceVersion: precondition?.resourceVersion ?? existing?.metadata?.resourceVersion,
        // Enforced by the API server when set: a replace naming a different uid than the
        // stored object is refused. Free when the caller does not set it.
        ...(precondition?.uid ? { uid: precondition.uid } : {}),
        labels: req.labels || existing?.metadata?.labels,
        annotations: req.annotations || existing?.metadata?.annotations,
      },
      type: req.type || existing?.type || 'Opaque',
      data: req.data,
      stringData: req.stringData,
    }

    return this.coreApi.replaceNamespacedSecret({ namespace: ns, name: req.name, body })
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
   * Requires `secrets: patch` RBAC verb on the target namespace's Role.
   * Granted in `deploy/base/channels/rbac.yaml` (the
   * `control-api-communication-channels` Role, for the channel-reader flow
   * above) and in `deploy/base/mcp-server/rbac.yaml` (the `control-api` Role,
   * for the issue #223 connector credential-rotation route). Do NOT call this
   * from a route targeting any OTHER namespace unless that namespace's Role
   * has been granted `patch`.
   */
  async mergeSecret(req: SecretUpsertRequest): Promise<unknown> {
    assertValidSecretWriteKeys(req)
    const ns = req.namespace || this.defaultNamespace

    const body: Partial<k8s.V1Secret> = {}
    if (req.stringData !== undefined) body.stringData = req.stringData
    if (req.data !== undefined) body.data = req.data
    // NOTE: merge-patch on metadata.labels REPLACES the whole labels map (it's
    // a leaf merge — the map IS the leaf). Do not pass req.labels for
    // multi-owner Secrets where another owner (e.g. HCC) writes labels.
    if (req.labels !== undefined) body.metadata = { labels: req.labels }
    if (req.type !== undefined) body.type = req.type

    return this.coreApi.patchNamespacedSecret(
      {
        namespace: ns,
        name: req.name,
        body,
      },
      {
        middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
      }
    )
  }

  async removeSecretKey(req: { name: string; namespace?: string; key: string }): Promise<unknown> {
    assertValidSecretDataKey(req.key)
    const ns = req.namespace || this.defaultNamespace
    const body = { data: { [req.key]: null } } as unknown as Partial<k8s.V1Secret>

    return this.coreApi.patchNamespacedSecret(
      {
        namespace: ns,
        name: req.name,
        body,
      },
      {
        middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
      }
    )
  }

  /**
   * Delete a Secret by name.
   *
   * Pass `precondition` to bind the delete to a specific object rather than to
   * whatever currently answers to that name (see `SecretPreconditions`). A
   * name-addressed delete is the more dangerous of the two mutations: an
   * ownership check followed by a bare delete will remove a REPLACEMENT object
   * — including one an external owner created in the gap — on the strength of
   * a decision made about something that no longer exists. With `uid` set the
   * API server refuses that with 409 instead.
   */
  async deleteSecret(
    name: string,
    namespace?: string,
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    const hasPrecondition = Boolean(precondition?.uid || precondition?.resourceVersion)
    return this.coreApi.deleteNamespacedSecret({
      namespace: namespace || this.defaultNamespace,
      name,
      ...(hasPrecondition && {
        body: {
          preconditions: {
            ...(precondition?.uid && { uid: precondition.uid }),
            ...(precondition?.resourceVersion && {
              resourceVersion: precondition.resourceVersion,
            }),
          },
        },
      }),
    })
  }
}

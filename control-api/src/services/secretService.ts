import * as k8s from '@kubernetes/client-node'
import { SecretPreconditions, SecretUpsertRequest } from '../types.js'
import {
  type SecretConstraintOptions,
  assertMutablePreservedSecretType,
  assertValidSecretAnnotations,
  assertValidSecretConstraints,
  assertValidSecretType,
  resolveSecretAnnotationsForReplace,
} from './secretConstraints.js'
import { assertValidSecretDataKey, assertValidSecretWriteKeys } from './secretKeys.js'
import { SecretResource, SecretSnapshot, toSecretSnapshot } from './secretRepository.js'

export interface SecretSummary {
  name: string
  namespace: string
  keys: string[]
}

export interface DeleteSecretSummary {
  name: string
  namespace: string
  deleted: true
}

export function toPublicSecretSummary(
  raw: SecretSummary | SecretSnapshot | Record<string, unknown> | null | undefined,
  fallbackName = '',
  fallbackNamespace = ''
): SecretSummary {
  const value = (raw ?? {}) as {
    name?: unknown
    namespace?: unknown
    keys?: unknown
    data?: unknown
    stringData?: unknown
    metadata?: { name?: unknown; namespace?: unknown }
  }
  const name =
    fallbackName ||
    (typeof value.name === 'string' ? value.name : '') ||
    (typeof value.metadata?.name === 'string' ? value.metadata.name : '')
  const namespace =
    fallbackNamespace ||
    (typeof value.namespace === 'string' ? value.namespace : '') ||
    (typeof value.metadata?.namespace === 'string' ? value.metadata.namespace : '')
  const keys = Array.isArray(value.keys)
    ? value.keys.filter((key): key is string => typeof key === 'string')
    : [
        ...Object.keys(
          value.data && typeof value.data === 'object'
            ? (value.data as Record<string, unknown>)
            : {}
        ),
        ...Object.keys(
          value.stringData && typeof value.stringData === 'object'
            ? (value.stringData as Record<string, unknown>)
            : {}
        ),
      ]
  return {
    name,
    namespace,
    keys: [...new Set(keys)].sort((a, b) => a.localeCompare(b)),
  }
}

export function toPublicDeleteSecretSummary(summary: DeleteSecretSummary): DeleteSecretSummary {
  return { name: summary.name, namespace: summary.namespace, deleted: true }
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
        ...(s.metadata?.uid ? { uid: s.metadata.uid } : {}),
        ...(s.metadata?.resourceVersion ? { resourceVersion: s.metadata.resourceVersion } : {}),
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
  async getSecret(name: string, namespace = this.defaultNamespace): Promise<SecretResource> {
    return this.coreApi.readNamespacedSecret({ namespace, name })
  }

  private async createSecretRaw(
    req: SecretUpsertRequest,
    opts?: SecretConstraintOptions
  ): Promise<unknown> {
    assertValidSecretConstraints(req, opts)
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

    const created = await this.coreApi.createNamespacedSecret({
      namespace: req.namespace || this.defaultNamespace,
      body,
    })
    return created
  }

  async createSecretSnapshot(
    req: SecretUpsertRequest,
    opts?: SecretConstraintOptions
  ): Promise<SecretSnapshot> {
    const namespace = req.namespace || this.defaultNamespace
    const created = await this.createSecretRaw(req, opts)
    return toSecretSnapshot(created, req.name, namespace)
  }

  async createSecret(
    req: SecretUpsertRequest,
    opts?: SecretConstraintOptions
  ): Promise<SecretSummary> {
    const namespace = req.namespace || this.defaultNamespace
    const created = await this.createSecretRaw(req, opts)
    return toPublicSecretSummary(created as Record<string, unknown>, req.name, namespace)
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
   * `resourceVersion` the current object is still read so a full replacement
   * cannot drop protected metadata merely because the caller omitted it. The
   * caller's `resourceVersion`/`uid` is sent as-is, so the apiserver remains
   * the authoritative CAS boundary.
   */
  private async updateSecretRaw(
    req: SecretUpsertRequest,
    precondition?: SecretPreconditions,
    opts?: SecretConstraintOptions
  ): Promise<unknown> {
    if (req.type !== undefined) assertValidSecretType(req.type)
    assertValidSecretWriteKeys(req)
    const ns = req.namespace || this.defaultNamespace
    const existing = await this.coreApi.readNamespacedSecret({ namespace: ns, name: req.name })
    assertMutablePreservedSecretType(existing.type)
    assertValidSecretAnnotations(req.annotations, opts, existing.metadata?.annotations)
    const effectiveAnnotations = resolveSecretAnnotationsForReplace(
      existing?.metadata?.annotations,
      req.annotations,
      opts
    )

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
        annotations: effectiveAnnotations,
        ...(existing?.metadata?.ownerReferences
          ? { ownerReferences: existing.metadata.ownerReferences }
          : {}),
        ...(existing?.metadata?.finalizers ? { finalizers: existing.metadata.finalizers } : {}),
      },
      type: req.type ?? existing?.type ?? 'Opaque',
      data: req.data,
      stringData: req.stringData,
      ...(typeof existing?.immutable === 'boolean' ? { immutable: existing.immutable } : {}),
    }

    // Explicit types passed the write allowlist above. A preserved type is
    // mutable unless it belongs to a Kubernetes or Helm-managed Secret.
    const replaced = await this.coreApi.replaceNamespacedSecret({
      namespace: ns,
      name: req.name,
      body,
    })
    return replaced
  }

  async updateSecretSnapshot(
    req: SecretUpsertRequest,
    precondition?: SecretPreconditions,
    opts?: SecretConstraintOptions
  ): Promise<SecretSnapshot> {
    const namespace = req.namespace || this.defaultNamespace
    const replaced = await this.updateSecretRaw(req, precondition, opts)
    return toSecretSnapshot(replaced, req.name, namespace)
  }

  async updateSecret(
    req: SecretUpsertRequest,
    precondition?: SecretPreconditions,
    opts?: SecretConstraintOptions
  ): Promise<SecretSummary> {
    const namespace = req.namespace || this.defaultNamespace
    const replaced = await this.updateSecretRaw(req, precondition, opts)
    return toPublicSecretSummary(replaced as Record<string, unknown>, req.name, namespace)
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
  private async mergeSecretRaw(
    req: SecretUpsertRequest,
    opts?: SecretConstraintOptions,
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    if (req.type !== undefined) assertValidSecretType(req.type)
    assertValidSecretWriteKeys(req)
    const ns = req.namespace || this.defaultNamespace
    const existing = await this.coreApi.readNamespacedSecret({ namespace: ns, name: req.name })
    assertMutablePreservedSecretType(existing.type)
    assertValidSecretAnnotations(req.annotations, opts, existing.metadata?.annotations)
    const effectiveAnnotations = resolveSecretAnnotationsForReplace(
      existing.metadata?.annotations,
      req.annotations,
      opts
    )

    const body: Partial<k8s.V1Secret> = {}
    if (req.stringData !== undefined) body.stringData = req.stringData
    if (req.data !== undefined) body.data = req.data
    // RFC 7396 merges object members recursively. The labels map therefore
    // preserves omitted labels; callers that intend to replace the complete
    // map must use updateSecret. A metadata merge without an explicit identity
    // fence carries the version read above so two writers cannot silently
    // replace each other's metadata map. A data-only merge may carry a UID
    // fence without a resourceVersion: that preserves delete/recreate safety
    // while allowing independent owners to update disjoint data keys.
    if (
      req.labels !== undefined ||
      req.annotations !== undefined ||
      precondition?.uid !== undefined ||
      precondition?.resourceVersion !== undefined
    ) {
      body.metadata = {
        ...(req.labels !== undefined ? { labels: req.labels } : {}),
        ...(req.annotations !== undefined ? { annotations: effectiveAnnotations } : {}),
        ...(precondition?.resourceVersion
          ? { resourceVersion: precondition.resourceVersion }
          : !precondition?.uid &&
              (req.labels !== undefined || req.annotations !== undefined) &&
              existing.metadata?.resourceVersion
            ? { resourceVersion: existing.metadata.resourceVersion }
            : {}),
        ...(precondition?.uid ? { uid: precondition.uid } : {}),
      }
    }
    if (req.type !== undefined) body.type = req.type

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
    return patched
  }

  async mergeSecretSnapshot(
    req: SecretUpsertRequest,
    opts?: SecretConstraintOptions,
    precondition?: SecretPreconditions
  ): Promise<SecretSnapshot> {
    const namespace = req.namespace || this.defaultNamespace
    const patched = await this.mergeSecretRaw(req, opts, precondition)
    return toSecretSnapshot(patched, req.name, namespace)
  }

  async mergeSecret(
    req: SecretUpsertRequest,
    opts?: SecretConstraintOptions,
    precondition?: SecretPreconditions
  ): Promise<SecretSummary> {
    const namespace = req.namespace || this.defaultNamespace
    const patched = await this.mergeSecretRaw(req, opts, precondition)
    return toPublicSecretSummary(patched as Record<string, unknown>, req.name, namespace)
  }

  private async removeSecretKeyRaw(
    req: {
      name: string
      namespace?: string
      key: string
    },
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    assertValidSecretDataKey(req.key)
    const ns = req.namespace || this.defaultNamespace
    const existing = await this.coreApi.readNamespacedSecret({ namespace: ns, name: req.name })

    // Removing one data key still mutates the Secret, so controller-owned
    // Secret types remain off limits here too.
    assertMutablePreservedSecretType(existing.type ?? 'Opaque')

    const body = {
      ...(precondition && {
        metadata: {
          ...(precondition.uid ? { uid: precondition.uid } : {}),
          ...(precondition.resourceVersion
            ? { resourceVersion: precondition.resourceVersion }
            : {}),
        },
      }),
      data: { [req.key]: null },
    } as unknown as Partial<k8s.V1Secret>

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
    return patched
  }

  async removeSecretKeySnapshot(
    req: {
      name: string
      namespace?: string
      key: string
    },
    precondition?: SecretPreconditions
  ): Promise<SecretSnapshot> {
    const namespace = req.namespace || this.defaultNamespace
    const patched = await this.removeSecretKeyRaw(req, precondition)
    return toSecretSnapshot(patched, req.name, namespace)
  }

  async removeSecretKey(
    req: {
      name: string
      namespace?: string
      key: string
    },
    precondition?: SecretPreconditions
  ): Promise<SecretSummary> {
    const namespace = req.namespace || this.defaultNamespace
    const patched = await this.removeSecretKeyRaw(req, precondition)
    return toPublicSecretSummary(patched as Record<string, unknown>, req.name, namespace)
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
  ): Promise<DeleteSecretSummary> {
    const hasPrecondition = Boolean(precondition?.uid || precondition?.resourceVersion)
    await this.coreApi.deleteNamespacedSecret({
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
    return toPublicDeleteSecretSummary({
      name,
      namespace: namespace || this.defaultNamespace,
      deleted: true,
    })
  }
}

import * as k8s from '@kubernetes/client-node'
import {
  CLERUM_GROUP,
  CLERUM_VERSION,
  ClerumResource,
  ClerumResourceType,
  ResourceListResponse,
} from '../types.js'
import {
  addNonEmpty,
  extractK8sStatus,
  kindFromPlural,
  parseProjectedGeneration,
} from './resourceServiceHelpers.js'
import { currentAdministrativeRequestContext } from './tracing/adminOperationContext.js'
import {
  ControlApiAdministrativeOperationService,
  type HostAdministrativeAction,
  type HostAdministrativeIntent,
  stripAdministrativeIntentAnnotation,
  withAdministrativeIntentAnnotation,
} from './tracing/adminOperationService.js'

let administrativeOperationService: ControlApiAdministrativeOperationService | null = null

export function setAdministrativeOperationService(
  service: ControlApiAdministrativeOperationService | null
): void {
  administrativeOperationService = service
}

export class K8sNotFoundError extends Error {
  readonly httpStatus = 404
  constructor(message: string) {
    super(message)
    this.name = 'K8sNotFoundError'
  }
}

/**
 * AP-6 (docs/architecture/stateless-invariants.md): the caller supplied the
 * resourceVersion it READ and the object changed since that read. Retrying
 * would re-apply the same stale payload over the concurrent write, so the
 * conflict is surfaced to the caller instead of being retried away.
 */
export class K8sConflictError extends Error {
  readonly httpStatus = 409
  constructor(message: string) {
    super(message)
    this.name = 'K8sConflictError'
  }
}

export type ResourceListPage = Readonly<{
  items: readonly unknown[]
  continueToken: string | null
  resourceVersion: string
}>

type BoundedKubernetesRequest = Readonly<{
  signal: AbortSignal
  timeoutSeconds: number
}>

type KubernetesCallOptions = k8s.ConfigurationOptions<k8s.ObservableMiddleware>

function kubernetesAbortOptions(signal: AbortSignal): KubernetesCallOptions {
  const middleware: k8s.ObservableMiddleware = {
    pre: context => {
      context.setSignal(signal)
      return new k8s.Observable(Promise.resolve(context))
    },
    post: context => new k8s.Observable(Promise.resolve(context)),
  }
  return {
    middleware: [middleware],
    middlewareMergeStrategy: 'append',
  }
}

async function runKubernetesTransportCall<T>(
  signal: AbortSignal,
  invoke: (options: KubernetesCallOptions) => Promise<T>
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('request aborted')
  const result = await invoke(kubernetesAbortOptions(signal))
  if (signal.aborted) throw signal.reason ?? new Error('request aborted')
  return result
}

export type MutableResourceSnapshot = {
  metadata?: {
    annotations?: Record<string, string>
    labels?: Record<string, string>
    resourceVersion?: string
    generation?: number
  }
  spec?: Record<string, unknown>
}

type ResourceMutation = {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
  spec: Record<string, unknown>
} | null

/** Annotation keys under this prefix are platform-owned write-only projections. */
const PLATFORM_ANNOTATION_PREFIX = 'clerum.io/'

function isHostResource(plural: ClerumResourceType): boolean {
  return plural === 'hosts'
}

async function persistHostIntent(input: {
  plural: ClerumResourceType
  action: HostAdministrativeAction
  namespace: string
  name: string
}): Promise<HostAdministrativeIntent | null> {
  if (!isHostResource(input.plural) || !administrativeOperationService) return null
  const requestContext = currentAdministrativeRequestContext()
  if (!requestContext) return null
  return administrativeOperationService.persistHostIntent({
    action: input.action,
    namespace: input.namespace,
    name: input.name,
    operatorSub: requestContext.operatorSub,
    requestId: requestContext.requestId,
  })
}

async function persistHostFailure(intent: HostAdministrativeIntent | null): Promise<void> {
  if (!intent || !administrativeOperationService) return
  await administrativeOperationService.persistHostOutcome(
    intent,
    'failed',
    'kubernetes_write_failed'
  )
}

/**
 * Merge annotations for a full-replace write (updateResource/mutateResource).
 *
 * - `incoming === undefined` — the caller did not touch annotations: the
 *   server's current map survives verbatim (legacy behavior).
 * - `incoming` provided — caller-owned keys keep replace semantics (the
 *   incoming map wins per key, omission clears), but platform-owned
 *   `clerum.io/*` keys present on the server are re-added unless the caller
 *   EXPLICITLY sets that exact key. Platform annotations are write-only
 *   projections owned by control-api/HCC (e.g. `clerum.io/wake-requested`,
 *   see hostWakeService.ts) — an admin PUT that happens to carry an
 *   annotations map must never erase them (AP-6 companion fix).
 */
export function mergeAnnotationsForReplace(
  current: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (incoming === undefined) return current
  const merged: Record<string, string> = { ...incoming }
  for (const [key, value] of Object.entries(current ?? {})) {
    if (key.startsWith(PLATFORM_ANNOTATION_PREFIX) && !(key in incoming)) {
      merged[key] = value
    }
  }
  return merged
}

export class ResourceService {
  // Allowed namespaces derived from config at construction time.
  private readonly allowedNamespaces: Set<string>

  constructor(
    private readonly customApi: k8s.CustomObjectsApi,
    private readonly defaultNamespace: string,
    // Supports string (single namespace) or string[] (multiple namespaces for list operations).
    // The first element of an array is used as the primary namespace for create/get/update/delete.
    private readonly defaultNamespaces: Partial<Record<ClerumResourceType, string | string[]>>
  ) {
    // Build allowed set from all configured namespaces + the default
    const nsSet = new Set<string>([this.defaultNamespace])
    for (const ns of Object.values(this.defaultNamespaces)) {
      addNonEmpty(nsSet, ns)
    }
    this.allowedNamespaces = nsSet
  }

  private resolveNamespace(plural: ClerumResourceType, namespace?: string): string {
    if (namespace && namespace.trim()) {
      const ns = namespace.trim()
      if (!this.allowedNamespaces.has(ns)) {
        throw new Error(`Namespace not allowed: ${ns}`)
      }
      return ns
    }
    const configured = this.defaultNamespaces[plural]
    // For arrays, the first entry is the primary (creation) namespace.
    const primary = Array.isArray(configured) ? configured[0] : configured
    return primary || this.defaultNamespace
  }

  assertNamespaceAllowed(namespace: string): void {
    if (!this.allowedNamespaces.has(namespace)) {
      throw new Error(`Namespace not allowed: ${namespace}`)
    }
  }

  private listNamespacesForPlural(plural: ClerumResourceType): string[] {
    const namespaces = new Set<string>()
    addNonEmpty(namespaces, this.defaultNamespaces[plural])
    addNonEmpty(namespaces, this.defaultNamespace)
    return Array.from(namespaces)
  }

  async listResource(plural: ClerumResourceType, namespace?: string): Promise<unknown[]> {
    if (namespace === '*') {
      const items: unknown[] = []
      for (const nsName of this.listNamespacesForPlural(plural)) {
        try {
          const namespaced = (await this.customApi.listNamespacedCustomObject({
            group: CLERUM_GROUP,
            version: CLERUM_VERSION,
            namespace: nsName,
            plural,
          })) as unknown as ResourceListResponse
          items.push(...(namespaced.items || []))
        } catch {
          // Ignore namespaces where the resource is absent/inaccessible.
        }
      }
      return items
    }

    const resolvedNamespace = this.resolveNamespace(plural, namespace)
    const res = (await this.customApi.listNamespacedCustomObject({
      group: CLERUM_GROUP,
      version: CLERUM_VERSION,
      namespace: resolvedNamespace,
      plural,
    })) as unknown as ResourceListResponse
    return res.items || []
  }

  async listResourcePage(
    plural: ClerumResourceType,
    namespace: string,
    options: BoundedKubernetesRequest & {
      limit: number
      continueToken?: string
      resourceVersion?: string
    }
  ): Promise<ResourceListPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('Kubernetes list limit must be between 1 and 100')
    }
    if (
      !Number.isSafeInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 1 ||
      options.timeoutSeconds > 60
    ) {
      throw new Error('Kubernetes request timeout must be between 1 and 60 seconds')
    }
    const resolvedNamespace = this.resolveNamespace(plural, namespace)
    const response = (await runKubernetesTransportCall(options.signal, callOptions =>
      this.customApi.listNamespacedCustomObject(
        {
          group: CLERUM_GROUP,
          version: CLERUM_VERSION,
          namespace: resolvedNamespace,
          plural,
          limit: options.limit,
          _continue: options.continueToken,
          resourceVersion: options.resourceVersion,
          timeoutSeconds: options.timeoutSeconds,
        },
        callOptions
      )
    )) as ResourceListResponse
    const resourceVersion = String(response.metadata?.resourceVersion || '').trim()
    if (!resourceVersion) throw new Error('Kubernetes list response omitted resourceVersion')
    return Object.freeze({
      items: Object.freeze([...(response.items ?? [])]),
      continueToken: String(response.metadata?.continue || '').trim() || null,
      resourceVersion,
    })
  }

  async getResourceExact(
    plural: ClerumResourceType,
    name: string,
    namespace: string,
    options: BoundedKubernetesRequest
  ): Promise<unknown> {
    if (
      !Number.isSafeInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 1 ||
      options.timeoutSeconds > 60
    ) {
      throw new Error('Kubernetes request timeout must be between 1 and 60 seconds')
    }
    const resolvedNamespace = this.resolveNamespace(plural, namespace)
    try {
      return await runKubernetesTransportCall(options.signal, callOptions =>
        this.customApi.getNamespacedCustomObject(
          {
            group: CLERUM_GROUP,
            version: CLERUM_VERSION,
            namespace: resolvedNamespace,
            plural,
            name,
          },
          callOptions
        )
      )
    } catch (error) {
      if (extractK8sStatus(error) === 404) {
        throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${resolvedNamespace}`)
      }
      throw error
    }
  }

  async getResource(
    plural: ClerumResourceType,
    name: string,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    try {
      return await this.customApi.getNamespacedCustomObject({
        group: CLERUM_GROUP,
        version: CLERUM_VERSION,
        namespace: ns,
        plural,
        name,
      })
    } catch (err) {
      const status = extractK8sStatus(err)
      if (namespace && namespace.trim()) {
        if (status === 404) {
          throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${ns}`)
        }
        throw err
      }
      if (status !== 404 && status !== null) {
        throw err
      }
      const items = (await this.listResource(plural, '*')) as Array<{
        metadata?: { name?: string }
      }>
      const match = items.find(i => i.metadata?.name === name)
      if (!match)
        throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${ns} or cluster-wide`)
      return match
    }
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
    // Namespaces are determined by the HTTP layer from server-side config; the
    // service intentionally ignores any namespace the body might carry.
    const ns = this.resolveNamespace(plural, namespace)
    const intent = await persistHostIntent({
      plural,
      action: 'create',
      namespace: ns,
      name: body.metadata.name,
    })
    const sanitizedMetadata = stripAdministrativeIntentAnnotation(body.metadata) ?? body.metadata
    const annotations = intent
      ? withAdministrativeIntentAnnotation(sanitizedMetadata.annotations, intent, 1)
      : sanitizedMetadata.annotations
    const resource: ClerumResource = {
      apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
      kind: kindFromPlural(plural),
      metadata: {
        name: body.metadata.name,
        namespace: ns,
        ...(sanitizedMetadata.labels && { labels: sanitizedMetadata.labels }),
        ...(annotations && { annotations }),
      },
      spec: body.spec,
    }

    try {
      return await this.customApi.createNamespacedCustomObject({
        group: CLERUM_GROUP,
        version: CLERUM_VERSION,
        namespace: ns,
        plural,
        body: resource,
      })
    } catch (err) {
      await persistHostFailure(intent)
      throw err
    }
  }

  async updateResource(
    plural: ClerumResourceType,
    name: string,
    body: {
      metadata?: {
        labels?: Record<string, string>
        annotations?: Record<string, string>
        /**
         * AP-6 — reader's-version precondition. When present, this is the
         * resourceVersion the CALLER READ (e.g. the version the control-ui
         * edit form was built from). It is used as the replace precondition
         * INSTEAD of the server's current version, and a 409 surfaces as
         * K8sConflictError without retrying: re-reading only to re-apply the
         * same stale payload is the lost-update bug optimistic concurrency
         * exists to prevent. When absent, legacy last-write-wins behavior is
         * preserved (server-version precondition + bounded retry) for
         * API-only callers that intentionally replace whatever is current.
         */
        resourceVersion?: string
      }
      spec: Record<string, unknown>
    },
    namespace?: string,
    options?: {
      /**
       * N1 — a CR snapshot the caller ALREADY read for this same object (e.g.
       * the admin PUT ratchet read in resources.ts). When present it is reused
       * for the FIRST replace attempt instead of issuing a second apiserver
       * GET, collapsing the per-PUT read count from 2 to 1. On a 409 retry the
       * loop falls back to a fresh read (the pre-read is stale by definition),
       * so the last-write-wins semantics are unchanged. Never used past
       * attempt 1.
       */
      preReadCurrent?: MutableResourceSnapshot
    }
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    const intent = await persistHostIntent({ plural, action: 'update', namespace: ns, name })
    const readerResourceVersion = body.metadata?.resourceVersion || undefined
    // With a reader-supplied precondition a retry can never succeed with the
    // same payload, so the loop collapses to a single attempt.
    const maxAttempts = readerResourceVersion ? 1 : 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = (
        attempt === 1 && options?.preReadCurrent
          ? options.preReadCurrent
          : await this.getResource(plural, name, ns)
      ) as {
        metadata?: {
          annotations?: Record<string, string>
          labels?: Record<string, string>
          resourceVersion?: string
          generation?: number
        }
      }

      const sanitizedMetadata = stripAdministrativeIntentAnnotation(body.metadata)
      const mergedAnnotations = mergeAnnotationsForReplace(
        current.metadata?.annotations,
        sanitizedMetadata?.annotations
      )
      const annotations = intent
        ? withAdministrativeIntentAnnotation(
            mergedAnnotations,
            intent,
            Math.max(1, (current.metadata?.generation ?? 0) + 1)
          )
        : mergedAnnotations
      const resource: ClerumResource = {
        apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
        kind: kindFromPlural(plural),
        metadata: {
          name,
          namespace: ns,
          ...(current.metadata?.labels && { labels: current.metadata.labels }),
          ...(sanitizedMetadata?.labels && { labels: sanitizedMetadata.labels }),
          ...(annotations && { annotations }),
        },
        spec: body.spec,
      }

      try {
        return await this.customApi.replaceNamespacedCustomObject({
          group: CLERUM_GROUP,
          version: CLERUM_VERSION,
          namespace: ns,
          plural,
          name,
          body: {
            ...resource,
            metadata: {
              ...resource.metadata,
              resourceVersion: readerResourceVersion ?? current.metadata?.resourceVersion,
            },
          },
        })
      } catch (err) {
        if (extractK8sStatus(err) === 409) {
          if (readerResourceVersion) {
            await persistHostFailure(intent)
            throw new K8sConflictError(
              `${plural}/${name} changed since it was read (stale resourceVersion ${readerResourceVersion})`
            )
          }
          if (attempt < maxAttempts) {
            continue
          }
        }
        await persistHostFailure(intent)
        throw err
      }
    }
    throw new Error(`Failed to update ${plural}/${name} after ${maxAttempts} attempts`)
  }

  /**
   * Merge-patch ONLY metadata.annotations of a custom object.
   *
   * Unlike updateResource/mutateResource this is a single server-side JSON
   * merge patch: no read-modify-write, no resourceVersion, no retry loop —
   * concurrent full replaces (e.g. the admin facade) cannot clobber it and it
   * cannot clobber them. Used for write-only annotation projections such as
   * `clerum.io/wake-requested`.
   */
  async patchResourceAnnotations(
    plural: ClerumResourceType,
    name: string,
    annotations: Record<string, string>,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    try {
      return await this.customApi.patchNamespacedCustomObject(
        {
          group: CLERUM_GROUP,
          version: CLERUM_VERSION,
          namespace: ns,
          plural,
          name,
          body: { metadata: { annotations } },
        },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
      )
    } catch (err) {
      if (extractK8sStatus(err) === 404) {
        throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${ns}`)
      }
      throw err
    }
  }

  /**
   * Monotonically project a single numeric annotation whose value must never
   * regress under concurrent writers.
   *
   * Why this exists (and why a blind `patchResourceAnnotations` merge patch is
   * unsafe here): the wake generation is a strictly monotonic counter in
   * Postgres (the source of truth). The annotation is only a WRITE-ONLY
   * PROJECTION of that counter for HCC to observe. A blind merge patch carries
   * no ordering guarantee — with coalesce-window = 0 or control-api replicas
   * > 1, a slower gen=5 patch can land AFTER a faster gen=6 patch and REGRESS
   * the projected annotation. HCC advances `wakeHandledGeneration` up to the
   * value it observes; a regressed projection can briefly exceed the projected
   * value and SUPPRESS a later legitimate wake event. Bounded (the host still
   * wakes via resync) but it violates the "strictly monotonic projection"
   * invariant this projection is supposed to uphold.
   *
   * Fix: max-semantics with an optimistic-concurrency precondition.
   *   - Read the current projected value. If it is already >= the new
   *     generation, do NOT patch (never regress).
   *   - Otherwise merge-patch the annotation WITH the object's
   *     `metadata.resourceVersion` as a precondition. The apiserver rejects
   *     the patch with 409 if the object changed since the read; on 409 we
   *     re-read and re-evaluate max-semantics, which also lets a concurrent
   *     higher-generation write win the race.
   * The generation itself always comes from Postgres — this method only
   * decides WHETHER (and with which precondition) to project it.
   */
  async patchAnnotationMonotonic(
    plural: ClerumResourceType,
    name: string,
    annotationKey: string,
    generation: number,
    namespace?: string
  ): Promise<unknown> {
    if (!Number.isFinite(generation) || generation < 0 || !Number.isInteger(generation)) {
      throw new Error(
        `patchAnnotationMonotonic: generation must be a non-negative integer, got ${generation}`
      )
    }
    const ns = this.resolveNamespace(plural, namespace)
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = (await this.getResource(plural, name, ns)) as {
        metadata?: {
          annotations?: Record<string, string>
          resourceVersion?: string
        }
      }
      const projected = parseProjectedGeneration(current.metadata?.annotations?.[annotationKey])
      if (projected !== null && projected >= generation) {
        // The annotation already projects an equal-or-higher generation.
        // Patching would regress (lower value) or be a no-op (equal value):
        // in both cases skip, preserving the monotonic invariant.
        return current
      }

      const resourceVersion = current.metadata?.resourceVersion
      if (!resourceVersion) {
        // Fail loud: without a resourceVersion we cannot enforce the
        // optimistic-concurrency precondition, so a blind patch could regress
        // the projection — exactly the bug this method exists to prevent.
        throw new Error(
          `patchAnnotationMonotonic: ${plural}/${name} has no metadata.resourceVersion; cannot project ${annotationKey} safely`
        )
      }

      try {
        // metadata.resourceVersion in a merge-patch body is honored by the
        // apiserver as an optimistic-concurrency precondition: the patch is
        // rejected with 409 if the object changed since the read above.
        return await this.customApi.patchNamespacedCustomObject(
          {
            group: CLERUM_GROUP,
            version: CLERUM_VERSION,
            namespace: ns,
            plural,
            name,
            body: {
              metadata: {
                resourceVersion,
                annotations: { [annotationKey]: String(generation) },
              },
            },
          },
          k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
        )
      } catch (err) {
        const status = extractK8sStatus(err)
        if (status === 404) {
          throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${ns}`)
        }
        if (status === 409 && attempt < maxAttempts) {
          // The object changed under us (concurrent projection or unrelated
          // metadata write). Re-read and re-evaluate max-semantics.
          continue
        }
        throw err
      }
    }
    throw new Error(
      `patchAnnotationMonotonic: failed to project ${annotationKey}=${generation} onto ${plural}/${name} after ${maxAttempts} attempts`
    )
  }

  async mutateResource(
    plural: ClerumResourceType,
    name: string,
    mutate: (current: MutableResourceSnapshot) => ResourceMutation | Promise<ResourceMutation>,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    let intent: HostAdministrativeIntent | null = null
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = (await this.getResource(plural, name, ns)) as MutableResourceSnapshot
      const next = await mutate(current)
      if (!next) {
        return current
      }
      if (!intent) {
        intent = await persistHostIntent({ plural, action: 'config', namespace: ns, name })
      }

      const sanitizedMetadata = stripAdministrativeIntentAnnotation(next.metadata)
      // Same per-key merge as updateResource: platform-owned clerum.io/*
      // annotations survive unless the mutation explicitly sets that key.
      const mergedAnnotations = mergeAnnotationsForReplace(
        current.metadata?.annotations,
        sanitizedMetadata?.annotations
      )
      const annotations = intent
        ? withAdministrativeIntentAnnotation(
            mergedAnnotations,
            intent,
            Math.max(1, (current.metadata?.generation ?? 0) + 1)
          )
        : mergedAnnotations
      const resource: ClerumResource = {
        apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
        kind: kindFromPlural(plural),
        metadata: {
          name,
          namespace: ns,
          ...(current.metadata?.labels && { labels: current.metadata.labels }),
          ...(sanitizedMetadata?.labels && { labels: sanitizedMetadata.labels }),
          ...(annotations && { annotations }),
        },
        spec: next.spec,
      }

      try {
        return await this.customApi.replaceNamespacedCustomObject({
          group: CLERUM_GROUP,
          version: CLERUM_VERSION,
          namespace: ns,
          plural,
          name,
          body: {
            ...resource,
            metadata: {
              ...resource.metadata,
              resourceVersion: current.metadata?.resourceVersion,
            },
          },
        })
      } catch (err) {
        if (extractK8sStatus(err) === 409 && attempt < maxAttempts) {
          continue
        }
        await persistHostFailure(intent)
        throw err
      }
    }
    throw new Error(`Failed to mutate ${plural}/${name} after ${maxAttempts} attempts`)
  }

  async deleteResource(
    plural: ClerumResourceType,
    name: string,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    const intent = await persistHostIntent({ plural, action: 'delete', namespace: ns, name })
    try {
      const deleted = await this.customApi.deleteNamespacedCustomObject({
        group: CLERUM_GROUP,
        version: CLERUM_VERSION,
        namespace: ns,
        plural,
        name,
      })
      if (intent && administrativeOperationService) {
        await administrativeOperationService.persistHostOutcome(intent, 'succeeded', 'deleted')
      }
      return deleted
    } catch (err) {
      await persistHostFailure(intent)
      throw err
    }
  }

  // Merge-patches a CRD's /status subresource. Used by the recipe retry
  // endpoint to drive the state-machine transition out of the terminal
  // `failed` phase without going through a full spec update.
  async patchResourceStatus(
    plural: ClerumResourceType,
    name: string,
    statusPatch: Record<string, unknown>,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    return this.customApi.patchNamespacedCustomObjectStatus(
      {
        group: CLERUM_GROUP,
        version: CLERUM_VERSION,
        namespace: ns,
        plural,
        name,
        body: { status: statusPatch },
      },
      { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
    )
  }
}

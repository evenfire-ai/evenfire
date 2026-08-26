import * as k8s from '@kubernetes/client-node'

/** Extract HTTP status code from a K8s client error (handles both error formats). */
export function getErrorCode(error: unknown): number | undefined {
  const e = error as { code?: number; response?: { statusCode?: number } }
  return e.code ?? e.response?.statusCode
}

/**
 * Re-read + replace with optimistic-lock retry. K8s rejects a replace whose
 * `metadata.resourceVersion` does not match the current value; the only
 * recovery is read-modify-write. Concurrent reconcilers (McpServer/Context/
 * Host watch events firing for the same downstream resource) routinely race
 * here, so we retry up to maxAttempts times before propagating.
 *
 * Between attempts we sleep a jittered backoff so concurrent retriers don't
 * lockstep-collide on the same resourceVersion. Without jitter, N watchers
 * all read the same RV, all attempt replace, all but one fail, all retry
 * simultaneously, repeat — amplifying API load instead of converging.
 */
export async function replaceWithConflictRetry<
  T extends { metadata?: { resourceVersion?: string } },
>(opts: {
  description: string
  logPrefix: string
  body: T
  /** Rebuild mutable desired state immediately before each replace attempt. */
  resolveBody?: () => T | Promise<T>
  read: () => Promise<T>
  replace: (body: T) => Promise<unknown>
  mergeExisting?: (body: T, existing: T) => T
  /**
   * Called after the desired object has been merged with server-owned fields.
   * Returning true avoids a no-op replace (and therefore avoids a needless
   * resourceVersion/generation bump) while retaining the conflict-retry path
   * when a meaningful change is still required.
   */
  isUpToDate?: (body: T, existing: T) => boolean
  /** Reject an object whose identity or ownership is unsafe to replace. */
  validateExisting?: (existing: T) => void
  /** Rechecked immediately before every Kubernetes write attempt. */
  mutationAllowed?: () => boolean
  maxAttempts?: number
}): Promise<void> {
  const {
    description,
    logPrefix,
    body,
    resolveBody,
    read,
    replace,
    mergeExisting,
    isUpToDate,
    validateExisting,
    mutationAllowed,
    maxAttempts = 3,
  } = opts
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = await read()
    validateExisting?.(existing)
    const desired = resolveBody ? await resolveBody() : body
    const base: T = {
      ...desired,
      metadata: { ...desired.metadata, resourceVersion: existing.metadata?.resourceVersion },
    }
    const next = mergeExisting ? mergeExisting(base, existing) : base
    if (isUpToDate?.(next, existing)) return
    if (mutationAllowed && !mutationAllowed()) return
    try {
      await replace(next)
      const suffix = attempt > 1 ? ` (after ${attempt} attempts)` : ''
      console.log(`${logPrefix} Updated ${description}${suffix}`)
      return
    } catch (err) {
      if (getErrorCode(err) === 409 && attempt < maxAttempts) {
        // Jittered backoff: 25–125ms on attempt 1, 50–250ms on attempt 2.
        const baseMs = 25 * attempt
        const jitterMs = Math.floor(Math.random() * baseMs * 4)
        await new Promise(r => setTimeout(r, baseMs + jitterMs))
        continue
      }
      throw err
    }
  }
}

function mergeAnnotations(
  desired?: Record<string, string>,
  existing?: Record<string, string>
): Record<string, string> | undefined {
  const merged = { ...(existing ?? {}), ...(desired ?? {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Preserve operator/runtime annotations while keeping controller-authored labels
 * and specs authoritative. This intentionally does not preserve arbitrary
 * labels because Clerum ownership and cleanup depend on them.
 */
export function preserveObjectAnnotations<
  T extends { metadata?: { annotations?: Record<string, string> } },
>(desired: T, existing: T): T {
  const annotations = mergeAnnotations(
    desired.metadata?.annotations,
    existing.metadata?.annotations
  )
  return {
    ...desired,
    metadata: {
      ...desired.metadata,
      annotations,
    },
  }
}

/**
 * Preserve Deployment annotations at both object and pod-template level.
 * Pod-template annotations include operational restart markers such as
 * kubectl.kubernetes.io/restartedAt.
 */
export function preserveDeploymentAnnotations<
  T extends {
    metadata?: { annotations?: Record<string, string> }
    spec?: { template?: { metadata?: { annotations?: Record<string, string> } } }
  },
>(desired: T, existing: T): T {
  const objectPreserved = preserveObjectAnnotations(desired, existing)
  const templateAnnotations = mergeAnnotations(
    desired.spec?.template?.metadata?.annotations,
    existing.spec?.template?.metadata?.annotations
  )

  return {
    ...objectPreserved,
    spec: {
      ...objectPreserved.spec,
      template: {
        ...objectPreserved.spec?.template,
        metadata: {
          ...objectPreserved.spec?.template?.metadata,
          annotations: templateAnnotations,
        },
      },
    },
  }
}

/**
 * Preserve immutable Service fields assigned by Kubernetes while keeping the
 * desired Service spec otherwise authoritative.
 */
export function preserveServiceAssignedFields<
  T extends {
    metadata?: { annotations?: Record<string, string> }
    spec?: {
      clusterIP?: string
      clusterIPs?: string[]
      ipFamilies?: string[]
      ipFamilyPolicy?: string
    }
  },
>(desired: T, existing: T): T {
  const next = preserveObjectAnnotations(desired, existing)
  return {
    ...next,
    spec: {
      ...next.spec,
      clusterIP: existing.spec?.clusterIP ?? next.spec?.clusterIP,
      clusterIPs: existing.spec?.clusterIPs ?? next.spec?.clusterIPs,
      ipFamilies: existing.spec?.ipFamilies ?? next.spec?.ipFamilies,
      ipFamilyPolicy: existing.spec?.ipFamilyPolicy ?? next.spec?.ipFamilyPolicy,
    },
  }
}

/**
 * True when the merged desired Service is equivalent to the live object, so a
 * replace would be a no-op. Canonicalize first: the apiserver default-fills
 * type/sessionAffinity/internalTrafficPolicy/protocol and omitted targetPort,
 * and key order is not stable (#307). Arrays stay in author order (#214).
 * Doubt or a malformed object returns false (fail-open-to-write).
 */
export function serviceMatchesDesired(
  desired: k8s.V1Service | undefined,
  existing: k8s.V1Service | undefined
): boolean {
  try {
    if (!desired?.spec || !existing?.spec) return false
    return (
      JSON.stringify(normalizeServiceForComparison(desired)) ===
      JSON.stringify(normalizeServiceForComparison(existing))
    )
  } catch {
    return false
  }
}

function normalizeServiceForComparison(service: k8s.V1Service): unknown {
  const normalized = structuredClone(service)
  delete normalized.status
  delete normalized.metadata?.resourceVersion
  delete normalized.metadata?.uid
  delete normalized.metadata?.generation
  delete normalized.metadata?.creationTimestamp
  delete normalized.metadata?.managedFields
  delete normalized.metadata?.selfLink

  const spec = normalized.spec
  if (spec) {
    if (spec.type === 'ClusterIP') delete spec.type
    if (spec.sessionAffinity === 'None') delete spec.sessionAffinity
    if (spec.internalTrafficPolicy === 'Cluster') delete spec.internalTrafficPolicy
    for (const port of spec.ports ?? []) {
      if (port.protocol === 'TCP') delete port.protocol
      if (port.targetPort === undefined) port.targetPort = port.port
    }
  }

  return normalizeServiceValue(normalized)
}

function normalizeServiceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeServiceValue)
  if (!isServiceObject(value)) return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    if (entry !== undefined) normalized[key] = normalizeServiceValue(entry)
  }
  return normalized
}

function isServiceObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Create-or-replace a NetworkPolicy (409 catch → conflict-retry replace). */
export async function applyNetworkPolicy(
  api: k8s.NetworkingV1Api,
  name: string,
  namespace: string,
  policy: k8s.V1NetworkPolicy,
  logPrefix = '[NetPol]',
  mutationAllowed?: () => boolean,
  validateExisting?: (existing: k8s.V1NetworkPolicy) => void
): Promise<void> {
  if (mutationAllowed && !mutationAllowed()) return
  try {
    await api.createNamespacedNetworkPolicy({ namespace, body: policy })
    console.log(`${logPrefix} Created policy "${name}" in ${namespace}`)
    return
  } catch (error: unknown) {
    if (getErrorCode(error) !== 409) {
      throw error
    }
  }
  await replaceWithConflictRetry<k8s.V1NetworkPolicy>({
    description: `policy "${name}" in ${namespace}`,
    logPrefix,
    body: policy,
    read: () => api.readNamespacedNetworkPolicy({ name, namespace }),
    replace: body => api.replaceNamespacedNetworkPolicy({ name, namespace, body }),
    mutationAllowed,
    validateExisting,
  })
}

/**
 * Stable JSON for hashing: object keys are emitted in sorted order, so the
 * digest of a Secret's data depends on its content and not on the order the
 * API server happened to return the keys in.
 *
 * Shared by the Host channel-reader credentials revision and the McpServer
 * connector credentials revision (issue #223): both hash Secret content into a
 * pod-template annotation, and a divergence between the two canonical forms
 * would be invisible until a rollout silently stopped happening.
 */
export function canonicalStringify(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort()
  return JSON.stringify(sorted.map(k => [k, obj[k]]))
}

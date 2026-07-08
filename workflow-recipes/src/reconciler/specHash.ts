import { createHash } from 'node:crypto'

/**
 * Annotation that records a hash of the recipe-derived manifest WRC last applied
 * to a managed object. On the next reconcile the reconciler recomputes the hash
 * from the freshly-built manifest and compares it to this annotation; when they
 * match it skips the write entirely.
 *
 * Why this exists: WRC's apply path does an unconditional full PUT
 * (replaceNamespaced*) every reconcile. Because builders emit a partial spec, the
 * API server re-defaults server-managed fields (strategy, revisionHistoryLimit,
 * progressDeadlineSeconds, …) on every replace, bumping `metadata.generation`
 * with no real change. That perpetual churn drove a degraded↔active status flap
 * (observedGeneration always one behind) and a downstream HCC NetworkPolicy
 * no-op write storm. Hashing the *desired* manifest (never the server's defaulted
 * view) and gating the write makes reconciles idempotent.
 */
export const SPEC_HASH_ANNOTATION = 'clerum.io/spec-hash'

// Loose, class-compatible shape: K8s client model classes (V1Deployment, …) have
// `metadata?: V1ObjectMeta` with `annotations?: { [k]: string }`, so they satisfy
// this without needing an index signature.
type AnnotatableManifest = { metadata?: { annotations?: { [key: string]: string } } }

// Fields the API server owns/defaults; they must never influence the hash or the
// computed hash would differ between what we send and what we read back, defeating
// the gate. `annotations[SPEC_HASH_ANNOTATION]` is stripped to avoid self-reference.
const VOLATILE_METADATA_FIELDS = [
  'resourceVersion',
  'uid',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'managedFields',
  'selfLink',
  'ownerReferences',
]

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
  return `{${entries.join(',')}}`
}

/**
 * Hash the recipe-derived shape of a manifest: its spec and the metadata we
 * author (name/namespace/labels/annotations), excluding server-managed/volatile
 * fields, `status`, and the spec-hash annotation itself.
 */
export function computeSpecHash(manifest: object): string {
  const clone = JSON.parse(JSON.stringify(manifest ?? {})) as {
    status?: unknown
    metadata?: { annotations?: { [key: string]: string } } & Record<string, unknown>
  }
  delete clone.status
  if (clone.metadata && typeof clone.metadata === 'object') {
    for (const field of VOLATILE_METADATA_FIELDS) {
      delete (clone.metadata as Record<string, unknown>)[field]
    }
    if (clone.metadata.annotations && typeof clone.metadata.annotations === 'object') {
      delete clone.metadata.annotations[SPEC_HASH_ANNOTATION]
      // An empty annotations object must hash identically to an absent one, so that
      // a freshly-built (unstamped) manifest and the same manifest after stamping
      // produce the same hash (the gate's idempotency guarantee).
      if (Object.keys(clone.metadata.annotations).length === 0) {
        delete (clone.metadata as Record<string, unknown>).annotations
      }
    }
  }
  return createHash('sha256').update(stableStringify(clone)).digest('hex').slice(0, 32)
}

/**
 * Compute the spec hash and write it into `metadata.annotations`. Mutates and
 * returns the hash. Idempotent: re-stamping the same manifest yields the same hash
 * because the prior hash annotation is excluded from the computation.
 */
export function stampSpecHash(manifest: AnnotatableManifest): string {
  const hash = computeSpecHash(manifest)
  const meta = (manifest.metadata ?? {}) as { annotations?: { [key: string]: string } }
  meta.annotations = meta.annotations ?? {}
  meta.annotations[SPEC_HASH_ANNOTATION] = hash
  ;(manifest as { metadata?: unknown }).metadata = meta
  return hash
}

/**
 * True when `existing` already carries the same spec-hash annotation that
 * `desired` was (or would be) stamped with — i.e. the apply would be a no-op.
 * Returns false when either side lacks the annotation (e.g. an object created
 * before this gate existed), forcing one reconciling write that stamps it.
 */
export function specHashUnchanged(
  desired: AnnotatableManifest,
  existing: { metadata?: { annotations?: { [key: string]: string } } } | null | undefined
): boolean {
  const desiredHash =
    desired.metadata?.annotations?.[SPEC_HASH_ANNOTATION] ?? computeSpecHash(desired)
  const existingHash = existing?.metadata?.annotations?.[SPEC_HASH_ANNOTATION]
  return Boolean(existingHash && desiredHash === existingHash)
}

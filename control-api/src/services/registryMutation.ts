import { createHash } from 'node:crypto'

export const REGISTRY_OPERATION_ID_ANNOTATION = 'clerum.io/registry-operation-id'
export const REGISTRY_SPEC_DIGEST_ANNOTATION = 'clerum.io/registry-spec-sha256'

export type RegistryMutationOutcome = 'committed' | 'not-committed' | 'ambiguous'
export type RegistryMutationReadbackOutcome = 'committed' | 'ambiguous'

export type RegistryResourceSnapshot = {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: Record<string, unknown>
}

export type RegistryMutationDesired = {
  spec: Record<string, unknown>
  metadata: {
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  specDigest: string
}

/** Canonicalize only JSON-like values; object key order is not semantic, array order is. */
export function canonicalRegistryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter(entry => entry !== undefined).map(canonicalRegistryValue)
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalRegistryValue(entry)])
  )
}

export function canonicalRegistryJson(value: unknown): string {
  return JSON.stringify(canonicalRegistryValue(value))
}

export function registrySpecDigest(spec: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalRegistryJson(spec)).digest('hex')
}

function metadataSubsetMatches(
  current: RegistryResourceSnapshot['metadata'],
  expected: RegistryResourceSnapshot['metadata']
): boolean {
  for (const [key, value] of Object.entries(expected?.labels ?? {})) {
    if (current?.labels?.[key] !== value) return false
  }
  for (const [key, value] of Object.entries(expected?.annotations ?? {})) {
    if (current?.annotations?.[key] !== value) return false
  }
  return true
}

/**
 * Classify a readback after a Registry mutation returned an ambiguous error.
 * resourceVersion is intentionally treated as opaque: only equality matters.
 * An unchanged prior object is `not-committed` only when the caller has
 * established that exact state through its bounded repeated-read policy; a
 * single stale read must remain ambiguous at the route boundary.
 */
export function classifyRegistryMutationReadback(input: {
  before: RegistryResourceSnapshot
  desired: RegistryMutationDesired
  current: RegistryResourceSnapshot
  operationId: string
}): RegistryMutationReadbackOutcome {
  const beforeMeta = input.before.metadata
  const currentMeta = input.current.metadata
  if (!beforeMeta?.uid || !beforeMeta.resourceVersion || !currentMeta?.uid) return 'ambiguous'

  const sameUid = currentMeta.uid === beforeMeta.uid
  const currentOperationId = currentMeta.annotations?.[REGISTRY_OPERATION_ID_ANNOTATION]
  const desiredMetadataMatches = metadataSubsetMatches(currentMeta, input.desired.metadata)
  const currentSpecDigest = registrySpecDigest(input.current.spec ?? {})

  if (
    sameUid &&
    typeof currentMeta.resourceVersion === 'string' &&
    currentMeta.resourceVersion !== beforeMeta.resourceVersion &&
    currentOperationId === input.operationId &&
    currentSpecDigest === input.desired.specDigest &&
    desiredMetadataMatches
  ) {
    return 'committed'
  }

  // A readback alone cannot prove that a failed write is no longer in flight.
  // Only the caller's successful identity fence may produce `not-committed`.
  return 'ambiguous'
}

export function classifyRegistryAssociationReadback(input: {
  before: RegistryResourceSnapshot
  current: RegistryResourceSnapshot | null
  isCommitted: (spec: Record<string, unknown>) => boolean
}): RegistryMutationReadbackOutcome {
  const beforeMeta = input.before.metadata
  const currentMeta = input.current?.metadata
  if (
    !beforeMeta?.uid ||
    !beforeMeta.resourceVersion ||
    !currentMeta?.uid ||
    typeof currentMeta.resourceVersion !== 'string'
  ) {
    return 'ambiguous'
  }
  if (currentMeta.uid !== beforeMeta.uid) return 'ambiguous'
  if (
    currentMeta.resourceVersion !== beforeMeta.resourceVersion &&
    input.isCommitted(input.current?.spec ?? {})
  ) {
    return 'committed'
  }
  return 'ambiguous'
}

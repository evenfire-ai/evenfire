import { createHash } from 'node:crypto'

export const REGISTRY_OPERATION_ID_ANNOTATION = 'clerum.io/registry-operation-id'
export const REGISTRY_SPEC_DIGEST_ANNOTATION = 'clerum.io/registry-spec-sha256'

export type RegistryMutationOutcome = 'committed' | 'not-committed' | 'ambiguous'
export type SecretMutationReadbackClassification = 'desired' | 'prior' | 'ambiguous'
export type SecretMutationSnapshot = {
  metadata?: {
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  data?: Record<string, string>
  stringData?: Record<string, string>
}

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

export function registrySecretDataDigest(
  data: Record<string, string> | undefined,
  plaintext: Record<string, string> | undefined = undefined
): string {
  const effectiveData = { ...(data ?? {}) }
  for (const [key, value] of Object.entries(plaintext ?? {})) {
    effectiveData[key] = Buffer.from(value, 'utf8').toString('base64')
  }
  return registrySpecDigest(effectiveData)
}

/**
 * Classify a Secret readback after the client lost the response. A matching
 * operation marker and payload are only candidates: a GET cannot prove that
 * its resourceVersion belongs to this write. Callers must keep the result
 * non-terminal unless they obtain a direct write response or a later CAS
 * receipt of their own.
 */
export function classifySecretMutationReadback(input: {
  before?: SecretMutationSnapshot
  current: SecretMutationSnapshot | null
  operationId: string
  operationAnnotationKey: string
  expectedDataDigest?: string
  expectedMetadata?: {
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
}): SecretMutationReadbackClassification {
  const currentMetadata = input.current?.metadata
  if (
    !currentMetadata ||
    typeof currentMetadata.uid !== 'string' ||
    typeof currentMetadata.resourceVersion !== 'string'
  ) {
    return 'ambiguous'
  }
  const beforeMetadata = input.before?.metadata
  if (beforeMetadata && currentMetadata.uid !== beforeMetadata.uid) {
    return 'ambiguous'
  }
  const currentOperationId = currentMetadata.annotations?.[input.operationAnnotationKey]
  if (currentOperationId === input.operationId) {
    if (beforeMetadata && currentMetadata.resourceVersion === beforeMetadata.resourceVersion) {
      return 'ambiguous'
    }
    if (
      !input.expectedDataDigest ||
      registrySecretDataDigest(input.current?.data, input.current?.stringData) !==
        input.expectedDataDigest
    ) {
      return 'ambiguous'
    }
    if (
      input.expectedMetadata &&
      (!metadataMapsEqual(currentMetadata.labels, input.expectedMetadata.labels) ||
        !metadataMapsEqual(currentMetadata.annotations, input.expectedMetadata.annotations))
    ) {
      // A same-UID write may carry our data marker while another writer has
      // changed metadata. Treat that state as ambiguous: a later full restore
      // would otherwise erase the concurrent metadata under the same identity.
      return 'ambiguous'
    }
    return 'desired'
  }
  if (beforeMetadata && currentMetadata.resourceVersion === beforeMetadata.resourceVersion) {
    return 'prior'
  }
  return 'ambiguous'
}

/**
 * Classify a create response that may have been lost after the object committed.
 *
 * `committed` here means that the observed object carries this operation's complete
 * intent. A create readback has no pre-write UID to compare against, so it does NOT
 * prove that the observed UID is the object created by this request. Callers may use
 * the result to finish an idempotent success, but must mark the snapshot as
 * non-compensable until a direct create response supplied its identity.
 */
export function classifyCreatedRegistryMutationReadback(input: {
  current: RegistryResourceSnapshot | null
  desired: RegistryMutationDesired
  operationId: string
}): RegistryMutationOutcome {
  const metadata = input.current?.metadata
  if (
    !metadata ||
    typeof metadata.uid !== 'string' ||
    typeof metadata.resourceVersion !== 'string'
  ) {
    return 'ambiguous'
  }
  if (metadata.annotations?.[REGISTRY_OPERATION_ID_ANNOTATION] !== input.operationId) {
    return 'ambiguous'
  }
  if (registrySpecDigest(input.current?.spec ?? {}) !== input.desired.specDigest) {
    return 'ambiguous'
  }
  if (!metadataSubsetMatches(metadata, input.desired.metadata)) return 'ambiguous'
  return 'committed'
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
}): RegistryMutationOutcome {
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

  // A stable readback of the exact prior object proves that this mutation did
  // not reach the apiserver: identity, version, spec digest, and all metadata
  // maps are still byte-for-byte the prior state, and this operation's marker
  // is absent. Callers only use this result after bounded repeated reads; a
  // single stale read is not promoted to this state by the route.
  if (
    sameUid &&
    currentMeta.resourceVersion === beforeMeta.resourceVersion &&
    currentOperationId !== input.operationId &&
    currentSpecDigest === registrySpecDigest(input.before.spec ?? {}) &&
    metadataMapsEqual(currentMeta.labels, beforeMeta.labels) &&
    metadataMapsEqual(currentMeta.annotations, beforeMeta.annotations)
  ) {
    return 'not-committed'
  }

  return 'ambiguous'
}

export function classifyRegistryAssociationReadback(input: {
  before: RegistryResourceSnapshot
  current: RegistryResourceSnapshot | null
  isCommitted: (spec: Record<string, unknown>) => boolean
}): RegistryMutationOutcome {
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
  if (
    currentMeta.resourceVersion === beforeMeta.resourceVersion &&
    registrySpecDigest(input.current?.spec ?? {}) === registrySpecDigest(input.before.spec ?? {})
  ) {
    return 'not-committed'
  }
  return 'ambiguous'
}

function metadataMapsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

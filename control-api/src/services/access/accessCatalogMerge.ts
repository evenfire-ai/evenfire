import {
  canonicalAccessPathSeeds,
  canonicalAuthorizationRelationships,
} from './authorizationRevision.js'
import {
  type CatalogIdentityCandidate,
  type CatalogKey,
  type HydratedCatalogResource,
  catalogKeyEquals,
  compareCatalogKey,
} from './catalogContracts.js'
import { resourceIdentityKey } from './resourceIdentity.js'

export class AccessCatalogMergeError extends Error {
  constructor(readonly code: string) {
    super(`Access catalog merge invariant failed: ${code}`)
    this.name = 'AccessCatalogMergeError'
  }
}

export type CatalogCandidateStream = Readonly<{
  streamId: string
  candidates: readonly CatalogIdentityCandidate[]
}>

type StreamCursor = {
  stream: CatalogCandidateStream
  index: number
}

type HeapEntry = Readonly<{
  cursor: StreamCursor
  candidate: CatalogIdentityCandidate
}>

function entryCompare(left: HeapEntry, right: HeapEntry): number {
  const keyOrder = compareCatalogKey(left.candidate.key, right.candidate.key)
  return keyOrder || left.cursor.stream.streamId.localeCompare(right.cursor.stream.streamId)
}

function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (entryCompare(heap[parent], heap[index]) <= 0) break
    ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
    index = parent
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry | undefined {
  const first = heap[0]
  const last = heap.pop()
  if (!first || !last || heap.length === 0) return first
  heap[0] = last
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && entryCompare(heap[left], heap[smallest]) < 0) smallest = left
    if (right < heap.length && entryCompare(heap[right], heap[smallest]) < 0) smallest = right
    if (smallest === index) break
    ;[heap[index], heap[smallest]] = [heap[smallest], heap[index]]
    index = smallest
  }
  return first
}

function validateCandidateStream(stream: CatalogCandidateStream): void {
  if (!stream.streamId) throw new AccessCatalogMergeError('stream_id_missing')
  for (let index = 1; index < stream.candidates.length; index += 1) {
    if (compareCatalogKey(stream.candidates[index - 1].key, stream.candidates[index].key) >= 0) {
      throw new AccessCatalogMergeError('stream_not_strictly_ordered')
    }
  }
}

function advance(heap: HeapEntry[], cursor: StreamCursor): void {
  cursor.index += 1
  const candidate = cursor.stream.candidates[cursor.index]
  if (candidate) heapPush(heap, { cursor, candidate })
}

/**
 * Deterministically merges already-keyset-paged producer streams. The bound is
 * an output bound (normally pageSize + 1), not a hint: no later candidate is
 * inspected after the bound has been satisfied.
 */
export function mergeCatalogCandidateStreams(
  streams: readonly CatalogCandidateStream[],
  maximumOutputs: number
): CatalogIdentityCandidate[] {
  if (!Number.isSafeInteger(maximumOutputs) || maximumOutputs < 0) {
    throw new AccessCatalogMergeError('output_bound_invalid')
  }
  const streamIds = new Set<string>()
  const heap: HeapEntry[] = []
  for (const stream of streams) {
    validateCandidateStream(stream)
    if (streamIds.has(stream.streamId)) {
      throw new AccessCatalogMergeError('stream_id_duplicate')
    }
    streamIds.add(stream.streamId)
    const cursor: StreamCursor = { stream, index: 0 }
    const candidate = stream.candidates[0]
    if (candidate) heapPush(heap, { cursor, candidate })
  }

  const values: CatalogIdentityCandidate[] = []
  while (heap.length > 0 && values.length < maximumOutputs) {
    const first = heapPop(heap)!
    const equal = [first]
    while (heap[0] && catalogKeyEquals(heap[0].candidate.key, first.candidate.key)) {
      equal.push(heapPop(heap)!)
    }
    if (equal.some(entry => entry.candidate.canonicalId !== first.candidate.canonicalId)) {
      throw new AccessCatalogMergeError('canonical_id_conflict')
    }
    const validUntilValues = equal
      .flatMap(entry => (entry.candidate.validUntil ? [entry.candidate.validUntil] : []))
      .sort()
    for (const entry of equal) advance(heap, entry.cursor)
    values.push(
      Object.freeze({
        ...first.candidate,
        validUntil: validUntilValues[0] ?? null,
      })
    )
  }
  return values
}

function keyString(key: CatalogKey): string {
  return JSON.stringify(key)
}

function assertHydratedIdentity(value: HydratedCatalogResource): void {
  if (
    value.key[0] !== value.resource.environmentId ||
    value.key[1] !== value.resource.type ||
    value.key[2] !== value.resource.logicalId ||
    value.resource.canonicalId !== `${value.resource.type}:${value.resource.logicalId}`
  ) {
    throw new AccessCatalogMergeError('hydrated_identity_mismatch')
  }
}

function canonicalHydratedResource(value: HydratedCatalogResource): HydratedCatalogResource {
  assertHydratedIdentity(value)
  return Object.freeze({
    ...value,
    accessPaths: Object.freeze(canonicalAccessPathSeeds(value.accessPaths)),
    relationships: Object.freeze(canonicalAuthorizationRelationships(value.relationships)),
  })
}

/**
 * Merges fragments only when they describe the exact same immutable resource
 * and authoritative snapshot. Equal paths and relationships are deduplicated;
 * every non-equal path and relationship is retained.
 */
export function mergeHydratedCatalogResources(
  values: readonly HydratedCatalogResource[]
): Map<string, HydratedCatalogResource> {
  const merged = new Map<string, HydratedCatalogResource>()
  for (const raw of values) {
    const value = canonicalHydratedResource(raw)
    const key = keyString(value.key)
    const prior = merged.get(key)
    if (!prior) {
      merged.set(key, value)
      continue
    }
    if (
      resourceIdentityKey(prior.resource) !== resourceIdentityKey(value.resource) ||
      JSON.stringify(prior.resource) !== JSON.stringify(value.resource)
    ) {
      throw new AccessCatalogMergeError('resource_identity_conflict')
    }
    if (
      prior.authorizationResourceRevision !== value.authorizationResourceRevision ||
      prior.authorizationSourceRevision !== value.authorizationSourceRevision ||
      prior.authorizationRelationshipsRevision !== value.authorizationRelationshipsRevision
    ) {
      throw new AccessCatalogMergeError('authorization_revision_conflict')
    }
    merged.set(
      key,
      Object.freeze({
        ...prior,
        accessPaths: Object.freeze(
          canonicalAccessPathSeeds([...prior.accessPaths, ...value.accessPaths])
        ),
        relationships: Object.freeze(
          canonicalAuthorizationRelationships([...prior.relationships, ...value.relationships])
        ),
        validUntil:
          [prior.validUntil, value.validUntil]
            .filter((item): item is string => Boolean(item))
            .sort()[0] ?? null,
      })
    )
  }
  return merged
}

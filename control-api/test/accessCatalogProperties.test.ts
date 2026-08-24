import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  AccessCatalogMergeError,
  mergeCatalogCandidateStreams,
  mergeHydratedCatalogResources,
} from '../src/services/access/accessCatalogMerge.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../src/services/access/accessExecutionBudget.js'
import type {
  AccessPathBehavior,
  AccessPathSeed,
  BehaviorDimension,
} from '../src/services/access/accessPath.js'
import {
  canonicalAccessPathSeeds,
  canonicalAuthorizationRelationships,
} from '../src/services/access/authorizationRevision.js'
import type { AccessCapability } from '../src/services/access/capabilityRegistry.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type CatalogIdentityCandidate,
  type CatalogKey,
  type CatalogRelationship,
  type HydratedCatalogResource,
  catalogKey,
  catalogKeyEquals,
  compareCatalogKey,
} from '../src/services/access/catalogContracts.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const environmentId = 'cluster.local/evenfire'
const capabilities: readonly AccessCapability[] = [
  'user.profile.read',
  'team.read',
  'host.read',
  'context.read',
  'workflow.read',
  'notification.read',
]

function identifier(value: number): string {
  return `id-${String(value).padStart(5, '0')}`
}

function compareTextOracle(left: string, right: string): number {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!
  }
  return leftBytes.length - rightBytes.length
}

function compareKeyOracle(left: CatalogKey, right: CatalogKey): number {
  return (
    compareTextOracle(left[0], right[0]) ||
    compareTextOracle(left[1], right[1]) ||
    compareTextOracle(left[2], right[2])
  )
}

const catalogTextArbitrary = fc
  .array(
    fc.constantFrom('a', 'z', 'A', 'Z', '0', '9', '-', '_', '.', '/', 'é', 'e\u0301', 'Ω', '😀'),
    {
      minLength: 1,
      maxLength: 16,
    }
  )
  .map(parts => parts.join(''))

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

const candidateArbitrary = fc
  .record({
    family: fc.constantFrom<CatalogFamily>(...CATALOG_FAMILIES),
    logicalId: catalogTextArbitrary,
    validUntil: fc.option(
      fc
        .integer({ min: 1, max: 20 })
        .map(day => `2030-01-${String(day).padStart(2, '0')}T00:00:00.000Z`),
      { nil: null }
    ),
  })
  .map(({ family, logicalId, validUntil }): CatalogIdentityCandidate => {
    return Object.freeze({
      key: catalogKey(environmentId, family, logicalId),
      canonicalId: `${family}:${logicalId}`,
      validUntil,
    })
  })

const candidateStreamsArbitrary = fc
  .array(
    fc.uniqueArray(candidateArbitrary, {
      maxLength: 30,
      selector: candidate => JSON.stringify(candidate.key),
    }),
    { maxLength: 8 }
  )
  .map(candidateLists =>
    candidateLists.map((candidates, index) => ({
      streamId: `stream-${index}`,
      candidates: [...candidates].sort((left, right) => compareKeyOracle(left.key, right.key)),
    }))
  )

function expectedCandidateUnion(
  streams: readonly Readonly<{ candidates: readonly CatalogIdentityCandidate[] }>[],
  maximumOutputs = Number.MAX_SAFE_INTEGER
): CatalogIdentityCandidate[] {
  const byKey = new Map<string, CatalogIdentityCandidate>()
  for (const candidate of streams.flatMap(stream => stream.candidates)) {
    const key = JSON.stringify(candidate.key)
    const prior = byKey.get(key)
    const validUntil = [prior?.validUntil, candidate.validUntil]
      .filter((value): value is string => Boolean(value))
      .sort()[0]
    byKey.set(key, { ...candidate, validUntil: validUntil ?? null })
  }
  return [...byKey.values()]
    .sort((left, right) => compareKeyOracle(left.key, right.key))
    .slice(0, maximumOutputs)
}

const dimensionArbitrary: fc.Arbitrary<BehaviorDimension> = fc.oneof(
  fc.constant({ state: 'unknown' } as const),
  fc.option(fc.string({ maxLength: 24 }), { nil: null }).map(value => ({
    state: 'known' as const,
    value,
  }))
)

const behaviorArbitrary: fc.Arbitrary<AccessPathBehavior> = fc.record({
  capabilities: fc.uniqueArray(fc.constantFrom(...capabilities), {
    maxLength: capabilities.length,
  }),
  budget: dimensionArbitrary,
  credentialPolicy: dimensionArbitrary,
  approvalPolicy: dimensionArbitrary,
  filesystemScope: dimensionArbitrary,
  runtime: dimensionArbitrary,
  providerModelPolicy: dimensionArbitrary,
  audit: dimensionArbitrary,
})

const pathArbitrary: fc.Arbitrary<AccessPathSeed> = fc
  .record({
    kind: fc.constantFrom<'direct' | 'team'>('direct', 'team'),
    grant: fc.integer({ min: 0, max: 100 }),
    team: fc.integer({ min: 1, max: 20 }),
    role: fc.constantFrom<'admin' | 'inviter' | 'member'>('admin', 'inviter', 'member'),
    behavior: behaviorArbitrary,
  })
  .map(({ kind, grant, team, role, behavior }) =>
    kind === 'direct'
      ? { kind, grantId: `direct-${grant}`, behavior }
      : { kind, grantId: `team-${grant}`, teamId: uuid(team), currentRole: role, behavior }
  )

const relationshipArbitrary: fc.Arbitrary<CatalogRelationship> = fc
  .record({
    type: fc.constantFrom('mounted_by', 'served_by', 'created_from'),
    target: fc.integer({ min: 0, max: 100 }),
    instance: fc.option(fc.integer({ min: 0, max: 30 }), { nil: undefined }),
  })
  .map(({ type, target, instance }) => ({
    type,
    targetResourceId: `target:${identifier(target)}`,
    ...(instance === undefined ? {} : { instanceId: `edge-${instance}` }),
  }))

function hydrated(input: {
  id: number
  displayName?: string
  paths: readonly AccessPathSeed[]
  relationships: readonly CatalogRelationship[]
  validUntil?: string | null
}): HydratedCatalogResource {
  const logicalId = uuid(input.id)
  return {
    key: catalogKey(environmentId, 'user', logicalId),
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'user',
      logicalId,
      displayName: input.displayName ?? `User ${input.id}`,
    }),
    accessPaths: input.paths,
    relationships: input.relationships,
    authorizationResourceRevision: 'resource-1',
    authorizationSourceRevision: 'source-1',
    authorizationRelationshipsRevision: 'relationships-1',
    validUntil: input.validUntil ?? null,
  }
}

describe('aggregate access catalog properties', () => {
  it('matches an independent UTF-8 byte oracle with exact identity', () => {
    fc.assert(
      fc.property(candidateArbitrary, candidateArbitrary, (left, right) => {
        expect(Math.sign(compareCatalogKey(left.key, right.key))).toBe(
          Math.sign(compareKeyOracle(left.key, right.key))
        )
        expect(catalogKeyEquals(left.key, right.key)).toBe(
          left.key[0] === right.key[0] &&
            left.key[1] === right.key[1] &&
            left.key[2] === right.key[2]
        )
      }),
      { numRuns: 1_000 }
    )
  })

  it('k-way merge is ordered, bounded, deduplicating, and producer-order independent', () => {
    fc.assert(
      fc.property(
        candidateStreamsArbitrary,
        fc.integer({ min: 0, max: 50 }),
        (streams, maximumOutputs) => {
          const expected = expectedCandidateUnion(streams, maximumOutputs)
          expect(mergeCatalogCandidateStreams(streams, maximumOutputs)).toEqual(expected)
          expect(mergeCatalogCandidateStreams([...streams].reverse(), maximumOutputs)).toEqual(
            expected
          )
        }
      ),
      { numRuns: 300 }
    )
  })

  it('composes bounded pages without identity loss or duplication', () => {
    const perFamilyStreams = fc.subarray([...CATALOG_FAMILIES], { minLength: 1 }).chain(families =>
      fc
        .tuple(
          ...families.map(family =>
            fc.uniqueArray(catalogTextArbitrary, { maxLength: 25 }).map(values => ({
              streamId: family,
              candidates: values
                .map(logicalId => {
                  return {
                    key: catalogKey(environmentId, family, logicalId),
                    canonicalId: `${family}:${logicalId}`,
                    validUntil: null,
                  }
                })
                .sort((left, right) => compareKeyOracle(left.key, right.key)),
            }))
          )
        )
        .map(streams => streams)
    )

    fc.assert(
      fc.property(perFamilyStreams, fc.integer({ min: 1, max: 20 }), (streams, pageSize) => {
        const expected = expectedCandidateUnion(streams)
        const remaining = streams.map(stream => ({
          streamId: stream.streamId,
          candidates: [...stream.candidates],
        }))
        const composed: CatalogIdentityCandidate[] = []
        while (remaining.some(stream => stream.candidates.length > 0)) {
          const page = mergeCatalogCandidateStreams(remaining, pageSize + 1).slice(0, pageSize)
          expect(page.length).toBeGreaterThan(0)
          composed.push(...page)
          for (const stream of remaining) {
            const emitted = page.filter(candidate => candidate.key[1] === stream.streamId)
            const afterKey = emitted.at(-1)?.key
            if (afterKey) {
              stream.candidates = stream.candidates.filter(
                candidate => compareKeyOracle(candidate.key, afterKey) > 0
              )
            }
          }
        }
        expect(composed).toEqual(expected)
      }),
      { numRuns: 200 }
    )
  })

  it('same-ID fragments preserve every distinct path and relationship exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(pathArbitrary, { maxLength: 40 }),
        fc.array(relationshipArbitrary, { maxLength: 60 }),
        fc.nat(),
        fc.boolean(),
        (paths, relationships, splitSeed, reverse) => {
          const duplicatedPaths = [...paths, ...paths.slice(0, paths.length % 5)]
          const duplicatedRelationships = [
            ...relationships,
            ...relationships.slice(0, relationships.length % 7),
          ]
          const pathSplit = duplicatedPaths.length === 0 ? 0 : splitSeed % duplicatedPaths.length
          const relationshipSplit =
            duplicatedRelationships.length === 0 ? 0 : splitSeed % duplicatedRelationships.length
          const fragments = [
            hydrated({
              id: 1,
              paths: duplicatedPaths.slice(0, pathSplit),
              relationships: duplicatedRelationships.slice(0, relationshipSplit),
            }),
            hydrated({
              id: 1,
              paths: duplicatedPaths.slice(pathSplit),
              relationships: duplicatedRelationships.slice(relationshipSplit),
            }),
          ]
          const result = mergeHydratedCatalogResources(reverse ? fragments.reverse() : fragments)
          const value = [...result.values()][0]
          expect(value.accessPaths).toEqual(canonicalAccessPathSeeds(duplicatedPaths))
          expect(value.relationships).toEqual(
            canonicalAuthorizationRelationships(duplicatedRelationships)
          )
          expect(mergeHydratedCatalogResources([...result.values()])).toEqual(result)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('preserves equivalent provenance and every behavior-distinct path', () => {
    fc.assert(
      fc.property(
        behaviorArbitrary,
        fc.string({ minLength: 1, maxLength: 24 }),
        (behavior, scope) => {
          const direct: AccessPathSeed = { kind: 'direct', grantId: 'direct', behavior }
          const team: AccessPathSeed = {
            kind: 'team',
            grantId: 'team',
            teamId: uuid(2),
            currentRole: 'member',
            behavior,
          }
          const distinctScope: AccessPathSeed = {
            kind: 'direct',
            grantId: 'direct',
            behavior: {
              ...behavior,
              filesystemScope: { state: 'known', value: scope },
            },
          }
          const value = [
            ...mergeHydratedCatalogResources([
              hydrated({ id: 1, paths: [direct, team, distinctScope], relationships: [] }),
            ]).values(),
          ][0]
          expect(value.accessPaths).toHaveLength(
            canonicalAccessPathSeeds([direct, team, distinctScope]).length
          )
          expect(value.accessPaths).toEqual(canonicalAccessPathSeeds([direct, team, distinctScope]))
        }
      ),
      { numRuns: 200 }
    )
  })

  it('never merges same-label resources with different immutable IDs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1_001, max: 2_000 }),
        (left, right) => {
          const result = mergeHydratedCatalogResources([
            hydrated({ id: left, displayName: 'Same name', paths: [], relationships: [] }),
            hydrated({ id: right, displayName: 'Same name', paths: [], relationships: [] }),
          ])
          expect(result).toHaveLength(2)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('rejects conflicting producer identity or authority revisions', () => {
    const value = hydrated({ id: 1, paths: [], relationships: [] })
    expect(() =>
      mergeHydratedCatalogResources([
        value,
        { ...value, authorizationResourceRevision: 'resource-2' },
      ])
    ).toThrow(AccessCatalogMergeError)
    expect(() =>
      mergeCatalogCandidateStreams(
        [
          { streamId: 'a', candidates: [{ ...candidate('user', 1), canonicalId: 'user:a' }] },
          { streamId: 'b', candidates: [{ ...candidate('user', 1), canonicalId: 'user:b' }] },
        ],
        2
      )
    ).toThrow(AccessCatalogMergeError)
  })

  it('recovers a complete deterministic union when a partial producer returns', () => {
    fc.assert(
      fc.property(candidateStreamsArbitrary, streams => {
        const missing = streams.slice(1)
        const partial = mergeCatalogCandidateStreams(missing, 10_000)
        const recovered = mergeCatalogCandidateStreams(streams, 10_000)
        expect(
          partial.every(value => recovered.some(item => item.canonicalId === value.canonicalId))
        ).toBe(true)
        expect(recovered).toEqual(expectedCandidateUnion(streams))
      }),
      { numRuns: 200 }
    )
  })
})

function candidate(family: CatalogFamily, value: number): CatalogIdentityCandidate {
  const logicalId = identifier(value)
  return {
    key: catalogKey(environmentId, family, logicalId),
    canonicalId: `${family}:${logicalId}`,
    validUntil: null,
  }
}

describe('execution-budget properties', () => {
  it('rejects exactly when an arbitrary cumulative charge crosses its limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 30 }),
        (capacity, charges) => {
          const budget = AccessExecutionBudget.create('catalog', {
            limits: { accessPaths: capacity },
          })
          let consumed = 0
          let rejected = false
          for (const amount of charges) {
            if (rejected) break
            if (consumed + amount > capacity) {
              expect(() => budget.charge({ kind: 'accessPaths', amount })).toThrow(
                AccessBudgetExceededError
              )
              rejected = true
            } else {
              budget.charge({ kind: 'accessPaths', amount })
              consumed += amount
            }
          }
          expect(budget.remaining('accessPaths')).toBe(capacity - consumed)
          budget.close()
        }
      ),
      { numRuns: 200 }
    )
  })

  it('never publishes late producer results after arbitrary cancellation', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async producerCount => {
        const budget = AccessExecutionBudget.create('catalog', {
          limits: { producerCalls: producerCount, producerConcurrency: Math.min(4, producerCount) },
        })
        const completions: Array<() => void> = []
        const published: number[] = []
        const work = Array.from({ length: producerCount }, (_, index) =>
          budget
            .runProducer(
              () =>
                new Promise<number>(resolve => {
                  completions.push(() => resolve(index))
                })
            )
            .then(value => published.push(value))
        )
        await Promise.resolve()
        budget.cancel()
        for (const complete of completions) complete()
        const results = await Promise.allSettled(work)
        expect(results.every(result => result.status === 'rejected')).toBe(true)
        expect(
          results.every(
            result =>
              result.status === 'rejected' && result.reason instanceof AccessExecutionCancelledError
          )
        ).toBe(true)
        expect(published).toEqual([])
        budget.close()
      }),
      { numRuns: 30 }
    )
  })
})

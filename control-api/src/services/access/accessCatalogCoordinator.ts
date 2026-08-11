import type { DbClient } from '../../db.js'
import { withTransaction } from '../../db.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import { configureAccessAuthorityTransaction } from './accessAuthorityTransaction.js'
import {
  ACCESS_CATALOG_CONTRACT_VERSION,
  ACCESS_CATALOG_SORT,
  type AccessCatalogCursorV3,
  assertAccessCatalogCursorCurrent,
  catalogFilterHash,
  decodeAccessCatalogCursor,
  encodeAccessCatalogCursor,
} from './accessCatalogCursor.js'
import { AccessExecutionBudget, type AccessExecutionLimits } from './accessExecutionBudget.js'
import { buildAccessPath, canonicalAccessPathTuple } from './accessPath.js'
import { authorizationRevision, revisionOfValues } from './authorizationRevision.js'
import { normalizeAccessCapabilities } from './capabilityRegistry.js'
import {
  CatalogAuthorityError,
  catalogSourceStateRevision,
  loadCatalogRequestContext,
} from './catalogAuthorityContext.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type CatalogIdentityCandidate,
  type CatalogKey,
  type CatalogProducerPage,
  type CatalogRelationship,
  type CatalogRequestContext,
  type HydratedCatalogResource,
  type ProducerContinuation,
  type SafeCatalogPartialError,
  catalogKeyEquals,
  compareCatalogKey,
} from './catalogContracts.js'
import { CatalogProducerContractError } from './catalogProducerSupport.js'
import { requireCatalogProducer } from './catalogProducers.js'
import { canonicalEnvironmentId } from './operationalAccessProjection.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export type PublicCatalogAccessPath = Readonly<{
  accessPathId: string
  kind: 'direct' | 'team'
  safeTeamDescriptor?: Readonly<{ teamId: string; currentRole: string }>
  capabilities: readonly string[]
  behaviorDescriptors: ReturnType<typeof buildAccessPath>['behavior']
}>

export type AccessCatalogItem = Readonly<{
  resource: CanonicalResourceIdentity & Readonly<{ resourceRevision: string }>
  relationships: readonly CatalogRelationship[]
  capabilities: readonly string[]
  accessPaths: readonly PublicCatalogAccessPath[]
}>

export type AccessCatalogResponse = Readonly<{
  contractVersion: typeof ACCESS_CATALOG_CONTRACT_VERSION
  authorizationRevision: string
  sourceStateRevision: string
  complete: boolean
  partialErrors: readonly SafeCatalogPartialError[]
  items: readonly AccessCatalogItem[]
  nextCursor: string | null
}>

export class AccessCatalogRequestError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'authority_unavailable'
      | 'session_not_live'
      | 'catalog_invariant_failed'
  ) {
    super(`Access catalog request failed: ${code}`)
    this.name = 'AccessCatalogRequestError'
  }
}

type CatalogTransaction = <T>(work: (db: DbClient) => Promise<T>) => Promise<T>

type ProducerRuntime = {
  family: CatalogFamily
  inputContinuation: ProducerContinuation
  page: CatalogProducerPage
  cursorIndex: number
  emittedCount: number
}

type HeapEntry = Readonly<{
  runtime: ProducerRuntime
  candidate: CatalogIdentityCandidate
}>

function normalizeFamilies(value: readonly CatalogFamily[] | undefined): CatalogFamily[] {
  if (value === undefined) return [...CATALOG_FAMILIES]
  if (value.length === 0 || value.length > CATALOG_FAMILIES.length) {
    throw new AccessCatalogRequestError('invalid_request')
  }
  const requested = new Set<CatalogFamily>()
  for (const family of value) {
    if (!CATALOG_FAMILIES.includes(family)) {
      throw new AccessCatalogRequestError('invalid_request')
    }
    requested.add(family)
  }
  return CATALOG_FAMILIES.filter(family => requested.has(family))
}

function emptyContinuations(): Record<CatalogFamily, ProducerContinuation> {
  return Object.fromEntries(
    CATALOG_FAMILIES.map(family => [family, Object.freeze({ afterKey: null, exhausted: false })])
  ) as Record<CatalogFamily, ProducerContinuation>
}

function entryCompare(left: HeapEntry, right: HeapEntry): number {
  const keyOrder = compareCatalogKey(left.candidate.key, right.candidate.key)
  return keyOrder || left.runtime.family.localeCompare(right.runtime.family)
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

function advanceRuntime(heap: HeapEntry[], runtime: ProducerRuntime): void {
  runtime.cursorIndex += 1
  const candidate = runtime.page.candidates[runtime.cursorIndex]
  if (candidate) heapPush(heap, { runtime, candidate })
}

function mergeCandidatePages(
  runtimes: readonly ProducerRuntime[],
  limit: number
): CatalogIdentityCandidate[] {
  const heap: HeapEntry[] = []
  for (const runtime of runtimes) {
    const candidate = runtime.page.candidates[0]
    if (candidate) heapPush(heap, { runtime, candidate })
  }
  const values: CatalogIdentityCandidate[] = []
  while (heap.length > 0 && values.length < limit + 1) {
    const first = heapPop(heap)!
    const equal = [first]
    while (heap[0] && catalogKeyEquals(heap[0].candidate.key, first.candidate.key)) {
      equal.push(heapPop(heap)!)
    }
    let validUntil: string | null = null
    for (const entry of equal) {
      if (entry.candidate.validUntil && (!validUntil || entry.candidate.validUntil < validUntil)) {
        validUntil = entry.candidate.validUntil
      }
      advanceRuntime(heap, entry.runtime)
    }
    values.push(Object.freeze({ ...first.candidate, validUntil }))
  }
  return values
}

function safePartialErrors(runtimes: readonly ProducerRuntime[]): SafeCatalogPartialError[] {
  const values = new Map<string, SafeCatalogPartialError>()
  for (const runtime of runtimes) {
    for (const error of runtime.page.partialErrors) {
      values.set(JSON.stringify([error.producer, error.code]), error)
    }
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

async function hydrateSelected(
  context: CatalogRequestContext,
  selected: readonly CatalogIdentityCandidate[]
): Promise<Map<string, HydratedCatalogResource>> {
  const byFamily = new Map<CatalogFamily, CatalogKey[]>()
  for (const candidate of selected) {
    const values = byFamily.get(candidate.key[1]) ?? []
    values.push(candidate.key)
    byFamily.set(candidate.key[1], values)
  }
  const hydrated = new Map<string, HydratedCatalogResource>()
  for (const family of CATALOG_FAMILIES) {
    const keys = byFamily.get(family)
    if (!keys?.length) continue
    const values = await requireCatalogProducer(family).hydrateCanonicalKeys(context, keys)
    for (const value of values) {
      const key = JSON.stringify(value.key)
      if (hydrated.has(key)) throw new AccessCatalogRequestError('catalog_invariant_failed')
      hydrated.set(key, value)
    }
  }
  for (const candidate of selected) {
    if (!hydrated.has(JSON.stringify(candidate.key))) {
      throw new AccessCatalogRequestError('authority_unavailable')
    }
  }
  return hydrated
}

function catalogItem(
  context: CatalogRequestContext,
  hydrated: HydratedCatalogResource
): AccessCatalogItem {
  const revision = authorizationRevision({
    principalUserId: context.principal.userId,
    sessionContract: context.principal.sessionContract,
    sessionRevision: context.principal.sessionRevision,
    userRevision: context.principal.userRevision,
    memberships: context.principal.memberships,
    resource: hydrated.resource,
    resourceRevision: hydrated.authorizationResourceRevision,
    sourceStateRevision: hydrated.authorizationSourceRevision,
    relationshipsRevision: hydrated.authorizationRelationshipsRevision,
    candidates: hydrated.accessPaths,
  })
  const paths = hydrated.accessPaths
    .map(seed =>
      buildAccessPath({
        principalUserId: context.principal.userId,
        resource: hydrated.resource,
        seed,
        authorizationRevision: revision,
      })
    )
    .sort((left, right) =>
      canonicalAccessPathTuple(left).localeCompare(canonicalAccessPathTuple(right))
    )
  const publicPaths: PublicCatalogAccessPath[] = paths.map(path =>
    Object.freeze({
      accessPathId: path.id,
      kind: path.kind,
      ...(path.kind === 'team'
        ? {
            safeTeamDescriptor: Object.freeze({
              teamId: path.teamId!,
              currentRole: path.currentRole!,
            }),
          }
        : {}),
      capabilities: path.behavior.capabilities,
      behaviorDescriptors: path.behavior,
    })
  )
  return Object.freeze({
    resource: Object.freeze({
      ...hydrated.resource,
      resourceRevision: hydrated.authorizationResourceRevision,
    }),
    relationships: hydrated.relationships,
    capabilities: Object.freeze(
      normalizeAccessCapabilities(paths.flatMap(path => path.behavior.capabilities))
    ),
    accessPaths: Object.freeze(publicPaths),
  })
}

function finalContinuations(input: {
  requestedFamilies: readonly CatalogFamily[]
  runtimes: readonly ProducerRuntime[]
  selected: readonly CatalogIdentityCandidate[]
  initial: Readonly<Record<CatalogFamily, ProducerContinuation>>
}): Record<CatalogFamily, ProducerContinuation> {
  const requested = new Set(input.requestedFamilies)
  const output = emptyContinuations()
  for (const family of CATALOG_FAMILIES) {
    if (!requested.has(family)) {
      output[family] = Object.freeze({ afterKey: null, exhausted: true })
      continue
    }
    const runtime = input.runtimes.find(value => value.family === family)!
    const emitted = input.selected.filter(candidate => candidate.key[1] === family)
    runtime.emittedCount = emitted.length
    const afterKey = emitted.at(-1)?.key ?? input.initial[family].afterKey
    const hasUnconsumed = runtime.page.candidates.length > emitted.length
    output[family] = Object.freeze({
      afterKey,
      exhausted:
        runtime.page.sourceCompleteness === 'complete' && !runtime.page.hasMore && !hasUnconsumed,
    })
  }
  return output
}

function earliestValidUntil(
  candidates: readonly CatalogIdentityCandidate[],
  hydrated: ReadonlyMap<string, HydratedCatalogResource>
): string | null {
  const values = [
    ...candidates.flatMap(candidate => (candidate.validUntil ? [candidate.validUntil] : [])),
    ...[...hydrated.values()].flatMap(value => (value.validUntil ? [value.validUntil] : [])),
  ]
  return values.length > 0 ? values.sort()[0] : null
}

function responseBytes(value: unknown): number {
  try {
    return Math.max(1, Buffer.byteLength(JSON.stringify(value), 'utf8'))
  } catch {
    throw new AccessCatalogRequestError('catalog_invariant_failed')
  }
}

async function buildInTransaction(input: {
  db: DbClient
  budget: AccessExecutionBudget
  session: ExternalSessionAuthorityContext
  environmentId: string
  families: readonly CatalogFamily[]
  limit: number
  decodedCursor: AccessCatalogCursorV3 | null
  filterHash: string
  now: Date
}): Promise<AccessCatalogResponse> {
  await configureAccessAuthorityTransaction(input.db, input.budget)
  const context = await loadCatalogRequestContext({
    db: input.db,
    budget: input.budget,
    session: input.session,
    environmentId: input.environmentId,
  })
  const sourceStateRevision = catalogSourceStateRevision(context.sourceStates)
  if (input.decodedCursor) {
    assertAccessCatalogCursorCurrent(input.decodedCursor, {
      authorizationRevision: context.principal.authorizationRevision,
      sourceStateRevision,
      filterHash: input.filterHash,
      now: input.now,
    })
  }
  const initial = input.decodedCursor?.producers ?? emptyContinuations()
  const runtimes: ProducerRuntime[] = []
  for (const family of input.families) {
    const page = await requireCatalogProducer(family).listCanonicalKeys(
      context,
      initial[family],
      input.limit
    )
    runtimes.push({
      family,
      inputContinuation: initial[family],
      page,
      cursorIndex: 0,
      emittedCount: 0,
    })
  }
  const merged = mergeCandidatePages(runtimes, input.limit)
  const selected = merged.slice(0, input.limit)
  const hydrated = await hydrateSelected(context, selected)
  const items = selected.map(candidate =>
    catalogItem(context, hydrated.get(JSON.stringify(candidate.key))!)
  )
  const partialErrors = safePartialErrors(runtimes)
  const continuations = finalContinuations({
    requestedFamilies: input.families,
    runtimes,
    selected,
    initial,
  })
  const hasNext =
    merged.length > input.limit ||
    runtimes.some(runtime => {
      const continuation = continuations[runtime.family]
      return runtime.page.sourceCompleteness === 'complete' && !continuation.exhausted
    })
  const validUntil = earliestValidUntil(merged, hydrated)
  const lastCanonicalKey = selected.at(-1)?.key
  const nextCursor =
    hasNext && lastCanonicalKey
      ? encodeAccessCatalogCursor(
          {
            v: 3,
            contractVersion: ACCESS_CATALOG_CONTRACT_VERSION,
            authorizationRevision: context.principal.authorizationRevision,
            sourceStateRevision,
            filterHash: input.filterHash,
            sort: ACCESS_CATALOG_SORT,
            lastCanonicalKey,
            producers: continuations,
            validUntil,
          },
          input.budget
        )
      : null
  const response: AccessCatalogResponse = Object.freeze({
    contractVersion: ACCESS_CATALOG_CONTRACT_VERSION,
    authorizationRevision: context.principal.authorizationRevision,
    sourceStateRevision,
    complete: partialErrors.length === 0,
    partialErrors: Object.freeze(partialErrors),
    items: Object.freeze(items),
    nextCursor,
  })
  input.budget.charge({ kind: 'responseBytes', amount: responseBytes(response) })
  return response
}

export async function buildAccessCatalog(
  input: {
    session: ExternalSessionAuthorityContext
    environmentId?: string
    families?: readonly CatalogFamily[]
    limit?: number
    cursor?: string | null
  },
  options: {
    transaction?: CatalogTransaction
    budget?: AccessExecutionBudget
    limits?: Partial<AccessExecutionLimits>
    now?: Date
  } = {}
): Promise<AccessCatalogResponse> {
  const environmentId = input.environmentId ?? canonicalEnvironmentId()
  if (environmentId !== canonicalEnvironmentId()) {
    throw new AccessCatalogRequestError('invalid_request')
  }
  const families = normalizeFamilies(input.families)
  const limit = input.limit ?? 50
  const budget =
    options.budget ?? AccessExecutionBudget.create('catalog', { limits: options.limits })
  const ownedBudget = options.budget ? null : budget
  try {
    budget.assertPageSize(limit)
    const filterHash = catalogFilterHash(families)
    const decodedCursor = input.cursor ? decodeAccessCatalogCursor(input.cursor, budget) : null
    return await (options.transaction ?? withTransaction)(db =>
      buildInTransaction({
        db,
        budget,
        session: input.session,
        environmentId,
        families,
        limit,
        decodedCursor,
        filterHash,
        now: options.now ?? new Date(),
      })
    )
  } catch (error) {
    if (error instanceof CatalogAuthorityError) {
      throw new AccessCatalogRequestError(
        error.code === 'session_not_live' ? 'session_not_live' : 'authority_unavailable'
      )
    }
    if (error instanceof CatalogProducerContractError) {
      throw new AccessCatalogRequestError('authority_unavailable')
    }
    throw error
  } finally {
    ownedBudget?.close()
  }
}

export function catalogCoordinatorContractRevision(): string {
  return revisionOfValues([
    ACCESS_CATALOG_CONTRACT_VERSION,
    ACCESS_CATALOG_SORT,
    CATALOG_FAMILIES,
    'request-local-only',
  ])
}

import type { DbClient } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import {
  type AuthorityCandidate,
  filterCandidatesForOperationTarget,
  loadPrincipalAuthoritySnapshot,
  loadResourceAuthority,
  operationTargetIsCurrentlyValid,
} from './accessAuthorityStore.js'
import { configureAccessAuthorityTransaction } from './accessAuthorityTransaction.js'
import { withAccessDatabaseTransaction } from './accessDatabaseQuery.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from './accessExecutionBudget.js'
import {
  type AccessPath,
  accessPathHandleEquals,
  buildAccessPath,
  selectEquivalentAccessPath,
} from './accessPath.js'
import {
  authorizationRevision,
  canonicalAccessPathSeeds,
  databaseRelationshipsRevision,
} from './authorizationRevision.js'
import {
  type AccessCapability,
  isAccessCapability,
  normalizeAccessCapabilities,
} from './capabilityRegistry.js'
import { validateExactOperationalBindings } from './exactOperationalAuthorization.js'
import {
  OperationTargetValidationError,
  stableOperationTarget,
  validateOperationTarget,
} from './operationTarget.js'
import { canonicalEnvironmentId } from './operationalAccessProjection.js'
import {
  type OperationalResourceGraphResult,
  isOperationalAccessResourceType,
  loadOperationalResourceGraph,
} from './operationalAccessReader.js'
import {
  type CanonicalResourceIdentity,
  canonicalResourceIdentity,
  resourceIdentityKey,
} from './resourceIdentity.js'

export type LiveAuthorizationInput = Readonly<{
  session: ExternalSessionAuthorityContext
  requiredCapability: unknown
  resource: CanonicalResourceIdentity
  operationTarget?: unknown
  requestedAccessPathId?: string
}>

export type LiveAuthorizationResult =
  | Readonly<{
      status: 'allowed'
      effectiveCapabilities: readonly AccessCapability[]
      paths: readonly AccessPath[]
      selectedPath: AccessPath
      authorizationRevision: string
      validUntil: string | null
    }>
  | Readonly<{
      status: 'denied'
      code: 'forbidden' | 'unknown_capability' | 'session_not_live'
    }>
  | Readonly<{ status: 'invalid'; code: 'invalid_resource' | 'invalid_operation_target' }>
  | Readonly<{ status: 'not_found'; code: 'not_found' }>
  | Readonly<{
      status: 'access_path_required'
      code: 'access_path_required'
      authorizationRevision: string
      safePathDescriptors: readonly Readonly<{
        id: string
        kind: 'direct' | 'team'
        teamId?: string
      }>[]
    }>
  | Readonly<{
      status: 'access_path_stale'
      code: 'access_path_stale'
      currentAuthorizationRevision: string
    }>
  | Readonly<{
      status: 'unavailable'
      dependencyClass: 'authorization_store' | 'operational_resource_store' | 'capacity'
      retryable: true
      correlationId?: string
    }>

type ResolverTransaction = <T>(work: (db: DbClient) => Promise<T>) => Promise<T>

function validPathHandle(value: string | undefined): value is string {
  return typeof value === 'string' && /^ap1_[A-Za-z0-9_-]{43}$/.test(value)
}

function dependencyForError(
  error: unknown
): 'authorization_store' | 'operational_resource_store' | 'capacity' {
  if (
    error instanceof AccessBudgetExceededError ||
    error instanceof AccessExecutionCancelledError
  ) {
    return 'capacity'
  }
  return 'authorization_store'
}

function candidateForPath(
  path: AccessPath,
  candidates: readonly AuthorityCandidate[]
): AuthorityCandidate | undefined {
  return candidates.find(
    candidate =>
      candidate.kind === path.kind &&
      candidate.grantId === path.grantId &&
      candidate.teamId === path.teamId
  )
}

export class AuthorizationRequestMemo {
  private readonly values = new Map<string, Promise<LiveAuthorizationResult>>()

  constructor(private readonly budget: AccessExecutionBudget) {}

  getOrCreate(
    input: LiveAuthorizationInput,
    targetKey: string,
    factory: () => Promise<LiveAuthorizationResult>
  ): Promise<LiveAuthorizationResult> {
    const key = JSON.stringify([
      input.session,
      input.requiredCapability,
      resourceIdentityKey(input.resource),
      targetKey,
      input.requestedAccessPathId ?? null,
    ])
    const existing = this.values.get(key)
    if (existing) return existing
    this.budget.charge({ kind: 'memoEntries' })
    this.budget.charge({ kind: 'memoBytes', amount: Buffer.byteLength(key, 'utf8') })
    const created = factory()
    this.values.set(key, created)
    void created.catch(() => this.values.delete(key))
    return created
  }
}

async function resolveInTransaction(input: {
  request: LiveAuthorizationInput
  capability: AccessCapability
  operationTarget: ReturnType<typeof validateOperationTarget>
  db: DbClient
  gateway?: Pick<K8sGateway, 'getResourceExact'>
  budget: AccessExecutionBudget
}): Promise<LiveAuthorizationResult> {
  await configureAccessAuthorityTransaction(input.db, input.budget)
  const snapshot = await loadPrincipalAuthoritySnapshot({
    db: input.db,
    budget: input.budget,
    session: input.request.session,
    resource: input.request.resource,
  })
  if (!snapshot) return { status: 'not_found', code: 'not_found' }
  if (!snapshot.sessionLive) return { status: 'denied', code: 'session_not_live' }

  let graph: OperationalResourceGraphResult | null = null
  if (isOperationalAccessResourceType(input.request.resource.type)) {
    try {
      graph = await loadOperationalResourceGraph({
        db: input.db,
        budget: input.budget,
        environmentId: input.request.resource.environmentId,
        resourceType: input.request.resource.type,
        logicalId: input.request.resource.logicalId,
      })
    } catch (error) {
      if (
        error instanceof AccessBudgetExceededError ||
        error instanceof AccessExecutionCancelledError
      ) {
        throw error
      }
      return {
        status: 'unavailable',
        dependencyClass: 'operational_resource_store',
        retryable: true,
      }
    }
    if (graph.status === 'unavailable') {
      return {
        status: 'unavailable',
        dependencyClass: 'operational_resource_store',
        retryable: true,
      }
    }
    if (graph.status === 'not_found') return { status: 'not_found', code: 'not_found' }
  }
  if (
    !(await operationTargetIsCurrentlyValid({
      db: input.db,
      budget: input.budget,
      resource: input.request.resource,
      capability: input.capability,
      operationTarget: input.operationTarget,
    }))
  ) {
    return { status: 'denied', code: 'forbidden' }
  }

  const authority = await loadResourceAuthority({
    db: input.db,
    budget: input.budget,
    snapshot,
    resource: input.request.resource,
    operationTarget: input.operationTarget,
    operationalGraph: graph,
  })
  if (!authority.exists) return { status: 'not_found', code: 'not_found' }
  const targeted = filterCandidatesForOperationTarget({
    candidates: authority.candidates,
    capability: input.capability,
    operationTarget: input.operationTarget,
  })
  const capable = canonicalAccessPathSeeds(
    targeted.filter(candidate => candidate.behavior.capabilities.includes(input.capability))
  )
  if (capable.length === 0) return { status: 'denied', code: 'forbidden' }
  input.budget.charge({ kind: 'accessPaths', amount: capable.length })

  const revision = authorizationRevision({
    principalUserId: snapshot.userId,
    sessionContract: snapshot.sessionContract,
    sessionRevision: snapshot.sessionRevision,
    userRevision: snapshot.userRevision,
    memberships: snapshot.memberships,
    resource: input.request.resource,
    resourceRevision: snapshot.resourceRevision,
    sourceStateRevision:
      graph?.status === 'current' ? graph.sourceStateRevision : 'database-resource',
    relationshipsRevision:
      graph?.status === 'current'
        ? graph.relationshipsRevision
        : databaseRelationshipsRevision(authority.relationships),
    candidates: capable,
  })
  const paths = Object.freeze(
    capable.map(seed =>
      buildAccessPath({
        principalUserId: snapshot.userId,
        resource: input.request.resource,
        seed,
        authorizationRevision: revision,
      })
    )
  )

  let selectedPath: AccessPath | undefined
  if (input.request.requestedAccessPathId) {
    selectedPath = paths.find(path =>
      accessPathHandleEquals(path.id, input.request.requestedAccessPathId!)
    )
    if (!selectedPath) {
      return {
        status: 'access_path_stale',
        code: 'access_path_stale',
        currentAuthorizationRevision: revision,
      }
    }
  } else {
    selectedPath = selectEquivalentAccessPath(paths) ?? undefined
    if (!selectedPath) {
      return {
        status: 'access_path_required',
        code: 'access_path_required',
        authorizationRevision: revision,
        safePathDescriptors: Object.freeze(
          paths.map(path =>
            Object.freeze({
              id: path.id,
              kind: path.kind,
              ...(path.teamId ? { teamId: path.teamId } : {}),
            })
          )
        ),
      }
    }
  }

  const selectedCandidate = candidateForPath(selectedPath, capable)
  if (!selectedCandidate) {
    return {
      status: 'access_path_stale',
      code: 'access_path_stale',
      currentAuthorizationRevision: revision,
    }
  }
  const exact = await validateExactOperationalBindings({
    gateway: input.gateway,
    budget: input.budget,
    bindings: selectedCandidate.operationalBindings,
  })
  if (exact.status === 'not_found') return { status: 'not_found', code: 'not_found' }
  if (exact.status === 'stale') {
    return input.request.requestedAccessPathId
      ? {
          status: 'access_path_stale',
          code: 'access_path_stale',
          currentAuthorizationRevision: revision,
        }
      : {
          status: 'unavailable',
          dependencyClass: 'operational_resource_store',
          retryable: true,
        }
  }
  if (exact.status === 'unavailable') {
    return {
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
    }
  }
  return Object.freeze({
    status: 'allowed',
    effectiveCapabilities: Object.freeze(
      normalizeAccessCapabilities(paths.flatMap(path => path.behavior.capabilities))
    ),
    paths,
    selectedPath,
    authorizationRevision: revision,
    validUntil: authority.validUntil?.toISOString() ?? null,
  })
}

export async function resolveLiveAuthorization(
  input: LiveAuthorizationInput,
  options: {
    gateway?: Pick<K8sGateway, 'getResourceExact'>
    budget?: AccessExecutionBudget
    memo?: AuthorizationRequestMemo
    transaction?: ResolverTransaction
    correlationId?: string
  } = {}
): Promise<LiveAuthorizationResult> {
  const ownedBudget = options.budget ? null : AccessExecutionBudget.create('action')
  const budget = options.budget ?? ownedBudget!
  try {
    if (!isAccessCapability(input.requiredCapability)) {
      return { status: 'denied', code: 'unknown_capability' }
    }
    if (
      input.session.userId.trim().length === 0 ||
      input.session.userId !== input.session.userId.trim() ||
      input.resource.environmentId !== canonicalEnvironmentId()
    ) {
      return { status: 'invalid', code: 'invalid_resource' }
    }
    let resource: CanonicalResourceIdentity
    try {
      resource = canonicalResourceIdentity(input.resource)
    } catch {
      return { status: 'invalid', code: 'invalid_resource' }
    }
    if (resourceIdentityKey(resource) !== resourceIdentityKey(input.resource)) {
      return { status: 'invalid', code: 'invalid_resource' }
    }
    if (
      input.requestedAccessPathId !== undefined &&
      !validPathHandle(input.requestedAccessPathId)
    ) {
      return { status: 'invalid', code: 'invalid_operation_target' }
    }
    let operationTarget: ReturnType<typeof validateOperationTarget>
    try {
      operationTarget = validateOperationTarget({
        capability: input.requiredCapability,
        resource,
        operationTarget: input.operationTarget,
      })
    } catch (error) {
      if (error instanceof OperationTargetValidationError) {
        return { status: 'invalid', code: 'invalid_operation_target' }
      }
      throw error
    }
    const work = (db: DbClient) =>
      resolveInTransaction({
        request: { ...input, resource },
        capability: input.requiredCapability as AccessCapability,
        operationTarget,
        db,
        gateway: options.gateway,
        budget,
      })
    const factory = () =>
      options.transaction
        ? options.transaction(work)
        : withAccessDatabaseTransaction(budget, work, { mode: 'caller_configured' })
    return options.memo
      ? await options.memo.getOrCreate(input, stableOperationTarget(operationTarget), factory)
      : await factory()
  } catch (error) {
    return {
      status: 'unavailable',
      dependencyClass: dependencyForError(error),
      retryable: true,
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    }
  } finally {
    ownedBudget?.close()
  }
}

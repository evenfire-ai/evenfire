import { type DbClient, pool } from '../../db.js'
import { loadResourceAuthority } from './accessAuthorityStore.js'
import { configureAccessAuthorityTransaction } from './accessAuthorityTransaction.js'
import { runAccessDatabaseQuery, withAccessDatabaseTransaction } from './accessDatabaseQuery.js'
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
  type ActionOperationId,
  ActionOperationTargetError,
  getActionOperationDefinition,
  validateActionOperationTarget,
} from './actionOperationRegistry.js'
import { type AuthorityCandidate, type OperationalPathBinding } from './authorityCandidates.js'
import {
  authorizationRevision,
  canonicalAccessPathSeeds,
  databaseRelationshipsRevision,
  revisionOfValues,
} from './authorizationRevision.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import { type AccessCapability, isAccessCapability } from './capabilityRegistry.js'
import { validateExactOperationalBindings } from './exactOperationalAuthorization.js'
import type { ValidatedOperationTarget } from './operationTarget.js'
import { canonicalEnvironmentId } from './operationalAccessProjection.js'
import {
  type OperationalGraphClass,
  type OperationalGraphGateway,
  type OperationalResourceGraphResult,
  isOperationalAccessResourceType,
  loadLiveOperationalResourceGraph,
  operationalDependencyRevision,
} from './operationalAccessReader.js'
import {
  type AccessAuthoritySession,
  loadPrincipalAuthoritySnapshot,
} from './principalAuthoritySnapshot.js'
import {
  type CanonicalResourceIdentity,
  canonicalResourceIdentity,
  resourceIdentityKey,
} from './resourceIdentity.js'

export type LiveAuthorizationInput = Readonly<{
  session: AccessAuthoritySession
  requiredCapability: unknown
  resource: CanonicalResourceIdentity
  operationId?: ActionOperationId
  operationTarget?: unknown
  requestedAccessPathId?: string
}>

export type LiveActionAuthorizationInput = Readonly<{
  session: AccessAuthoritySession
  operationId: ActionOperationId
  /**
   * The signed operation resource remains authoritative for target validation.
   * Runtime actions may resolve grants through an exact Host ancestor instead.
   */
  resource: CanonicalResourceIdentity
  authorizationResource?: CanonicalResourceIdentity
  operationTarget?: unknown
  requestedAccessPathId?: string
}>

export type LiveAuthorizationResult =
  | Readonly<{
      status: 'allowed'
      effectiveCapabilities: readonly AccessCapability[]
      paths: readonly AccessPath[]
      selectedPath: AccessPath
      operationalBindings: readonly OperationalPathBinding[]
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

const HOST_GRAPH_ACTIONS = new Set<ActionOperationId>([
  'host.status.read',
  'host.health.read',
  'host.wake',
  'host.manage',
  'host.activity.read',
  'host.activity.read_all',
  'remote_desktop.status',
  'remote_desktop.open',
  'remote_desktop.reconnect',
])

export type LiveAuthorizationGateway = OperationalGraphGateway

export type LiveAuthorizationOptions = Readonly<{
  gateway?: LiveAuthorizationGateway
  budget?: AccessExecutionBudget
  /**
   * A caller-owned transaction. Only Postgres-only resources may be resolved
   * in it: the resolver never makes a Kubernetes call while a caller holds a
   * Postgres transaction.
   */
  transaction?: ResolverTransaction
  configureTransaction?: boolean
  correlationId?: string
}>

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

export function selectActionOperationalDependencies(
  graph: OperationalResourceGraphResult,
  operationId: ActionOperationId | undefined,
  operationTarget?: ValidatedOperationTarget
): OperationalResourceGraphResult {
  if (graph.status !== 'current' || !operationId) return graph
  const root = graph.resource
  if (
    root.resourceType !== 'host' ||
    !HOST_GRAPH_ACTIONS.has(operationId) ||
    operationTarget?.hostRef !== root.logicalId
  ) {
    return graph
  }

  const hostContextEdges = graph.relationships.filter(
    relationship =>
      relationship.sourceType === 'host' &&
      relationship.sourceId === root.logicalId &&
      relationship.relationshipType === 'uses_context' &&
      relationship.targetType === 'context'
  )
  if (hostContextEdges.length > 1) {
    return { status: 'unavailable', safeCode: 'operational_related_resource_incomplete' }
  }
  const selectedContextId = hostContextEdges[0]?.targetId
  const relationships = graph.relationships.filter(
    relationship =>
      hostContextEdges.includes(relationship) ||
      (selectedContextId !== undefined &&
        relationship.sourceType === 'context' &&
        relationship.sourceId === selectedContextId &&
        relationship.relationshipType !== 'includes_mcp_server')
  )

  const selectedKeys = new Set<string>([JSON.stringify([root.resourceType, root.logicalId])])
  for (const relationship of relationships) {
    for (const [resourceType, logicalId] of [
      [relationship.sourceType, relationship.sourceId],
      [relationship.targetType, relationship.targetId],
    ] as const) {
      if (
        ['host', 'context', 'mcp_server', 'workflow_recipe', 'shared_filesystem'].includes(
          resourceType
        )
      ) {
        selectedKeys.add(JSON.stringify([resourceType, logicalId]))
      }
    }
  }
  const selectedResources = graph.resources.filter(resource =>
    selectedKeys.has(JSON.stringify([resource.resourceType, resource.logicalId]))
  )
  if (selectedResources.length !== selectedKeys.size) {
    return { status: 'unavailable', safeCode: 'operational_related_resource_incomplete' }
  }
  const resources = graph.resources
    .filter(resource =>
      selectedKeys.has(JSON.stringify([resource.resourceType, resource.logicalId]))
    )
    .sort((left, right) =>
      compareCanonicalUtf8Text(
        JSON.stringify([left.resourceType, left.logicalId]),
        JSON.stringify([right.resourceType, right.logicalId])
      )
    )
  const orderedRelationships = [...relationships].sort((left, right) =>
    compareCanonicalUtf8Text(
      JSON.stringify([
        left.sourceType,
        left.sourceId,
        left.relationshipType,
        left.targetType,
        left.targetId,
        left.relationshipInstanceId,
      ]),
      JSON.stringify([
        right.sourceType,
        right.sourceId,
        right.relationshipType,
        right.targetType,
        right.targetId,
        right.relationshipInstanceId,
      ])
    )
  )
  const relationshipsRevision = revisionOfValues(
    orderedRelationships.map(relationship => [
      relationship.sourceType,
      relationship.sourceId,
      relationship.relationshipType,
      relationship.targetType,
      relationship.targetId,
      relationship.relationshipInstanceId,
      relationship.behaviorAttributes,
      relationship.sourceProviderUid,
      relationship.sourceResourceVersion,
    ])
  )
  return Object.freeze({
    ...graph,
    resources: Object.freeze(resources),
    relationships: Object.freeze(orderedRelationships),
    dependencyRevision: operationalDependencyRevision({ resource: root, resources }),
    relationshipsRevision,
  })
}

function operationalGraphClass(
  request: LiveAuthorizationInput,
  operationTarget: ValidatedOperationTarget
): OperationalGraphClass {
  return request.resource.type === 'host' &&
    request.operationId !== undefined &&
    HOST_GRAPH_ACTIONS.has(request.operationId) &&
    operationTarget?.hostRef === request.resource.logicalId
    ? 'host_graph'
    : 'full'
}

function isWorkflowRunResume(
  request: LiveAuthorizationInput,
  operationTarget: ValidatedOperationTarget
): boolean {
  return (
    request.resource.type === 'workflow_run' &&
    request.session.contract === 'v2' &&
    operationTarget?.runId === request.resource.logicalId &&
    operationTarget.action === 'resume'
  )
}

type KubernetesPhase = Readonly<{
  graph: OperationalResourceGraphResult | null
  workflowRunRecipeGraph: OperationalResourceGraphResult | null
}>

/**
 * Phase K1, outside any Postgres transaction: the live operational graph of
 * the resource, or, for a V2 workflow run resume, of the run's recipe.
 */
async function loadKubernetesPhase(input: {
  request: LiveAuthorizationInput
  operationTarget: ValidatedOperationTarget
  gateway?: LiveAuthorizationGateway
  budget: AccessExecutionBudget
}): Promise<KubernetesPhase> {
  if (isOperationalAccessResourceType(input.request.resource.type)) {
    if (!input.gateway) {
      return {
        graph: { status: 'unavailable', safeCode: 'operational_gateway_unavailable' },
        workflowRunRecipeGraph: null,
      }
    }
    try {
      const graph = await loadLiveOperationalResourceGraph({
        gateway: input.gateway,
        budget: input.budget,
        resource: input.request.resource,
        operationClass: operationalGraphClass(input.request, input.operationTarget),
      })
      return {
        graph: selectActionOperationalDependencies(
          graph,
          input.request.operationId,
          input.operationTarget
        ),
        workflowRunRecipeGraph: null,
      }
    } catch (error) {
      if (
        error instanceof AccessBudgetExceededError ||
        error instanceof AccessExecutionCancelledError
      ) {
        throw error
      }
      return {
        graph: { status: 'unavailable', safeCode: 'operational_source_unavailable' },
        workflowRunRecipeGraph: null,
      }
    }
  }
  if (!isWorkflowRunResume(input.request, input.operationTarget)) {
    return { graph: null, workflowRunRecipeGraph: null }
  }
  // One autocommit statement names the run's recipe; phase P re-reads the run in
  // its snapshot and requires the same recipe.
  const run = await runAccessDatabaseQuery(
    pool,
    input.budget,
    `SELECT recipe_namespace, recipe_name
       FROM workflow_runs
      WHERE run_id::text = $1`,
    [input.request.resource.logicalId]
  )
  const row = run.rows[0] as Record<string, unknown> | undefined
  if (!row) return { graph: null, workflowRunRecipeGraph: null }
  if (!input.gateway) {
    return {
      graph: null,
      workflowRunRecipeGraph: {
        status: 'unavailable',
        safeCode: 'operational_gateway_unavailable',
      },
    }
  }
  const recipe = canonicalResourceIdentity({
    environmentId: input.request.resource.environmentId,
    type: 'workflow_recipe',
    logicalId: `${String(row.recipe_namespace)}/${String(row.recipe_name)}`,
  })
  return {
    graph: null,
    workflowRunRecipeGraph: await loadLiveOperationalResourceGraph({
      gateway: input.gateway,
      budget: input.budget,
      resource: recipe,
      operationClass: 'full',
    }),
  }
}

type PostgresPhase =
  | Readonly<{ status: 'resolved'; result: LiveAuthorizationResult }>
  | Readonly<{
      status: 'selected'
      revision: string
      paths: readonly AccessPath[]
      selectedPath: AccessPath
      selectedCandidate: AuthorityCandidate
      validUntil: Date | null
    }>

/**
 * Phase P, one short read-only transaction: principal snapshot, candidates,
 * policy snapshot, `ar1_` and path selection. It makes no Kubernetes call.
 */
async function resolvePostgresPhase(input: {
  request: LiveAuthorizationInput
  capability: AccessCapability
  operationTarget: ValidatedOperationTarget
  kubernetes: KubernetesPhase
  db: DbClient
  budget: AccessExecutionBudget
  configureTransaction: boolean
}): Promise<PostgresPhase> {
  const resolved = (result: LiveAuthorizationResult): PostgresPhase => ({
    status: 'resolved',
    result,
  })
  if (input.configureTransaction) {
    await configureAccessAuthorityTransaction(input.db, input.budget)
  }
  const snapshot = await loadPrincipalAuthoritySnapshot({
    db: input.db,
    budget: input.budget,
    session: input.request.session,
  })
  if (!snapshot) return resolved({ status: 'not_found', code: 'not_found' })
  if (!snapshot.sessionLive) return resolved({ status: 'denied', code: 'session_not_live' })

  const graph = input.kubernetes.graph
  if (graph?.status === 'unavailable') {
    return resolved({
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
    })
  }
  if (graph?.status === 'not_found') return resolved({ status: 'not_found', code: 'not_found' })

  const authority = await loadResourceAuthority({
    db: input.db,
    budget: input.budget,
    snapshot,
    resource: input.request.resource,
    operationTarget: input.operationTarget,
    operationalGraph: graph,
    workflowRunRecipeGraph: input.kubernetes.workflowRunRecipeGraph,
  })
  if (!authority.exists) return resolved({ status: 'not_found', code: 'not_found' })
  const identitySeeds = canonicalAccessPathSeeds(authority.candidates)
  if (identitySeeds.length === 0) return resolved({ status: 'denied', code: 'forbidden' })
  input.budget.charge({ kind: 'accessPaths', amount: identitySeeds.length })
  const capable = Object.freeze(
    identitySeeds.filter(candidate => candidate.behavior.capabilities.includes(input.capability))
  )
  if (capable.length === 0) return resolved({ status: 'denied', code: 'forbidden' })

  let resourceRevision: string
  if (graph?.status === 'current') {
    resourceRevision = revisionOfValues([
      graph.resource.providerUid,
      graph.resource.providerResourceVersion,
    ])
  } else {
    if (authority.candidateRowsRevision === null) {
      throw new Error('authorization_resource_revision_unavailable')
    }
    resourceRevision = authority.candidateRowsRevision
  }
  const revision = authorizationRevision({
    principalUserId: snapshot.userId,
    sessionContract: snapshot.sessionContract,
    sessionRevision: snapshot.sessionRevision,
    memberships: snapshot.memberships,
    resource: input.request.resource,
    resourceRevision,
    dependencyRevision:
      graph?.status === 'current' ? graph.dependencyRevision : 'database-resource',
    relationshipsRevision:
      graph?.status === 'current'
        ? graph.relationshipsRevision
        : databaseRelationshipsRevision(authority.relationships),
    candidates: identitySeeds,
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
      return resolved({
        status: 'access_path_stale',
        code: 'access_path_stale',
        currentAuthorizationRevision: revision,
      })
    }
  } else {
    selectedPath = selectEquivalentAccessPath(paths) ?? undefined
    if (!selectedPath) {
      return resolved({
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
      })
    }
  }

  const selectedCandidate = candidateForPath(selectedPath, capable)
  if (!selectedCandidate) {
    return resolved({
      status: 'access_path_stale',
      code: 'access_path_stale',
      currentAuthorizationRevision: revision,
    })
  }
  return {
    status: 'selected',
    revision,
    paths,
    selectedPath,
    selectedCandidate,
    validUntil: authority.validUntil,
  }
}

async function resolveLiveAuthorizationUsing(
  input: LiveAuthorizationInput,
  options: LiveAuthorizationOptions,
  operationTarget: ValidatedOperationTarget
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
    const request: LiveAuthorizationInput = { ...input, resource }
    if (
      options.transaction &&
      (isOperationalAccessResourceType(resource.type) ||
        isWorkflowRunResume(request, operationTarget))
    ) {
      // A caller-held transaction may not span the Kubernetes reads of phase K1.
      return {
        status: 'unavailable',
        dependencyClass: 'operational_resource_store',
        retryable: true,
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      }
    }

    const kubernetes = await loadKubernetesPhase({
      request,
      operationTarget,
      gateway: options.gateway,
      budget,
    })
    const work = (db: DbClient) =>
      resolvePostgresPhase({
        request,
        capability: input.requiredCapability as AccessCapability,
        operationTarget,
        kubernetes,
        db,
        budget,
        configureTransaction: options.configureTransaction !== false,
      })
    const phase = options.transaction
      ? await options.transaction(work)
      : await withAccessDatabaseTransaction(budget, work, { mode: 'caller_configured' })
    if (phase.status === 'resolved') return phase.result

    // Phase K2, outside any Postgres transaction: re-read every binding of the
    // selected path and compare it with what phases K1 and P decided on.
    const exact = await validateExactOperationalBindings({
      gateway: options.gateway,
      budget,
      bindings: phase.selectedCandidate.operationalBindings,
    })
    if (exact.status === 'not_found') return { status: 'not_found', code: 'not_found' }
    if (exact.status === 'stale') {
      return input.requestedAccessPathId
        ? {
            status: 'access_path_stale',
            code: 'access_path_stale',
            currentAuthorizationRevision: phase.revision,
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
      effectiveCapabilities: Object.freeze([...phase.selectedPath.behavior.capabilities]),
      paths: phase.paths,
      selectedPath: phase.selectedPath,
      operationalBindings: Object.freeze([...phase.selectedCandidate.operationalBindings]),
      authorizationRevision: phase.revision,
      validUntil: phase.validUntil?.toISOString() ?? null,
    })
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

/**
 * Resolves one canonical PR 2 action without passing its exact target through
 * the legacy capability-target table. The shared operation registry owns target
 * shape and resource binding. The common live resolver continues to own current
 * session, grant, selected-path, revision, and exact operational binding checks.
 */
export async function resolveLiveActionAuthorization(
  input: LiveActionAuthorizationInput,
  options: LiveAuthorizationOptions = {}
): Promise<LiveAuthorizationResult> {
  let operation
  try {
    operation = getActionOperationDefinition(input.operationId)
  } catch {
    return { status: 'invalid', code: 'invalid_operation_target' }
  }
  const requiredCapability = operation.requiredCapabilities[0]
  if (!requiredCapability || operation.requiredCapabilities.length !== 1) {
    return { status: 'denied', code: 'unknown_capability' }
  }
  let operationResource: CanonicalResourceIdentity
  let authorizationResource: CanonicalResourceIdentity
  let operationTarget: ReturnType<typeof validateActionOperationTarget>
  try {
    operationResource = canonicalResourceIdentity(input.resource)
    if (
      resourceIdentityKey(operationResource) !== resourceIdentityKey(input.resource) ||
      operationResource.environmentId !== canonicalEnvironmentId()
    ) {
      return { status: 'invalid', code: 'invalid_resource' }
    }
    authorizationResource = canonicalResourceIdentity(input.authorizationResource ?? input.resource)
    if (
      resourceIdentityKey(authorizationResource) !==
        resourceIdentityKey(input.authorizationResource ?? input.resource) ||
      authorizationResource.environmentId !== operationResource.environmentId
    ) {
      return { status: 'invalid', code: 'invalid_resource' }
    }
    operationTarget = validateActionOperationTarget({
      operationId: input.operationId,
      resource: operationResource,
      operationTarget: input.operationTarget,
    })
  } catch (error) {
    if (error instanceof ActionOperationTargetError) {
      return { status: 'invalid', code: 'invalid_operation_target' }
    }
    return { status: 'invalid', code: 'invalid_resource' }
  }
  if (resourceIdentityKey(authorizationResource) !== resourceIdentityKey(operationResource)) {
    const hostRef = operationTarget && 'hostRef' in operationTarget ? operationTarget.hostRef : null
    if (
      authorizationResource.type !== 'host' ||
      typeof hostRef !== 'string' ||
      hostRef !== authorizationResource.logicalId
    ) {
      return { status: 'invalid', code: 'invalid_resource' }
    }
  }
  const request: LiveAuthorizationInput = {
    session: input.session,
    requiredCapability,
    resource: authorizationResource,
    operationId: input.operationId,
    operationTarget,
    ...(input.requestedAccessPathId ? { requestedAccessPathId: input.requestedAccessPathId } : {}),
  }
  return resolveLiveAuthorizationUsing(request, options, operationTarget)
}

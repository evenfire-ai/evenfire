import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { ClerumResourceType } from '../../types.js'
import { K8sNotFoundError, type ResourceListPage } from '../resourceService.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import {
  type OperationalBehaviorSources,
  type OperationalObjectProjection,
  type OperationalRelationshipRecord,
  type OperationalResourceType,
  type OperationalSourceFamily,
  projectOperationalObject,
} from './operationalAccessProjection.js'
import type { AccessResourceType, CanonicalResourceIdentity } from './resourceIdentity.js'

export type OperationalIndexedResource = Readonly<{
  environmentId: string
  resourceType: OperationalResourceType
  logicalId: string
  sourceFamily: OperationalSourceFamily
  providerUid: string
  providerResourceVersion: string
  displayName: string
  enabled: boolean
  deletedAt: string | null
  observedGeneration: number | null
  contentBytes: number
  behaviorSources: OperationalBehaviorSources
}>

export type OperationalIndexedRelationship = OperationalRelationshipRecord

export type OperationalResourceGraphResult =
  | Readonly<{
      status: 'current'
      resource: OperationalIndexedResource
      resources: readonly OperationalIndexedResource[]
      relationships: readonly OperationalIndexedRelationship[]
      /**
       * Grant reference names per canonical Context in `resources`: its
       * metadata.name and its spec.contextId alias, each kept only when it
       * resolves to that Context alone.
       */
      contextReferenceNames: ReadonlyMap<string, readonly string[]>
      dependencyRevision: string
      relationshipsRevision: string
    }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'unavailable'; safeCode: string }>

type CurrentOperationalGraph = Extract<OperationalResourceGraphResult, { status: 'current' }>

/**
 * `host_graph` serves the Host status, health, wake, manage, activity and
 * remote desktop actions on their own Host: the Context's MCP servers are not
 * read and not required here; the resolver's dependency selection requires
 * every remaining resource. `full` requires every related resource.
 */
export type OperationalGraphClass = 'full' | 'host_graph'

export type OperationalGraphGateway = Pick<K8sGateway, 'getResourceExact' | 'listResourcePage'>

type OperationalPlural = Extract<
  ClerumResourceType,
  'hosts' | 'contexts' | 'mcpservers' | 'workflowrecipes' | 'sharedfilesystems'
>

const OPERATIONAL_FAMILY_SOURCES: Readonly<
  Record<OperationalSourceFamily, Readonly<{ plural: OperationalPlural; namespace: string }>>
> = Object.freeze({
  host: { plural: 'hosts', namespace: config.hostsNamespace },
  context: { plural: 'contexts', namespace: config.contextsNamespace },
  mcp_server: { plural: 'mcpservers', namespace: config.mcpServersNamespace },
  workflow_recipe: { plural: 'workflowrecipes', namespace: config.sandboxNamespace },
  shared_filesystem: {
    plural: 'sharedfilesystems',
    namespace: config.sharedFilesystemsNamespace,
  },
})

const RELATED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'shared_filesystem',
])

const OPERATIONAL_ACCESS_RESOURCE_TYPES: ReadonlySet<AccessResourceType> = new Set([
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'shared_filesystem',
  'sandbox_app',
])

export function isOperationalAccessResourceType(type: AccessResourceType): boolean {
  return OPERATIONAL_ACCESS_RESOURCE_TYPES.has(type)
}

function resourceKey(resourceType: string, logicalId: string): string {
  return JSON.stringify([resourceType, logicalId])
}

/**
 * The facts the loader read about every dependency of a decision graph (all
 * resources except its root). `metadata.generation` moves on spec changes only,
 * so status writes on Hosts and Contexts do not change it.
 */
export function operationalDependencyRevision(input: {
  resource: OperationalIndexedResource
  resources: readonly OperationalIndexedResource[]
}): string {
  const rootKey = resourceKey(input.resource.resourceType, input.resource.logicalId)
  return revisionOfValues(
    input.resources
      .filter(resource => resourceKey(resource.resourceType, resource.logicalId) !== rootKey)
      .map(resource => [
        resource.resourceType,
        resource.logicalId,
        resource.providerUid,
        resource.observedGeneration,
        resource.enabled,
        resource.deletedAt,
      ])
  )
}

/**
 * Restrict a loaded live graph to one selected runtime path. The graph loader
 * intentionally returns the complete candidate neighborhood for derived
 * resources (for example, every Context that includes an MCP server). A path
 * must not inherit policy from sibling Hosts or Contexts in that neighborhood.
 */
export function selectOperationalPathGraph(input: {
  graph: CurrentOperationalGraph
  contextId?: string
  hostId?: string
  recipeId?: string
}): CurrentOperationalGraph | null {
  const { graph } = input
  const root = graph.resource
  const resourcesByKey = new Map(
    graph.resources.map(resource => [
      JSON.stringify([resource.resourceType, resource.logicalId]),
      resource,
    ])
  )
  let contextId = input.contextId
  let recipeId = input.recipeId
  if (!recipeId && root.resourceType === 'workflow_recipe') recipeId = root.logicalId
  if (!recipeId && root.resourceType === 'sandbox_app') {
    const recipeIds = new Set(
      graph.relationships
        .filter(
          relationship =>
            relationship.sourceType === 'workflow_recipe' &&
            relationship.relationshipType === 'exposes_sandbox_app' &&
            relationship.targetType === 'sandbox_app' &&
            relationship.targetId === root.logicalId
        )
        .map(relationship => relationship.sourceId)
    )
    if (recipeIds.size !== 1) return null
    recipeId = [...recipeIds][0]
  }
  if (!contextId && root.resourceType === 'context') contextId = root.logicalId
  if (!contextId && ['host', 'workflow_recipe', 'sandbox_app'].includes(root.resourceType)) {
    const sourceType = root.resourceType === 'sandbox_app' ? 'workflow_recipe' : root.resourceType
    const sourceId = root.resourceType === 'sandbox_app' ? recipeId : root.logicalId
    const contextEdges = graph.relationships.filter(
      relationship =>
        relationship.sourceType === sourceType &&
        relationship.sourceId === sourceId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context'
    )
    if (contextEdges.length > 1) return null
    if (contextEdges.length === 1) contextId = contextEdges[0]!.targetId
  }

  if (contextId && !resourcesByKey.has(JSON.stringify(['context', contextId]))) return null

  let hostId = input.hostId
  if (!hostId && root.resourceType === 'host') hostId = root.logicalId
  if (hostId && !resourcesByKey.has(JSON.stringify(['host', hostId]))) return null
  if (recipeId && !resourcesByKey.has(JSON.stringify(['workflow_recipe', recipeId]))) return null
  if (hostId) {
    const hostContextEdges = graph.relationships.filter(
      relationship =>
        relationship.sourceType === 'host' &&
        relationship.sourceId === hostId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context'
    )
    if (
      hostContextEdges.length > 1 ||
      (contextId &&
        (hostContextEdges.length !== 1 || hostContextEdges[0]!.targetId !== contextId)) ||
      (!contextId && hostContextEdges.length !== 0)
    ) {
      return null
    }
  }
  if (recipeId && contextId) {
    const recipeContextEdges = graph.relationships.filter(
      relationship =>
        relationship.sourceType === 'workflow_recipe' &&
        relationship.sourceId === recipeId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context' &&
        relationship.targetId === contextId
    )
    if (recipeContextEdges.length !== 1) return null
  }

  const selectedRelationships = graph.relationships.filter(relationship => {
    if (contextId && relationship.sourceType === 'context' && relationship.sourceId === contextId) {
      return true
    }
    if (
      hostId &&
      relationship.sourceType === 'host' &&
      relationship.sourceId === hostId &&
      relationship.relationshipType === 'uses_context' &&
      relationship.targetId === contextId
    ) {
      return true
    }
    if (
      recipeId &&
      relationship.sourceType === 'workflow_recipe' &&
      relationship.sourceId === recipeId &&
      ((relationship.relationshipType === 'uses_context' && relationship.targetId === contextId) ||
        (root.resourceType === 'sandbox_app' &&
          relationship.relationshipType === 'exposes_sandbox_app' &&
          relationship.targetId === root.logicalId))
    ) {
      return true
    }
    if (relationship.sourceType === root.resourceType && relationship.sourceId === root.logicalId) {
      return true
    }
    return false
  })

  const selectedKeys = new Set<string>([
    JSON.stringify([root.resourceType, root.logicalId]),
    ...(contextId ? [JSON.stringify(['context', contextId])] : []),
    ...(hostId ? [JSON.stringify(['host', hostId])] : []),
    ...(recipeId ? [JSON.stringify(['workflow_recipe', recipeId])] : []),
  ])
  for (const relationship of selectedRelationships) {
    for (const [type, id] of [
      [relationship.sourceType, relationship.sourceId],
      [relationship.targetType, relationship.targetId],
    ] as const) {
      if (
        ['host', 'context', 'mcp_server', 'workflow_recipe', 'shared_filesystem'].includes(type)
      ) {
        selectedKeys.add(JSON.stringify([type, id]))
      }
    }
  }
  const resources = [...selectedKeys]
    .map(key => resourcesByKey.get(key))
    .filter((resource): resource is OperationalIndexedResource => Boolean(resource))
  if (resources.length !== selectedKeys.size) return null

  const relationships = Object.freeze(
    selectedRelationships.sort((left, right) =>
      compareCanonicalUtf8Text(left.relationshipInstanceId, right.relationshipInstanceId)
    )
  )
  return Object.freeze({
    ...graph,
    resources: Object.freeze(resources),
    relationships,
    dependencyRevision: operationalDependencyRevision({ resource: root, resources }),
    relationshipsRevision: revisionOfValues(
      relationships.map(relationship => [
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
    ),
  })
}

/**
 * Resolve a namespace-qualified Context reference to its canonical
 * `<namespace>/<metadata.name>` identity. The candidates are every Context whose
 * logical id is the reference and every Context whose spec.contextId alias
 * targets it; exactly one distinct candidate resolves, anything else is null.
 * No enabled filter applies, as none applied to the index lookup it replaces.
 */
export function createContextReferenceResolver(
  contexts: readonly OperationalObjectProjection[]
): (reference: string) => string | null {
  const claims = new Map<string, Set<string>>()
  const claim = (reference: string, canonicalId: string) => {
    const owners = claims.get(reference) ?? new Set<string>()
    owners.add(canonicalId)
    claims.set(reference, owners)
  }
  for (const context of contexts) {
    if (context.family !== 'context') throw new Error('operational_context_projection_invalid')
    claim(context.rootId, context.rootId)
    for (const relationship of context.relationships) {
      if (relationship.relationshipType === 'context_identity_alias') {
        claim(relationship.targetId, relationship.sourceId)
      }
    }
  }
  return reference => {
    const owners = claims.get(reference)
    return owners && owners.size === 1 ? [...owners][0]! : null
  }
}

function contextReferenceNames(
  context: OperationalObjectProjection,
  resolve: (reference: string) => string | null
): readonly string[] {
  const prefix = `${context.namespace}/`
  const names = new Set<string>([context.rootId.slice(prefix.length)])
  for (const relationship of context.relationships) {
    if (
      relationship.relationshipType === 'context_identity_alias' &&
      relationship.targetId.startsWith(prefix)
    ) {
      names.add(relationship.targetId.slice(prefix.length))
    }
  }
  return Object.freeze(
    [...names]
      .filter(name => resolve(`${prefix}${name}`) === context.rootId)
      .sort(compareCanonicalUtf8Text)
  )
}

function indexedResource(
  resource: OperationalObjectProjection['resources'][number]
): OperationalIndexedResource {
  return Object.freeze({ ...resource, displayName: resource.displayName ?? resource.logicalId })
}

function compareRelationships(
  left: OperationalIndexedRelationship,
  right: OperationalIndexedRelationship
): number {
  for (const field of [
    'sourceType',
    'sourceId',
    'relationshipType',
    'targetType',
    'targetId',
    'relationshipInstanceId',
  ] as const) {
    const order = compareCanonicalUtf8Text(left[field], right[field])
    if (order !== 0) return order
  }
  return 0
}

type OperationalNeighbourhood =
  | Readonly<{
      status: 'current'
      resource: OperationalIndexedResource
      relationships: readonly OperationalIndexedRelationship[]
      relatedKeys: ReadonlyMap<string, readonly [string, string]>
      resourcesByKey: ReadonlyMap<string, OperationalIndexedResource>
      contexts: readonly OperationalObjectProjection[]
      resolveContext: (reference: string) => string | null
    }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'unavailable'; safeCode: string }>

/**
 * The neighbourhood of one root, as the index reader selected it: the root's
 * own edges, the edges of the Contexts it reaches, and for an MCP server the
 * Hosts whose canonical Context includes it. Context alias edges never enter;
 * `uses_context` targets are canonicalised and kept raw when they do not
 * resolve, so the related resource is then missing.
 */
function operationalNeighbourhood(input: {
  root: Readonly<{ resourceType: AccessResourceType; logicalId: string }>
  objects: readonly OperationalObjectProjection[]
}): OperationalNeighbourhood {
  const rootType = input.root.resourceType
  const rootId = input.root.logicalId
  if (!isOperationalAccessResourceType(rootType)) {
    throw new Error('operational_resource_type_unsupported')
  }
  const resourcesByKey = new Map<string, OperationalIndexedResource>()
  for (const object of input.objects) {
    for (const resource of object.resources) {
      const key = resourceKey(resource.resourceType, resource.logicalId)
      if (resourcesByKey.has(key)) throw new Error('operational_resource_duplicate')
      resourcesByKey.set(key, indexedResource(resource))
    }
  }
  const resource = resourcesByKey.get(resourceKey(rootType, rootId))
  if (!resource || !resource.enabled || resource.deletedAt) return { status: 'not_found' }

  const contexts = input.objects.filter(object => object.family === 'context')
  const resolveContext = createContextReferenceResolver(contexts)
  const allRelationships = input.objects.flatMap(object => object.relationships)

  if (rootType === 'host') {
    const unresolved = allRelationships.some(
      relationship =>
        relationship.sourceType === 'host' &&
        relationship.sourceId === rootId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context' &&
        resolveContext(relationship.targetId) === null
    )
    if (unresolved) return { status: 'unavailable', safeCode: 'operational_source_unavailable' }
  }

  const contextIds = new Set<string>()
  const mcpContextIds = new Set<string>()
  const exposingRecipeIds = new Set<string>()
  for (const relationship of allRelationships) {
    if (
      relationship.sourceType === rootType &&
      relationship.sourceId === rootId &&
      relationship.relationshipType === 'uses_context' &&
      relationship.targetType === 'context'
    ) {
      const canonical = resolveContext(relationship.targetId)
      if (canonical) contextIds.add(canonical)
    }
    if (
      rootType === 'mcp_server' &&
      relationship.relationshipType === 'includes_mcp_server' &&
      relationship.targetType === 'mcp_server' &&
      relationship.targetId === rootId
    ) {
      contextIds.add(relationship.sourceId)
      mcpContextIds.add(relationship.sourceId)
    }
    if (
      rootType === 'shared_filesystem' &&
      relationship.relationshipType === 'mounts_shared_filesystem' &&
      relationship.targetType === 'shared_filesystem' &&
      relationship.targetId === rootId
    ) {
      contextIds.add(relationship.sourceId)
    }
    if (
      rootType === 'sandbox_app' &&
      relationship.relationshipType === 'exposes_sandbox_app' &&
      relationship.targetType === 'sandbox_app' &&
      relationship.targetId === rootId
    ) {
      exposingRecipeIds.add(relationship.sourceId)
    }
  }
  if (rootType === 'sandbox_app') {
    for (const relationship of allRelationships) {
      if (
        relationship.sourceType === 'workflow_recipe' &&
        exposingRecipeIds.has(relationship.sourceId) &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context'
      ) {
        const canonical = resolveContext(relationship.targetId)
        if (canonical) contextIds.add(canonical)
      }
    }
  }

  const selected: OperationalIndexedRelationship[] = []
  for (const relationship of allRelationships) {
    if (relationship.relationshipType === 'context_identity_alias') continue
    const canonicalTarget =
      relationship.relationshipType === 'uses_context'
        ? resolveContext(relationship.targetId)
        : relationship.targetId
    if (
      (rootType === 'mcp_server' || rootType === 'shared_filesystem') &&
      relationship.sourceType === 'context' &&
      !(
        (rootType === 'mcp_server' &&
          relationship.relationshipType === 'includes_mcp_server' &&
          relationship.targetType === 'mcp_server' &&
          relationship.targetId === rootId) ||
        (rootType === 'shared_filesystem' &&
          relationship.relationshipType === 'mounts_shared_filesystem' &&
          relationship.targetType === 'shared_filesystem' &&
          relationship.targetId === rootId)
      )
    ) {
      continue
    }
    const included =
      (relationship.sourceType === rootType && relationship.sourceId === rootId) ||
      (rootType !== 'context' &&
        relationship.targetType === rootType &&
        canonicalTarget === rootId) ||
      (relationship.sourceType === 'context' && contextIds.has(relationship.sourceId)) ||
      (rootType === 'mcp_server' &&
        relationship.sourceType === 'host' &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context' &&
        canonicalTarget !== null &&
        mcpContextIds.has(canonicalTarget)) ||
      (rootType === 'sandbox_app' &&
        relationship.sourceType === 'workflow_recipe' &&
        exposingRecipeIds.has(relationship.sourceId))
    if (!included) continue
    selected.push(
      relationship.relationshipType === 'uses_context' &&
        canonicalTarget !== null &&
        canonicalTarget !== relationship.targetId
        ? Object.freeze({ ...relationship, targetId: canonicalTarget })
        : relationship
    )
  }
  const relationships = Object.freeze(selected.sort(compareRelationships))

  const relatedKeys = new Map<string, readonly [string, string]>([
    [resourceKey(rootType, rootId), [rootType, rootId]],
  ])
  for (const relationship of relationships) {
    for (const [type, id] of [
      [relationship.sourceType, relationship.sourceId],
      [relationship.targetType, relationship.targetId],
    ] as const) {
      if (RELATED_RESOURCE_TYPES.has(type)) relatedKeys.set(resourceKey(type, id), [type, id])
    }
  }
  return {
    status: 'current',
    resource,
    relationships,
    relatedKeys,
    resourcesByKey,
    contexts,
    resolveContext,
  }
}

/**
 * Pure: build one root's operational graph from the projected objects the
 * loader read. A complete graph or an explicit not_found/unavailable result;
 * never a partial graph for the `full` class.
 */
export function buildOperationalResourceGraph(input: {
  root: Readonly<{ resourceType: AccessResourceType; logicalId: string }>
  objects: readonly OperationalObjectProjection[]
  operationClass: OperationalGraphClass
}): OperationalResourceGraphResult {
  const neighbourhood = operationalNeighbourhood(input)
  if (neighbourhood.status !== 'current') return neighbourhood
  const resources = [...neighbourhood.relatedKeys.keys()]
    .map(key => neighbourhood.resourcesByKey.get(key))
    .filter((resource): resource is OperationalIndexedResource => Boolean(resource))
    .sort((left, right) => {
      const byType = compareCanonicalUtf8Text(left.resourceType, right.resourceType)
      return byType !== 0 ? byType : compareCanonicalUtf8Text(left.logicalId, right.logicalId)
    })
  if (input.operationClass === 'full' && resources.length !== neighbourhood.relatedKeys.size) {
    return { status: 'unavailable', safeCode: 'operational_related_resource_incomplete' }
  }
  const root = neighbourhood.resource
  const contextNames = new Map<string, readonly string[]>()
  for (const context of neighbourhood.contexts) {
    if (
      resources.some(item => item.resourceType === 'context' && item.logicalId === context.rootId)
    ) {
      contextNames.set(context.rootId, contextReferenceNames(context, neighbourhood.resolveContext))
    }
  }
  return Object.freeze({
    status: 'current',
    resource: root,
    resources: Object.freeze(resources),
    relationships: neighbourhood.relationships,
    contextReferenceNames: contextNames,
    dependencyRevision: operationalDependencyRevision({ resource: root, resources }),
    relationshipsRevision: revisionOfValues(
      neighbourhood.relationships
        .filter(
          relationship =>
            relationship.sourceType === root.resourceType &&
            relationship.sourceId === root.logicalId
        )
        .map(relationship => [
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
    ),
  })
}

function scopedName(logicalId: string): { namespace: string; name: string } | null {
  const separator = logicalId.indexOf('/')
  if (separator < 1 || separator === logicalId.length - 1) return null
  return { namespace: logicalId.slice(0, separator), name: logicalId.slice(separator + 1) }
}

/**
 * The only I/O of the live graph: namespaced Kubernetes GET and paged LIST
 * reads, each charged to the action budget, each object projected and charged.
 * It never touches Postgres. Any read or projection error propagates; only the
 * root GET's 404 becomes not_found.
 */
export async function loadLiveOperationalResourceGraph(input: {
  gateway: OperationalGraphGateway
  budget: AccessExecutionBudget
  resource: CanonicalResourceIdentity
  operationClass: OperationalGraphClass
}): Promise<OperationalResourceGraphResult> {
  const { budget, gateway, resource } = input
  if (!isOperationalAccessResourceType(resource.type)) {
    throw new Error('operational_resource_type_unsupported')
  }
  const rootFamily: OperationalSourceFamily =
    resource.type === 'sandbox_app' ? 'workflow_recipe' : (resource.type as OperationalSourceFamily)
  const rootSource = OPERATIONAL_FAMILY_SOURCES[rootFamily]
  const identity = scopedName(resource.logicalId)
  if (!identity || identity.namespace !== rootSource.namespace) return { status: 'not_found' }

  const timeoutSeconds = () => Math.max(1, Math.min(60, Math.ceil(budget.remainingMs() / 1_000)))
  const project = (family: OperationalSourceFamily, object: unknown) => {
    const source = OPERATIONAL_FAMILY_SOURCES[family]
    const projection = projectOperationalObject({
      environmentId: resource.environmentId,
      plural: source.plural,
      namespace: source.namespace,
      object,
      behaviorFingerprintKey: config.sessionJwtPrivateKey,
      // The budget charge below is the object size bound (objectBytes).
      maxObjectBytes: Number.MAX_SAFE_INTEGER,
      relationshipNamespaces: {
        context: config.contextsNamespace,
        mcpServer: config.mcpServersNamespace,
        sharedFilesystem: config.sharedFilesystemsNamespace,
      },
    })
    budget.chargeOperationalObject(projection.contentBytes, true)
    return projection
  }
  const getRoot = async (): Promise<OperationalObjectProjection | null> => {
    let object: unknown
    try {
      object = await budget.runProducer(signal =>
        gateway.getResourceExact(rootSource.plural, identity.name, identity.namespace, {
          timeoutSeconds: timeoutSeconds(),
          signal,
        })
      )
    } catch (error) {
      if (error instanceof K8sNotFoundError) return null
      throw error
    }
    return project(rootFamily, object)
  }
  const list = async (family: OperationalSourceFamily) => {
    const source = OPERATIONAL_FAMILY_SOURCES[family]
    const projections: OperationalObjectProjection[] = []
    let continueToken: string | null = null
    do {
      const pageToken: string | null = continueToken
      const page: ResourceListPage = await budget.runProducer(signal =>
        gateway.listResourcePage(source.plural, source.namespace, {
          limit: budget.limits.kubernetesPageSize,
          ...(pageToken ? { continueToken: pageToken } : {}),
          timeoutSeconds: timeoutSeconds(),
          signal,
        })
      )
      for (const item of page.items) projections.push(project(family, item))
      continueToken = page.continueToken
    } while (continueToken)
    return projections
  }

  const objects: OperationalObjectProjection[] = []
  if (resource.type === 'context') {
    objects.push(...(await list('context')))
  } else {
    const [rootObject, contexts, hosts] = await Promise.all([
      getRoot(),
      list('context'),
      resource.type === 'mcp_server' ? list('host') : Promise.resolve([]),
    ])
    if (!rootObject) return { status: 'not_found' }
    objects.push(rootObject, ...contexts, ...hosts)
  }

  const root = { resourceType: resource.type, logicalId: resource.logicalId }
  const neighbourhood = operationalNeighbourhood({ root, objects })
  if (neighbourhood.status !== 'current') return neighbourhood
  const missingFamilies = new Set<OperationalSourceFamily>()
  for (const [key, [type]] of neighbourhood.relatedKeys) {
    if (neighbourhood.resourcesByKey.has(key)) continue
    if (type === 'shared_filesystem') missingFamilies.add('shared_filesystem')
    if (type === 'mcp_server' && input.operationClass === 'full') missingFamilies.add('mcp_server')
  }
  const secondRound = await Promise.all(
    (['mcp_server', 'shared_filesystem'] as const)
      .filter(family => missingFamilies.has(family))
      .map(family => list(family))
  )
  for (const projections of secondRound) objects.push(...projections)

  const graph = buildOperationalResourceGraph({
    root,
    objects,
    operationClass: input.operationClass,
  })
  if (graph.status === 'current' && graph.relationships.length > 0) {
    budget.charge({ kind: 'relationships', amount: graph.relationships.length })
    budget.charge({
      kind: 'decodedBytes',
      amount: graph.relationships.reduce(
        (total, relationship) => total + relationship.contentBytes,
        0
      ),
    })
  }
  return graph
}

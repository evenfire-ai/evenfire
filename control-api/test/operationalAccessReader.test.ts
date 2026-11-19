import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import {
  type OperationalObjectProjection,
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import {
  type OperationalResourceGraphResult,
  buildOperationalResourceGraph,
  createContextReferenceResolver,
} from '../src/services/access/operationalAccessReader.js'
import {
  OPERATIONAL_NAMESPACES,
  type OperationalPlural,
  contextObject,
  hostObject,
  mcpServerObject,
  sharedFilesystemObject,
  workflowRecipeObject,
} from './helpers/fakeOperationalGateway.js'

// T-L1 is a specification test of merge plan v2 §2.1, with expectations derived
// by hand from that table. It does not claim parity with the deleted index SQL.

const environmentId = canonicalEnvironmentId()
const ctx = (name: string) => `${OPERATIONAL_NAMESPACES.contexts}/${name}`
const mcp = (name: string) => `${OPERATIONAL_NAMESPACES.mcpservers}/${name}`
const host = (name: string) => `${OPERATIONAL_NAMESPACES.hosts}/${name}`
const sfs = (name: string) => `${OPERATIONAL_NAMESPACES.sharedfilesystems}/${name}`
const recipe = (name: string) => `${OPERATIONAL_NAMESPACES.workflowrecipes}/${name}`

function project(plural: OperationalPlural, object: unknown): OperationalObjectProjection {
  return projectOperationalObject({
    environmentId,
    plural,
    namespace: OPERATIONAL_NAMESPACES[plural],
    object,
    behaviorFingerprintKey: config.sessionJwtPrivateKey,
    relationshipNamespaces: {
      context: config.contextsNamespace,
      mcpServer: config.mcpServersNamespace,
      sharedFilesystem: config.sharedFilesystemsNamespace,
    },
  })
}

const objects = Object.freeze({
  ctxA: project(
    'contexts',
    contextObject('ctx-a', {
      contextId: 'alias-a',
      mcpServers: ['weather', 'search'],
      sharedFileSystems: ['docs'],
    })
  ),
  ctxB: project('contexts', contextObject('ctx-b', { mcpServers: ['weather'] })),
  hostA: project('hosts', hostObject('host-a', { contextRef: 'alias-a' })),
  hostB: project('hosts', hostObject('host-b', { contextRef: 'ctx-b' })),
  hostC: project('hosts', hostObject('host-c', { contextRef: 'ctx-a' })),
  weather: project('mcpservers', mcpServerObject('weather', { contextRef: 'ctx-b' })),
  search: project('mcpservers', mcpServerObject('search')),
  docs: project('sharedfilesystems', sharedFilesystemObject('docs')),
  report: project(
    'workflowrecipes',
    workflowRecipeObject('report', { contextRef: 'ctx-a', ui: true })
  ),
})
const everything = Object.values(objects)

type CurrentGraph = Extract<OperationalResourceGraphResult, { status: 'current' }>

function current(result: OperationalResourceGraphResult): CurrentGraph {
  expect(result.status, JSON.stringify(result)).toBe('current')
  return result as CurrentGraph
}

function edges(graph: CurrentGraph): string[] {
  return graph.relationships
    .map(edge =>
      [edge.sourceType, edge.sourceId, edge.relationshipType, edge.targetType, edge.targetId].join(
        ' '
      )
    )
    .sort()
}

function resources(graph: CurrentGraph): string[] {
  return graph.resources.map(resource => `${resource.resourceType} ${resource.logicalId}`).sort()
}

const contextAEdges = () => [
  `context ${ctx('ctx-a')} includes_mcp_server mcp_server ${mcp('search')}`,
  `context ${ctx('ctx-a')} includes_mcp_server mcp_server ${mcp('weather')}`,
  `context ${ctx('ctx-a')} mounts_shared_filesystem shared_filesystem ${sfs('docs')}`,
]

describe('buildOperationalResourceGraph (merge plan v2 §2.1)', () => {
  it('Host: its canonical uses_context edge and every Context edge except aliases', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: host('host-a') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(edges(graph)).toEqual(
      [...contextAEdges(), `host ${host('host-a')} uses_context context ${ctx('ctx-a')}`].sort()
    )
    expect(resources(graph)).toEqual(
      [
        `context ${ctx('ctx-a')}`,
        `host ${host('host-a')}`,
        `mcp_server ${mcp('search')}`,
        `mcp_server ${mcp('weather')}`,
        `shared_filesystem ${sfs('docs')}`,
      ].sort()
    )
    expect(graph.resource.logicalId).toBe(host('host-a'))
  })

  it('Context: only its own edges, no reverse edges and no alias edge', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'context', logicalId: ctx('ctx-a') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(edges(graph)).toEqual(contextAEdges().sort())
    expect(resources(graph)).toEqual(
      [
        `context ${ctx('ctx-a')}`,
        `mcp_server ${mcp('search')}`,
        `mcp_server ${mcp('weather')}`,
        `shared_filesystem ${sfs('docs')}`,
      ].sort()
    )
  })

  it('MCP server: own Context edge, each including Context edge, and Hosts on those Contexts', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'mcp_server', logicalId: mcp('weather') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(edges(graph)).toEqual(
      [
        `context ${ctx('ctx-a')} includes_mcp_server mcp_server ${mcp('weather')}`,
        `context ${ctx('ctx-b')} includes_mcp_server mcp_server ${mcp('weather')}`,
        `host ${host('host-a')} uses_context context ${ctx('ctx-a')}`,
        `host ${host('host-b')} uses_context context ${ctx('ctx-b')}`,
        `host ${host('host-c')} uses_context context ${ctx('ctx-a')}`,
        `mcp_server ${mcp('weather')} uses_context context ${ctx('ctx-b')}`,
      ].sort()
    )
    expect(resources(graph)).toEqual(
      [
        `context ${ctx('ctx-a')}`,
        `context ${ctx('ctx-b')}`,
        `host ${host('host-a')}`,
        `host ${host('host-b')}`,
        `host ${host('host-c')}`,
        `mcp_server ${mcp('weather')}`,
      ].sort()
    )
  })

  it('MCP server reached through a Host: the Host arm carries the Hosts', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'mcp_server', logicalId: mcp('search') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(edges(graph)).toEqual(
      [
        `context ${ctx('ctx-a')} includes_mcp_server mcp_server ${mcp('search')}`,
        `host ${host('host-a')} uses_context context ${ctx('ctx-a')}`,
        `host ${host('host-c')} uses_context context ${ctx('ctx-a')}`,
      ].sort()
    )
  })

  it('Shared filesystem: only the mount edge of each mounting Context', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'shared_filesystem', logicalId: sfs('docs') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(edges(graph)).toEqual([
      `context ${ctx('ctx-a')} mounts_shared_filesystem shared_filesystem ${sfs('docs')}`,
    ])
    expect(resources(graph)).toEqual([
      `context ${ctx('ctx-a')}`,
      `shared_filesystem ${sfs('docs')}`,
    ])
  })

  it('Workflow recipe: its own edges and every edge of its Context', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'workflow_recipe', logicalId: recipe('report') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(edges(graph)).toEqual(
      [
        ...contextAEdges(),
        `workflow_recipe ${recipe('report')} exposes_sandbox_app sandbox_app ${recipe('report')}`,
        `workflow_recipe ${recipe('report')} uses_context context ${ctx('ctx-a')}`,
      ].sort()
    )
    expect(resources(graph)).toEqual(
      [
        `context ${ctx('ctx-a')}`,
        `mcp_server ${mcp('search')}`,
        `mcp_server ${mcp('weather')}`,
        `shared_filesystem ${sfs('docs')}`,
        `workflow_recipe ${recipe('report')}`,
      ].sort()
    )
  })

  it('Sandbox app: the exposing recipe (same logical id) and its Context', () => {
    const graph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'sandbox_app', logicalId: recipe('report') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(graph.resource.resourceType).toBe('sandbox_app')
    expect(edges(graph)).toEqual(
      [
        ...contextAEdges(),
        `workflow_recipe ${recipe('report')} exposes_sandbox_app sandbox_app ${recipe('report')}`,
        `workflow_recipe ${recipe('report')} uses_context context ${ctx('ctx-a')}`,
      ].sort()
    )
    expect(resources(graph)).toEqual(
      [
        `context ${ctx('ctx-a')}`,
        `mcp_server ${mcp('search')}`,
        `mcp_server ${mcp('weather')}`,
        `sandbox_app ${recipe('report')}`,
        `shared_filesystem ${sfs('docs')}`,
        `workflow_recipe ${recipe('report')}`,
      ].sort()
    )
  })

  it('requires every related resource for the full class only', () => {
    const withoutSearch = everything.filter(object => object !== objects.search)
    expect(
      buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: host('host-a') },
        objects: withoutSearch,
        operationClass: 'full',
      })
    ).toEqual({ status: 'unavailable', safeCode: 'operational_related_resource_incomplete' })
    // Witness: the same objects build a current host_graph, which leaves the
    // MCP servers to the resolver's dependency selection.
    const hostGraph = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: host('host-a') },
        objects: withoutSearch,
        operationClass: 'host_graph',
      })
    )
    expect(resources(hostGraph)).not.toContain(`mcp_server ${mcp('search')}`)
    expect(resources(hostGraph)).toContain(`mcp_server ${mcp('weather')}`)
  })

  it('keeps an unresolved uses_context target raw, so the related resource is missing', () => {
    const orphan = project('mcpservers', mcpServerObject('orphan', { contextRef: 'missing' }))
    expect(
      buildOperationalResourceGraph({
        root: { resourceType: 'mcp_server', logicalId: mcp('orphan') },
        objects: [...everything, orphan],
        operationClass: 'full',
      })
    ).toEqual({ status: 'unavailable', safeCode: 'operational_related_resource_incomplete' })
  })

  it.each([
    ['absent', [] as OperationalObjectProjection[]],
    ['disabled', [project('hosts', hostObject('host-z', { enabled: false }))]],
    [
      'being deleted',
      [project('hosts', hostObject('host-z', {}, { deletionTimestamp: '2026-11-09T00:00:00Z' }))],
    ],
  ])('answers not_found for a root that is %s', (_label, extra) => {
    const result = buildOperationalResourceGraph({
      root: { resourceType: 'host', logicalId: host('host-z') },
      objects: [...everything, ...extra],
      operationClass: 'full',
    })
    expect(result).toEqual({ status: 'not_found' })
    // Witness: a sibling Host in the same objects builds.
    current(
      buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: host('host-b') },
        objects: [...everything, ...extra],
        operationClass: 'full',
      })
    )
  })
})

describe('Context aliases and canonical identity (merge plan v2 §2.6)', () => {
  const contextX = () => project('contexts', contextObject('ctx-x', { contextId: 'shared' }))
  const contextY = () => project('contexts', contextObject('ctx-y', { contextId: 'shared' }))

  it('resolves an alias and a name to one canonical Context', () => {
    const resolve = createContextReferenceResolver([objects.ctxA, objects.ctxB])
    expect(resolve(ctx('alias-a'))).toBe(ctx('ctx-a'))
    expect(resolve(ctx('ctx-a'))).toBe(ctx('ctx-a'))
    expect(resolve(ctx('ctx-b'))).toBe(ctx('ctx-b'))
    expect(resolve(ctx('nothing'))).toBeNull()
  })

  it('resolves nothing when two Contexts claim the same reference', () => {
    const resolve = createContextReferenceResolver([contextX(), contextY()])
    expect(resolve(ctx('shared'))).toBeNull()
    // Witness: each Context still resolves by its own name.
    expect(resolve(ctx('ctx-x'))).toBe(ctx('ctx-x'))
    expect(resolve(ctx('ctx-y'))).toBe(ctx('ctx-y'))
  })

  it('fails a Host closed when its Context reference is ambiguous', () => {
    const ambiguousHost = project('hosts', hostObject('host-amb', { contextRef: 'shared' }))
    expect(
      buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: host('host-amb') },
        objects: [contextX(), contextY(), ambiguousHost],
        operationClass: 'full',
      })
    ).toEqual({ status: 'unavailable', safeCode: 'operational_source_unavailable' })
    // Witness: the same Host on an unambiguous name builds.
    const clearHost = project('hosts', hostObject('host-amb', { contextRef: 'ctx-x' }))
    current(
      buildOperationalResourceGraph({
        root: { resourceType: 'host', logicalId: host('host-amb') },
        objects: [contextX(), contextY(), clearHost],
        operationClass: 'full',
      })
    )
  })

  it('carries grant reference names and drops an ambiguous alias', () => {
    const plain = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'context', logicalId: ctx('ctx-a') },
        objects: everything,
        operationClass: 'full',
      })
    )
    expect(plain.contextReferenceNames.get(ctx('ctx-a'))).toEqual(['alias-a', 'ctx-a'])

    const ambiguous = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'context', logicalId: ctx('ctx-x') },
        objects: [contextX(), contextY()],
        operationClass: 'full',
      })
    )
    expect(ambiguous.contextReferenceNames.get(ctx('ctx-x'))).toEqual(['ctx-x'])

    // A Context named like another Context's alias makes that name ambiguous
    // for both of them.
    const named = project('contexts', contextObject('alias-a'))
    const collided = current(
      buildOperationalResourceGraph({
        root: { resourceType: 'context', logicalId: ctx('ctx-a') },
        objects: [objects.ctxA, named, objects.weather, objects.search, objects.docs],
        operationClass: 'full',
      })
    )
    expect(collided.contextReferenceNames.get(ctx('ctx-a'))).toEqual(['ctx-a'])
  })
})

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { selectActionOperationalDependencies } from '../src/services/access/liveAuthorizationResolver.js'
import type { OperationalResourceGraphResult } from '../src/services/access/operationalAccessReader.js'

type CurrentGraph = Extract<OperationalResourceGraphResult, { status: 'current' }>

function resource(resourceType: string, logicalId: string) {
  return {
    environmentId: 'development:local',
    resourceType,
    logicalId,
    sourceFamily: resourceType,
    providerUid: `uid:${resourceType}:${logicalId}`,
    providerResourceVersion: '1',
    displayName: logicalId,
    enabled: true,
    deletedAt: null,
    observedGeneration: 1,
    contentBytes: 1,
    behaviorSources: {},
  }
}

function relationship(
  sourceType: string,
  sourceId: string,
  relationshipType: string,
  targetType: string,
  targetId: string,
  relationshipInstanceId: string
) {
  return {
    environmentId: 'development:local',
    sourceType,
    sourceId,
    relationshipType,
    targetType,
    targetId,
    relationshipInstanceId,
    behaviorAttributes: {},
    sourceFamily: sourceType,
    sourceProviderUid: `uid:${sourceType}:${sourceId}`,
    sourceResourceVersion: '1',
    sourceGeneration: 1,
    observedGeneration: 1,
    contentBytes: 1,
  }
}

function threeMcpGraph(siblings: readonly string[]): CurrentGraph {
  const hostId = 'mcp-server/agent'
  const contextId = 'mcp-server/workspace'
  const mcpNames = [...siblings, 'target']
  const resources = [
    resource('host', hostId),
    resource('context', contextId),
    resource('shared_filesystem', 'shared-filesystem/workspace'),
    ...mcpNames.map(name => resource('mcp_server', `mcp-server/${name}`)),
  ]
  const relationships = [
    relationship('host', hostId, 'uses_context', 'context', contextId, 'host-context'),
    relationship(
      'context',
      contextId,
      'mounts_shared_filesystem',
      'shared_filesystem',
      'shared-filesystem/workspace',
      'context-filesystem'
    ),
    ...mcpNames.map(name =>
      relationship(
        'context',
        contextId,
        'includes_mcp_server',
        'mcp_server',
        `mcp-server/${name}`,
        `context-${name}`
      )
    ),
  ]
  return {
    status: 'current',
    resource: resources[0]!,
    resources,
    relationships,
    sourceStateRevision: 'source-state',
    relationshipsRevision: 'unselected',
  } as unknown as CurrentGraph
}

function mcpRootGraph(siblings: readonly string[]): CurrentGraph {
  const hostId = 'mcp-server/agent'
  const contextId = 'mcp-server/workspace'
  const targetId = 'mcp-server/target'
  const resources = [
    resource('mcp_server', targetId),
    resource('host', hostId),
    resource('context', contextId),
    resource('shared_filesystem', 'shared-filesystem/workspace'),
    ...siblings.map(name => resource('mcp_server', `mcp-server/${name}`)),
  ]
  const relationships = [
    relationship('host', hostId, 'uses_context', 'context', contextId, 'host-context'),
    relationship(
      'context',
      contextId,
      'mounts_shared_filesystem',
      'shared_filesystem',
      'shared-filesystem/workspace',
      'context-filesystem'
    ),
    relationship('context', contextId, 'includes_mcp_server', 'mcp_server', targetId, 'target'),
    ...siblings.map(name =>
      relationship(
        'context',
        contextId,
        'includes_mcp_server',
        'mcp_server',
        `mcp-server/${name}`,
        `sibling-${name}`
      )
    ),
  ]
  return {
    status: 'current',
    resource: resources[0]!,
    resources,
    relationships,
    sourceStateRevision: 'source-state',
    relationshipsRevision: 'unselected',
  } as unknown as CurrentGraph
}

describe('selected-action operational dependency closure', () => {
  it('removes Context MCP siblings for every selected Host action deterministically', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.string({ minLength: 1, maxLength: 12 }).filter(name => name !== 'target'),
          {
            minLength: 1,
            maxLength: 5,
          }
        ),
        fc.constantFrom(
          'host.status.read',
          'host.health.read',
          'host.wake',
          'host.manage',
          'host.activity.read',
          'host.activity.read_all',
          'remote_desktop.status',
          'remote_desktop.open',
          'remote_desktop.reconnect'
        ),
        (siblings, operationId) => {
          const original = threeMcpGraph(siblings)
          const reordered = {
            ...original,
            resources: [...original.resources].reverse(),
            relationships: [...original.relationships].reverse(),
          } as CurrentGraph
          const hostRef = original.resource.logicalId
          const target = { hostRef } as never
          const selected = selectActionOperationalDependencies(original, operationId, target)
          const selectedAgain = selectActionOperationalDependencies(reordered, operationId, target)
          expect(selected.status).toBe('current')
          expect(selectedAgain.status).toBe('current')
          if (selected.status !== 'current' || selectedAgain.status !== 'current') return
          expect(selected.resources.map(item => item.resourceType)).toEqual([
            'context',
            'host',
            'shared_filesystem',
          ])
          expect(selected.relationships.map(item => item.relationshipType)).toEqual([
            'mounts_shared_filesystem',
            'uses_context',
          ])
          expect(selected.resources).toEqual(selectedAgain.resources)
          expect(selected.relationshipsRevision).toBe(selectedAgain.relationshipsRevision)
        }
      ),
      { numRuns: 10_000 }
    )
  })

  it('leaves the producer-selected MCP dependency graph intact', () => {
    const graph = mcpRootGraph(['sibling-a', 'sibling-b'])
    expect(selectActionOperationalDependencies(graph, 'mcp.invoke')).toBe(graph)
  })

  it('leaves generic and intentionally absent action context unchanged', () => {
    const graph = threeMcpGraph(['sibling-a', 'sibling-b'])
    expect(selectActionOperationalDependencies(graph, undefined)).toBe(graph)
    expect(selectActionOperationalDependencies(graph, 'workflow.trigger')).toBe(graph)
  })

  it('keeps a Host action valid when the producer has no configured Context edge', () => {
    const graph = threeMcpGraph(['sibling-a', 'sibling-b'])
    const noContext = {
      ...graph,
      resources: [graph.resource],
      relationships: [],
    } as CurrentGraph

    const selected = selectActionOperationalDependencies(noContext, 'host.status.read', {
      hostRef: graph.resource.logicalId,
    } as never)

    expect(selected.status).toBe('current')
    if (selected.status !== 'current') return
    expect(selected.resources).toEqual([graph.resource])
    expect(selected.relationships).toEqual([])
  })

  it('fails closed when a configured selected Context is missing from the current graph', () => {
    const graph = threeMcpGraph(['sibling-a', 'sibling-b'])
    const incomplete = {
      ...graph,
      resources: graph.resources.filter(item => item.resourceType !== 'context'),
    } as CurrentGraph
    const selected = selectActionOperationalDependencies(incomplete, 'host.status.read', {
      hostRef: graph.resource.logicalId,
    } as never)
    expect(selected).toEqual({
      status: 'unavailable',
      safeCode: 'operational_related_resource_incomplete',
    })
  })

  it('fails closed when a Host producer graph has ambiguous Context edges', () => {
    const graph = threeMcpGraph(['sibling-a', 'sibling-b'])
    const hostContextEdge = graph.relationships.find(
      item => item.sourceType === 'host' && item.relationshipType === 'uses_context'
    )!
    const ambiguous = {
      ...graph,
      relationships: [
        ...graph.relationships,
        { ...hostContextEdge, targetId: 'contexts/second', relationshipInstanceId: 'second-edge' },
      ],
      resources: [...graph.resources, resource('context', 'contexts/second')],
    } as unknown as CurrentGraph

    expect(
      selectActionOperationalDependencies(ambiguous, 'host.status.read', {
        hostRef: graph.resource.logicalId,
      } as never)
    ).toEqual({
      status: 'unavailable',
      safeCode: 'operational_related_resource_incomplete',
    })
  })
})

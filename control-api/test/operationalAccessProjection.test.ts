import { describe, expect, it } from 'vitest'
import {
  OperationalProjectionError,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'

const namespaces = {
  context: 'contexts',
  mcpServer: 'mcp-server',
  sharedFilesystem: 'mcp-host',
}

function contextObject(sharedFileSystems: unknown[]) {
  return {
    metadata: {
      name: 'ctx-a',
      namespace: 'contexts',
      uid: 'uid-context-a',
      resourceVersion: '41',
      generation: 3,
    },
    spec: {
      contextId: 'ctx-a',
      mcpServers: ['server-a'],
      sharedFileSystems,
    },
  }
}

describe('operational access projection', () => {
  it('uses namespace-qualified canonical identities and relationship targets', () => {
    const projection = projectOperationalObject({
      environmentId: 'test:cluster',
      plural: 'contexts',
      namespace: 'contexts',
      object: contextObject([{ name: 'files', mountPath: '/workspace' }]),
      behaviorFingerprintKey: 'test-key',
      relationshipNamespaces: namespaces,
    })

    expect(projection.rootId).toBe('contexts/ctx-a')
    expect(projection.resources[0]).toMatchObject({
      resourceType: 'context',
      logicalId: 'contexts/ctx-a',
      providerUid: 'uid-context-a',
    })
    expect(projection.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationshipType: 'includes_mcp_server',
          targetId: 'mcp-server/server-a',
        }),
        expect.objectContaining({
          relationshipType: 'mounts_shared_filesystem',
          targetId: 'mcp-host/files',
          behaviorAttributes: { mountPath: '/workspace', readOnly: true },
        }),
      ])
    )
  })

  it('preserves repeated filesystem relationship instances with different mount scopes', () => {
    const projection = projectOperationalObject({
      environmentId: 'test:cluster',
      plural: 'contexts',
      namespace: 'contexts',
      object: contextObject([
        { name: 'files', mountPath: '/workspace/a' },
        { name: 'files', mountPath: '/workspace/b' },
      ]),
      behaviorFingerprintKey: 'test-key',
      relationshipNamespaces: namespaces,
    })
    const mounts = projection.relationships.filter(
      relationship => relationship.relationshipType === 'mounts_shared_filesystem'
    )

    expect(mounts).toHaveLength(2)
    expect(new Set(mounts.map(mount => mount.relationshipInstanceId)).size).toBe(2)
    expect(mounts.map(mount => mount.behaviorAttributes.mountPath).sort()).toEqual([
      '/workspace/a',
      '/workspace/b',
    ])
  })

  it('rejects over-budget relationship fan-out before projection', () => {
    expect(() =>
      projectOperationalObject({
        environmentId: 'test:cluster',
        plural: 'contexts',
        namespace: 'contexts',
        object: contextObject(
          Array.from({ length: 257 }, (_, index) => ({
            name: `files-${index}`,
            mountPath: `/workspace/${index}`,
          }))
        ),
        behaviorFingerprintKey: 'test-key',
        relationshipNamespaces: namespaces,
      })
    ).toThrowError(OperationalProjectionError)
  })

  it('derives sandbox app identity without exposing raw runtime policy', () => {
    const projection = projectOperationalObject({
      environmentId: 'test:cluster',
      plural: 'workflowrecipes',
      namespace: 'sandbox-recipes',
      object: {
        metadata: {
          name: 'recipe-a',
          namespace: 'sandbox-recipes',
          uid: 'uid-recipe-a',
          resourceVersion: '9',
        },
        spec: {
          contextRef: 'ctx-a',
          runtimeEgress: { allow: ['private-service'] },
          oauthClients: [{ secretRef: 'oauth-secret' }],
          ui: { workloadRef: 'web', port: 8080, defaultPath: '/home' },
        },
      },
      behaviorFingerprintKey: 'test-key',
      relationshipNamespaces: namespaces,
    })

    expect(
      projection.resources.map(resource => [resource.resourceType, resource.logicalId])
    ).toEqual([
      ['workflow_recipe', 'sandbox-recipes/recipe-a'],
      ['sandbox_app', 'sandbox-recipes/recipe-a'],
    ])
    const encoded = JSON.stringify(projection.relationships)
    expect(encoded).not.toContain('private-service')
    expect(encoded).not.toContain('oauth-secret')
  })
})

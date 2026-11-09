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

  it('projects a supported Context alias without changing canonical identity', () => {
    const projection = projectOperationalObject({
      environmentId: 'test:cluster',
      plural: 'contexts',
      namespace: 'contexts',
      object: {
        ...contextObject([]),
        metadata: {
          ...contextObject([]).metadata,
          name: 'ctx-resource',
        },
        spec: {
          contextId: 'ctx-wire',
          mcpServers: [],
          sharedFileSystems: [],
        },
      },
      behaviorFingerprintKey: 'test-key',
      relationshipNamespaces: namespaces,
    })

    expect(projection.rootId).toBe('contexts/ctx-resource')
    expect(projection.relationships).toContainEqual(
      expect.objectContaining({
        sourceType: 'context',
        sourceId: 'contexts/ctx-resource',
        relationshipType: 'context_identity_alias',
        targetType: 'context',
        targetId: 'contexts/ctx-wire',
      })
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

  it('deduplicates repeated MCP allowlist entries but preserves distinct targets', () => {
    const projection = projectOperationalObject({
      environmentId: 'test:cluster',
      plural: 'contexts',
      namespace: 'contexts',
      object: {
        ...contextObject([]),
        spec: {
          contextId: 'ctx-a',
          mcpServers: ['server-a', 'server-a', 'server-b'],
          sharedFileSystems: [],
        },
      },
      behaviorFingerprintKey: 'test-key',
      relationshipNamespaces: namespaces,
    })
    const relationships = projection.relationships.filter(
      relationship => relationship.relationshipType === 'includes_mcp_server'
    )

    expect(relationships.map(relationship => relationship.targetId).sort()).toEqual([
      'mcp-server/server-a',
      'mcp-server/server-b',
    ])
    expect(
      new Set(relationships.map(relationship => relationship.relationshipInstanceId)).size
    ).toBe(2)
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

  it('does not convert malformed or missing source configuration into known none', () => {
    expect(() =>
      projectOperationalObject({
        environmentId: 'test:cluster',
        plural: 'contexts',
        namespace: 'contexts',
        object: {
          metadata: {
            name: 'ctx-malformed',
            namespace: 'contexts',
            uid: 'uid-context-malformed',
            resourceVersion: '1',
          },
          spec: { sharedFileSystems: 'not-an-array' },
        },
        behaviorFingerprintKey: 'test-key',
        relationshipNamespaces: namespaces,
      })
    ).toThrowError(OperationalProjectionError)

    expect(() =>
      projectOperationalObject({
        environmentId: 'test:cluster',
        plural: 'contexts',
        namespace: 'contexts',
        object: {
          metadata: {
            name: 'ctx-missing-spec',
            namespace: 'contexts',
            uid: 'uid-context-missing-spec',
            resourceVersion: '1',
          },
        },
        behaviorFingerprintKey: 'test-key',
        relationshipNamespaces: namespaces,
      })
    ).toThrowError(OperationalProjectionError)
  })

  it('binds Host approval and credential-reference policy content without secret bytes', () => {
    const host = (approval: unknown, secretRef: string) =>
      projectOperationalObject({
        environmentId: 'test:cluster',
        plural: 'hosts',
        namespace: 'mcp-host',
        object: {
          metadata: {
            name: 'host-policy',
            namespace: 'mcp-host',
            uid: 'uid-host-policy',
            resourceVersion: '1',
          },
          spec: {
            contextRef: 'ctx-a',
            secretRef,
            ...(approval === undefined ? {} : { approval }),
          },
        },
        behaviorFingerprintKey: 'test-key',
        relationshipNamespaces: namespaces,
      }).resources[0]?.behaviorSources

    const first = host(
      { defaultPolicy: 'cli_only', channels: { telegram: { enabled: true } } },
      'host-secret-a'
    )
    const changedApproval = host(
      { defaultPolicy: 'designated_approvers', channels: { telegram: { enabled: true } } },
      'host-secret-a'
    )
    const changedSecret = host(
      { defaultPolicy: 'cli_only', channels: { telegram: { enabled: true } } },
      'host-secret-b'
    )

    expect(first.approvalPolicyConfigured).toBe(true)
    expect(first.approvalPolicy.fingerprint).not.toBe(changedApproval.approvalPolicy.fingerprint)
    expect(first.credentialPolicy.fingerprint).not.toBe(changedSecret.credentialPolicy.fingerprint)
    expect(first.credentialPolicy.fingerprint).not.toContain('host-secret-a')
  })

  it('binds a Host OAuth broker grant identity without exposing the grant key', () => {
    const host = (connectionRef: string) =>
      projectOperationalObject({
        environmentId: 'test:cluster',
        plural: 'hosts',
        namespace: 'mcp-host',
        object: {
          metadata: {
            name: 'host-broker',
            namespace: 'mcp-host',
            uid: 'uid-host-broker',
            resourceVersion: '1',
          },
          spec: {
            model: {
              provider: 'codex-subscription',
              name: 'gpt-test',
              connectionRef,
            },
          },
        },
        behaviorFingerprintKey: 'test-key',
        relationshipNamespaces: namespaces,
      }).resources[0]?.behaviorSources

    const first = host('grant-a')
    const rotated = host('grant-b')

    expect(first).toMatchObject({
      credentialPolicy: { state: 'known', fingerprint: expect.any(String) },
      credentialReferenceNames: [],
    })
    expect(rotated).toMatchObject({
      credentialPolicy: { state: 'known', fingerprint: expect.any(String) },
      credentialReferenceNames: [],
    })
    expect(first!.credentialPolicy.fingerprint).not.toBe(rotated!.credentialPolicy.fingerprint)
    expect(first!.credentialReferenceFingerprints.join('')).not.toContain('grant-a')
    expect(first!.credentialPolicy.fingerprint).not.toContain('grant-a')
  })

  it('binds a WorkflowRecipe OAuth broker grant from current annotations', () => {
    const recipe = (connectionRef: string) =>
      projectOperationalObject({
        environmentId: 'test:cluster',
        plural: 'workflowrecipes',
        namespace: 'sandbox-recipes',
        object: {
          metadata: {
            name: 'recipe-broker',
            namespace: 'sandbox-recipes',
            uid: 'uid-recipe-broker',
            resourceVersion: '1',
            annotations: {
              'clerum.io/codex-connection-ref': connectionRef,
              'clerum.io/subscription-connection-ref': connectionRef,
            },
          },
          spec: {
            agent: { provider: 'codex-subscription', model: 'gpt-test' },
          },
        },
        behaviorFingerprintKey: 'test-key',
        relationshipNamespaces: namespaces,
      }).resources[0]!.behaviorSources

    const first = recipe('grant-a')
    const rotated = recipe('grant-b')

    expect(first).toMatchObject({
      credentialPolicy: { state: 'known', fingerprint: expect.any(String) },
      credentialReferenceNames: [],
    })
    expect(rotated).toMatchObject({
      credentialPolicy: { state: 'known', fingerprint: expect.any(String) },
      credentialReferenceNames: [],
    })
    expect(first!.credentialPolicy.fingerprint).not.toBe(rotated!.credentialPolicy.fingerprint)
    expect(first!.credentialReferenceFingerprints.join('')).not.toContain('grant-a')
    expect(first!.credentialPolicy.fingerprint).not.toContain('grant-a')
  })

  it('represents an explicit no-auth MCP source as source-proven none', () => {
    const projection = projectOperationalObject({
      environmentId: 'test:cluster',
      plural: 'mcpservers',
      namespace: 'mcp-server',
      object: {
        metadata: {
          name: 'no-auth',
          namespace: 'mcp-server',
          uid: 'uid-no-auth',
          resourceVersion: '1',
        },
        spec: { auth: { type: 'none' } },
      },
      behaviorFingerprintKey: 'test-key',
      relationshipNamespaces: namespaces,
    })

    expect(projection.resources[0]?.behaviorSources).toMatchObject({
      credentialMode: 'none',
      credentialPolicyConfigured: false,
      credentialReferenceNames: [],
    })
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
    const sandboxExposures = projection.relationships.filter(
      relationship => relationship.relationshipType === 'exposes_sandbox_app'
    )
    expect(sandboxExposures).toHaveLength(1)
    expect(sandboxExposures[0]).toEqual(
      expect.objectContaining({
        sourceId: 'sandbox-recipes/recipe-a',
        targetId: 'sandbox-recipes/recipe-a',
      })
    )
    const encoded = JSON.stringify(projection.relationships)
    expect(encoded).not.toContain('private-service')
    expect(encoded).not.toContain('oauth-secret')
  })
})

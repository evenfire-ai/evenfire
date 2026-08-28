import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { findSecretReferenceState } from '../src/services/secretReferenceService.js'

const referencedName = 'referenced-credential'

describe('findSecretReferenceState', () => {
  it('recognizes every explicitly contracted CRD reference shape', async () => {
    const cases = [
      {
        label: 'McpServer auth secret',
        namespace: config.mcpServersNamespace,
        plural: 'mcpservers',
        resourceNamespace: config.mcpServersNamespace,
        resource: { spec: { auth: { secretRef: referencedName } } },
      },
      {
        label: 'McpServer environment secret',
        namespace: config.mcpServersNamespace,
        plural: 'mcpservers',
        resourceNamespace: config.mcpServersNamespace,
        resource: { spec: { envSecret: { name: referencedName } } },
      },
      {
        label: 'McpServer image pull secret',
        namespace: config.mcpServersNamespace,
        plural: 'mcpservers',
        resourceNamespace: config.mcpServersNamespace,
        resource: { spec: { imagePullSecrets: [{ name: referencedName }] } },
      },
      {
        label: 'LlmHook image pull secret',
        namespace: config.llmHooksNamespace,
        plural: 'llmhooks',
        resourceNamespace: config.llmHooksNamespace,
        resource: { spec: { target: { image: { imagePullSecrets: [referencedName] } } } },
      },
      {
        label: 'LlmHook environment secret',
        namespace: config.llmHooksNamespace,
        plural: 'llmhooks',
        resourceNamespace: config.llmHooksNamespace,
        resource: { spec: { target: { image: { envSecret: referencedName } } } },
      },
      {
        label: 'LlmHook remote auth headers secret',
        namespace: config.llmHooksNamespace,
        plural: 'llmhooks',
        resourceNamespace: config.llmHooksNamespace,
        resource: { spec: { target: { remote: { authHeadersSecret: referencedName } } } },
      },
      {
        label: 'Host Secret',
        namespace: config.secretsNamespace,
        plural: 'hosts',
        resourceNamespace: config.hostsNamespace,
        resource: { spec: { secretRef: referencedName } },
      },
      {
        label: 'CommunicationChannel credential Secret',
        namespace: config.communicationChannelsNamespace,
        plural: 'communicationchannels',
        resourceNamespace: config.communicationChannelsNamespace,
        resource: { spec: { credentialsSecretRef: { name: referencedName } } },
      },
      {
        label: 'WorkflowRecipe agent Secret with an explicit namespace',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            agent: {
              secretRef: { name: referencedName, namespace: config.sandboxNamespace },
            },
          },
        },
      },
      {
        label: 'WorkflowRecipe snippet Secret',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            steps: [
              {
                run: {
                  capabilities: {
                    secrets: [{ secretRef: { name: referencedName, key: 'api-key' } }],
                  },
                },
              },
            ],
          },
        },
      },
      {
        label: 'WorkflowRecipe regular workload environment Secret',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: { spec: { workloads: [{ id: 'worker', envSecret: { name: referencedName } }] } },
      },
      {
        label: 'WorkflowRecipe transport workload environment Secret',
        namespace: config.mcpServersNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            workloads: [
              { id: 'transport', transport: { type: 'sse' }, envSecret: { name: referencedName } },
            ],
          },
        },
      },
      {
        label: 'WorkflowRecipe UI workload environment Secret',
        namespace: config.sandboxUiNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            ui: { workloadRef: 'ui' },
            workloads: [{ id: 'ui', envSecret: { name: referencedName } }],
          },
        },
      },
      {
        label: 'WorkflowRecipe UI workload image pull Secret',
        namespace: config.sandboxUiNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            ui: { workloadRef: 'ui' },
            workloads: [{ id: 'ui', imagePullSecrets: [referencedName] }],
          },
        },
      },
      {
        label: 'WorkflowRecipe OAuth client ID Secret',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: { oauthClients: [{ clientIdRef: { name: referencedName, key: 'client-id' } }] },
        },
      },
      {
        label: 'WorkflowRecipe OAuth client Secret',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            oauthClients: [{ clientSecretRef: { name: referencedName, key: 'client-secret' } }],
          },
        },
      },
      {
        label: 'WorkflowRecipe webhook verification Secret',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            webhooks: [{ verification: { secretRef: { name: referencedName, key: 'signing' } } }],
          },
        },
      },
      {
        label: 'WorkflowRecipe webhook setup handshake Secret',
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resourceNamespace: config.sandboxNamespace,
        resource: {
          spec: {
            webhooks: [
              {
                verification: {
                  setupHandshake: { secretRef: { name: referencedName, key: 'verify' } },
                },
              },
            ],
          },
        },
      },
    ]

    for (const { label, namespace, plural, resourceNamespace, resource } of cases) {
      const reader = {
        listResource: vi.fn(async (requestedPlural: string, requestedNamespace?: string) =>
          requestedPlural === plural && requestedNamespace === resourceNamespace ? [resource] : []
        ),
      }

      await expect(
        findSecretReferenceState(reader as never, referencedName, namespace),
        label
      ).resolves.toBe('referenced')
      expect(reader.listResource).toHaveBeenCalledWith(plural, resourceNamespace)
    }
  })

  it('does not treat uncontracted reference-shaped values as Secret dependencies', async () => {
    const reader = {
      listResource: vi.fn(async (plural: string, namespace?: string) =>
        plural === 'workflowrecipes' && namespace === config.sandboxNamespace
          ? [
              {
                spec: {
                  extraCredentials: { name: referencedName, key: 'api-key' },
                },
              },
            ]
          : []
      ),
    }

    await expect(
      findSecretReferenceState(reader as never, referencedName, config.sandboxNamespace)
    ).resolves.toBe('not-referenced')
  })

  it('binds ordinary WorkflowRecipe workloads to sandbox-recipes, not every workflow Secret namespace', async () => {
    const reader = {
      listResource: vi.fn(async (plural: string, namespace?: string) =>
        plural === 'workflowrecipes' && namespace === config.sandboxNamespace
          ? [{ spec: { workloads: [{ id: 'worker', envSecret: { name: referencedName } }] } }]
          : []
      ),
    }

    await expect(
      findSecretReferenceState(reader as never, referencedName, config.mcpServersNamespace)
    ).resolves.toBe('not-referenced')
  })

  it('fails closed when no contract applies or a required CRD list cannot be read', async () => {
    const reader = { listResource: vi.fn(async () => []) }
    await expect(
      findSecretReferenceState(reader as never, referencedName, 'untracked-namespace')
    ).resolves.toBe('unknown')
    expect(reader.listResource).not.toHaveBeenCalled()

    const unavailableReader = {
      listResource: vi.fn(async () => Promise.reject(new Error('unavailable'))),
    }
    await expect(
      findSecretReferenceState(unavailableReader as never, referencedName, config.sandboxNamespace)
    ).resolves.toBe('unknown')
  })
})

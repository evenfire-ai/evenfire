import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { findSecretReferenceState } from '../src/services/secretReferenceService.js'

const referencedName = 'referenced-credential'

describe('findSecretReferenceState', () => {
  it('recognizes every current CRD reference shape that can retain a Secret', async () => {
    const cases = [
      {
        namespace: config.mcpServersNamespace,
        plural: 'mcpservers',
        resource: { spec: { imagePullSecrets: [{ name: referencedName }] } },
      },
      {
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resource: { spec: { workloads: [{ imagePullSecrets: [referencedName] }] } },
      },
      {
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resource: { spec: { oauth: { clientIdRef: { name: referencedName, key: 'client-id' } } } },
      },
      {
        namespace: config.sandboxNamespace,
        plural: 'workflowrecipes',
        resource: {
          spec: { oauth: { clientSecretRef: { name: referencedName, key: 'client-secret' } } },
        },
      },
      {
        namespace: config.llmHooksNamespace,
        plural: 'llmhooks',
        resource: { spec: { target: { image: { imagePullSecrets: [referencedName] } } } },
      },
      {
        namespace: config.llmHooksNamespace,
        plural: 'llmhooks',
        resource: { spec: { target: { remote: { authHeadersSecret: referencedName } } } },
      },
    ]

    for (const { namespace, plural, resource } of cases) {
      const reader = {
        listResource: vi.fn(async (requestedPlural: string, requestedNamespace?: string) =>
          requestedPlural === plural && requestedNamespace === namespace ? [resource] : []
        ),
      }

      await expect(findSecretReferenceState(reader as never, referencedName, namespace)).resolves.toBe(
        'referenced'
      )
      expect(reader.listResource).toHaveBeenCalledWith(plural, namespace)
    }
  })
})

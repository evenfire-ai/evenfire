import { secretFound } from '../../components/__tests__/fixtures/secretResolvedConditions'
import type { McpServerResource } from '../../lib/api'
import {
  registryEnvSecret,
  registryMcpServerMetadata,
  registrySecretName,
} from './registryMcpServerProducer'

const HCC_RECONCILED_AT = '2026-01-01T00:00:00.000Z'

/** Registry install -> API list -> HCC reconcile. Callers supply registry
 * inputs only; the producer owns the Secret reference, metadata, and status. */
export function buildRegistryMcpServerReference(options: {
  name: string
  catalogId: string
  catalogVersion: string
  credentialKeyNames?: string[]
}): McpServerResource {
  const secretName = registrySecretName(options.name)
  const spec = {
    image: 'ghcr.io/acme/linear-mcp:1.4.0',
    contextRef: 'default',
    enabled: true,
    managed: true,
    transport: { type: 'streamableHttp', port: 3000 },
    envSecret: registryEnvSecret(secretName, options.credentialKeyNames ?? ['api-key']),
  }
  return {
    metadata: registryMcpServerMetadata({
      serverName: options.name,
      catalogId: options.catalogId,
      catalogVersion: options.catalogVersion,
      namespace: 'mcp-server',
      spec,
    }),
    spec,
    status: { conditions: [secretFound({ at: HCC_RECONCILED_AT })] },
  }
}

export { buildDirectCrdMcpServerReference } from './directCrdMcpServer'
/** Compatibility name for the existing direct-CRD edit-page tests. */
export { buildDirectCrdMcpServerReference as buildMcpServerReference } from './directCrdMcpServer'

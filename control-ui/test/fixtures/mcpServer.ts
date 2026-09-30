import { secretFound } from '../../components/__tests__/fixtures/secretResolvedConditions'
import type { EnvSecret, McpServerResource } from '../../lib/api'
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

/** Direct CRD API input, deliberately separate from registry install output.
 * It covers shared Secret references, noncanonical names, and distinct key-to-
 * environment mappings that the registry install producer does not emit. */
export function buildDirectCrdMcpServerReference(options: {
  name: string
  secretName: string
  secretKey?: string
  envVar?: string
  annotations?: Record<string, string>
  labels?: Record<string, string>
}): McpServerResource {
  const envSecret: EnvSecret = {
    name: options.secretName,
    keys: [
      {
        secretKey: options.secretKey ?? 'api-key',
        envVar: options.envVar ?? 'LINEAR_API_KEY',
      },
    ],
  }
  return {
    metadata: {
      name: options.name,
      namespace: 'mcp-server',
      ...(options.annotations ? { annotations: options.annotations } : {}),
      ...(options.labels ? { labels: options.labels } : {}),
    },
    spec: {
      image: 'ghcr.io/acme/linear-mcp:1.4.0',
      contextRef: 'default',
      enabled: true,
      managed: true,
      transport: { type: 'streamableHttp', port: 3000 },
      envSecret,
    },
    ...(envSecret.name.trim() === envSecret.name
      ? { status: { conditions: [secretFound({ at: HCC_RECONCILED_AT })] } }
      : {}),
  }
}

/** Existing edit-page test harness models direct CRD inputs. */
export const buildMcpServerReference = buildDirectCrdMcpServerReference

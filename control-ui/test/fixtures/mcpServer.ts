import { secretFound } from '../../components/__tests__/fixtures/secretResolvedConditions'
import type { EnvSecret, McpServerResource } from '../../lib/api'
import { registryEnvSecret, registrySecretName } from './registryMcpServerProducer'

/** Secret reference derived from the registry assignment, with an optional
 * direct-CRD env mapping used by the credential form's adversarial cases. */
type ReferenceOptions = {
  name: string
  secretName: string
  secretKey?: string
  envVar?: string
  annotations?: Record<string, string>
  labels?: Record<string, string>
}

export function buildMcpServerReference(options: ReferenceOptions): McpServerResource {
  const envSecret = registryEnvSecret(options.secretName, [options.secretKey ?? 'api-key'])
  if (options.envVar !== undefined) envSecret.keys[0].envVar = options.envVar
  else envSecret.keys[0].envVar = 'LINEAR_API_KEY'

  return buildReference(options, envSecret)
}

/** Unmodified output of the registry install producer, used by the table's
 * producer/consumer contract tests. */
export function buildRegistryMcpServerReference(
  options: Omit<ReferenceOptions, 'secretName' | 'secretKey' | 'envVar'>
): McpServerResource {
  const secretName = registrySecretName(options.name)
  return buildReference({ ...options, secretName }, registryEnvSecret(secretName, ['api-key']))
}

function buildReference(options: ReferenceOptions, envSecret: EnvSecret): McpServerResource {
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
    // An invalid Kubernetes Secret name cannot reach HCC's resolved state.
    ...(envSecret.name.trim() === envSecret.name
      ? { status: { conditions: [secretFound({ at: '2026-01-01T00:00:00.000Z' })] } }
      : {}),
  }
}

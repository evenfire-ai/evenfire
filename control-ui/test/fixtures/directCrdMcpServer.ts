import { secretFound } from '../../components/__tests__/fixtures/secretResolvedConditions'
import type { EnvSecret, McpServerResource } from '../../lib/api'

const HCC_RECONCILED_AT = '2026-01-01T00:00:00.000Z'

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

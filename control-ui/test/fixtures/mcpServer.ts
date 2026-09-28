import type { McpServerResource } from '../../lib/api'

/** Mirrors the McpServer written by the registry install producer: the Secret
 * reference always carries both its name and declared key-to-env mappings. */
export function buildMcpServerReference(options: {
  name: string
  secretName: string
  secretKey?: string
  envVar?: string
  annotations?: Record<string, string>
  labels?: Record<string, string>
}): McpServerResource {
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
      envSecret: {
        name: options.secretName,
        keys: [
          {
            secretKey: options.secretKey ?? 'api-key',
            envVar: options.envVar ?? 'LINEAR_API_KEY',
          },
        ],
      },
    },
    status: { conditions: [] },
  }
}

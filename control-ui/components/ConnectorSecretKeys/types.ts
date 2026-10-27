import type { EnvSecret, McpServerResource } from '@lib/api'

export type ConnectorSecretKeysProps = {
  secretName: string
  keys: string[]
  serverName?: string
  envSecret?: EnvSecret
  server?: McpServerResource
  referencingConnectors: string[]
  onKeysChange: (keys: string[]) => void
  onMissing: () => void
  onServerChange: (server: McpServerResource) => void
}

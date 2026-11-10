import type { RegistryCredentialSource } from '@components/UpdateConnectorCredentials/types'
import type { McpServerResource } from '@lib/api'

export type AttachConnectorCredentialsProps = {
  serverName: string
  server: McpServerResource
  registryCredentialSource?: RegistryCredentialSource
  blockedReason?: string
  onBusyChange?: (busy: boolean) => void
  onSpecSaved: (server: McpServerResource) => void
  onFinished: () => void
}

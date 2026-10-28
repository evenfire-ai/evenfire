import type { EnvSecret, McpServerResource } from '@lib/api'
import type { ExistingCredentialSelection } from '@lib/connectorCredentials.types'

export type ExistingConnectorSecretFieldsProps = {
  server: McpServerResource
  initialReference?: EnvSecret
  disabled?: boolean
  onChange: (selection: ExistingCredentialSelection) => void
}

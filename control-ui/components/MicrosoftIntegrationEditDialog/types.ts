import type { IdentityProviderConnection } from '@lib/identityProviders.types'

export type MicrosoftIntegrationEditDialogProps = {
  connection: IdentityProviderConnection | null
  onClose: () => void
  onSaved: (connection: IdentityProviderConnection) => void
}

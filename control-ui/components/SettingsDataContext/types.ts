import type { ControlAdminProfile } from '@lib/api'
import type { IdentityProviderConnection } from '@lib/identityProviders.types'

export type PendingAdminEmailChange = NonNullable<ControlAdminProfile['pendingEmailChange']>

export type SettingsDataContextValue = {
  accountError: string
  accountLoading: boolean
  connections: IdentityProviderConnection[]
  connectionsLoading: boolean
  integrationsError: string
  microsoftCallbackUrl: string
  profile: ControlAdminProfile | null
  refreshConnections: () => Promise<void>
  removeConnection: (connectionId: string) => void
  replaceConnection: (connection: IdentityProviderConnection) => void
  updatePendingEmailChange: (pendingEmailChange: PendingAdminEmailChange | null) => void
  updateProfile: (profile: ControlAdminProfile) => void
}

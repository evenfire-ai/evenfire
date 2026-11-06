import type { ReactNode } from 'react'
import type { RegistryEntry, RegistryRemoteOAuthGrantScope } from '@lib/api'
import type { RemoteOAuthCatalogView } from '@lib/oauthInstall.types'
import type { RemoteOAuthSlotRow } from '@lib/remoteOAuthSlots.types'

export type ValidRemoteOAuthCatalogView = Extract<RemoteOAuthCatalogView, { valid: true }>

export type RemoteOAuthSlotListProps = {
  rows: RemoteOAuthSlotRow[]
  /** Per-slot controls; the catalog table leaves them to its row menu. */
  renderActions?: (row: RemoteOAuthSlotRow) => ReactNode
}

export type RemoteOAuthEntryBadgesProps = {
  view: ValidRemoteOAuthCatalogView
}

export type RemoteOAuthNotInstallableProps = {
  reason: string
}

export type UseRemoteOAuthSlotActionsOptions = {
  /** Re-reads the install state after an uninstall or a vanished connector. */
  onChanged: () => Promise<unknown>
}

export type RemoteOAuthSlotActions = {
  install: (
    entry: Pick<RegistryEntry, 'name' | 'version'>,
    scope: RegistryRemoteOAuthGrantScope
  ) => void
  openAgents: (serverName: string) => Promise<void>
  uninstall: (serverName: string) => Promise<void>
  /** Whether an action is still running on this connector. */
  isBusy: (serverName: string) => boolean
  error: string
  /** The agent-access dialog and the uninstall confirmation, to render once. */
  dialogs: ReactNode
}

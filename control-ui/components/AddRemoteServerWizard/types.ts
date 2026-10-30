import type { ReactNode } from 'react'
import type {
  RemoteAsEndpointHosts,
  RemoteCatalogDrift,
  RemoteCatalogInstallTarget,
  RemoteGrantScope,
} from '../../lib/remoteMcp.types'

export type AddRemoteServerWizardProps = {
  /** Rendered create-page header (icon, title, back). */
  pageHeader: ReactNode
  /** Called after a successful install (201). The page picks the destination. */
  onInstalled: () => void
  /** Called when the operator cancels from the first step. */
  onCancel: () => void
  /**
   * Marketplace catalog mode: the URL, the server name and the grant scope belong to
   * the entry and the slot, so none of them is editable or sent. Absent = manual mode.
   */
  catalog?: RemoteCatalogInstallTarget
  /**
   * Catalog mode: another install holds the slot (or is taking it). The page shows the
   * message and returns to the Marketplace, whose card then reloads the slot state.
   */
  onSlotTaken?: (message: string) => void
}

export type CatalogDriftNoticeProps = {
  drift: RemoteCatalogDrift
}

export type GrantScopeOption = {
  value: RemoteGrantScope
  label: string
  description: string
}

/** A pre-registered install that succeeded; the wizard holds to show its redirect URI. */
export type InstalledRedirectUri = {
  /** The URI control-api reported in the 201 — authoritative over the preview. */
  redirectUri: string
  /** The 201 URI differs from the one previewed before install. */
  changedSincePreview: boolean
}

export type RedirectUriCopyProps = {
  uri: string
  onCopy: (uri: string) => void
}

export type AsEndpointHostsSummaryProps = {
  hosts: RemoteAsEndpointHosts
  /** Explain why the hosts are shown (the configuration step; the confirm step omits it). */
  withExplanation?: boolean
}

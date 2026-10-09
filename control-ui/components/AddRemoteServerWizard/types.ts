import type { ReactNode } from 'react'
import type {
  RemoteAsEndpointHosts,
  RemoteGrantScope,
  RemoteProviderMessage,
} from '../../lib/remoteMcp.types'

export type AddRemoteServerWizardProps = {
  /** Rendered create-page header (icon, title, back). */
  pageHeader: ReactNode
  /** Called after a successful install (201). Redirects to the connectors list. */
  onInstalled: () => void
  /** Called when the operator cancels from the first step. */
  onCancel: () => void
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

/** A failed install: the platform's copy, plus any text the AS sent with it. */
export type InstallFailure = {
  message: string
  provider: RemoteProviderMessage | null
}

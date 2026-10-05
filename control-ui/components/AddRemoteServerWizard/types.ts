import type { ReactNode } from 'react'
import type { RemoteAsEndpointHosts, RemoteGrantScope } from '../../lib/remoteMcp.types'

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

/**
 * An install that succeeded but needs the operator's attention before leaving:
 * a pre-registered redirect URI to copy, and/or agents that could not be given
 * access.
 */
export type InstalledHold = {
  /** The URI control-api reported in the 201 — authoritative over the preview. */
  redirectUri?: string
  /** The 201 URI differs from the one previewed before install. */
  changedSincePreview: boolean
  /** Agents whose Context could not be updated after the install. */
  accessWarning?: string
}

/** The generated private scope used when no agent is selected. */
export type PrivateScope = {
  serverName: string
  contextRef: string
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

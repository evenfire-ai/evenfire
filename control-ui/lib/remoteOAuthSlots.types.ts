import type { RegistryManualRemoteOAuthServer, RegistryRemoteOAuthGrantScope } from './api'

/** What one install slot (entry × grant scope) of a remote-OAuth entry shows. */
export type RemoteOAuthSlotStatus =
  | { kind: 'free' }
  | {
      kind: 'installed'
      serverName: string
      version: string
      /** False when the instance does not carry the slot's canonical name. */
      canonical: boolean
    }
  | { kind: 'uninstalling'; serverName: string }
  /** The slot's name is held by a resource that was not installed into this slot. */
  | { kind: 'occupied'; serverName: string }

export type RemoteOAuthSlotRow = {
  scope: RegistryRemoteOAuthGrantScope
  /** "Per user" / "Per context". */
  label: string
  status: RemoteOAuthSlotStatus
  /** Manual (by URL) installs of the same URL and grant scope. */
  manualMatches: RegistryManualRemoteOAuthServer[]
}

/** The client-side verification filter of the Marketplace. */
export type RemoteOAuthVerificationKind = 'verified' | 'untested' | 'known-issue' | 'third-party'

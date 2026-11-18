export type GfsAccessState = 'active' | 'revoked'

export type GfsAuthoritySurface = 'discovery' | 'operation'

/**
 * `revoked`: an authority failure of the live session; the shared access key
 * was written and its cache cleared. `stale`: an authority failure from a
 * session that is no longer the live one; nothing was written. `not-authority`:
 * a policy or transport failure that stays local to its caller.
 */
export type GfsAuthorityFailureOutcome = 'revoked' | 'stale' | 'not-authority'

export interface GfsLiveSessionAuthority {
  scope: string | null
  generation: number | null
}

export interface GfsSessionScopeSource {
  isAuthenticated: boolean
  me: { id: string; teamId?: string | null } | null
  runtimeConfigState: { envKey: string } | null | undefined
}

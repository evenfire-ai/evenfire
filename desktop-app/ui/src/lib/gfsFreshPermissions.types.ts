import type { QueryClient, QueryState } from '@tanstack/react-query'

export interface GfsFreshAuthority {
  held?: string[]
  grantableBits?: string[]
}

/** The affordances a server read returns. */
export type GfsServerAuthority = Awaited<ReturnType<Window['clerum']['gfs']['affordances']>>

export interface GfsFreshAuthorityRequest {
  scope: string | null
  gen: number | null
  resourceId: string
  /** Named in the permission toasts. */
  resourceName: string
  drive?: string
}

export interface GfsFreshPermissionsRequest extends GfsFreshAuthorityRequest {
  bits: readonly string[]
  grantableBits?: readonly string[]
}

export interface GfsFreshPermissionsContext {
  queryClient: QueryClient
  /**
   * Fail-closed boundary for a failed authority read, called with the session
   * the read was issued under. True when the failure was a session-authority
   * failure, so the caller stays quiet and the revoked state takes over.
   */
  handleAuthorityFailure: (error: unknown, scope: string | null, gen: number | null) => boolean
  pushToast?: (message: string, tone: 'error') => void
  /** Whether the request still belongs to the owner's live, active session. */
  isCurrent: () => boolean
  /**
   * Authority the owner already holds for this exact resource, consulted only
   * when the shared query has no fresh success. Receives that query's state.
   */
  fallbackAuthority?: (
    queryState: QueryState<unknown, Error> | undefined
  ) => GfsFreshAuthority | null | undefined
}

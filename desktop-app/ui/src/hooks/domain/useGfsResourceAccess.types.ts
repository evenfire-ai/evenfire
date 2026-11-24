import type { useGfsResourceAccess } from './useGfsResourceAccess'
import type { GfsOperationAuthorityFailureHandler } from './useGfsResourceOperations.types'

/** The resource whose sharing is read and changed: always explicit, never a browser location. */
export interface GfsAccessTarget {
  resourceId: string
}

export interface GfsResourceAccessOptions {
  /**
   * Fail-closed boundary for an authority rejection of an ACL read or write,
   * called with the session the request was issued under.
   */
  handleAuthorityFailure: GfsOperationAuthorityFailureHandler
}

/** The session an ACL mutation was issued under, captured when it starts. */
export interface GfsAccessMutationAuthority {
  resourceId: string
  authorityScope: string | null
  authorityGeneration: number | null
}

export type GfsResourceAccess = ReturnType<typeof useGfsResourceAccess>

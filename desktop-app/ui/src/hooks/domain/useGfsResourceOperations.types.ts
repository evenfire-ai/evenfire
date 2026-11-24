import type { GfsAuthoritySurface } from '@lib/gfsSessionAuthority.types'

type GfsBridge = typeof window.clerum.gfs

/** The session a mutation was issued under, captured when it starts. */
export interface GfsOperationAuthority {
  authorityScope: string | null
  authorityGeneration: number | null
}

export interface GfsMoveConvergenceInput {
  resourceId: string
  destinationId: string
  newName?: string
  oldParentId?: string | null
  expectedSessionGeneration?: number
}

export interface GfsMoveMutationInput {
  resourceId: string
  destinationId: string
  ifMatch?: number
  newName?: string
  oldParentId?: string | null
  operationScope?: string
  authorityHandledByCaller?: boolean
  expectedSessionGeneration: number
}

/**
 * A committed operation as the owner of a location sees it. A move reaches
 * here only after the shared convergence ran, with `operationScope` already
 * resolved to the scope the convergence used.
 */
export type GfsCommittedOperation =
  | {
      op: 'createFolder'
      input: { parentResourceId: string; name: string }
      result: Awaited<ReturnType<GfsBridge['createFolder']>>
    }
  | {
      op: 'createFile'
      input: { parentResourceId: string; name: string; encodedData: string }
      result: Awaited<ReturnType<GfsBridge['createFile']>>
    }
  | {
      op: 'createFileFromPath'
      input: { parentResourceId: string; name: string; filePath: string }
      result: Awaited<ReturnType<GfsBridge['createFileFromPath']>>
    }
  | {
      op: 'replaceFile'
      input: { resourceId: string; encodedData: string; ifMatch?: number }
      result: Awaited<ReturnType<GfsBridge['replaceFile']>>
    }
  | {
      op: 'replaceFileFromPath'
      input: { resourceId: string; filePath: string; ifMatch?: number }
      result: Awaited<ReturnType<GfsBridge['replaceFileFromPath']>>
    }
  | {
      op: 'renameResource'
      input: { resourceId: string; name: string; ifMatch?: number }
      result: Awaited<ReturnType<GfsBridge['renameResource']>>
    }
  | {
      op: 'deleteResource'
      input: { resourceId: string; ifMatch?: number }
      result: Awaited<ReturnType<GfsBridge['deleteResource']>>
    }
  | {
      op: 'moveResource'
      input: GfsMoveConvergenceInput & { operationScope: string | null }
      result: { version: number }
    }

export type GfsOperationAuthorityFailureHandler = (
  message: string,
  surface: GfsAuthoritySurface,
  scope: string | null,
  generation: number | null
) => unknown

export interface GfsResourceOperationsOptions {
  /**
   * Fail-closed boundary for a mutation rejection, called with the session the
   * mutation was issued under. Defaults to the shared library handler; a
   * browser controller injects its own so its location clears synchronously.
   */
  handleAuthorityFailure?: GfsOperationAuthorityFailureHandler
  /** Owner-side reaction to a committed operation, awaited before the cache refresh. */
  onCommitted?: (commit: GfsCommittedOperation) => void | Promise<void>
}

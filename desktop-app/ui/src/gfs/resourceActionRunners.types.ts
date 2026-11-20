import type { GfsUploadNameReservationBook } from '@clerum/gfs-interaction-policy'
import type { useGfsResourceOperations } from '@hooks/domain/useGfsResourceOperations'
import type { requireFreshGfsPermissions } from '@lib/gfsFreshPermissions'
import type { GfsAccessState } from '@lib/gfsSessionAuthority.types'

type GfsResourceOperations = ReturnType<typeof useGfsResourceOperations>

/** What an action needs to decide whether it still belongs to the session it started under. */
export interface GfsActionGuardDeps {
  /** Synchronous read of the shared access flag (never a render value). */
  readAccessState: () => GfsAccessState
  /** The generation the renderer has published right now. */
  publishedGeneration: () => number | null
  /** The owner's own liveness for this action (token, session scope). */
  isCurrent?: () => boolean
}

export interface GfsActionRunnerDeps extends GfsActionGuardDeps {
  ops: Pick<
    GfsResourceOperations,
    'renameResource' | 'createFolder' | 'deleteResource' | 'createFileFromPath'
  >
  /** The owner's binding of `requireFreshGfsPermissions`; null means "do not start". */
  freshPermissions: (
    resourceId: string,
    resourceName: string,
    bits: readonly string[]
  ) => ReturnType<typeof requireFreshGfsPermissions>
}

/**
 * `isCurrent`: synchronous liveness, checked after every await. `admitEffect`:
 * the last word before a mutation, confirmed with main.
 */
export interface GfsActionGuards {
  isCurrent: () => boolean
  admitEffect: () => Promise<boolean>
}

export interface GfsActionResource {
  resourceId: string
  name: string
  version?: number
}

export interface GfsActionFolder {
  resourceId: string
  name: string
}

/**
 * `aborted`: the action never reached its mutation (no permission, or the
 * session it started under is no longer current); any feedback was already
 * given. `failed`: the mutation, or a local precondition, threw.
 */
export type GfsActionRunResult<T = undefined> =
  | { status: 'done'; value: T }
  | { status: 'unchanged' }
  | { status: 'aborted' }
  | { status: 'failed'; error: unknown }

export interface GfsCreateFolderRunOptions {
  /** Called once the parent's write permission is confirmed, before the name is normalized. */
  onPermitted?: () => void
}

export type GfsUploadReservations = GfsUploadNameReservationBook

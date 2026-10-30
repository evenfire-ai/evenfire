import type { GfsCrumb } from '@hooks/domain/useGfsBrowserController'

type GfsMoveDialogBaseProps = {
  /** The resource being moved (kind powers the dialog title + cycle guard).
   * `parentResourceId`, when known (list rows carry it), lets the dialog
   * disable a no-op move into the folder that already contains the target. */
  target: {
    resourceId: string
    name: string
    kind: 'file' | 'directory'
    parentResourceId?: string | null
  }
  /** Cache scope from useGfsBrowserController — shares the page's gfs queries. */
  sessionScope?: string
  /** Published generation that owns all authority reads in this dialog. */
  sessionGeneration: number | null
  /** Dialog-local starting path (typically the page crumbs, minus the target). */
  initialCrumbs: GfsCrumb[]
  /** Recheck both source and destination permissions without committing Move. */
  onRetryPermissionCheck: (
    destinationId: string,
    destinationName: string,
    isCurrent: () => boolean
  ) => Promise<void>
  onClose: () => void
  busy?: boolean
  permissionStatus?: 'checking' | 'failed' | null
  /** Central fail-closed boundary (R4 spec §1): destination-listing authority
   *  failures must revoke the session even though the dialog owns these
   *  query observers. Policy verdicts return false and stay local. */
  onAuthorityFailure?: (message: string, scope: string, sessionGeneration: number) => boolean
}

export type GfsNumberedNameConsent = (proposedName: string) => Promise<boolean>

/** Commit adapter: ordinary callers may use onMove; snapshot owners may use the
 * ownership-aware adapter instead, or provide both for compatibility. */
type GfsMoveDialogCommitProps =
  | {
      /** Commit the move; resolves on success and throws the server verdict on denial. */
      onMove: (destinationId: string, destinationName: string) => Promise<void>
      /** Optional ownership-aware adapter for callers with a move snapshot. */
      onMoveWithOwnership?: (
        destinationId: string,
        destinationName: string,
        isCurrent: () => boolean,
        requestNumberedNameConsent: GfsNumberedNameConsent
      ) => Promise<void>
    }
  | {
      onMove?: undefined
      onMoveWithOwnership: (
        destinationId: string,
        destinationName: string,
        isCurrent: () => boolean,
        requestNumberedNameConsent: GfsNumberedNameConsent
      ) => Promise<void>
    }

export type GfsMoveDialogProps = GfsMoveDialogBaseProps & GfsMoveDialogCommitProps

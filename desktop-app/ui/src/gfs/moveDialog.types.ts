import type { GfsCrumb } from '@hooks/domain/useGfsBrowserController'

export type GfsMoveDialogProps = {
  /** The resource being moved (kind powers the dialog title + cycle guard). */
  target: { resourceId: string; name: string; kind: 'file' | 'directory' }
  /** Cache scope from useGfsBrowserController — shares the page's gfs queries. */
  sessionScope?: string
  /** Dialog-local starting path (typically the page crumbs, minus the target). */
  initialCrumbs: GfsCrumb[]
  /** Commit the move; resolves on success (caller toasts) and throws the
   *  server verdict on denial so the dialog can surface it in place. */
  onMove: (destinationId: string, destinationName: string) => Promise<void>
  onClose: () => void
  busy?: boolean
}

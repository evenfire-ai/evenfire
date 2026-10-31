import type { GfsDiscoveryFailure } from '@hooks/domain/useGfsBrowserController'

/** One row of the caller's recent files, as the proxy returns it. */
export interface GfsRecentFileRow {
  resourceId: string
  gfsUri: string
  drive: string
  name: string
  version: number
  bytes: number
  /** ISO 8601 UTC. */
  lastActivityAt: string
}

export type GfsRecentFilesCardProps = {
  files: readonly GfsRecentFileRow[]
  /** Allow the dedicated view to reveal more history in groups of five. */
  expandable?: boolean
  visibleCount?: number
  onVisibleCountChange?: (count: number) => void
  loading: boolean
  fetching: boolean
  failure: GfsDiscoveryFailure | null
  onRetry: () => void
  onOpen: (file: GfsRecentFileRow) => void
}

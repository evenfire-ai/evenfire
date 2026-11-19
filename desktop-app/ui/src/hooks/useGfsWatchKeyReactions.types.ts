import type { MutableRefObject } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { GfsWatchAuthority } from '@lib/gfsWatchReaction'

export interface GfsWatchKeyReactionsOptions {
  queryClient: QueryClient
  /** The session the reactions read for, as of the latest render. */
  authorityRef: MutableRefObject<GfsWatchAuthority>
  /** Watch key of the Files location on screen, or null when none is resolved. */
  activeFilesLocationKeyRef: MutableRefObject<string | null>
  /** Re-reads every open preview of a watched file key. */
  refreshFilePreviews: (key: string) => Promise<unknown>
}

export interface GfsWatchKeyReactions {
  /** The mounted Files page hands in its location refresh; returns its unregister. */
  registerFilesLocationRefresh: (refresh: () => Promise<unknown>) => () => void
  /** Re-reads one watched key, single-flighted per key. */
  reactToGfsWatchKey: (key: string) => void
  /**
   * Re-reads the Files location on screen after a change made elsewhere. With a
   * watched key it is that key's own reaction, so it coalesces with the watch's
   * echo instead of running beside it.
   */
  refreshFilesLocation: () => void
}

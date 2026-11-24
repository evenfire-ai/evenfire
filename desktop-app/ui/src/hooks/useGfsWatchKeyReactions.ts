import { useCallback, useEffect, useRef } from 'react'
import { parseGfsWatchKey } from '@lib/gfsWatchKeys'
import { refetchWatchedFolder } from '@lib/gfsWatchReaction'
import { type KeyedSingleFlight, createKeyedSingleFlight } from '@lib/keyedSingleFlight'
import type {
  GfsWatchKeyReactions,
  GfsWatchKeyReactionsOptions,
} from './useGfsWatchKeyReactions.types'

/**
 * The reactions to a watched key: a re-read through the same authoritative
 * paths a user refresh takes, at most one in flight and one kept per key.
 */
export function useGfsWatchKeyReactions({
  queryClient,
  authorityRef,
  activeFilesLocationKeyRef,
  refreshFilePreviews,
}: GfsWatchKeyReactionsOptions): GfsWatchKeyReactions {
  const filesLocationRefreshRef = useRef<(() => Promise<unknown>) | null>(null)
  const registerFilesLocationRefresh = useCallback((refresh: () => Promise<unknown>) => {
    filesLocationRefreshRef.current = refresh
    return () => {
      if (filesLocationRefreshRef.current === refresh) filesLocationRefreshRef.current = null
    }
  }, [])
  const refreshFilePreviewsRef = useRef(refreshFilePreviews)
  refreshFilePreviewsRef.current = refreshFilePreviews

  // Created in the effect, not in render: StrictMode runs the cleanup once
  // before the real mount, and a disposed instance would drop every reaction.
  const reactionsRef = useRef<KeyedSingleFlight | null>(null)
  useEffect(() => {
    const reactions = createKeyedSingleFlight()
    reactionsRef.current = reactions
    return () => {
      reactions.dispose()
      if (reactionsRef.current === reactions) reactionsRef.current = null
    }
  }, [])

  const reactToGfsWatchKey = useCallback(
    (key: string) => {
      const parts = parseGfsWatchKey(key)
      if (!parts) return
      reactionsRef.current?.run(key, async () => {
        if (parts.kind === 'file') {
          await refreshFilePreviewsRef.current(key)
        } else {
          await refetchWatchedFolder(queryClient, authorityRef.current, parts.drive, parts.rid)
        }
        if (activeFilesLocationKeyRef.current === key) await filesLocationRefreshRef.current?.()
      })
    },
    [activeFilesLocationKeyRef, authorityRef, queryClient]
  )

  const refreshFilesLocation = useCallback(() => {
    const key = activeFilesLocationKeyRef.current
    if (key) {
      reactToGfsWatchKey(key)
      return
    }
    // The page renders its own refresh failure (banner or inaccessible
    // state); nothing here could add to it.
    filesLocationRefreshRef.current?.().catch(() => {})
  }, [activeFilesLocationKeyRef, reactToGfsWatchKey])

  return { registerFilesLocationRefresh, reactToGfsWatchKey, refreshFilesLocation }
}

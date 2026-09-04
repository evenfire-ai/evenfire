import { useCallback, useEffect, useMemo, useState } from 'react'
import { TOUR_CATALOG_GRACE_MS, TOUR_PREVIEW, TOUR_SEEN_STORAGE_KEY } from '@constants/tour'

interface UseTourControllerParams {
  isAuthenticated: boolean
  /** The access catalog has resolved or errored — either way, done waiting. */
  catalogSettled: boolean
  /**
   * Another modal is up. The tour yields to all of them: every one is the
   * consequence of a user action or a security decision, and the tour is
   * neither, so it must never paint over a choice someone has to make.
   */
  blockedByOtherModal: boolean
}

export interface TourViewModel {
  visible: boolean
  dismiss: () => void
}

/**
 * Reads the once-per-install seen flag.
 *
 * A read that throws counts as seen. An environment that cannot remember the
 * tour is one where the tour must not reappear at every launch.
 */
function readSeen(): boolean {
  // Previewing must not consume the one real showing, so the flag is neither
  // read nor written while the dev switch is on.
  if (TOUR_PREVIEW) return false
  try {
    return window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY) === 'true'
  } catch {
    return true
  }
}

/**
 * Resolved once per app session, deliberately outside React.
 *
 * The flag is written the moment the tour paints, so any remount that re-read
 * storage would see the value this run just wrote and hide the tour it is in
 * the middle of showing. StrictMode makes that certain — it mounts, unmounts
 * and remounts, which burned the tour before a single frame reached the user —
 * but a remount for any other reason would do the same.
 */
let seenAtSessionStart: boolean | null = null

function readSeenOncePerSession(): boolean {
  if (seenAtSessionStart === null) seenAtSessionStart = readSeen()
  return seenAtSessionStart
}

/** Test support: forget the memoized read so each case starts fresh. */
export function resetTourSeenSessionCache(): void {
  seenAtSessionStart = null
}

/**
 * Whether the first-run tour should be on screen, and the single persisted
 * byte that stops it coming back.
 *
 * The flag is written when the first step paints, not when the tour completes.
 * Someone who force-quits midway has in effect declined it; the alternative —
 * a modal at every launch until somebody reaches the last card — is the worse
 * failure by a wide margin.
 */
export function useTourController({
  isAuthenticated,
  catalogSettled,
  blockedByOtherModal,
}: UseTourControllerParams): TourViewModel {
  // Read once per session: flipping this on the write below would hide the
  // tour mid-run.
  const [seenAtMount] = useState(readSeenOncePerSession)
  const [dismissed, setDismissed] = useState(false)
  const [graceElapsed, setGraceElapsed] = useState(false)

  const eligible = isAuthenticated && !seenAtMount && !dismissed

  useEffect(() => {
    if (!eligible || catalogSettled) return
    const timer = window.setTimeout(() => setGraceElapsed(true), TOUR_CATALOG_GRACE_MS)
    // Cleared on unmount so it can never fire into a signed-out app.
    return () => window.clearTimeout(timer)
  }, [eligible, catalogSettled])

  const visible = eligible && (catalogSettled || graceElapsed) && !blockedByOtherModal

  useEffect(() => {
    if (!visible || TOUR_PREVIEW) return
    try {
      window.localStorage.setItem(TOUR_SEEN_STORAGE_KEY, 'true')
    } catch {
      // Nothing to do: the next launch's read will throw too and count as seen.
    }
  }, [visible])

  const dismiss = useCallback(() => setDismissed(true), [])

  return useMemo(() => ({ visible, dismiss }), [visible, dismiss])
}

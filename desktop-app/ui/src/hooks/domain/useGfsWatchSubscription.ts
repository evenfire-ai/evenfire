import { useEffect, useRef } from 'react'
import { GFS_WATCH_DEBOUNCE_MS } from '@constants/gfsWatch'
import type { GfsWatchEvent } from '../../../../src/types'

type GfsWatchHandle = Awaited<ReturnType<Window['clerum']['gfsWatch']['open']>>

export interface GfsWatchSubscriptionOptions {
  /** Canonical keys, highest priority first. */
  keys: readonly string[]
  /** `me.id` of the user the keys were derived for; main drops a list of another user. */
  userId: string | null
  /**
   * Changes whenever the session, principal, team or environment changes.
   * Main empties every window's list on those transitions, so the next send
   * must go out even when the list itself did not change.
   */
  sessionKey: string
  onEvent: (event: GfsWatchEvent) => void
}

const signatureOf = (keys: readonly string[], userId: string | null) =>
  JSON.stringify([userId, keys])

/**
 * Registers this window with the GFS watch on mount — with whatever list it
 * has, even an empty one, so it receives session and access events — and
 * keeps main's copy of the list in step with React state.
 */
export function useGfsWatchSubscription({
  keys,
  userId,
  sessionKey,
  onEvent,
}: GfsWatchSubscriptionOptions): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const desiredRef = useRef({ keys, userId })
  desiredRef.current = { keys, userId }
  const handleRef = useRef<GfsWatchHandle | null>(null)
  const lastSentRef = useRef<string | null>(null)
  const forceNextRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const flushRef = useRef<() => void>(() => undefined)
  const mountedRef = useRef(false)

  flushRef.current = () => {
    const handle = handleRef.current
    if (!handle) return
    const desired = desiredRef.current
    const signature = signatureOf(desired.keys, desired.userId)
    if (!forceNextRef.current && signature === lastSentRef.current) return
    forceNextRef.current = false
    lastSentRef.current = signature
    handle
      .setSubscriptions({ keys: [...desired.keys], userId: desired.userId })
      .then(result => {
        if (result.sessionExpired && handleRef.current === handle) {
          onEventRef.current({ type: 'sessionExpired' })
        }
      })
      .catch(() => {
        // Main did not take the list; the next change must not be deduped against it.
        if (lastSentRef.current === signature) lastSentRef.current = null
      })
  }

  const scheduleRef = useRef(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      flushRef.current()
    }, GFS_WATCH_DEBOUNCE_MS)
  })

  useEffect(() => {
    const bridge = window.clerum?.gfsWatch
    if (typeof bridge?.open !== 'function') return
    let disposed = false
    mountedRef.current = true
    const initial = desiredRef.current
    bridge
      .open(event => onEventRef.current(event), {
        keys: [...initial.keys],
        userId: initial.userId,
      })
      .then(handle => {
        if (disposed) {
          // A registration that outlived its mount (StrictMode's extra cleanup)
          // empties this window's list in main when it closes, possibly after
          // the live mount already sent its own. Resend from the live mount.
          void handle
            .close()
            .catch(() => undefined)
            .then(() => {
              if (!mountedRef.current) return
              forceNextRef.current = true
              scheduleRef.current()
            })
          return
        }
        handleRef.current = handle
        lastSentRef.current = signatureOf(initial.keys, initial.userId)
        if (handle.sessionExpired) onEventRef.current({ type: 'sessionExpired' })
        // State that changed while the registration was in flight.
        scheduleRef.current()
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      mountedRef.current = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      const handle = handleRef.current
      handleRef.current = null
      if (handle) void handle.close().catch(() => undefined)
    }
  }, [])

  const signature = signatureOf(keys, userId)
  useEffect(() => {
    scheduleRef.current()
  }, [signature])

  const previousSessionKeyRef = useRef(sessionKey)
  useEffect(() => {
    if (previousSessionKeyRef.current === sessionKey) return
    previousSessionKeyRef.current = sessionKey
    // Through the debounce like any send: the tab reset of a principal change
    // lands in the same commit, so the list sent is never the previous user's.
    forceNextRef.current = true
    scheduleRef.current()
  }, [sessionKey])
}

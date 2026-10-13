import { useEffect, useRef, useState } from 'react'
import { focusManager } from '@tanstack/react-query'
import { AUTO_REFRESH_POLL_INTERVAL_MS, AUTO_REFRESH_STALE_AFTER_MS } from '@constants/autoRefresh'
import type { AutoRefreshControls, AutoRefreshOptions } from './useAutoRefresh.types'

type SchedulerOptions = Required<Omit<AutoRefreshOptions, 'enabled'>>

/**
 * One timer chain per surface. Invariants:
 *  - at most one run in flight; focus and manual refreshes JOIN it;
 *  - the next deadline is `start of the latest run + interval` (never its
 *    completion), so a slow reply cannot push the poll out or make the
 *    age-based staleness check skip it;
 *  - a deadline that passes while a run is in flight is coalesced into ONE run
 *    when that run settles — no backlog.
 */
function createRefreshScheduler(readOptions: () => SchedulerOptions) {
  let active = false
  let timer: number | null = null
  let inFlight: Promise<void> | null = null
  let lastStartedAt = 0
  let deadlineMissed = false

  const clearTimer = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }

  const armAt = (deadline: number) => {
    clearTimer()
    if (!active) return
    timer = window.setTimeout(onDeadline, Math.max(0, deadline - Date.now()))
  }

  function onDeadline() {
    timer = null
    if (inFlight) {
      deadlineMissed = true
      return
    }
    void run()
  }

  function run(): Promise<void> {
    if (inFlight) {
      // Re-enabled while a run (started when disabled, or before) is still in
      // flight: keep the chain alive from that run's start.
      if (active && timer === null && !deadlineMissed) {
        armAt(lastStartedAt + readOptions().pollIntervalMs)
      }
      return inFlight
    }
    lastStartedAt = Date.now()
    armAt(lastStartedAt + readOptions().pollIntervalMs)
    let pending: Promise<unknown>
    try {
      pending = readOptions().refresh()
    } catch {
      pending = Promise.resolve()
    }
    const settled = Promise.resolve(pending).then(
      () => undefined,
      () => undefined
    )
    inFlight = settled.then(() => {
      inFlight = null
      if (deadlineMissed) {
        deadlineMissed = false
        if (active) void run()
      }
    })
    return inFlight
  }

  return {
    run,
    start() {
      active = true
      const { isStale, staleAfterMs, pollIntervalMs } = readOptions()
      if (isStale(staleAfterMs)) {
        void run()
      } else {
        armAt(Date.now() + pollIntervalMs)
      }
    },
    stop() {
      active = false
      deadlineMissed = false
      clearTimer()
    },
    onFocus() {
      if (!active) return
      const { isStale, staleAfterMs } = readOptions()
      if (isStale(staleAfterMs)) void run()
    },
  }
}

/**
 * Bounded staleness for a surface that shows server data which can change
 * mid-session (#991): refresh on enable when stale, on window focus when stale
 * (`useWindowFocusBridge` forwards Electron focus into `focusManager`), and on
 * a start-anchored poll while enabled. The query stays app-coordinated: every
 * run goes through the caller's imperative `refresh`, so identity teardown
 * (`reset` on logout / team switch) is untouched.
 */
export function useAutoRefresh({
  enabled,
  refresh,
  isStale,
  pollIntervalMs = AUTO_REFRESH_POLL_INTERVAL_MS,
  staleAfterMs = AUTO_REFRESH_STALE_AFTER_MS,
}: AutoRefreshOptions): AutoRefreshControls {
  // Latest callbacks, read at call time: consumers pass fresh arrows every
  // render, and those must neither tear down the timer chain nor refetch.
  const optionsRef = useRef<SchedulerOptions>({ refresh, isStale, pollIntervalMs, staleAfterMs })
  optionsRef.current = { refresh, isStale, pollIntervalMs, staleAfterMs }

  const [scheduler] = useState(() => createRefreshScheduler(() => optionsRef.current))
  const [controls] = useState<AutoRefreshControls>(() => ({ refreshNow: scheduler.run }))

  useEffect(() => {
    if (!enabled) return undefined
    scheduler.start()
    const unsubscribeFocus = focusManager.subscribe(isFocused => {
      if (isFocused) scheduler.onFocus()
    })
    return () => {
      unsubscribeFocus()
      scheduler.stop()
    }
  }, [enabled, scheduler])

  return controls
}

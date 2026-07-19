import { useCallback, useEffect, useRef, useState } from 'react'
import { getTracingOperationsSnapshot } from '@lib/governedTrace'
import type { TracingOperationsSnapshot } from '@lib/governedTrace'
import { TRACING_OPERATIONS_POLL_INTERVAL_MS } from './constants'
import type { TracingOperationsViewState } from './types'

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function useTracingOperationsSnapshot(): TracingOperationsViewState {
  const [snapshot, setSnapshot] = useState<TracingOperationsSnapshot | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [stale, setStale] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const snapshotRef = useRef<TracingOperationsSnapshot | null>(null)
  const inFlightRef = useRef(false)
  const refreshPendingRef = useRef(false)
  const mountedRef = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async function refreshSnapshot(queueIfBusy = false) {
    if (document.hidden) return
    if (inFlightRef.current) {
      if (queueIfBusy) refreshPendingRef.current = true
      return
    }
    inFlightRef.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    if (mountedRef.current) setRefreshing(true)
    try {
      const next = await getTracingOperationsSnapshot(controller.signal)
      if (!mountedRef.current || controller.signal.aborted) return
      snapshotRef.current = next
      setSnapshot(next)
      setStale(false)
      setUnavailable(false)
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted || isAbort(error)) return
      if (snapshotRef.current) {
        setStale(true)
      } else {
        setUnavailable(true)
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      inFlightRef.current = false
      const refreshAgain = refreshPendingRef.current && mountedRef.current && !document.hidden
      refreshPendingRef.current = false
      if (mountedRef.current) {
        if (!controller.signal.aborted) setInitialLoading(false)
        setRefreshing(false)
      }
      if (refreshAgain) void refreshSnapshot()
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const interval = window.setInterval(() => void refresh(), TRACING_OPERATIONS_POLL_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.hidden) {
        refreshPendingRef.current = false
        controllerRef.current?.abort()
        return
      }
      void refresh(true)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      controllerRef.current = null
      inFlightRef.current = false
      refreshPendingRef.current = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  return { snapshot, initialLoading, refreshing, stale, unavailable, refresh }
}

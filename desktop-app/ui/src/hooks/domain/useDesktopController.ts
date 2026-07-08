import { useCallback, useEffect, useState } from 'react'
import { getDesktopErrorMessage } from '@lib/desktopErrors'
import type { Tone } from '../../uiTypes'

interface UseDesktopControllerParams {
  selectedAgent: string | null
  pushToast: (msg: string, tone: Tone) => void
}

const DESKTOP_NOT_ENABLED_MESSAGE = 'Host does not have desktop enabled'

export function useDesktopController({ selectedAgent, pushToast }: UseDesktopControllerParams) {
  const [desktopStatus, setDesktopStatus] = useState<'inactive' | 'starting' | 'running' | 'error'>(
    'inactive'
  )
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const [desktopHostRef, setDesktopHostRef] = useState<string | null>(null)
  const [desktopAvailable, setDesktopAvailable] = useState(false)

  useEffect(() => {
    const hostRef = selectedAgent
    setDesktopAvailable(false)
    if (!hostRef) return

    let cancelled = false
    const checkDesktopAvailability = async () => {
      try {
        const status = await window.clerum.desktop.getStatus({ hostRef })
        if (cancelled) return
        // Coupled to the current free-text desktop status message until the
        // desktop API returns a typed `enabled: boolean` field.
        setDesktopAvailable(status.message !== DESKTOP_NOT_ENABLED_MESSAGE)
      } catch {
        if (!cancelled) {
          setDesktopAvailable(false)
        }
      }
    }

    void checkDesktopAvailability()
    return () => {
      cancelled = true
    }
  }, [selectedAgent])

  // I2: Listen for desktop window closed events from the main process
  useEffect(() => {
    const unsubscribe = window.clerum.desktop.onWindowClosed(({ hostRef }) => {
      if (desktopHostRef === hostRef) {
        setDesktopHostRef(null)
        setDesktopStatus('inactive')
        setDesktopError(null)
      }
    })
    return () => unsubscribe()
  }, [desktopHostRef])

  // M4: Poll desktop status every 10s while a window is open so the UI
  // detects when HCC removes the desktop or the mcp-host pod crashes.
  useEffect(() => {
    if (desktopStatus !== 'running' || !desktopHostRef) return

    const poll = async () => {
      try {
        const status = await window.clerum.desktop.getStatus({ hostRef: desktopHostRef })
        if (status.status !== 'running') {
          setDesktopStatus('error')
          setDesktopError(status.message || 'Desktop is no longer running')
          // Coupled to the current free-text desktop status message until the
          // desktop API returns a typed `enabled: boolean` field.
          if (status.message === DESKTOP_NOT_ENABLED_MESSAGE) {
            setDesktopAvailable(false)
          }
        }
      } catch (err) {
        console.warn('Desktop status poll failed:', err)
        // Don't flip to error state on transient poll failures
      }
    }

    const id = setInterval(poll, 10_000)
    return () => clearInterval(id)
  }, [desktopStatus, desktopHostRef])

  const handleOpenDesktop = useCallback(async () => {
    const hostRef = selectedAgent
    if (!hostRef) {
      setDesktopStatus('error')
      setDesktopError('No agent selected')
      return
    }
    setDesktopStatus('starting')
    setDesktopError(null)
    try {
      const status = await window.clerum.desktop.getStatus({ hostRef })
      if (status.status !== 'running') {
        const message = status.message || 'Desktop is not running for this agent'
        setDesktopStatus('error')
        setDesktopError(message)
        // Coupled to the current free-text desktop status message until the
        // desktop API returns a typed `enabled: boolean` field.
        if (message === DESKTOP_NOT_ENABLED_MESSAGE) {
          setDesktopAvailable(false)
        }
        pushToast(message, 'error')
        return
      }
      setDesktopAvailable(true)
      await window.clerum.desktop.openWindow({ hostRef })
      setDesktopHostRef(hostRef)
      setDesktopStatus('running')
    } catch (err) {
      const message = getDesktopErrorMessage(err)
      setDesktopStatus('error')
      setDesktopError(message)
      pushToast(message, 'error')
    }
  }, [pushToast, selectedAgent])

  return {
    desktopStatus,
    desktopError,
    desktopAvailable,
    handleOpenDesktop,
  }
}

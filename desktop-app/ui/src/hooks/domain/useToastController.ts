import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_TOAST_DURATION_MS, ERROR_TOAST_DURATION_MS } from '@constants/toasts'
import type { ToastMessage, Tone } from '../../uiTypes'

export function useToastController() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const pushToast = useCallback(
    (message: string, tone: Tone, options: { durationMs?: number } = {}) => {
      if (!message.trim()) return
      const toast: ToastMessage = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        text: message,
        tone,
        durationMs: options.durationMs,
      }
      setToasts(previous => [...previous.slice(-2), toast])
    },
    []
  )

  useEffect(() => {
    if (!toasts.length) return
    const latest = toasts[toasts.length - 1]
    if (!latest) return
    const timeoutId = window.setTimeout(
      () => {
        setToasts(previous => previous.filter(toast => toast.id !== latest.id))
      },
      latest.durationMs ??
        (latest.tone === 'error' ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS)
    )
    return () => window.clearTimeout(timeoutId)
  }, [toasts])

  return { toasts, pushToast }
}

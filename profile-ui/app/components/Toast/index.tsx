'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { ToastContextValue, ToastOptions, ToastRecord } from './types'

const DEFAULT_DURATION_MS = 3500
const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([])
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const dismissToast = useCallback((id: string) => {
    setItems(prev => prev.filter(item => item.id !== id))
    const existing = timersRef.current[id]
    if (existing) {
      clearTimeout(existing)
      delete timersRef.current[id]
    }
  }, [])

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      const trimmed = message.trim()
      if (!trimmed) return
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const tone = options?.tone || 'info'
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS
      setItems(prev => [...prev, { id, message: trimmed, tone }].slice(-4))
      timersRef.current[id] = setTimeout(() => {
        dismissToast(id)
      }, durationMs)
    },
    [dismissToast]
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      dismissToast,
      showToast,
    }),
    [dismissToast, showToast]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cu-toast-stack" aria-live="polite" aria-atomic="true">
        {items.map(item => (
          <div key={item.id} className={`cu-toast cu-toast--${item.tone}`} role="status">
            <span className="cu-toast__text">{item.message}</span>
            <button
              type="button"
              className="cu-toast__close"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(item.id)}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

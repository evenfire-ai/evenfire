import { useEffect, useRef, useState } from 'react'
import { BOOT_SPLASH_EXIT_MS, BOOT_SPLASH_MIN_DISPLAY_MS } from '@constants/bootSplash'
import type { BootSplashProps } from './types'

/**
 * Full-screen startup overlay. The backdrop stays opaque while the splash
 * exits so partially hydrated workspace surfaces never show through.
 */
export function BootSplash({ loading }: BootSplashProps) {
  const [leaving, setLeaving] = useState(!loading)
  const [mounted, setMounted] = useState(loading)
  const mountedAtRef = useRef(Date.now())

  useEffect(() => {
    if (loading) {
      setLeaving(false)
      setMounted(true)
      mountedAtRef.current = Date.now()
      return
    }

    const elapsed = Date.now() - mountedAtRef.current
    const leaveDelay = Math.max(0, BOOT_SPLASH_MIN_DISPLAY_MS - elapsed)
    const leaveTimer = window.setTimeout(() => setLeaving(true), leaveDelay)
    const unmountTimer = window.setTimeout(
      () => setMounted(false),
      leaveDelay + BOOT_SPLASH_EXIT_MS
    )
    return () => {
      window.clearTimeout(leaveTimer)
      window.clearTimeout(unmountTimer)
    }
  }, [loading])

  if (!mounted) return null

  return (
    <div className={`boot-overlay${leaving ? ' boot-overlay--leaving' : ''}`}>
      <section className="boot-screen glass-card" role="status" aria-live="polite">
        <div className="boot-brand">
          <img className="boot-brand-mark" src="./logo.svg" alt="" aria-hidden="true" />
          <span className="boot-brand-copy">
            <span className="boot-brand-title">Evenfire</span>
            <span className="boot-brand-subtitle">Desktop App</span>
          </span>
        </div>
        <div className="boot-progress" aria-hidden="true" />
        <p className="boot-status muted">Loading session…</p>
      </section>
    </div>
  )
}

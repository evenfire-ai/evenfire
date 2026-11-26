'use client'

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Portal-based hover tooltip. The table viewport scrolls (overflow: auto),
// which clips absolutely-positioned ::after tooltips at its edges; rendering
// into document.body escapes that clipping, and fixed coordinates from the
// trigger's bounding rect need no scroll math. Shows immediately on hover —
// no reveal delay — and closes on scroll (capture catches inner scrollers)
// so it never sits stale over moved content.
export function HoverTooltip({
  label,
  tooltip,
  className,
}: {
  label: string
  tooltip: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipId = React.useId()

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    // Center under the trigger, clamped so the card stays inside the window.
    const halfCard = 150
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, halfCard + 8),
      window.innerWidth - halfCard - 8
    )
    setPos({ top: rect.bottom + 6, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {label}
      </span>
      {open && pos
        ? createPortal(
            <div
              role="tooltip"
              id={tooltipId}
              className="cu-hover-tooltip-card"
              style={{ top: pos.top, left: pos.left }}
            >
              {tooltip}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

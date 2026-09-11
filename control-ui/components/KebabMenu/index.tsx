'use client'

import React, { useEffect, useRef, useState } from 'react'
import type { KebabMenuProps } from './types'

// The overflow menu that sits next to a detail-page title, holding the actions
// that are not the page's primary call to action (edit, retry, uninstall).
// Shared so every detail page spells that affordance the same way.
export function KebabMenu({ items, ariaLabel }: KebabMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function handleDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])
  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--ghost cu-btn--sm cu-kebab__trigger"
        onClick={() => setOpen(v => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div role="menu" className="cu-kebab__menu">
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`cu-kebab__item${item.danger ? ' cu-kebab__item--danger' : ''}`}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

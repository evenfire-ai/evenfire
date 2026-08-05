'use client'

import { useEffect, useRef, useState } from 'react'
import { IconDotsVertical } from '@components/icons'

export type RowAction = {
  key: string
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

export function RowActionsMenu({
  ariaLabel,
  actions,
}: {
  ariaLabel: string
  actions: RowAction[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  if (actions.length === 0) return null

  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        onClick={event => {
          event.stopPropagation()
          setOpen(value => !value)
        }}
      >
        <IconDotsVertical width={16} height={16} />
      </button>
      {open ? (
        <div className="cu-kebab__menu" role="menu">
          {actions.map(action => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={`cu-kebab__item${action.danger ? ' cu-kebab__item--danger' : ''}`}
              disabled={action.disabled}
              onClick={event => {
                event.stopPropagation()
                setOpen(false)
                action.onClick()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

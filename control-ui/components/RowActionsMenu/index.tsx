'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function handleDown(event: MouseEvent) {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
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

  useLayoutEffect(() => {
    if (!open) return

    function positionMenu() {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return

      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const edgeInset = 8
      const left = Math.min(
        Math.max(edgeInset, triggerRect.right - menuRect.width),
        window.innerWidth - menuRect.width - edgeInset
      )
      const opensAbove =
        triggerRect.bottom + edgeInset + menuRect.height > window.innerHeight - edgeInset &&
        triggerRect.top - edgeInset - menuRect.height >= edgeInset

      setMenuPosition({
        top: opensAbove
          ? triggerRect.top - menuRect.height - edgeInset
          : triggerRect.bottom + edgeInset,
        left,
      })
    }

    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
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
        ref={triggerRef}
        onClick={event => {
          event.stopPropagation()
          setOpen(value => !value)
        }}
      >
        <IconDotsVertical width={16} height={16} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="cu-kebab__menu cu-kebab__menu--portal"
              role="menu"
              style={
                menuPosition
                  ? { top: menuPosition.top, left: menuPosition.left }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
            >
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
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

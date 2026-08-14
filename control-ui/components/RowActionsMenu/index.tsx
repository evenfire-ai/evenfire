'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDotsVertical, IconMoreHorizontal } from '@components/icons'
import type { RowActionsMenuProps } from './types'

export type { RowAction } from './types'

function getEnabledMenuItems(menu: HTMLDivElement | null): HTMLButtonElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
}

export function RowActionsMenu({
  ariaLabel,
  actions,
  horizontalTrigger = false,
}: RowActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<'first' | 'last'>('first')
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)

  const closeMenu = useCallback((restoreTriggerFocus = false) => {
    setOpen(false)
    if (restoreTriggerFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    function handleDown(event: MouseEvent) {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
      }
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [closeMenu, open])

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
    const items = getEnabledMenuItems(menuRef.current)
    const initialItem = initialFocusRef.current === 'last' ? items.at(-1) : items[0]
    initialItem?.focus()
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
          initialFocusRef.current = 'first'
          setOpen(value => !value)
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          event.stopPropagation()
          initialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
          setOpen(true)
        }}
      >
        {horizontalTrigger ? (
          <IconMoreHorizontal width={16} height={16} />
        ) : (
          <IconDotsVertical width={16} height={16} />
        )}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="cu-kebab__menu cu-kebab__menu--portal"
              role="menu"
              onKeyDown={event => {
                const items = getEnabledMenuItems(menuRef.current)
                if (items.length === 0) return
                const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  closeMenu(true)
                  return
                }
                let nextIndex: number | null = null
                if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length
                if (event.key === 'ArrowUp') {
                  nextIndex = (currentIndex - 1 + items.length) % items.length
                }
                if (event.key === 'Home') nextIndex = 0
                if (event.key === 'End') nextIndex = items.length - 1
                if (nextIndex === null) return
                event.preventDefault()
                items[nextIndex]?.focus()
              }}
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
                    closeMenu(true)
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

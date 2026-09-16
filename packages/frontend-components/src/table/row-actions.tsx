'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RowAction } from './types'
import { classNames } from './utils'

function focusableItems(menu: HTMLDivElement | null) {
  return menu
    ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    : []
}

export function RowActionMenu({
  actions,
  ariaLabel,
  className,
  menuClassName,
  triggerVariant = 'vertical',
}: {
  actions: RowAction[]
  ariaLabel: string
  className?: string
  menuClassName?: string
  triggerVariant?: 'horizontal' | 'vertical'
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<'first' | 'last'>('first')
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const hasDisabledReason = actions.some(action => action.disabled && action.disabledReason)
  const triggerDisabled = actions.every(action => action.disabled) && !hasDisabledReason

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (triggerDisabled && open) close()
  }, [close, open, triggerDisabled])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [close, open])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const anchor = trigger.getBoundingClientRect()
      const bounds = menu.getBoundingClientRect()
      const inset = 8
      const left = Math.max(
        inset,
        Math.min(anchor.right - bounds.width, innerWidth - bounds.width - inset)
      )
      const above =
        anchor.bottom + bounds.height + inset > innerHeight && anchor.top > bounds.height
      setPosition({ left, top: above ? anchor.top - bounds.height - inset : anchor.bottom + inset })
    }
    place()
    const items = focusableItems(menuRef.current)
    ;(initialFocusRef.current === 'last' ? items.at(-1) : items[0])?.focus()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  if (actions.length === 0) return null
  return (
    <span className={classNames('eft-row-actions', className)}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className={classNames(
          'eft-row-actions__trigger',
          triggerVariant === 'horizontal' && 'eft-row-actions__trigger--horizontal'
        )}
        disabled={triggerDisabled}
        onClick={event => {
          event.stopPropagation()
          initialFocusRef.current = 'first'
          setOpen(value => !value)
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          initialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
          setOpen(true)
        }}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true">{triggerVariant === 'horizontal' ? '⋯' : '⋮'}</span>
      </button>
      {open
        ? createPortal(
            <div
              className={classNames('eft-row-actions__menu', menuClassName)}
              onClick={event => event.stopPropagation()}
              onKeyDown={event => {
                const items = focusableItems(menuRef.current)
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                if (event.key === 'Escape') {
                  event.preventDefault()
                  close(true)
                  return
                }
                const next =
                  event.key === 'ArrowDown'
                    ? (current + 1) % items.length
                    : event.key === 'ArrowUp'
                      ? (current - 1 + items.length) % items.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : null
                if (next == null || items.length === 0) return
                event.preventDefault()
                items[next]?.focus()
              }}
              ref={menuRef}
              role="menu"
              style={position ? position : { left: 0, top: 0, visibility: 'hidden' }}
            >
              {actions.map(action => {
                const disabledReason = action.disabled ? action.disabledReason : undefined
                const disabledWithReason = Boolean(disabledReason)
                return (
                  <button
                    aria-disabled={action.disabled ? true : undefined}
                    className={classNames(
                      'eft-row-actions__item',
                      action.danger && 'eft-row-actions__item--danger'
                    )}
                    disabled={action.disabled && !disabledWithReason}
                    key={action.key}
                    onClick={() => {
                      if (action.disabled) return
                      close(true)
                      action.onSelect()
                    }}
                    role="menuitem"
                    title={typeof disabledReason === 'string' ? disabledReason : undefined}
                    type="button"
                  >
                    <span>{action.label}</span>
                    {disabledReason ? (
                      <span className="eft-row-actions__item-reason">{disabledReason}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

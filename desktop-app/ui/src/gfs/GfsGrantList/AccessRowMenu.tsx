import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, MenuItem } from '@components/Common'
import { IconMoreVertical } from '@components/SidebarNav/icons'

type AccessRowMenuProps = {
  disabled?: boolean
  label: string
  onRemove: () => void | Promise<void>
}

export function AccessRowMenu({ disabled = false, label, onRemove }: AccessRowMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

  useEffect(() => {
    if (disabled && open) close()
  }, [close, disabled, open])

  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const inset = 8
    const gap = 6
    const menuWidth = menuRect.width || 184
    const menuHeight = menuRect.height || 52
    const left = Math.max(
      inset,
      Math.min(triggerRect.right - menuWidth, window.innerWidth - menuWidth - inset)
    )
    const opensAbove =
      triggerRect.bottom + gap + menuHeight > window.innerHeight - inset &&
      triggerRect.top > menuHeight
    const top = opensAbove
      ? Math.max(inset, triggerRect.top - menuHeight - gap)
      : Math.min(triggerRect.bottom + gap, window.innerHeight - menuHeight - inset)
    setPosition({ left, top: Math.max(inset, top) })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    placeMenu()
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
    }
  }, [open, placeMenu])

  return (
    <span className="da-gfs-access-row-menu">
      <IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        className="da-gfs-resource-menu__trigger"
        disabled={disabled}
        label={`Actions for ${label}`}
        onClick={() => setOpen(value => !value)}
        ref={triggerRef}
        size="sm"
        variant="ghost"
      >
        <IconMoreVertical />
      </IconButton>
      {open
        ? createPortal(
            <div
              aria-label={`Actions for ${label}`}
              className="da-gfs-resource-menu__panel da-gfs-access-row-menu__panel"
              ref={menuRef}
              role="menu"
              style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
            >
              <MenuItem
                color="danger"
                onClick={() => {
                  close(true)
                  void onRemove()
                }}
                role="menuitem"
              >
                Remove access
              </MenuItem>
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

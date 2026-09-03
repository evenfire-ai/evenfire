import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconButton, MenuItem } from '@components/Common'
import { IconMoreHorizontal } from '@components/SidebarNav/icons'
import { useClickOutside } from '@hooks/useClickOutside'
import type { GfsResourceMenuProps } from './types'

export function GfsResourceMenu({
  resourceName,
  onManage,
  onCopyLink,
  onCreateFolder,
  onDelete,
  onOpen,
  onOpenChange,
  onPreview,
  onDownload,
  onRename,
  onMove,
}: GfsResourceMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeMenu = useCallback(() => setOpen(false), [])
  const onOpenChangeRef = useRef(onOpenChange)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    if (prevOpenRef.current === open) return
    prevOpenRef.current = open
    onOpenChangeRef.current?.(open)
  }, [open])

  useEffect(
    () => () => {
      if (prevOpenRef.current) onOpenChangeRef.current?.(false)
    },
    []
  )

  useClickOutside(menuRef, open, closeMenu)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, open])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    )
    if (!items.length) return
    event.preventDefault()
    const activeIndex = items.findIndex(item => item === document.activeElement)
    let nextIndex = activeIndex < 0 ? 0 : activeIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = items.length - 1
    if (event.key === 'ArrowDown') nextIndex = (nextIndex + 1) % items.length
    if (event.key === 'ArrowUp') nextIndex = (nextIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  const runAction = (action: () => void) => {
    closeMenu()
    action()
  }

  return (
    <span
      className={`da-gfs-resource-menu${open ? ' is-open' : ''}`}
      ref={menuRef}
      onKeyDown={handleMenuKeyDown}
    >
      <IconButton
        className="da-gfs-resource-menu__trigger"
        label={`Options for ${resourceName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => {
          event.stopPropagation()
          setOpen(value => !value)
        }}
        ref={triggerRef}
        size="sm"
        variant="ghost"
      >
        <IconMoreHorizontal />
      </IconButton>
      {open ? (
        <span className="da-gfs-resource-menu__panel" role="menu">
          {onManage ? (
            <MenuItem role="menuitem" onClick={() => runAction(onManage)}>
              Manage
            </MenuItem>
          ) : null}
          {onOpen ? (
            <MenuItem role="menuitem" onClick={() => runAction(onOpen)}>
              Open folder
            </MenuItem>
          ) : null}
          {onPreview ? (
            <MenuItem role="menuitem" onClick={() => runAction(onPreview)}>
              Preview
            </MenuItem>
          ) : null}
          {onCreateFolder ? (
            <MenuItem role="menuitem" onClick={() => runAction(onCreateFolder)}>
              New folder
            </MenuItem>
          ) : null}
          {onRename ? (
            <MenuItem role="menuitem" onClick={() => runAction(onRename)}>
              Rename
            </MenuItem>
          ) : null}
          {onMove ? (
            <MenuItem role="menuitem" onClick={() => runAction(onMove)}>
              Move to…
            </MenuItem>
          ) : null}
          {onDownload ? (
            <MenuItem role="menuitem" onClick={() => runAction(onDownload)}>
              Download
            </MenuItem>
          ) : null}
          <MenuItem role="menuitem" onClick={() => runAction(onCopyLink)}>
            Copy GFS link
          </MenuItem>
          {onDelete ? (
            <MenuItem color="danger" role="menuitem" onClick={() => runAction(onDelete)}>
              Delete
            </MenuItem>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

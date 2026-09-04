import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, MenuItem } from '@components/Common'
import {
  IconConnectors,
  IconContexts,
  IconCopy,
  IconDownload,
  IconEdit,
  IconEye,
  IconMoreVertical,
  IconPlus,
  IconTeams,
  IconTrash,
} from '@components/SidebarNav/icons'
import type { GfsResourceMenuProps } from './types'

type GfsResourceMenuAction = {
  color?: 'neutral' | 'danger'
  icon: ReactNode
  key: string
  label: string
  onClick: () => void
}

function menuAction(
  key: string,
  label: string,
  icon: ReactNode,
  onClick: (() => void) | undefined,
  color?: GfsResourceMenuAction['color']
): GfsResourceMenuAction | null {
  return onClick ? { color, icon, key, label, onClick } : null
}

function isMenuAction(action: GfsResourceMenuAction | null): action is GfsResourceMenuAction {
  return action !== null
}

export function GfsResourceMenu({
  resourceName,
  onManage,
  onCopyLink,
  onCreateFolder,
  onDelete,
  onOpen,
  onOpenGfsLink,
  onOpenChange,
  onPreview,
  onDownload,
  onRename,
  onMove,
}: GfsResourceMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null)
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

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || panelRef.current?.contains(target)) return
      closeMenu()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [closeMenu, open])

  const positionPanel = useCallback(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return

    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const left = Math.min(
      Math.max(edgeInset, triggerRect.right - panelRect.width),
      Math.max(edgeInset, viewportWidth - panelRect.width - edgeInset)
    )
    const opensAbove =
      triggerRect.bottom + gap + panelRect.height > viewportHeight - edgeInset &&
      triggerRect.top - gap - panelRect.height >= edgeInset
    const unclampedTop = opensAbove
      ? triggerRect.top - panelRect.height - gap
      : triggerRect.bottom + gap
    const top = Math.min(
      Math.max(edgeInset, unclampedTop),
      Math.max(edgeInset, viewportHeight - panelRect.height - edgeInset)
    )

    setPanelPosition({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPanelPosition(null)
      return
    }

    positionPanel()
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
    return () => {
      window.removeEventListener('resize', positionPanel)
      window.removeEventListener('scroll', positionPanel, true)
    }
  }, [open, positionPanel])

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, open])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
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

  const actionGroups = [
    [
      menuAction('manage', 'Share', <IconTeams />, onManage),
      menuAction('open-folder', 'Open folder', <IconContexts />, onOpen),
      menuAction('open-gfs-link', 'Open GFS link', <IconConnectors />, onOpenGfsLink),
      menuAction('preview', 'Preview', <IconEye />, onPreview),
    ].filter(isMenuAction),
    [
      menuAction('new-folder', 'New folder', <IconPlus />, onCreateFolder),
      menuAction('rename', 'Rename', <IconEdit />, onRename),
      menuAction('move', 'Move to…', <IconContexts />, onMove),
    ].filter(isMenuAction),
    [
      menuAction('download', 'Download', <IconDownload />, onDownload),
      menuAction('copy-link', 'Copy GFS link', <IconCopy />, onCopyLink),
    ].filter(isMenuAction),
    [menuAction('delete', 'Delete', <IconTrash />, onDelete, 'danger')].filter(isMenuAction),
  ].filter(group => group.length > 0)

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
        <IconMoreVertical />
      </IconButton>
      {open
        ? createPortal(
            <div
              className="da-gfs-resource-menu__panel"
              ref={panelRef}
              role="menu"
              style={
                panelPosition
                  ? { left: panelPosition.left, top: panelPosition.top }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
              onKeyDown={handleMenuKeyDown}
            >
              {actionGroups.map((group, groupIndex) => (
                <Fragment key={`group-${groupIndex}`}>
                  {groupIndex > 0 ? (
                    <div className="da-gfs-resource-menu__separator" role="separator" />
                  ) : null}
                  {group.map(action => (
                    <MenuItem
                      color={action.color}
                      key={action.key}
                      leadingIcon={action.icon}
                      role="menuitem"
                      onClick={() => runAction(action.onClick)}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
                </Fragment>
              ))}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

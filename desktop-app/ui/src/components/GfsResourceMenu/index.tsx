import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, MenuItem } from '@components/Common'
import {
  IconChevronRight,
  IconContexts,
  IconCopy,
  IconDownload,
  IconEdit,
  IconEye,
  IconMoreVertical,
  IconPlus,
  IconShare,
  IconTrash,
  IconUpload,
} from '@components/SidebarNav/icons'
import type { GfsResourceMenuProps } from './types'

type GfsResourceMenuAction = {
  color?: 'neutral' | 'danger'
  icon: ReactNode
  key: string
  label: string
  onClick: () => void
  submenu?: boolean
  disabled?: boolean
}

function menuAction(
  key: string,
  label: string,
  icon: ReactNode,
  onClick: (() => void) | undefined,
  options: Pick<GfsResourceMenuAction, 'color' | 'submenu' | 'disabled'> = {}
): GfsResourceMenuAction | null {
  return onClick ? { ...options, icon, key, label, onClick } : null
}

function isMenuAction(action: GfsResourceMenuAction | null): action is GfsResourceMenuAction {
  return action !== null
}

function horizontalBounds(anchor: HTMLElement, edgeInset: number) {
  const viewportLeft = edgeInset
  const viewportRight = window.innerWidth - edgeInset
  const drive = anchor.closest<HTMLElement>('.da-gfs-drive')
  const driveRect = drive?.getBoundingClientRect()

  // Breadcrumb menus live beside a persistent sidebar. Keep their portal
  // inside the Files surface instead of allowing right-edge alignment to push
  // the panel underneath that sidebar. Isolated consumers and zero-layout test
  // environments fall back to the viewport.
  if (!driveRect || driveRect.width <= 0) {
    return { left: viewportLeft, right: viewportRight }
  }

  return {
    left: Math.max(viewportLeft, driveRect.left),
    right: Math.min(viewportRight, driveRect.right),
  }
}

export function GfsResourceMenu({
  resourceName,
  actions,
  onManage,
  onCopyLink,
  onCreateFolder,
  onDelete,
  onOpen,
  onOpenChange,
  onPreview,
  onDownload,
  onDownloadZip,
  onRename,
  onMove,
  onReplace,
}: GfsResourceMenuProps) {
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null)
  const closeMenu = useCallback(() => {
    setOpen(false)
    setShareOpen(false)
  }, [])
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
      if (
        menuRef.current?.contains(target) ||
        panelRef.current?.contains(target) ||
        submenuRef.current?.contains(target)
      )
        return
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
    const viewportHeight = window.innerHeight
    const bounds = horizontalBounds(trigger, edgeInset)
    const maxLeft = Math.max(bounds.left, bounds.right - panelRect.width)
    const left = Math.min(Math.max(bounds.left, triggerRect.right - panelRect.width), maxLeft)
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
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionPanel)
    const trigger = triggerRef.current
    const drive = trigger?.closest<HTMLElement>('.da-gfs-drive')
    if (trigger) resizeObserver?.observe(trigger)
    if (drive) resizeObserver?.observe(drive)
    if (panelRef.current) resizeObserver?.observe(panelRef.current)
    return () => {
      window.removeEventListener('resize', positionPanel)
      window.removeEventListener('scroll', positionPanel, true)
      resizeObserver?.disconnect()
    }
  }, [open, positionPanel])

  const positionSubmenu = useCallback(() => {
    const trigger = shareTriggerRef.current
    const submenu = submenuRef.current
    if (!trigger || !submenu) return

    const triggerRect = trigger.getBoundingClientRect()
    const submenuRect = submenu.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    const viewportHeight = window.innerHeight
    const bounds = horizontalBounds(triggerRef.current ?? trigger, edgeInset)
    const opensLeft = triggerRect.right + gap + submenuRect.width > bounds.right
    const preferredLeft = opensLeft
      ? triggerRect.left - submenuRect.width - gap
      : triggerRect.right + gap
    const maxLeft = Math.max(bounds.left, bounds.right - submenuRect.width)
    const left = Math.min(Math.max(bounds.left, preferredLeft), maxLeft)
    const maxTop = Math.max(edgeInset, viewportHeight - submenuRect.height - edgeInset)
    const top = Math.min(Math.max(edgeInset, triggerRect.top), maxTop)

    setSubmenuPosition({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (!shareOpen) {
      setSubmenuPosition(null)
      return
    }

    positionSubmenu()
    window.addEventListener('resize', positionSubmenu)
    window.addEventListener('scroll', positionSubmenu, true)
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionSubmenu)
    const trigger = triggerRef.current
    const drive = trigger?.closest<HTMLElement>('.da-gfs-drive')
    if (trigger) resizeObserver?.observe(trigger)
    if (drive) resizeObserver?.observe(drive)
    if (panelRef.current) resizeObserver?.observe(panelRef.current)
    if (shareTriggerRef.current) resizeObserver?.observe(shareTriggerRef.current)
    if (submenuRef.current) resizeObserver?.observe(submenuRef.current)
    return () => {
      window.removeEventListener('resize', positionSubmenu)
      window.removeEventListener('scroll', positionSubmenu, true)
      resizeObserver?.disconnect()
    }
  }, [panelPosition, positionSubmenu, shareOpen])

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (shareOpen) {
          event.preventDefault()
          setShareOpen(false)
          shareTriggerRef.current?.focus()
        } else {
          closeMenu()
          triggerRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, open, shareOpen])

  useEffect(() => {
    if (!shareOpen) return
    submenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
  }, [shareOpen])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open) return
    if (event.key === 'ArrowRight' && event.target === shareTriggerRef.current) {
      event.preventDefault()
      setShareOpen(true)
      return
    }
    if (
      event.key === 'ArrowLeft' &&
      shareOpen &&
      submenuRef.current?.contains(document.activeElement)
    ) {
      event.preventDefault()
      setShareOpen(false)
      shareTriggerRef.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
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

  const fallbackShareChildren = [
    menuAction('share-access', 'Share', <IconShare />, onManage),
    menuAction('copy-link', 'Copy link', <IconCopy />, onCopyLink),
  ].filter(isMenuAction)
  const fallbackShareGroup = fallbackShareChildren.length
    ? [
        menuAction('share', 'Share', <IconShare />, () => setShareOpen(true), {
          submenu: true,
        }),
      ].filter(isMenuAction)
    : []
  const fallbackActionGroups = [
    [
      ...fallbackShareGroup,
      menuAction('open-folder', 'Open folder', <IconContexts />, onOpen),
      menuAction('preview', 'Preview', <IconEye />, onPreview),
    ].filter(isMenuAction),
    [
      menuAction('new-folder', 'New folder', <IconPlus />, onCreateFolder),
      menuAction('rename', 'Rename', <IconEdit />, onRename),
      menuAction('move', 'Move to…', <IconContexts />, onMove),
    ].filter(isMenuAction),
    [
      menuAction('download', 'Download', <IconDownload />, onDownload),
      menuAction('download-zip', 'Download as zip', <IconDownload />, onDownloadZip),
      menuAction(
        'replace',
        'Replace file',
        <IconUpload />,
        onReplace ? () => replaceInputRef.current?.click() : undefined
      ),
    ].filter(isMenuAction),
    [menuAction('delete', 'Delete', <IconTrash />, onDelete, { color: 'danger' })].filter(
      isMenuAction
    ),
  ].filter(group => group.length > 0)
  const menuActions = actions?.filter(action => action.menu)
  const sharedActions: GfsResourceMenuAction[] | undefined = menuActions?.map(action => ({
    color: action.id === 'delete' ? 'danger' : undefined,
    disabled: action.disabled,
    icon: action.icon,
    key: action.id,
    label: action.label,
    onClick:
      action.id === 'replace'
        ? () =>
            action.run(undefined, {
              requestFileSelection: () => replaceInputRef.current?.click(),
            })
        : () => action.run(),
  }))
  const shareMenuChildren =
    actions !== undefined
      ? (sharedActions ?? [])
          .filter(action => ['share', 'copy-link', 'copy-route'].includes(action.key))
          .map(action =>
            action.key === 'share' ? { ...action, key: 'share-access', label: 'Share' } : action
          )
      : fallbackShareChildren
  const hasShareSubmenu = shareMenuChildren.length > 0
  const shareGroup = hasShareSubmenu
    ? [
        menuAction('share', 'Share', <IconShare />, () => setShareOpen(value => !value), {
          submenu: true,
        }),
      ].filter(isMenuAction)
    : []
  const visibleSharedActions = sharedActions?.filter(
    action => !['share', 'copy-link', 'copy-route', 'delete'].includes(action.key)
  )
  const actionGroups =
    actions !== undefined
      ? [
          ...(shareGroup.length ? [shareGroup] : []),
          ...(visibleSharedActions?.length ? [visibleSharedActions] : []),
          ...(sharedActions?.some(action => action.key === 'delete')
            ? [sharedActions.filter(action => action.key === 'delete')]
            : []),
        ].filter(group => group.length > 0)
      : fallbackActionGroups

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
          if (open) {
            closeMenu()
          } else {
            setOpen(true)
          }
        }}
        ref={triggerRef}
        size="sm"
        variant="ghost"
      >
        <IconMoreVertical />
      </IconButton>
      {open
        ? createPortal(
            <Fragment>
              <div
                className="da-gfs-resource-menu__panel"
                ref={panelRef}
                role="menu"
                aria-label={`Actions for ${resourceName}`}
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
                        aria-expanded={action.submenu ? shareOpen : undefined}
                        aria-haspopup={action.submenu ? 'menu' : undefined}
                        color={action.color}
                        data-gfs-action={action.key}
                        disabled={action.disabled}
                        key={action.key}
                        leadingIcon={action.icon}
                        role="menuitem"
                        ref={action.submenu ? shareTriggerRef : undefined}
                        trailingIcon={action.submenu ? <IconChevronRight /> : undefined}
                        onMouseEnter={action.submenu ? () => setShareOpen(true) : undefined}
                        onClick={() => {
                          if (action.disabled) return
                          if (action.submenu) {
                            action.onClick()
                          } else {
                            runAction(action.onClick)
                          }
                        }}
                      >
                        {action.label}
                      </MenuItem>
                    ))}
                  </Fragment>
                ))}
              </div>
              {shareOpen && hasShareSubmenu ? (
                <div
                  aria-label={`Share options for ${resourceName}`}
                  className="da-gfs-resource-menu__submenu"
                  ref={submenuRef}
                  role="menu"
                  style={
                    submenuPosition
                      ? { left: submenuPosition.left, top: submenuPosition.top }
                      : { left: 0, top: 0, visibility: 'hidden' }
                  }
                  onKeyDown={handleMenuKeyDown}
                >
                  {shareMenuChildren.map(action => (
                    <MenuItem
                      data-gfs-action={action.key}
                      disabled={action.disabled}
                      key={action.key}
                      leadingIcon={action.icon}
                      role="menuitem"
                      onClick={() => runAction(action.onClick)}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
                </div>
              ) : null}
            </Fragment>,
            document.body
          )
        : null}
      {menuActions?.some(action => action.id === 'replace') ||
      (actions === undefined && onReplace) ? (
        <input
          aria-label={`Replace ${resourceName}`}
          className="visually-hidden"
          ref={replaceInputRef}
          type="file"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!file) return
            closeMenu()
            const replaceAction = menuActions?.find(action => action.id === 'replace')
            if (replaceAction) replaceAction.run(file)
            else onReplace?.(file)
          }}
        />
      ) : null}
    </span>
  )
}

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
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
import { withPermissionGate } from '@lib/gfsResourceMenuPermissionGate'
import type { GfsResourceMenuActionKey, GfsResourceMenuProps } from './types'

type GfsResourceMenuAction = {
  color?: 'neutral' | 'danger'
  icon: ReactNode
  key: GfsResourceMenuActionKey
  label: string
  onClick: () => void
  submenu?: boolean
  disabled?: boolean
  disabledReason?: string
}

function menuAction(
  key: GfsResourceMenuActionKey,
  label: string,
  icon: ReactNode,
  onClick: (() => void) | undefined,
  options: Pick<GfsResourceMenuAction, 'color' | 'submenu' | 'disabled'> = {}
): GfsResourceMenuAction | null {
  return onClick ? { ...options, icon, key, label, onClick } : null
}

/**
 * An item disabled for a reason stays focusable and announces that reason, so
 * it is `aria-disabled` and the click guard keeps it inert. One disabled only
 * while a change is in flight has nothing to explain and stays natively
 * disabled.
 */
function disabledItemProps(action: GfsResourceMenuAction) {
  if (!action.disabled) return { disabled: false }
  if (action.disabledReason) return { 'aria-disabled': true, title: action.disabledReason }
  return { disabled: true }
}

function isMenuAction(action: GfsResourceMenuAction | null): action is GfsResourceMenuAction {
  return action !== null
}

// Actions that finish without opening a dialog or picker: they navigate,
// save a file or write the clipboard.
const ACTIONS_WITHOUT_SURFACE: ReadonlySet<GfsResourceMenuActionKey> = new Set([
  'preview',
  'download',
  'download-zip',
  'copy-link',
  'open-folder',
])

const EDGE_INSET = 8
const GAP = 6

type AnchorRect = Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>
type HorizontalBounds = { left: number; right: number }

function horizontalBounds(anchor: HTMLElement | null, edgeInset: number): HorizontalBounds {
  const viewportLeft = edgeInset
  const viewportRight = window.innerWidth - edgeInset
  const drive = anchor?.closest<HTMLElement>('.da-gfs-drive')
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

function pointRect(point: { x: number; y: number }): AnchorRect {
  return { bottom: point.y, left: point.x, right: point.x, top: point.y }
}

/** Right edge of the panel aligned with the anchor's right edge. */
function endAlignedLeft(anchorRect: AnchorRect, width: number, bounds: HorizontalBounds) {
  const maxLeft = Math.max(bounds.left, bounds.right - width)
  return Math.min(Math.max(bounds.left, anchorRect.right - width), maxLeft)
}

/** Beside the anchor, flipping to its left side when the right side overflows. */
function besideLeft(anchorRect: AnchorRect, width: number, bounds: HorizontalBounds) {
  const opensLeft = anchorRect.right + GAP + width > bounds.right
  const preferredLeft = opensLeft ? anchorRect.left - width - GAP : anchorRect.right + GAP
  const maxLeft = Math.max(bounds.left, bounds.right - width)
  return Math.min(Math.max(bounds.left, preferredLeft), maxLeft)
}

/** Below the anchor, flipping above it when the bottom overflows. */
function belowOrAboveTop(anchorRect: AnchorRect, height: number, viewportHeight: number) {
  const opensAbove =
    anchorRect.bottom + GAP + height > viewportHeight - EDGE_INSET &&
    anchorRect.top - GAP - height >= EDGE_INSET
  const unclampedTop = opensAbove ? anchorRect.top - height - GAP : anchorRect.bottom + GAP
  return Math.min(
    Math.max(EDGE_INSET, unclampedTop),
    Math.max(EDGE_INSET, viewportHeight - height - EDGE_INSET)
  )
}

export function GfsResourceMenu({
  resourceName,
  actions,
  anchor,
  permissionStatus: requestedPermissionStatus,
  onDismiss,
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
  const anchorMode = anchor !== undefined
  const anchorX = anchor?.x
  const anchorY = anchor?.y
  // A context menu that is not told its bits are settled treats them as
  // unresolved, so a caller that forgets the status cannot offer actions the
  // target may not allow.
  const permissionStatus = requestedPermissionStatus ?? (anchorMode ? 'pending' : undefined)
  const [open, setOpen] = useState(anchorMode)
  const [shareOpen, setShareOpen] = useState(false)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  // Whether a pointer move over Share may open its submenu. It starts disarmed
  // on every menu open, after every explicit close of the submenu and whenever
  // Share is activated (click, Enter or Space), and only a pointermove that
  // lands outside Share re-arms it. Without it, a pointer resting on Share
  // (where the panel appeared, or after Escape closed the submenu) would
  // reopen the submenu on the first 1px tremor and steal focus from a
  // keyboard user. Boundary events (pointerover/enter, pointerleave)
  // cannot stand in for that move: Chromium fires them on layout changes and
  // scrolls while the pointer is still.
  const shareHoverArmedRef = useRef(false)
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null)
  const panelPositioned = panelPosition !== null
  const submenuPositioned = submenuPosition !== null
  const closeMenu = useCallback(() => {
    setOpen(false)
    setShareOpen(false)
  }, [])
  const onOpenChangeRef = useRef(onOpenChange)
  const onDismissRef = useRef(onDismiss)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
    onDismissRef.current = onDismiss
  }, [onDismiss, onOpenChange])

  // `onOpenChange` only reports state, and StrictMode replays it as
  // open → closed → open on mount. An owner that unmounted on that transient
  // `false` would drop the menu as it appears, so unmounting follows this
  // user-driven dismissal instead.
  const dismissMenu = useCallback(() => {
    closeMenu()
    onDismissRef.current?.()
  }, [closeMenu])

  useEffect(() => {
    if (prevOpenRef.current === open) return
    prevOpenRef.current = open
    onOpenChangeRef.current?.(open)
  }, [open])

  useEffect(
    () => () => {
      if (!prevOpenRef.current) return
      // Reset so a StrictMode effect replay of a menu that mounts open
      // re-reports `true` instead of leaving the owner stuck on `false`.
      prevOpenRef.current = false
      onOpenChangeRef.current?.(false)
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
      dismissMenu()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [dismissMenu, open])

  const positionPanel = useCallback(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    const hasPoint = anchorX !== undefined && anchorY !== undefined
    const anchorRect = hasPoint
      ? pointRect({ x: anchorX, y: anchorY })
      : trigger?.getBoundingClientRect()
    if (!panel || !anchorRect) return

    const panelRect = panel.getBoundingClientRect()
    const bounds = horizontalBounds(trigger, EDGE_INSET)
    // A trigger owns its panel's end edge; a pointer opens a context menu
    // beside the point, like the Share flyout beside its item.
    const left = hasPoint
      ? besideLeft(anchorRect, panelRect.width, bounds)
      : endAlignedLeft(anchorRect, panelRect.width, bounds)
    const top = belowOrAboveTop(anchorRect, panelRect.height, window.innerHeight)

    setPanelPosition({ left, top })
  }, [anchorX, anchorY])

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
    const viewportHeight = window.innerHeight
    const bounds = horizontalBounds(triggerRef.current ?? trigger, EDGE_INSET)
    const left = besideLeft(triggerRect, submenuRect.width, bounds)
    const maxTop = Math.max(EDGE_INSET, viewportHeight - submenuRect.height - EDGE_INSET)
    const top = Math.min(Math.max(EDGE_INSET, triggerRect.top), maxTop)

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
    if (!open || !anchorMode) return
    const focused = document.activeElement
    // A StrictMode replay runs after focus already moved into the menu; the
    // opener captured on the first run stays the return target.
    if (panelRef.current?.contains(focused) || submenuRef.current?.contains(focused)) return
    returnFocusRef.current = focused instanceof HTMLElement ? focused : null
  }, [anchorMode, open])

  /** One Escape closes one level: the Share flyout first, then the menu. */
  const dismissOneLevel = useCallback(
    (event: KeyboardEvent) => {
      if (shareOpen) {
        event.preventDefault()
        shareHoverArmedRef.current = false
        setShareOpen(false)
        shareTriggerRef.current?.focus()
        return
      }
      dismissMenu()
      ;(triggerRef.current ?? returnFocusRef.current)?.focus()
    },
    [dismissMenu, shareOpen]
  )

  // Entry focus waits for the positioned commit: the first commit paints the
  // panel with `visibility: hidden`, and Chromium refuses focus on a hidden
  // element, so focusing on `open` alone leaves focus on the opener. The deps
  // are booleans so a scroll or resize that repositions the panel does not
  // pull focus back to the first item.
  useEffect(() => {
    if (!open || !panelPositioned) return
    panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open, panelPositioned])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissOneLevel(event)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dismissOneLevel, open])

  // A context menu opens inside surfaces that also close on Escape (the
  // compact sidebar drawer listens on document). Capturing on document lets
  // the menu consume that Escape before any bubble listener, and only while
  // focus is in the menu, so a closed menu leaves Escape to the drawer. A
  // click on a disabled item or the panel padding drops focus to body; that
  // Escape still belongs to the open menu.
  useEffect(() => {
    if (!open || !anchorMode) return
    const handleEscapeCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const focused = document.activeElement
      const focusInMenu =
        panelRef.current?.contains(focused) ||
        submenuRef.current?.contains(focused) ||
        focused === document.body
      if (!focusInMenu) return
      event.preventDefault()
      event.stopPropagation()
      dismissOneLevel(event)
    }
    document.addEventListener('keydown', handleEscapeCapture, true)
    return () => document.removeEventListener('keydown', handleEscapeCapture, true)
  }, [anchorMode, dismissOneLevel, open])

  // Same constraint as the panel's entry focus: the submenu's first commit is
  // hidden until it is positioned.
  useEffect(() => {
    if (!shareOpen || !submenuPositioned) return
    submenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
  }, [shareOpen, submenuPositioned])

  useEffect(() => {
    if (!open) return
    const rearmShareHover = (event: Event) => {
      if (shareTriggerRef.current?.contains(event.target as Node | null)) return
      shareHoverArmedRef.current = true
    }
    document.addEventListener('pointermove', rearmShareHover)
    return () => document.removeEventListener('pointermove', rearmShareHover)
  }, [open])

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
      shareHoverArmedRef.current = false
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

  // Only real pointer movement opens Share: Chromium fires mouseenter and
  // pointerenter/over when the panel appears or scrolls under a still pointer.
  const openShareOnHover = () => {
    if (!shareOpen && shareHoverArmedRef.current) setShareOpen(true)
  }

  // With focus in the portal, a ContextMenu key or right-click would reach
  // Electron, which shows its native text menu over this one when the page
  // has a selection.
  const preventNativeContextMenu = (event: ReactMouseEvent) => event.preventDefault()

  const runAction = (action: GfsResourceMenuAction) => {
    dismissMenu()
    // An anchored menu unmounts with the item that had focus, which drops it
    // to <body>. For an action that opens nothing of its own, focus goes back
    // to the anchor. An action that opens a host surface leaves it where it
    // falls: that surface may not take focus (the Move dialog does not, and
    // the host checks permissions before any dialog mounts), and a focused
    // row under it would still answer Enter or Shift+F10.
    if (anchorMode && ACTIONS_WITHOUT_SURFACE.has(action.key)) returnFocusRef.current?.focus()
    action.onClick()
  }

  // The fallback Share child is keyed apart from its submenu parent.
  const gateFallback = (action: GfsResourceMenuAction) =>
    withPermissionGate(
      action,
      action.key === 'share-access' ? 'share' : action.key,
      permissionStatus
    )
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
  const gatedMenuActions = menuActions?.map(action =>
    withPermissionGate(action, action.id, permissionStatus)
  )
  const sharedActions: GfsResourceMenuAction[] | undefined = gatedMenuActions?.map(action => ({
    color: action.id === 'delete' ? 'danger' : undefined,
    disabled: action.disabled,
    disabledReason: action.disabledReason,
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
          .filter(action => ['share', 'copy-link'].includes(action.key))
          .map(
            (action): GfsResourceMenuAction =>
              action.key === 'share' ? { ...action, key: 'share-access', label: 'Share' } : action
          )
      : fallbackShareChildren.map(gateFallback)
  const hasShareSubmenu = shareMenuChildren.length > 0
  const shareGroup = hasShareSubmenu
    ? [
        menuAction('share', 'Share', <IconShare />, () => setShareOpen(value => !value), {
          submenu: true,
        }),
      ].filter(isMenuAction)
    : []
  const visibleSharedActions = sharedActions?.filter(
    action => !['share', 'copy-link', 'delete'].includes(action.key)
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
      : fallbackActionGroups.map(group => group.map(gateFallback))

  const gatedReplace = actionGroups.flat().find(action => action.key === 'replace')

  return (
    <span
      className={`da-gfs-resource-menu${open ? ' is-open' : ''}`}
      ref={menuRef}
      onKeyDown={handleMenuKeyDown}
    >
      {anchorMode ? null : (
        <IconButton
          className="da-gfs-resource-menu__trigger"
          label={`Options for ${resourceName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={event => {
            event.stopPropagation()
            if (open) {
              dismissMenu()
            } else {
              shareHoverArmedRef.current = false
              setOpen(true)
            }
          }}
          ref={triggerRef}
          size="sm"
          variant="ghost"
        >
          <IconMoreVertical />
        </IconButton>
      )}
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
                onContextMenu={preventNativeContextMenu}
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
                        {...disabledItemProps(action)}
                        key={action.key}
                        leadingIcon={action.icon}
                        role="menuitem"
                        ref={action.submenu ? shareTriggerRef : undefined}
                        trailingIcon={action.submenu ? <IconChevronRight /> : undefined}
                        onPointerMove={action.submenu ? openShareOnHover : undefined}
                        onClick={() => {
                          if (action.disabled) return
                          if (action.submenu) {
                            shareHoverArmedRef.current = false
                            action.onClick()
                          } else {
                            runAction(action)
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
                  onContextMenu={preventNativeContextMenu}
                >
                  {shareMenuChildren.map(action => (
                    <MenuItem
                      data-gfs-action={action.key}
                      {...disabledItemProps(action)}
                      key={action.key}
                      leadingIcon={action.icon}
                      role="menuitem"
                      onClick={() => {
                        if (action.disabled) return
                        runAction(action)
                      }}
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
          // Only the Replace item opens the picker, so the hidden input stays
          // out of the tab order and refuses a file while that item is inert.
          // It is also disabled then, so assistive tech is not offered a live
          // upload control on a file that cannot be replaced.
          disabled={gatedReplace?.disabled}
          tabIndex={-1}
          type="file"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!file || !gatedReplace || gatedReplace.disabled) return
            closeMenu()
            const replaceAction = gatedMenuActions?.find(action => action.id === 'replace')
            if (replaceAction) replaceAction.run(file)
            else onReplace?.(file)
          }}
        />
      ) : null}
    </span>
  )
}

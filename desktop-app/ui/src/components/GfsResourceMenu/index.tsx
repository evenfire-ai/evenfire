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

// These selections open a dialog or chooser that takes focus. Navigation and
// downloads do not focus another DOM surface, so keyboard actions can return
// focus to the persistent menu trigger.
const ACTIONS_WITH_FOCUS_DESTINATION = new Set([
  'delete',
  'move',
  'new-folder',
  'open-route',
  'replace',
  'rename',
  'share',
  'upload-file',
])

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

function visibleSidebarBounds(anchor: HTMLElement) {
  const sidebar = anchor.closest<HTMLElement>('.left-nav')
  if (!sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true') {
    return null
  }
  const rect = sidebar.getBoundingClientRect()
  const left = Math.max(0, rect.left)
  const right = Math.min(window.innerWidth, rect.right)
  const top = Math.max(0, rect.top)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  return right > left && bottom > top ? { left, right, top, bottom } : null
}

export function GfsResourceMenu({
  resourceName,
  triggerMode = 'button',
  presentation = 'default',
  contextVisible = true,
  isContextOwnerCurrent,
  onContextUnavailable,
  onReplaceSelectionStart,
  onReplaceSelectionEnd,
  contextTargetRef,
  contextOpenRequest,
  onSidebarMenuStateChange,
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
  const lastContextRequestRef = useRef(0)
  const contextPointRef = useRef<{ x: number; y: number } | null>(null)
  const contextPointOffsetRef = useRef<number | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const restoreTriggerAfterActionRef = useRef(false)
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [sidebarPanelSize, setSidebarPanelSize] = useState<{
    width: number
    maxHeight: number
  } | null>(null)
  const [sidebarShareSize, setSidebarShareSize] = useState<{
    width: number
    maxHeight: number
  } | null>(null)
  const returnFocusToShareRef = useRef(false)
  const focusShareOnOpenRef = useRef(false)
  const shareFocusWithinRef = useRef(false)
  const pointerExitTimerRef = useRef<number | null>(null)
  const menuStateRef = useRef({ open, shareOpen })
  const closeMenu = useCallback(() => {
    if (pointerExitTimerRef.current !== null) {
      window.clearTimeout(pointerExitTimerRef.current)
      pointerExitTimerRef.current = null
    }
    setOpen(false)
    setShareOpen(false)
    contextPointOffsetRef.current = null
    returnFocusToShareRef.current = false
    focusShareOnOpenRef.current = false
  }, [])
  useEffect(
    () => () => {
      if (pointerExitTimerRef.current !== null) {
        window.clearTimeout(pointerExitTimerRef.current)
        pointerExitTimerRef.current = null
      }
    },
    []
  )
  const focusFirstShareChild = useCallback(() => {
    const item = submenuRef.current?.querySelector<HTMLButtonElement>(
      '[data-share-child="true"]:not(:disabled)'
    )
    if (item) {
      item.focus()
      shareFocusWithinRef.current = true
    }
  }, [])
  const openShareForKeyboard = useCallback(() => {
    focusShareOnOpenRef.current = true
    if (shareOpen) focusFirstShareChild()
    setShareOpen(true)
  }, [focusFirstShareChild, shareOpen])
  const focusReturnTarget = useCallback(() => {
    if (triggerMode === 'context') {
      if (contextTargetRef?.current?.isConnected) {
        contextTargetRef.current.focus()
      }
      return
    }
    triggerRef.current?.focus()
  }, [contextTargetRef, triggerMode])

  useEffect(() => {
    if (triggerMode !== 'context' || !contextOpenRequest) return
    if (lastContextRequestRef.current === contextOpenRequest.id) return
    if (!contextVisible || (isContextOwnerCurrent && !isContextOwnerCurrent('open'))) return
    const sameOwner = open && contextTargetRef?.current?.isConnected
    if (!sameOwner) setShareOpen(false)
    contextPointOffsetRef.current = null
    lastContextRequestRef.current = contextOpenRequest.id
    contextPointRef.current =
      contextOpenRequest.clientX === null || contextOpenRequest.clientY === null
        ? null
        : { x: contextOpenRequest.clientX, y: contextOpenRequest.clientY }
    restoreTriggerAfterActionRef.current = false
    setOpen(true)
  }, [
    contextOpenRequest,
    contextTargetRef,
    contextVisible,
    isContextOwnerCurrent,
    open,
    triggerMode,
  ])
  useEffect(() => {
    if (triggerMode !== 'context' || (contextVisible && contextOpenRequest)) return
    if (open) closeMenu()
  }, [closeMenu, contextOpenRequest, contextVisible, open, triggerMode])
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
    const trigger = triggerMode === 'context' ? contextTargetRef?.current : triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return

    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    if (presentation === 'sidebar-context') {
      const bounds = visibleSidebarBounds(contextTargetRef?.current ?? trigger)
      if (!contextVisible || !bounds) {
        setPanelPosition(null)
        setOpen(false)
        onContextUnavailable?.()
        return
      }
      const width = Math.max(
        0,
        Math.min(232, bounds.right - bounds.left - 16, window.innerWidth - 16)
      )
      const maxHeight = Math.max(0, bounds.bottom - bounds.top - 16)
      const contextPoint = contextPointRef.current
      if (contextPoint) contextPointOffsetRef.current = contextPoint.y - triggerRect.top
      const preferredTop = contextPoint?.y ?? triggerRect.top + (contextPointOffsetRef.current ?? 0)
      const maxTop = Math.max(
        bounds.top + edgeInset,
        bounds.bottom - edgeInset - Math.min(panelRect.height, maxHeight)
      )
      const top = Math.min(Math.max(bounds.top + edgeInset, preferredTop), maxTop)
      setSidebarPanelSize(current =>
        current?.width === width && current.maxHeight === maxHeight ? current : { width, maxHeight }
      )
      const left = bounds.left + edgeInset
      setPanelPosition(current =>
        current?.left === left && current.top === top ? current : { left, top }
      )
      contextPointRef.current = null
      return
    }
    const viewportHeight = window.innerHeight
    const bounds = horizontalBounds(trigger, edgeInset)
    const maxLeft = Math.max(bounds.left, bounds.right - panelRect.width)
    const contextPoint = contextPointRef.current
    const left = contextPoint
      ? Math.min(Math.max(bounds.left, contextPoint.x), maxLeft)
      : Math.min(Math.max(bounds.left, triggerRect.right - panelRect.width), maxLeft)
    const opensAbove =
      triggerRect.bottom + gap + panelRect.height > viewportHeight - edgeInset &&
      triggerRect.top - gap - panelRect.height >= edgeInset
    const unclampedTop = contextPoint
      ? contextPoint.y
      : opensAbove
        ? triggerRect.top - panelRect.height - gap
        : triggerRect.bottom + gap
    const top = Math.min(
      Math.max(edgeInset, unclampedTop),
      Math.max(edgeInset, viewportHeight - panelRect.height - edgeInset)
    )

    setPanelPosition({ left, top })
  }, [contextTargetRef, contextVisible, onContextUnavailable, presentation, triggerMode])

  useLayoutEffect(() => {
    if (!open || (triggerMode === 'context' && (!contextVisible || !contextOpenRequest))) {
      setPanelPosition(null)
      return
    }

    positionPanel()
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionPanel)
    const trigger =
      presentation === 'sidebar-context' && triggerMode === 'context'
        ? contextTargetRef?.current
        : triggerRef.current
    const drive = trigger?.closest<HTMLElement>('.da-gfs-drive')
    if (trigger) resizeObserver?.observe(trigger)
    if (drive) resizeObserver?.observe(drive)
    if (presentation === 'sidebar-context') {
      const sidebarAnchor = contextTargetRef?.current ?? trigger
      const sidebar = sidebarAnchor?.closest<HTMLElement>('.left-nav')
      if (sidebar) resizeObserver?.observe(sidebar)
    }
    if (panelRef.current) resizeObserver?.observe(panelRef.current)
    return () => {
      window.removeEventListener('resize', positionPanel)
      window.removeEventListener('scroll', positionPanel, true)
      resizeObserver?.disconnect()
    }
  }, [
    contextOpenRequest,
    contextTargetRef,
    contextVisible,
    open,
    positionPanel,
    presentation,
    triggerMode,
  ])

  const positionSubmenu = useCallback(() => {
    const trigger = shareTriggerRef.current
    const submenu = submenuRef.current
    if (!trigger || !submenu) return

    const triggerRect = trigger.getBoundingClientRect()
    const submenuRect = submenu.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    if (presentation === 'sidebar-context') {
      // Context menus are portaled to document.body, so the Share button has
      // no sidebar ancestor. Measure the real owning row instead.
      const bounds = visibleSidebarBounds(contextTargetRef?.current ?? trigger)
      const mainRect = panelRef.current?.getBoundingClientRect()
      if (!bounds || !mainRect || !contextVisible) {
        setShareOpen(false)
        onContextUnavailable?.()
        return
      }
      const left = mainRect.left + 48
      const width = Math.min(232, bounds.right - edgeInset - left)
      const maxHeight = Math.max(0, bounds.bottom - bounds.top - edgeInset * 2)
      if (width <= 0 || maxHeight <= 0) {
        closeMenu()
        onContextUnavailable?.()
        return
      }
      const maxTop = Math.max(
        bounds.top + edgeInset,
        bounds.bottom - edgeInset - Math.min(submenuRect.height, maxHeight)
      )
      const top = Math.min(Math.max(bounds.top + edgeInset, mainRect.top), maxTop)
      setSidebarShareSize(current =>
        current?.width === width && current.maxHeight === maxHeight ? current : { width, maxHeight }
      )
      setSubmenuPosition(current =>
        current?.left === left && current.top === top ? current : { left, top }
      )
      return
    }
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
  }, [closeMenu, contextVisible, onContextUnavailable, presentation])

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
    const trigger =
      presentation === 'sidebar-context' && triggerMode === 'context'
        ? contextTargetRef?.current
        : triggerRef.current
    const drive = trigger?.closest<HTMLElement>('.da-gfs-drive')
    if (trigger) resizeObserver?.observe(trigger)
    if (drive) resizeObserver?.observe(drive)
    if (presentation === 'sidebar-context') {
      const sidebar = trigger?.closest<HTMLElement>('.left-nav')
      if (sidebar) resizeObserver?.observe(sidebar)
    }
    if (panelRef.current) resizeObserver?.observe(panelRef.current)
    if (shareTriggerRef.current) resizeObserver?.observe(shareTriggerRef.current)
    if (submenuRef.current) resizeObserver?.observe(submenuRef.current)
    return () => {
      window.removeEventListener('resize', positionSubmenu)
      window.removeEventListener('scroll', positionSubmenu, true)
      resizeObserver?.disconnect()
    }
  }, [contextTargetRef, panelPosition, positionSubmenu, presentation, shareOpen, triggerMode])

  useLayoutEffect(() => {
    menuStateRef.current = { open, shareOpen }
  }, [open, shareOpen])

  useLayoutEffect(() => {
    if (presentation !== 'sidebar-context' || triggerMode !== 'context' || !contextOpenRequest) {
      return
    }
    onSidebarMenuStateChange?.(contextOpenRequest.id, open, shareOpen)
  }, [contextOpenRequest, onSidebarMenuStateChange, open, presentation, shareOpen, triggerMode])

  const closeSidebarShareForPointerTarget = (target: EventTarget | null) => {
    const next = target instanceof Node ? target : null
    if (pointerExitTimerRef.current !== null) {
      window.clearTimeout(pointerExitTimerRef.current)
      pointerExitTimerRef.current = null
    }
    if (next && (shareTriggerRef.current?.contains(next) || submenuRef.current?.contains(next))) {
      return
    }
    if (!next && presentation === 'sidebar-context') {
      // Portal pointer transitions can report a null relatedTarget between the
      // trigger and flyout. Let the paired enter event cancel this close first.
      pointerExitTimerRef.current = window.setTimeout(() => {
        pointerExitTimerRef.current = null
        const focusWasInShare = Boolean(submenuRef.current?.contains(document.activeElement))
        returnFocusToShareRef.current = false
        if (focusWasInShare) shareTriggerRef.current?.focus()
        setShareOpen(false)
      }, 0)
      return
    }

    const actionTarget =
      next instanceof Element ? next.closest<HTMLButtonElement>('[data-gfs-action]') : null
    const enteringMainAction = Boolean(
      actionTarget &&
      panelRef.current?.contains(actionTarget) &&
      actionTarget !== shareTriggerRef.current
    )
    const focusWasInShare = Boolean(submenuRef.current?.contains(document.activeElement))
    if (enteringMainAction || !next) shareFocusWithinRef.current = false
    if (enteringMainAction && focusWasInShare) {
      returnFocusToShareRef.current = false
      if (actionTarget?.disabled) shareTriggerRef.current?.focus()
      else actionTarget?.focus()
    } else {
      returnFocusToShareRef.current = false
      if (focusWasInShare) shareTriggerRef.current?.focus()
    }
    setShareOpen(false)
  }

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const trackFocusOwner = (event: FocusEvent) => {
      if (presentation !== 'sidebar-context') return
      shareFocusWithinRef.current = Boolean(
        event.target instanceof Node && submenuRef.current?.contains(event.target)
      )
    }
    document.addEventListener('focusin', trackFocusOwner)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const current = menuStateRef.current
        if (current.shareOpen) {
          event.preventDefault()
          const focusWasInShare = Boolean(
            presentation === 'sidebar-context' &&
            submenuRef.current?.contains(document.activeElement)
          )
          returnFocusToShareRef.current = false
          if (presentation !== 'sidebar-context' || focusWasInShare)
            shareTriggerRef.current?.focus()
          setShareOpen(false)
        } else {
          closeMenu()
          if (
            presentation !== 'sidebar-context' ||
            panelRef.current?.contains(document.activeElement)
          )
            focusReturnTarget()
        }
        return
      }
      if (
        event.key === 'ArrowLeft' &&
        presentation === 'sidebar-context' &&
        menuStateRef.current.shareOpen &&
        contextVisible &&
        (!isContextOwnerCurrent || isContextOwnerCurrent('open')) &&
        !panelRef.current?.contains(event.target as Node) &&
        !submenuRef.current?.contains(event.target as Node)
      ) {
        setShareOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('focusin', trackFocusOwner)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMenu, contextVisible, focusReturnTarget, isContextOwnerCurrent, open, presentation])

  useEffect(() => {
    if (open || !restoreTriggerAfterActionRef.current) return
    const timer = window.setTimeout(() => {
      restoreTriggerAfterActionRef.current = false
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      const activeElement = document.activeElement
      if (
        activeElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement &&
        activeElement.isConnected
      ) {
        return
      }
      if (triggerMode === 'context') {
        if (contextTargetRef?.current?.isConnected) contextTargetRef.current.focus()
      } else if (triggerRef.current?.isConnected) triggerRef.current.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [contextTargetRef, open, triggerMode])

  useEffect(() => {
    if (!shareOpen) {
      if (returnFocusToShareRef.current && open) {
        returnFocusToShareRef.current = false
        shareTriggerRef.current?.focus()
      }
      return
    }
    if (presentation === 'sidebar-context') {
      if (focusShareOnOpenRef.current) {
        focusShareOnOpenRef.current = false
        focusFirstShareChild()
      }
      return
    }
    submenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
  }, [focusFirstShareChild, open, presentation, shareOpen])

  useEffect(() => {
    if (presentation !== 'sidebar-context') return
    const input = replaceInputRef.current
    if (!input) return
    const handleCancel = () => onReplaceSelectionEnd?.()
    input.addEventListener('cancel', handleCancel)
    return () => input.removeEventListener('cancel', handleCancel)
  }, [onReplaceSelectionEnd, presentation])

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open) return
    if (event.key === 'ArrowRight' && event.target === shareTriggerRef.current) {
      event.preventDefault()
      if (presentation === 'sidebar-context') openShareForKeyboard()
      else setShareOpen(true)
      return
    }
    if (
      event.key === 'ArrowLeft' &&
      shareOpen &&
      (presentation === 'sidebar-context'
        ? panelRef.current?.contains(document.activeElement) ||
          submenuRef.current?.contains(document.activeElement)
        : submenuRef.current?.contains(document.activeElement))
    ) {
      event.preventDefault()
      const focusWasInShare = Boolean(submenuRef.current?.contains(document.activeElement))
      returnFocusToShareRef.current = presentation !== 'sidebar-context' && focusWasInShare
      if (presentation === 'sidebar-context' && focusWasInShare) shareTriggerRef.current?.focus()
      setShareOpen(false)
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

  const runAction = (
    action: () => void,
    keyboardActivated: boolean,
    actionKey: string,
    ownerPhase: 'open' | 'replace' = 'open'
  ) => {
    if (
      presentation === 'sidebar-context' &&
      (!contextVisible || (isContextOwnerCurrent && !isContextOwnerCurrent(ownerPhase)))
    ) {
      closeMenu()
      onContextUnavailable?.()
      return
    }
    restoreTriggerAfterActionRef.current =
      triggerMode === 'context' &&
      keyboardActivated &&
      !ACTIONS_WITH_FOCUS_DESTINATION.has(actionKey)
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
  const shareProjectionKey = shareMenuChildren
    .map(action => `${action.key}:${action.disabled ? 'disabled' : 'enabled'}`)
    .join('|')
  useLayoutEffect(() => {
    if (
      presentation !== 'sidebar-context' ||
      !open ||
      !shareOpen ||
      !shareFocusWithinRef.current ||
      submenuRef.current?.contains(document.activeElement)
    ) {
      return
    }
    focusFirstShareChild()
  }, [focusFirstShareChild, open, presentation, shareOpen, shareProjectionKey])
  const sidebarPresentation = presentation === 'sidebar-context'
  const contextPanelAllowed =
    triggerMode !== 'context' ||
    (contextVisible &&
      Boolean(contextOpenRequest) &&
      (!isContextOwnerCurrent || isContextOwnerCurrent('open')))

  return (
    <span
      className={`da-gfs-resource-menu${open ? ' is-open' : ''}${
        triggerMode === 'context' ? ' da-gfs-resource-menu--context' : ''
      }${sidebarPresentation ? ' da-gfs-resource-menu--sidebar-context' : ''}`}
      ref={menuRef}
    >
      {triggerMode === 'button' ? (
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
              restoreTriggerAfterActionRef.current = false
              setOpen(true)
            }
          }}
          ref={triggerRef}
          size="sm"
          variant="ghost"
        >
          <IconMoreVertical />
        </IconButton>
      ) : null}
      {open && contextPanelAllowed
        ? createPortal(
            <Fragment>
              <div
                className="da-gfs-resource-menu__panel"
                ref={panelRef}
                role="menu"
                aria-label={`Actions for ${resourceName}`}
                data-presentation={sidebarPresentation ? 'sidebar-context' : undefined}
                style={
                  panelPosition
                    ? {
                        left: panelPosition.left,
                        top: panelPosition.top,
                        ...(sidebarPresentation && sidebarPanelSize
                          ? { width: sidebarPanelSize.width, maxHeight: sidebarPanelSize.maxHeight }
                          : {}),
                      }
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
                        onMouseEnter={
                          action.submenu
                            ? () => {
                                if (!sidebarPresentation) setShareOpen(true)
                                else if (
                                  contextVisible &&
                                  (!isContextOwnerCurrent || isContextOwnerCurrent('open'))
                                ) {
                                  if (pointerExitTimerRef.current !== null) {
                                    window.clearTimeout(pointerExitTimerRef.current)
                                    pointerExitTimerRef.current = null
                                  }
                                  focusShareOnOpenRef.current = false
                                  setShareOpen(true)
                                }
                              }
                            : sidebarPresentation && shareOpen
                              ? event => closeSidebarShareForPointerTarget(event.currentTarget)
                              : undefined
                        }
                        onMouseLeave={
                          sidebarPresentation && action.submenu && shareOpen
                            ? event => closeSidebarShareForPointerTarget(event.relatedTarget)
                            : undefined
                        }
                        onClick={event => {
                          if (action.disabled) return
                          if (action.submenu) {
                            if (sidebarPresentation) {
                              if (
                                !contextVisible ||
                                (isContextOwnerCurrent && !isContextOwnerCurrent('open'))
                              ) {
                                closeMenu()
                                onContextUnavailable?.()
                              } else if (event.detail === 0) openShareForKeyboard()
                              else {
                                focusShareOnOpenRef.current = true
                                setShareOpen(true)
                              }
                            } else action.onClick()
                          } else {
                            if (sidebarPresentation && action.key === 'replace') {
                              if (
                                !contextVisible ||
                                (isContextOwnerCurrent && !isContextOwnerCurrent('open'))
                              ) {
                                closeMenu()
                                onContextUnavailable?.()
                                return
                              }
                              onReplaceSelectionStart?.()
                              runAction(action.onClick, event.detail === 0, action.key, 'replace')
                            } else {
                              runAction(action.onClick, event.detail === 0, action.key)
                            }
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
                  className={`da-gfs-resource-menu__submenu${sidebarPresentation ? ' da-gfs-resource-menu__submenu--sidebar-context' : ''}`}
                  ref={submenuRef}
                  role="menu"
                  data-presentation={sidebarPresentation ? 'sidebar-context' : undefined}
                  style={
                    submenuPosition
                      ? {
                          left: submenuPosition.left,
                          top: submenuPosition.top,
                          ...(sidebarPresentation && sidebarShareSize
                            ? {
                                width: sidebarShareSize.width,
                                maxHeight: sidebarShareSize.maxHeight,
                              }
                            : {}),
                        }
                      : { left: 0, top: 0, visibility: 'hidden' }
                  }
                  onKeyDown={handleMenuKeyDown}
                  onMouseLeave={
                    sidebarPresentation
                      ? event => closeSidebarShareForPointerTarget(event.relatedTarget)
                      : undefined
                  }
                  onMouseEnter={
                    sidebarPresentation
                      ? () => {
                          if (pointerExitTimerRef.current !== null) {
                            window.clearTimeout(pointerExitTimerRef.current)
                            pointerExitTimerRef.current = null
                          }
                        }
                      : undefined
                  }
                >
                  {shareMenuChildren.map(action => (
                    <MenuItem
                      data-gfs-action={action.key}
                      data-share-child={sidebarPresentation ? 'true' : undefined}
                      disabled={action.disabled}
                      key={action.key}
                      leadingIcon={action.icon}
                      role="menuitem"
                      onClick={event => {
                        if (action.disabled) return
                        runAction(action.onClick, event.detail === 0, action.key)
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
          type="file"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!file) {
              if (sidebarPresentation) onReplaceSelectionEnd?.()
              return
            }
            if (
              sidebarPresentation &&
              (!contextVisible || (isContextOwnerCurrent && !isContextOwnerCurrent('replace')))
            ) {
              onReplaceSelectionEnd?.()
              return
            }
            closeMenu()
            const replaceAction = menuActions?.find(action => action.id === 'replace')
            if (replaceAction) replaceAction.run(file)
            else onReplace?.(file)
            if (sidebarPresentation) onReplaceSelectionEnd?.()
          }}
        />
      ) : null}
    </span>
  )
}

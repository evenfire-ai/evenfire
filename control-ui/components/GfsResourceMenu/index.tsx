'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconFolder } from '@components/Sidebar/icons'
import {
  IconChevronRight,
  IconCopy,
  IconDotsVertical,
  IconDownload,
  IconEye,
  IconPencil,
  IconShare,
  IconTrash,
  IconUpload,
} from '@components/icons'
import type { GfsResourceMenuProps } from './types'

type GfsResourceMenuAction = {
  danger?: boolean
  disabled?: boolean
  icon: ReactNode
  key: string
  label: string
  onClick: () => void
  submenu?: boolean
}

function menuAction(
  key: string,
  label: string,
  icon: ReactNode,
  onClick: (() => void) | undefined,
  options?: Pick<GfsResourceMenuAction, 'danger' | 'disabled' | 'submenu'>
): GfsResourceMenuAction | null {
  return onClick ? { ...options, icon, key, label, onClick } : null
}

function isMenuAction(action: GfsResourceMenuAction | null): action is GfsResourceMenuAction {
  return action !== null
}

export function GfsResourceMenu({
  downloading = false,
  onCopyLink,
  onDelete,
  onDownload,
  onManage,
  onMove,
  onPreview,
  onRename,
  onReplace,
  resourceName,
  resourceUri,
}: GfsResourceMenuProps) {
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null)
  const closeMenu = useCallback(() => {
    setOpen(false)
    setShareOpen(false)
  }, [])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (
        rootRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        submenuRef.current?.contains(target)
      )
        return
      closeMenu()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [closeMenu, open])

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return

    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    const maxLeft = Math.max(edgeInset, window.innerWidth - menuRect.width - edgeInset)
    const left = Math.min(Math.max(edgeInset, triggerRect.right - menuRect.width), maxLeft)
    const opensAbove =
      triggerRect.bottom + gap + menuRect.height > window.innerHeight - edgeInset &&
      triggerRect.top - gap - menuRect.height >= edgeInset
    const unclampedTop = opensAbove
      ? triggerRect.top - menuRect.height - gap
      : triggerRect.bottom + gap
    const maxTop = Math.max(edgeInset, window.innerHeight - menuRect.height - edgeInset)
    const top = Math.min(Math.max(edgeInset, unclampedTop), maxTop)

    setMenuPosition({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null)
      return
    }

    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, positionMenu])

  const positionSubmenu = useCallback(() => {
    const trigger = shareTriggerRef.current
    const submenu = submenuRef.current
    if (!trigger || !submenu) return

    const triggerRect = trigger.getBoundingClientRect()
    const submenuRect = submenu.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const opensLeft = triggerRect.right + gap + submenuRect.width > viewportWidth - edgeInset
    const preferredLeft = opensLeft
      ? triggerRect.left - submenuRect.width - gap
      : triggerRect.right + gap
    const maxLeft = Math.max(edgeInset, viewportWidth - submenuRect.width - edgeInset)
    const left = Math.min(Math.max(edgeInset, preferredLeft), maxLeft)
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
    return () => {
      window.removeEventListener('resize', positionSubmenu)
      window.removeEventListener('scroll', positionSubmenu, true)
    }
  }, [positionSubmenu, shareOpen])

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    function handleKeyDown(event: KeyboardEvent) {
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
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, open, shareOpen])

  useEffect(() => {
    if (!shareOpen) return
    submenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
  }, [shareOpen])

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
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

  const run = (action: () => void) => {
    closeMenu()
    action()
  }

  const actionGroups: GfsResourceMenuAction[][] = [
    [
      menuAction(
        'share',
        'Share',
        <IconShare />,
        onManage ? () => setShareOpen(value => !value) : undefined,
        { submenu: true }
      ),
      onManage ? null : menuAction('copy-link', 'Copy link', <IconCopy />, onCopyLink),
      menuAction('preview', 'Preview', <IconEye />, onPreview),
    ].filter(isMenuAction),
    [
      menuAction(
        'download',
        downloading ? 'Downloading…' : 'Download',
        <IconDownload />,
        onDownload,
        {
          disabled: downloading,
        }
      ),
      menuAction(
        'replace',
        'Replace file',
        <IconUpload />,
        onReplace ? () => replaceInputRef.current?.click() : undefined
      ),
    ].filter(isMenuAction),
    [
      menuAction('rename', 'Rename', <IconPencil />, onRename),
      menuAction('move', 'Move to…', <IconFolder />, onMove),
    ].filter(isMenuAction),
    [menuAction('delete', 'Delete', <IconTrash />, onDelete, { danger: true })].filter(
      isMenuAction
    ),
  ].filter(group => group.length > 0)

  return (
    <div className="cu-kebab cu-gfs-resource-menu" ref={rootRef}>
      <button
        type="button"
        aria-label={`Actions for ${resourceName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        ref={triggerRef}
        onClick={event => {
          event.stopPropagation()
          if (open) {
            closeMenu()
          } else {
            setOpen(true)
          }
        }}
      >
        <IconDotsVertical width={18} height={18} />
      </button>
      {open
        ? createPortal(
            <>
              <div
                className="cu-gfs-resource-menu__menu cu-kebab__menu"
                ref={menuRef}
                role="menu"
                aria-label={`Actions for ${resourceName}`}
                style={
                  menuPosition
                    ? { left: menuPosition.left, top: menuPosition.top }
                    : { left: 0, top: 0, visibility: 'hidden' }
                }
                onKeyDown={handleMenuKeyDown}
              >
                {actionGroups.map((group, groupIndex) => (
                  <span key={`group-${groupIndex}`} className="cu-gfs-resource-menu__group">
                    {groupIndex > 0 ? (
                      <span className="cu-gfs-resource-menu__separator" role="separator" />
                    ) : null}
                    {group.map(action => (
                      <button
                        aria-expanded={action.submenu ? shareOpen : undefined}
                        aria-haspopup={action.submenu ? 'menu' : undefined}
                        data-gfs-action={action.key}
                        key={action.key}
                        type="button"
                        role="menuitem"
                        className={`cu-gfs-resource-menu__item cu-kebab__item${
                          action.danger ? ' cu-kebab__item--danger' : ''
                        }`}
                        disabled={action.disabled}
                        ref={action.submenu ? shareTriggerRef : undefined}
                        title={action.key === 'copy-link' ? resourceUri : undefined}
                        onMouseEnter={() => setShareOpen(action.submenu === true)}
                        onClick={event => {
                          event.stopPropagation()
                          if (action.submenu) {
                            action.onClick()
                          } else {
                            run(action.onClick)
                          }
                        }}
                      >
                        <span className="cu-gfs-resource-menu__icon" aria-hidden="true">
                          {action.icon}
                        </span>
                        <span>{action.label}</span>
                        {action.submenu ? (
                          <span className="cu-gfs-resource-menu__trailing" aria-hidden="true">
                            <IconChevronRight width={18} height={18} />
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </span>
                ))}
              </div>
              {shareOpen && onManage ? (
                <div
                  aria-label={`Share options for ${resourceName}`}
                  className="cu-gfs-resource-menu__submenu"
                  ref={submenuRef}
                  role="menu"
                  style={
                    submenuPosition
                      ? { left: submenuPosition.left, top: submenuPosition.top }
                      : { left: 0, top: 0, visibility: 'hidden' }
                  }
                  onKeyDown={handleMenuKeyDown}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="cu-gfs-resource-menu__item cu-kebab__item"
                    data-gfs-action="share-access"
                    onClick={event => {
                      event.stopPropagation()
                      run(onManage)
                    }}
                  >
                    <span className="cu-gfs-resource-menu__icon" aria-hidden="true">
                      <IconShare />
                    </span>
                    <span>Share</span>
                  </button>
                  {onCopyLink ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="cu-gfs-resource-menu__item cu-kebab__item"
                      data-gfs-action="copy-link"
                      title={resourceUri}
                      onClick={event => {
                        event.stopPropagation()
                        run(onCopyLink)
                      }}
                    >
                      <span className="cu-gfs-resource-menu__icon" aria-hidden="true">
                        <IconCopy />
                      </span>
                      <span>Copy link</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>,
            document.body
          )
        : null}
      {onReplace ? (
        <input
          aria-label={`Replace ${resourceName}`}
          className="sr-only"
          ref={replaceInputRef}
          type="file"
          onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (!file) return
            closeMenu()
            onReplace(file)
          }}
        />
      ) : null}
    </div>
  )
}

export type { GfsResourceMenuProps } from './types'

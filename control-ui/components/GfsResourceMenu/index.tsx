'use client'

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconMoreHorizontal } from '@components/icons'
import type { GfsResourceMenuProps } from './types'

export function GfsResourceMenu({
  downloading = false,
  onCopyLink,
  onDelete,
  onDownload,
  onManage,
  onPreview,
  onRename,
  onReplace,
  resourceName,
  resourceUri,
}: GfsResourceMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
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
    setOpen(false)
    action()
  }

  return (
    <div className="cu-kebab cu-gfs-resource-menu" ref={rootRef} onKeyDown={handleMenuKeyDown}>
      <button
        type="button"
        aria-label={`Actions for ${resourceName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        ref={triggerRef}
        onClick={() => setOpen(current => !current)}
      >
        <IconMoreHorizontal width={18} height={18} />
      </button>
      {open ? (
        <div className="cu-kebab__menu cu-kebab__menu--nowrap" role="menu">
          {onManage ? (
            <button
              type="button"
              role="menuitem"
              className="cu-kebab__item"
              onClick={() => run(onManage)}
            >
              Manage access
            </button>
          ) : null}
          {onPreview ? (
            <button
              type="button"
              role="menuitem"
              className="cu-kebab__item"
              onClick={() => run(onPreview)}
            >
              Preview
            </button>
          ) : null}
          {onDownload ? (
            <button
              type="button"
              role="menuitem"
              className="cu-kebab__item"
              disabled={downloading}
              onClick={() => run(onDownload)}
            >
              {downloading ? 'Downloading…' : 'Download'}
            </button>
          ) : null}
          {onReplace ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="cu-kebab__item"
                onClick={() => replaceInputRef.current?.click()}
              >
                Replace file
              </button>
              <input
                aria-label={`Replace ${resourceName}`}
                className="sr-only"
                ref={replaceInputRef}
                type="file"
                onChange={event => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (!file) return
                  setOpen(false)
                  onReplace(file)
                }}
              />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item"
            title={resourceUri}
            onClick={() => run(onCopyLink)}
          >
            Copy GFS link
          </button>
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item"
            onClick={() => run(onRename)}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item cu-kebab__item--danger"
            onClick={() => run(onDelete)}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

export type { GfsResourceMenuProps } from './types'

'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@components/ui'
import type { GfsPermissionDropdownProps } from './types'

const PERMISSION_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  delete: 'Delete',
  manage_acl: 'Manage access',
  share: 'Share',
}

export function GfsPermissionDropdown({
  disabled = false,
  onChange,
  permissions,
  value,
}: GfsPermissionDropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function togglePermission(permission: string) {
    onChange(
      value.includes(permission)
        ? value.filter(item => item !== permission)
        : permissions.filter(item => item === permission || value.includes(item))
    )
  }

  const label =
    value.length === 0
      ? 'Permissions'
      : value.length === 1
        ? (PERMISSION_LABELS[value[0] ?? ''] ?? value[0])
        : `${value.length} permissions`

  return (
    <div className="cu-gfs-permission-dropdown" ref={rootRef}>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        className="cu-gfs-permission-dropdown__trigger"
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
      >
        <span>{label}</span>
        <span className="cu-gfs-permission-dropdown__chevron" aria-hidden="true" />
      </Button>
      {open ? (
        <div className="cu-gfs-permission-dropdown__menu" role="menu" aria-label="Permissions">
          {permissions.map(permission => {
            const selected = value.includes(permission)
            return (
              <Button
                aria-checked={selected}
                className="cu-gfs-permission-dropdown__option"
                data-selected={selected ? 'true' : undefined}
                key={permission}
                onClick={() => togglePermission(permission)}
                role="menuitemcheckbox"
                variant="ghost"
              >
                <span className="cu-gfs-permission-dropdown__check" aria-hidden="true">
                  {selected ? '✓' : null}
                </span>
                <span>{PERMISSION_LABELS[permission] ?? permission}</span>
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export type { GfsPermissionDropdownProps } from './types'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, MenuItem } from '@components/Common'
import { useClickOutside } from '@hooks/useClickOutside'
import { GFS_PERMISSION_LABELS } from './constants'
import type { GfsPermissionDropdownProps } from './types'

export function GfsPermissionDropdown({
  disabled = false,
  onChange,
  permissions,
  value,
}: GfsPermissionDropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])

  useClickOutside(rootRef, open, close)

  useEffect(() => {
    if (disabled) close()
  }, [close, disabled])

  const togglePermission = (permission: string) => {
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
        ? (GFS_PERMISSION_LABELS[value[0] ?? ''] ?? value[0])
        : `${value.length} permissions`

  return (
    <div className="da-gfs-permission-dropdown" ref={rootRef}>
      <Button
        align="between"
        aria-expanded={open}
        aria-haspopup="menu"
        block
        className="da-gfs-permission-dropdown__trigger"
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        variant="outline"
      >
        <span>{label}</span>
        <span className="ui-dropdown-select__chevron" aria-hidden="true" />
      </Button>
      {open ? (
        <div className="da-gfs-permission-dropdown__menu" role="menu" aria-label="Permissions">
          {permissions.map(permission => {
            const selected = value.includes(permission)
            return (
              <MenuItem
                active={selected}
                aria-checked={selected}
                className="da-gfs-permission-dropdown__option"
                key={permission}
                leadingIcon={
                  <span className="da-gfs-permission-dropdown__check" aria-hidden="true">
                    {selected ? '✓' : null}
                  </span>
                }
                onClick={() => togglePermission(permission)}
                role="menuitemcheckbox"
              >
                {GFS_PERMISSION_LABELS[permission] ?? permission}
              </MenuItem>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export type { GfsPermissionDropdownProps } from './types'

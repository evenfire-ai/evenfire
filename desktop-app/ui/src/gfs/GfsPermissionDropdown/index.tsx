import { Select } from 'antd'
import { GFS_PERMISSION_LABELS } from './constants'
import type { GfsPermissionDropdownProps } from './types'

export function GfsPermissionDropdown({
  disabled = false,
  onChange,
  permissions,
  value,
}: GfsPermissionDropdownProps) {
  return (
    <Select
      aria-label="Permissions"
      disabled={disabled}
      mode="multiple"
      onChange={(next: string[]) =>
        onChange(permissions.filter(permission => next.includes(permission)))
      }
      options={permissions.map(permission => ({
        value: permission,
        label: GFS_PERMISSION_LABELS[permission] ?? permission,
      }))}
      showSearch={false}
      size="small"
      value={value}
    />
  )
}

export type { GfsPermissionDropdownProps } from './types'

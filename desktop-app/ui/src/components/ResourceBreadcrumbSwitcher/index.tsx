import { useMemo, useState } from 'react'
import { DownOutlined } from '@ant-design/icons'
import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import type { ResourceBreadcrumbSwitcherProps } from './types'

export function ResourceBreadcrumbSwitcher({
  ariaLabel,
  emptyLabel,
  onSelect,
  options,
  selectedId,
  selectedLabel,
}: ResourceBreadcrumbSwitcherProps) {
  const [open, setOpen] = useState(false)
  const items = useMemo<MenuProps['items']>(
    () =>
      options.length
        ? options.map(option => ({ key: option.id, label: option.label }))
        : [{ key: '__empty__', label: emptyLabel, disabled: true }],
    [emptyLabel, options]
  )

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomLeft"
      open={open}
      onOpenChange={setOpen}
      menu={{
        items,
        selectable: true,
        selectedKeys: [selectedId],
        onClick: ({ key }) => {
          setOpen(false)
          if (key !== selectedId && key !== '__empty__') onSelect(key)
        },
      }}
    >
      <Button type="text" size="small" aria-label={ariaLabel} aria-expanded={open}>
        {selectedLabel}
        <DownOutlined />
      </Button>
    </Dropdown>
  )
}

export type { ResourceBreadcrumbOption, ResourceBreadcrumbSwitcherProps } from './types'

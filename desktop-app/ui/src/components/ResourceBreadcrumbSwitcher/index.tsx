import { useMemo, useState } from 'react'
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
    <div className="resource-breadcrumb-switcher">
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
        <Button
          className="resource-breadcrumb-trigger"
          type="text"
          size="small"
          aria-label={ariaLabel}
          aria-expanded={open}
        >
          {selectedLabel}
          <svg
            viewBox="0 0 16 16"
            width={14}
            height={14}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d={open ? 'm4.5 10 3.5-3.5L11.5 10' : 'm4.5 6 3.5 3.5L11.5 6'} />
          </svg>
        </Button>
      </Dropdown>
    </div>
  )
}

export type { ResourceBreadcrumbOption, ResourceBreadcrumbSwitcherProps } from './types'

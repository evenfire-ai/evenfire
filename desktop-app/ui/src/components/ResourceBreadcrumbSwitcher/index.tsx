import { useRef, useState } from 'react'
import { Button, MenuItem } from '@components/Common'
import { useClickOutside } from '@hooks/useClickOutside'
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
  const wrapperRef = useRef<HTMLSpanElement | null>(null)

  useClickOutside(wrapperRef, open, () => setOpen(false))

  return (
    <span className="resource-breadcrumb-switcher" ref={wrapperRef}>
      <Button
        color="transparent"
        className="resource-breadcrumb-trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        size="sm"
        variant="text"
        onClick={() => setOpen(value => !value)}
      >
        <span className="resource-breadcrumb-trigger-label">{selectedLabel}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d={open ? 'm4.5 10 3.5-3.5L11.5 10' : 'm4.5 6 3.5 3.5L11.5 6'} />
        </svg>
      </Button>
      {open && (
        <span className="resource-breadcrumb-menu" role="menu">
          {options.length ? (
            options.map(option => (
              <MenuItem
                key={option.id}
                active={option.id === selectedId}
                className="resource-breadcrumb-menu-item"
                onClick={() => {
                  setOpen(false)
                  if (option.id !== selectedId) {
                    onSelect(option.id)
                  }
                }}
                role="menuitem"
              >
                {option.label}
              </MenuItem>
            ))
          ) : (
            <span className="resource-breadcrumb-empty">{emptyLabel}</span>
          )}
        </span>
      )}
    </span>
  )
}

export type { ResourceBreadcrumbOption, ResourceBreadcrumbSwitcherProps } from './types'

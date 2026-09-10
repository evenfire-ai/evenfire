import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@components/Common/Button'
import { MenuItem } from '@components/Common/MenuItem'
import type { DropdownSelectProps } from './types'

export function DropdownSelect({
  ariaLabel,
  className,
  disabled = false,
  id,
  onChange,
  options,
  placeholder,
  portal = false,
  value,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false)
  const [portalPosition, setPortalPosition] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = options.findIndex(option => option.value === value)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [close, open])

  const updatePortalPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const gap = 4
    const viewportPadding = 8
    const estimatedHeight = Math.min(260, 8 + options.length * 40)
    const menuHeight = menuRef.current?.offsetHeight || estimatedHeight
    const roomBelow = window.innerHeight - rect.bottom - viewportPadding
    const roomAbove = rect.top - viewportPadding
    const opensAbove = menuHeight > roomBelow && roomAbove > roomBelow
    const top = opensAbove
      ? Math.max(viewportPadding, rect.top - menuHeight - gap)
      : Math.max(
          viewportPadding,
          Math.min(rect.bottom + gap, window.innerHeight - menuHeight - viewportPadding)
        )
    const width = rect.width
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
    )
    setPortalPosition({ left, top, width })
  }, [options.length])

  useLayoutEffect(() => {
    if (!portal || !open) return
    updatePortalPosition()
    window.addEventListener('resize', updatePortalPosition)
    window.addEventListener('scroll', updatePortalPosition, true)
    return () => {
      window.removeEventListener('resize', updatePortalPosition)
      window.removeEventListener('scroll', updatePortalPosition, true)
    }
  }, [open, portal, updatePortalPosition])

  useEffect(() => {
    if (!open) return
    const focusIndex = selectedIndex >= 0 ? selectedIndex : 0
    optionRefs.current[focusIndex]?.focus()
  }, [open, selectedIndex])

  useEffect(() => {
    if (disabled) close()
  }, [close, disabled])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    close()
    triggerRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
      triggerRef.current?.focus()
      return
    }

    if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      setOpen(true)
      return
    }

    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const activeIndex = optionRefs.current.findIndex(option => option === document.activeElement)
    let nextIndex = activeIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = options.length - 1
    if (event.key === 'ArrowDown') nextIndex = Math.min(options.length - 1, activeIndex + 1)
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, activeIndex - 1)
    optionRefs.current[nextIndex]?.focus()
  }

  const menu = open ? (
    <div
      className={`ui-dropdown-select__menu${portal ? ' ui-dropdown-select__menu--portal' : ''}`}
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      style={
        portal
          ? portalPosition
            ? {
                left: portalPosition.left,
                top: portalPosition.top,
                width: portalPosition.width,
              }
            : { left: 0, top: 0, visibility: 'hidden' }
          : undefined
      }
    >
      {options.map((option, index) => (
        <MenuItem
          active={option.value === value}
          aria-selected={option.value === value}
          className="ui-dropdown-select__option"
          key={option.value}
          onClick={() => choose(option.value)}
          ref={element => {
            optionRefs.current[index] = element
          }}
          role="option"
        >
          {option.label}
        </MenuItem>
      ))}
    </div>
  ) : null

  return (
    <div
      className={`ui-dropdown-select${className ? ` ${className}` : ''}`}
      onKeyDown={handleKeyDown}
      ref={rootRef}
    >
      <Button
        align="between"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        block
        className="ui-dropdown-select__trigger"
        disabled={disabled}
        id={id}
        onClick={() => setOpen(current => !current)}
        ref={triggerRef}
        variant="outline"
      >
        <span className={selectedOption ? undefined : 'ui-dropdown-select__placeholder'}>
          {selectedOption?.label ?? placeholder}
        </span>
        <span className="ui-dropdown-select__chevron" aria-hidden="true" />
      </Button>
      {portal && menu ? createPortal(menu, document.body) : menu}
    </div>
  )
}

export type { DropdownSelectOption, DropdownSelectProps } from './types'

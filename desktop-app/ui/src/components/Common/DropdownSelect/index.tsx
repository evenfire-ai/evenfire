import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@components/Common/Button'
import { MenuItem } from '@components/Common/MenuItem'
import { useClickOutside } from '@hooks/useClickOutside'
import type { DropdownSelectProps } from './types'

export function DropdownSelect({
  ariaLabel,
  disabled = false,
  id,
  onChange,
  options,
  placeholder,
  value,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = options.findIndex(option => option.value === value)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null
  const close = useCallback(() => setOpen(false), [])

  useClickOutside(rootRef, open, close)

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

  return (
    <div className="ui-dropdown-select" onKeyDown={handleKeyDown} ref={rootRef}>
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
      {open ? (
        <div className="ui-dropdown-select__menu" role="listbox" aria-label={ariaLabel}>
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
      ) : null}
    </div>
  )
}

export type { DropdownSelectOption, DropdownSelectProps } from './types'

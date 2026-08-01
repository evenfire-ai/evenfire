'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@lib/cn'
import type { FilterSelectProps } from './types'

export function FilterSelect({
  ariaLabel,
  className,
  disabled = false,
  id,
  onChange,
  options,
  value,
}: FilterSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selected = options.find(option => option.value === value)
  const hasIcons = options.some(option => option.icon)
  const selectedIndex = Math.max(
    0,
    options.findIndex(option => option.value === value)
  )

  function closeMenu(restoreFocus = false) {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }

  function openMenu(index = selectedIndex) {
    setActiveIndex(index)
    setOpen(true)
  }

  function focusOption(index: number) {
    if (options.length === 0) return
    const nextIndex = (index + options.length) % options.length
    setActiveIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const index = Math.min(activeIndex, Math.max(options.length - 1, 0))
    setActiveIndex(index)
    optionRefs.current[index]?.focus()
  }, [activeIndex, open, options.length])

  return (
    <div ref={rootRef} className={cn('cu-agent-select', 'cu-agent-select--compact', className)}>
      <button
        id={id}
        ref={buttonRef}
        type="button"
        className="cu-agent-select__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'Home') {
            event.preventDefault()
            openMenu(0)
          } else if (event.key === 'ArrowUp' || event.key === 'End') {
            event.preventDefault()
            openMenu(Math.max(options.length - 1, 0))
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            closeMenu(true)
          }
        }}
      >
        <span className="cu-agent-select__button-copy cu-filter-select__copy">
          {selected?.icon ? (
            <span className="cu-filter-select__icon">{selected.icon}</span>
          ) : hasIcons ? (
            <span className="cu-filter-select__icon cu-filter-select__icon--placeholder" />
          ) : null}
          <span>{selected?.label ?? '—'}</span>
        </span>
        <span className="cu-agent-select__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="cu-agent-select__menu" role="listbox" aria-label={ariaLabel}>
          {options.length === 0 ? (
            <span className="cu-agent-select__empty">No options available.</span>
          ) : (
            options.map((option, index) => {
              const active = option.value === value
              return (
                <button
                  key={option.value}
                  ref={element => {
                    optionRefs.current[index] = element
                  }}
                  type="button"
                  className="cu-agent-select__option"
                  role="option"
                  aria-selected={active}
                  data-active={active ? 'true' : 'false'}
                  tabIndex={activeIndex === index ? 0 : -1}
                  onClick={() => {
                    onChange(option.value)
                    closeMenu(true)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      focusOption(index + 1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      focusOption(index - 1)
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      focusOption(0)
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      focusOption(options.length - 1)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      closeMenu(true)
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onChange(option.value)
                      closeMenu(true)
                    }
                  }}
                >
                  {option.icon ? (
                    <span className="cu-filter-select__icon">{option.icon}</span>
                  ) : hasIcons ? (
                    <span className="cu-filter-select__icon cu-filter-select__icon--placeholder" />
                  ) : null}
                  <span className="cu-agent-select__option-copy cu-filter-select__copy">
                    <span className="cu-agent-select__option-name">{option.label}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}

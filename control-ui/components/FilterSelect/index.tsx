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
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const selected = options.find(option => option.value === value)
  const hasIcons = options.some(option => option.icon)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

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
        onClick={() => setOpen(current => !current)}
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
            options.map(option => {
              const active = option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  className="cu-agent-select__option"
                  role="option"
                  aria-selected={active}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                    buttonRef.current?.focus()
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

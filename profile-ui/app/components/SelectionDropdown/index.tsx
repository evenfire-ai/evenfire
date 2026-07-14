'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@lib/cn'
import type { SelectionDropdownOption, SelectionDropdownProps } from './types'

function optionMatches(option: SelectionDropdownOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [option.label, option.description, option.badge]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(normalized))
}

function CheckIcon({ width = 14, height = 14 }: { width?: number; height?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  )
}

function XIcon({ width = 12, height = 12 }: { width?: number; height?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={width} height={height} aria-hidden="true">
      <path
        d="m18 6-12 12M6 6l12 12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.2"
      />
    </svg>
  )
}

export function SelectionDropdown({
  disabled = false,
  emptyLabel = 'No options available.',
  id,
  inline = false,
  multiple = true,
  onChange,
  options,
  placeholder,
  searchPlaceholder = 'Search...',
  selectionLabel = 'Selected',
  showSelectedChips = true,
  value,
}: SelectionDropdownProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const selectedSet = useMemo(() => new Set(value), [value])
  const selectedOptions = useMemo(
    () => options.filter(option => selectedSet.has(option.value)),
    [options, selectedSet]
  )
  const filteredOptions = useMemo(
    () => options.filter(option => optionMatches(option, query)),
    [options, query]
  )
  const menuVisible = inline || open

  useEffect(() => {
    if (!open || inline) return

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [inline, open])

  useEffect(() => {
    if (menuVisible) {
      window.setTimeout(() => searchRef.current?.focus(), 0)
    } else {
      setQuery('')
    }
  }, [menuVisible])

  function toggleOption(optionValue: string) {
    if (multiple) {
      onChange(
        selectedSet.has(optionValue)
          ? value.filter(item => item !== optionValue)
          : [...value, optionValue]
      )
      return
    }
    onChange(selectedSet.has(optionValue) ? [] : [optionValue])
    if (!inline) setOpen(false)
  }

  function clearOption(optionValue: string) {
    onChange(value.filter(item => item !== optionValue))
  }

  const buttonLabel =
    selectedOptions.length === 0
      ? placeholder
      : multiple && selectedOptions.length > 1
        ? `${selectedOptions.length} ${selectionLabel.toLowerCase()}`
        : selectedOptions[0]?.label

  return (
    <div
      className={cn('cu-selection-dropdown', inline && 'cu-selection-dropdown--inline')}
      ref={rootRef}
    >
      {inline ? null : (
        <button
          id={id}
          type="button"
          className={cn(
            'cu-selection-dropdown__button',
            selectedOptions.length === 0 && 'cu-selection-dropdown__button--placeholder'
          )}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen(current => !current)}
        >
          <span className="cu-selection-dropdown__button-copy">{buttonLabel}</span>
          <span className="cu-selection-dropdown__chevron" aria-hidden="true" />
        </button>
      )}

      {showSelectedChips && multiple && selectedOptions.length > 0 ? (
        <div className="cu-selection-dropdown__chips" aria-label={selectionLabel}>
          {selectedOptions.map(option => (
            <span className="cu-selection-dropdown__chip" key={option.value}>
              <span className="cu-selection-dropdown__chip-label">{option.label}</span>
              <button
                type="button"
                className="cu-selection-dropdown__chip-remove"
                onClick={() => clearOption(option.value)}
                disabled={disabled}
                aria-label={`Remove ${option.label}`}
              >
                <XIcon />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {menuVisible ? (
        <div className="cu-selection-dropdown__menu">
          <input
            id={inline ? id : undefined}
            ref={searchRef}
            className="cu-selection-dropdown__search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            disabled={disabled}
          />
          <div
            className="cu-selection-dropdown__list"
            role="listbox"
            aria-multiselectable={multiple}
          >
            {filteredOptions.length === 0 ? (
              <span className="cu-selection-dropdown__empty">{emptyLabel}</span>
            ) : (
              filteredOptions.map(option => {
                const selected = selectedSet.has(option.value)
                return (
                  <button
                    key={option.value}
                    type="button"
                    className="cu-selection-dropdown__option"
                    role="option"
                    aria-label={option.label}
                    aria-selected={selected}
                    data-selected={selected ? 'true' : undefined}
                    onClick={() => toggleOption(option.value)}
                  >
                    <span className="cu-selection-dropdown__check" aria-hidden="true">
                      {selected ? <CheckIcon /> : null}
                    </span>
                    <span className="cu-selection-dropdown__option-copy">
                      <span className="cu-selection-dropdown__option-label">{option.label}</span>
                      {option.description ? (
                        <span className="cu-selection-dropdown__option-description">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.badge ? (
                      <span className="cu-selection-dropdown__badge">{option.badge}</span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconX } from '@components/icons'
import { cn } from '@lib/cn'
import type { SelectionDropdownOption, SelectionDropdownProps } from './types'

function optionMatches(option: SelectionDropdownOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [option.label, option.description, option.badge]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(normalized))
}

export function SelectionDropdown({
  ariaLabel,
  className,
  disabled = false,
  emptyLabel = 'No options available.',
  id,
  inline = false,
  invalid = false,
  multiple = true,
  onChange,
  onSearchQueryChange,
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
      onSearchQueryChange?.('')
    }
  }, [menuVisible, onSearchQueryChange])

  function toggleOption(optionValue: string) {
    if (multiple) {
      onChange(
        selectedSet.has(optionValue)
          ? value.filter(item => item !== optionValue)
          : [...value, optionValue]
      )
      return
    }
    onChange([optionValue])
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
      className={cn('cu-selection-dropdown', inline && 'cu-selection-dropdown--inline', className)}
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
          aria-invalid={invalid || undefined}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => setOpen(current => !current)}
        >
          <span className="cu-selection-dropdown__button-value">
            {selectedOptions.length === 1 ? selectedOptions[0]?.icon : null}
            <span className="cu-selection-dropdown__button-copy">{buttonLabel}</span>
          </span>
          <span className="cu-selection-dropdown__chevron" aria-hidden="true" />
        </button>
      )}

      {showSelectedChips && multiple && selectedOptions.length > 0 ? (
        <div className="cu-selection-dropdown__chips" aria-label={selectionLabel}>
          {selectedOptions.map(option => (
            <span className="cu-selection-dropdown__chip" key={option.value}>
              {option.icon}
              <span className="cu-selection-dropdown__chip-label">{option.label}</span>
              <button
                type="button"
                className="cu-selection-dropdown__chip-remove"
                onClick={() => clearOption(option.value)}
                disabled={disabled}
                aria-label={`Remove ${option.label}`}
              >
                <IconX width={12} height={12} />
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
            onChange={event => {
              const nextQuery = event.target.value
              setQuery(nextQuery)
              onSearchQueryChange?.(nextQuery)
            }}
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
                    <span className="cu-selection-dropdown__option-leading" aria-hidden="true">
                      <span className="cu-selection-dropdown__check">
                        {selected ? <IconCheck width={14} height={14} /> : null}
                      </span>
                      {option.icon}
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

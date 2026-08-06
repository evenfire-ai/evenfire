'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconX } from '@components/icons'
import { cn } from '@lib/cn'
import type {
  SelectionDropdownMenuPosition,
  SelectionDropdownOption,
  SelectionDropdownProps,
} from './types'

const MENU_VIEWPORT_PADDING = 8
const MENU_TRIGGER_GAP = 4
const MENU_PREFERRED_HEIGHT = 288

function optionMatches(option: SelectionDropdownOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [option.label, option.description, option.badge]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(normalized))
}

export function SelectionDropdown({
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
  const [menuPosition, setMenuPosition] = useState<SelectionDropdownMenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
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

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false)
    window.setTimeout(() => buttonRef.current?.focus(), 0)
  }, [])

  const updateMenuPosition = useCallback(() => {
    const trigger = buttonRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const availableWidth = Math.max(0, window.innerWidth - MENU_VIEWPORT_PADDING * 2)
    const width = Math.min(rect.width, availableWidth)
    const left = Math.min(
      Math.max(MENU_VIEWPORT_PADDING, rect.left),
      Math.max(MENU_VIEWPORT_PADDING, window.innerWidth - width - MENU_VIEWPORT_PADDING)
    )
    const spaceBelow = window.innerHeight - rect.bottom - MENU_VIEWPORT_PADDING
    const spaceAbove = rect.top - MENU_VIEWPORT_PADDING
    const openAbove = spaceBelow < MENU_PREFERRED_HEIGHT && spaceAbove > spaceBelow

    setMenuPosition({
      left,
      width,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + MENU_TRIGGER_GAP }
        : { top: rect.bottom + MENU_TRIGGER_GAP }),
    })
  }, [])

  useEffect(() => {
    if (!open || inline) return

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeAndRestoreFocus()
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeAndRestoreFocus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeAndRestoreFocus, inline, open])

  useEffect(() => {
    if (!open || inline) return
    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [inline, open, updateMenuPosition])

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
    onChange(selectedSet.has(optionValue) ? [] : [optionValue])
    if (!inline) closeAndRestoreFocus()
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

  const menu = menuVisible ? (
    <div
      ref={menuRef}
      className={cn(
        'cu-selection-dropdown__menu',
        !inline && 'cu-selection-dropdown__menu--portal'
      )}
      {...(!inline && menuPosition
        ? {
            style: {
              top: menuPosition.top,
              bottom: menuPosition.bottom,
              left: menuPosition.left,
              width: menuPosition.width,
            },
          }
        : {})}
    >
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
      <div className="cu-selection-dropdown__list" role="listbox" aria-multiselectable={multiple}>
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
  ) : null

  return (
    <div
      className={cn('cu-selection-dropdown', inline && 'cu-selection-dropdown--inline', className)}
      ref={rootRef}
    >
      {inline ? null : (
        <button
          ref={buttonRef}
          id={id}
          type="button"
          className={cn(
            'cu-selection-dropdown__button',
            selectedOptions.length === 0 && 'cu-selection-dropdown__button--placeholder'
          )}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          disabled={disabled}
          onClick={() => {
            if (!open) updateMenuPosition()
            setOpen(current => !current)
          }}
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

      {inline
        ? menu
        : menu && typeof document !== 'undefined'
          ? createPortal(menu, document.body)
          : null}
    </div>
  )
}

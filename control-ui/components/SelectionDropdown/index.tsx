'use client'

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  menuClassName,
  multiple = true,
  onChange,
  onSearchQueryChange,
  options,
  placeholder,
  portal = false,
  searchable = true,
  searchPlaceholder = 'Search...',
  selectionLabel = 'Selected',
  showSelectedChips = true,
  value,
}: SelectionDropdownProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [portalPosition, setPortalPosition] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)
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

  useEffect(() => {
    if (!open || inline) return

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
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

  const updatePortalPosition = useCallback(() => {
    const trigger = buttonRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const gap = 4
    const viewportPadding = 8
    const estimatedHeight = Math.min(220, 8 + options.length * 43 + (searchable ? 48 : 0))
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
  }, [options.length, searchable])

  useLayoutEffect(() => {
    if (!portal || !menuVisible) return
    updatePortalPosition()
    window.addEventListener('resize', updatePortalPosition)
    window.addEventListener('scroll', updatePortalPosition, true)
    return () => {
      window.removeEventListener('resize', updatePortalPosition)
      window.removeEventListener('scroll', updatePortalPosition, true)
    }
  }, [menuVisible, portal, updatePortalPosition])

  useEffect(() => {
    if (menuVisible && searchable) {
      window.setTimeout(() => searchRef.current?.focus(), 0)
    } else {
      setQuery('')
      onSearchQueryChange?.('')
    }
  }, [menuVisible, onSearchQueryChange, searchable])

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

  const menu = menuVisible ? (
    <div
      className={cn(
        'cu-selection-dropdown__menu',
        portal && 'cu-selection-dropdown__menu--portal',
        menuClassName
      )}
      ref={menuRef}
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
      {searchable ? (
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
      ) : null}
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
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
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

      {portal && menu ? createPortal(menu, document.body) : menu}
    </div>
  )
}

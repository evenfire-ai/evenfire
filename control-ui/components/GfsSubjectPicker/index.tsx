'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SelectionDropdownOption } from '@components/SelectionDropdown/types'
import { IconX } from '@components/icons'
import { Button, TextInput } from '@components/ui'
import type { GfsSubjectPickerProps } from './types'

const SUBJECT_PICKER_LABEL = 'Add people, teams, agents, or workflows'

function optionMatches(option: SelectionDropdownOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [option.label, option.description, option.badge]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(normalized))
}

export function GfsSubjectPicker({
  disabled = false,
  loading = false,
  onChange,
  options,
  value,
}: GfsSubjectPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = useMemo(
    () => options.find(option => option.value === value) ?? null,
    [options, value]
  )
  const availableOptions = useMemo(
    () => options.filter(option => option.value !== value && optionMatches(option, query)),
    [options, query, value]
  )

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function selectSubject(option: SelectionDropdownOption) {
    onChange(option.value)
    setQuery('')
    setOpen(false)
  }

  function clearSubject() {
    onChange('')
    setQuery('')
    rootRef.current?.querySelector<HTMLInputElement>('.cu-gfs-subject-picker__input')?.focus()
  }

  return (
    <div className="cu-gfs-subject-picker" ref={rootRef}>
      <div
        aria-label="Grant subject"
        className={`cu-gfs-subject-picker__field${open ? ' is-open' : ''}`}
      >
        {selected ? (
          <span className="cu-gfs-subject-picker__chip">
            <span
              className={`cu-gfs-subject-picker__avatar cu-gfs-subject-picker__avatar--${selected.badge?.toLowerCase()}`}
              aria-hidden="true"
            >
              {selected.label.charAt(0).toUpperCase()}
            </span>
            <span className="cu-gfs-subject-picker__chip-label">{selected.label}</span>
            <Button
              aria-label={`Remove ${selected.label}`}
              className="cu-gfs-subject-picker__chip-remove"
              disabled={disabled}
              onClick={clearSubject}
              size="sm"
              variant="ghost"
            >
              <IconX width={12} height={12} />
            </Button>
          </span>
        ) : null}
        <TextInput
          aria-autocomplete="list"
          aria-controls="cu-gfs-subject-options"
          aria-expanded={open}
          aria-label={SUBJECT_PICKER_LABEL}
          autoComplete="off"
          className="cu-gfs-subject-picker__input"
          disabled={disabled}
          onChange={event => {
            setQuery(event.currentTarget.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={selected ? '' : SUBJECT_PICKER_LABEL}
          role="combobox"
          value={query}
        />
      </div>

      {open ? (
        <div
          aria-label="Available grant subjects"
          aria-multiselectable="false"
          className="cu-gfs-subject-picker__menu"
          id="cu-gfs-subject-options"
          role="listbox"
        >
          {loading ? (
            <span className="cu-gfs-subject-picker__empty">Loading subjects…</span>
          ) : availableOptions.length === 0 ? (
            <span className="cu-gfs-subject-picker__empty">
              {options.length === 1 && selected
                ? 'The available subject is selected.'
                : 'No subjects found.'}
            </span>
          ) : (
            availableOptions.map(option => (
              <Button
                aria-label={option.label}
                aria-selected="false"
                className="cu-gfs-subject-picker__option"
                key={option.value}
                onClick={() => selectSubject(option)}
                role="option"
                variant="ghost"
              >
                <span
                  className={`cu-gfs-subject-picker__avatar cu-gfs-subject-picker__avatar--${option.badge?.toLowerCase()}`}
                  aria-hidden="true"
                >
                  {option.label.charAt(0).toUpperCase()}
                </span>
                <span className="cu-gfs-subject-picker__option-copy">
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                <span className="cu-gfs-subject-picker__type">{option.badge}</span>
              </Button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

export type { GfsSubjectPickerProps } from './types'

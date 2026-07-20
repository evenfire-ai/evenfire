import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconButton, MenuItem, TextInput } from '@components/Common'
import { IconClose, IconTeams } from '@components/SidebarNav/icons'
import { useClickOutside } from '@hooks/useClickOutside'
import type { GfsDelegationSubjectOption } from '@/gfs/delegation.types'
import type { GfsSubjectPickerProps } from './types'

function subjectKey(subject: GfsDelegationSubjectOption): string {
  return `${subject.type}:${subject.id}`
}

function matchesQuery(subject: GfsDelegationSubjectOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [subject.label, subject.description, subject.type].some(value =>
    value?.toLowerCase().includes(normalized)
  )
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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const selectedSet = useMemo(() => new Set(value), [value])
  const selectedOptions = useMemo(
    () => options.filter(option => selectedSet.has(subjectKey(option))),
    [options, selectedSet]
  )
  const availableOptions = useMemo(
    () =>
      options.filter(option => !selectedSet.has(subjectKey(option)) && matchesQuery(option, query)),
    [options, query, selectedSet]
  )

  useClickOutside(rootRef, open, close)

  useEffect(() => {
    if (disabled) close()
  }, [close, disabled])

  const selectSubject = (subject: GfsDelegationSubjectOption) => {
    onChange([...value, subjectKey(subject)])
    setQuery('')
    setOpen(true)
    inputRef.current?.focus()
  }

  const removeSubject = (key: string) => {
    onChange(value.filter(item => item !== key))
    inputRef.current?.focus()
  }

  return (
    <div className="da-gfs-subject-picker" ref={rootRef}>
      <div
        className={`da-gfs-subject-picker__field${open ? ' is-open' : ''}`}
        aria-label="People and teams"
      >
        {selectedOptions.map(subject => {
          const key = subjectKey(subject)
          return (
            <span className="da-gfs-subject-picker__chip" key={key}>
              <span
                className={`da-gfs-subject-picker__avatar da-gfs-subject-picker__avatar--${subject.type}`}
                aria-hidden="true"
              >
                {subject.type === 'team' ? <IconTeams /> : subject.label.charAt(0).toUpperCase()}
              </span>
              <span className="da-gfs-subject-picker__chip-label">{subject.label}</span>
              <IconButton
                className="da-gfs-subject-picker__chip-remove"
                disabled={disabled}
                label={`Remove ${subject.label}`}
                onClick={() => removeSubject(key)}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </span>
          )
        })}
        <TextInput
          aria-autocomplete="list"
          aria-controls="gfs-subject-options"
          aria-expanded={open}
          aria-label="Add people or teams"
          autoComplete="off"
          className="da-gfs-subject-picker__input"
          disabled={disabled}
          onChange={event => {
            setQuery(event.currentTarget.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setOpen(false)
              return
            }
            if (event.key === 'Backspace' && !query && value.length > 0) {
              removeSubject(value[value.length - 1] ?? '')
            }
          }}
          placeholder={selectedOptions.length === 0 ? 'Add people or teams' : ''}
          ref={inputRef}
          role="combobox"
          value={query}
        />
      </div>

      {open ? (
        <div
          className="da-gfs-subject-picker__menu"
          id="gfs-subject-options"
          role="listbox"
          aria-label="Available people and teams"
          aria-multiselectable="true"
        >
          {loading ? (
            <span className="da-gfs-subject-picker__empty">Loading people and teams…</span>
          ) : availableOptions.length === 0 ? (
            <span className="da-gfs-subject-picker__empty">
              {options.length === selectedOptions.length
                ? 'Everyone available is selected.'
                : 'No people or teams found.'}
            </span>
          ) : (
            availableOptions.map(subject => (
              <MenuItem
                className="da-gfs-subject-picker__option"
                key={subjectKey(subject)}
                leadingIcon={
                  <span
                    className={`da-gfs-subject-picker__avatar da-gfs-subject-picker__avatar--${subject.type}`}
                    aria-hidden="true"
                  >
                    {subject.type === 'team' ? (
                      <IconTeams />
                    ) : (
                      subject.label.charAt(0).toUpperCase()
                    )}
                  </span>
                }
                onClick={() => selectSubject(subject)}
                role="option"
                aria-selected="false"
                trailingIcon={<span className="da-gfs-subject-picker__type">{subject.type}</span>}
              >
                <span className="da-gfs-subject-picker__option-copy">
                  <span>{subject.label}</span>
                  {subject.description ? <small>{subject.description}</small> : null}
                </span>
              </MenuItem>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

export type { GfsSubjectPickerProps } from './types'

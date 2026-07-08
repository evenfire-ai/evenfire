'use client'

import React, { useState } from 'react'
import { IconX } from '@components/icons'
import { Button, SelectInput, TextInput } from '@components/ui'
import type { ScopeDimensionConfig, ScopeSelectorProps } from './types'

// Per-dimension multi-value editor. Each dimension is independent (AND across
// dimensions); values within one dimension are ORed. Finite-option dimensions
// use a select-to-add control; free-text dimensions use a text input + Add.
export function ScopeSelector({
  dimensions,
  value,
  onChange,
  disabled,
  valueLabels,
}: ScopeSelectorProps) {
  function addValue(key: string, raw: string) {
    const v = raw.trim()
    if (!v) return
    const current = value[key] ?? []
    if (current.includes(v)) return
    onChange({ ...value, [key]: [...current, v] })
  }

  function removeValue(key: string, v: string) {
    const current = value[key] ?? []
    const next = current.filter(item => item !== v)
    const updated = { ...value }
    if (next.length === 0) delete updated[key]
    else updated[key] = next
    onChange(updated)
  }

  return (
    <div className="cu-tb-scope-editor">
      {dimensions.map(dimension => (
        <DimensionRow
          key={dimension.key}
          dimension={dimension}
          selected={value[dimension.key] ?? []}
          labels={valueLabels?.[dimension.key]}
          disabled={disabled}
          onAdd={raw => addValue(dimension.key, raw)}
          onRemove={v => removeValue(dimension.key, v)}
        />
      ))}
    </div>
  )
}

function DimensionRow({
  dimension,
  selected,
  labels,
  disabled,
  onAdd,
  onRemove,
}: {
  dimension: ScopeDimensionConfig
  selected: string[]
  labels?: Record<string, string>
  disabled?: boolean
  onAdd: (raw: string) => void
  onRemove: (value: string) => void
}) {
  const [draft, setDraft] = useState('')
  const listId = `cu-tb-scope-${dimension.key}-options`

  const optionLabel = (v: string): string => {
    if (labels?.[v]) return labels[v]
    const opt = dimension.options?.find(o => o.value === v)
    return opt ? opt.label : v
  }

  const availableOptions = dimension.options
    ? dimension.options.filter(o => !selected.includes(o.value))
    : null

  return (
    <div className="cu-tb-dim">
      <div className="cu-tb-dim__head">
        <span className="cu-tb-dim__label">{dimension.label}</span>
        {dimension.description ? (
          <span className="cu-tb-dim__hint">{dimension.description}</span>
        ) : null}
      </div>
      <div className="cu-tb-dim__control">
        {availableOptions ? (
          <SelectInput
            aria-label={`Add ${dimension.label} to scope`}
            value=""
            disabled={disabled || availableOptions.length === 0}
            onChange={event => {
              if (event.target.value) onAdd(event.target.value)
            }}
          >
            <option value="">
              {availableOptions.length === 0
                ? `All ${dimension.label.toLowerCase()} added`
                : `Add ${dimension.label.toLowerCase()}…`}
            </option>
            {availableOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        ) : (
          <div className="cu-tb-dim__freeform">
            <TextInput
              aria-label={`Add ${dimension.label} to scope`}
              list={dimension.suggestions?.length ? listId : undefined}
              monospace
              value={draft}
              placeholder={dimension.placeholder}
              disabled={disabled}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onAdd(draft)
                  setDraft('')
                }
              }}
            />
            {dimension.suggestions?.length ? (
              <datalist id={listId}>
                {dimension.suggestions.map(name => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || draft.trim().length === 0}
              onClick={() => {
                onAdd(draft)
                setDraft('')
              }}
            >
              Add
            </Button>
          </div>
        )}
      </div>
      {selected.length > 0 ? (
        <div className="cu-tb-dim__chips">
          {selected.map(v => (
            <span key={v} className="cu-tb-chip">
              <span className="cu-tb-chip__label">{optionLabel(v)}</span>
              <button
                type="button"
                className="cu-tb-chip__remove"
                disabled={disabled}
                onClick={() => onRemove(v)}
                aria-label={`Remove ${optionLabel(v)} from ${dimension.label} scope`}
              >
                <IconX width={12} height={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

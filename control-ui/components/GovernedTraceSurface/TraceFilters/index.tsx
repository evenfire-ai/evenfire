'use client'

import { useEffect } from 'react'
import { IconFilter, IconX } from '@components/icons'
import { Button, SelectInput, TextInput } from '@components/ui'
import {
  clearTraceFilters,
  traceActiveFilterCount,
  withTraceFilter,
  withoutTraceFilter,
} from '@lib/governedTraceFilters'
import type { TraceExplorationState, TraceTimeWindow } from '@lib/governedTraceFilters'
import { TraceFilterField } from './TraceFilterField'
import type { TraceFilterHeaderLabelProps, TraceFiltersProps } from './types'

export const TRACE_ALL_FILTERS_ID = '__all__'

function localDateTimeValue(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000)
  return local.toISOString().slice(0, 16)
}

function isoFromLocalDateTime(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function TraceTimeWindowControl({
  onChange,
  state,
}: {
  onChange: (next: TraceExplorationState) => void
  state: TraceExplorationState
}) {
  return (
    <SelectInput
      aria-label="Trace time window"
      compact
      onChange={event => {
        const window = event.target.value as TraceTimeWindow
        onChange({
          ...state,
          window,
          from: window === 'custom' ? state.from : null,
          to: window === 'custom' ? state.to : null,
        })
      }}
      value={state.window}
    >
      <option value="24h">Last 24 hours</option>
      <option value="7d">Last 7 days</option>
      <option value="30d">Last 30 days</option>
      <option value="custom">Custom UTC range</option>
    </SelectInput>
  )
}

export function TraceFilterHeaderLabel({
  activeCount,
  label,
  onOpen,
}: TraceFilterHeaderLabelProps) {
  return (
    <span className="cu-trace-filter-header">
      <span>{label}</span>
      <button
        aria-label={`Filter ${label}`}
        className="cu-trace-filter-header__button"
        data-active={activeCount > 0 ? 'true' : undefined}
        onClick={onOpen}
        title={`Filter ${label}`}
        type="button"
      >
        <IconFilter height={14} width={14} />
        {activeCount ? <span>{activeCount}</span> : null}
      </button>
    </span>
  )
}

export function TraceFilters({
  definitions,
  invalidRange,
  onChange,
  onClose,
  onOpenAll,
  openFilterId,
  state,
}: TraceFiltersProps) {
  const activeEntries = Object.entries(state.filters).filter(([, values]) => values.length)
  const activeCount = traceActiveFilterCount(state)
  const fieldLabels = new Map(
    definitions.flatMap(definition =>
      definition.fields.map(field => [field.key, field.label] as const)
    )
  )
  const visibleDefinitions =
    openFilterId === TRACE_ALL_FILTERS_ID
      ? definitions
      : definitions.filter(definition => definition.id === openFilterId)

  useEffect(() => {
    if (!openFilterId) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, openFilterId])

  return (
    <>
      <div className="cu-trace-filter-summary">
        <button
          aria-label={`Open filters${activeCount ? `, ${activeCount} active` : ''}`}
          className="cu-btn cu-btn--sm cu-trace-filter-summary__mobile"
          onClick={onOpenAll}
          type="button"
        >
          <IconFilter height={15} width={15} />
          Filters
          {activeCount ? <span>{activeCount}</span> : null}
        </button>
        {state.window === 'custom' ? (
          <div className="cu-trace-custom-range" aria-label="Custom trace time range">
            <label>
              <span>From</span>
              <TextInput
                compact
                onChange={event =>
                  onChange({ ...state, from: isoFromLocalDateTime(event.target.value) })
                }
                type="datetime-local"
                value={localDateTimeValue(state.from)}
              />
            </label>
            <label>
              <span>To</span>
              <TextInput
                compact
                onChange={event =>
                  onChange({ ...state, to: isoFromLocalDateTime(event.target.value) })
                }
                type="datetime-local"
                value={localDateTimeValue(state.to)}
              />
            </label>
            <span className="cu-table__cell-muted">Converted to UTC</span>
          </div>
        ) : null}
        {activeEntries.length ? (
          <div className="cu-trace-filter-chips" aria-label="Active trace filters">
            {activeEntries.map(([key, values]) => (
              <span className="cu-trace-filter-chip" key={key}>
                <span>
                  {fieldLabels.get(key) ?? key}: {values.join(', ')}
                </span>
                <button
                  aria-label={`Remove ${fieldLabels.get(key) ?? key} filter`}
                  onClick={() => onChange(withoutTraceFilter(state, key))}
                  type="button"
                >
                  <IconX height={12} width={12} />
                </button>
              </span>
            ))}
            <Button onClick={() => onChange(clearTraceFilters(state))} size="sm" variant="ghost">
              Clear all
            </Button>
          </div>
        ) : (
          <span className="cu-trace-filter-summary__empty">No column filters applied</span>
        )}
        {invalidRange ? (
          <span className="cu-trace-filter-error" role="alert">
            {invalidRange}
          </span>
        ) : null}
      </div>

      {openFilterId ? (
        <div
          className="cu-modal-overlay"
          onMouseDown={event => {
            if (event.currentTarget === event.target) onClose()
          }}
          role="presentation"
        >
          <section
            aria-label={
              openFilterId === TRACE_ALL_FILTERS_ID
                ? 'Trace filters'
                : `${visibleDefinitions[0]?.label} filters`
            }
            aria-modal="true"
            className="cu-modal-panel cu-modal-panel--selection cu-trace-filter-dialog"
            role="dialog"
          >
            <div className="cu-modal-panel__head">
              <div>
                <h2 className="cu-modal-panel__title">
                  {openFilterId === TRACE_ALL_FILTERS_ID
                    ? 'Trace filters'
                    : `${visibleDefinitions[0]?.label} filters`}
                </h2>
                <p className="cu-modal-copy">Filters run against the governed ledger.</p>
              </div>
              <button
                aria-label="Close trace filters"
                className="cu-btn cu-btn--icon"
                onClick={onClose}
                type="button"
              >
                <IconX height={18} width={18} />
              </button>
            </div>
            <div className="cu-modal-panel__body cu-trace-filter-dialog__body">
              {visibleDefinitions.map(definition => (
                <section className="cu-trace-filter-group" key={definition.id}>
                  <h3>{definition.label}</h3>
                  <div className="cu-trace-filter-group__fields">
                    {definition.fields.map(field => (
                      <TraceFilterField
                        definition={field}
                        key={field.key}
                        onChange={values => onChange(withTraceFilter(state, field.key, values))}
                        values={state.filters[field.key] ?? []}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <div className="cu-modal-panel__foot">
              {activeEntries.length ? (
                <Button onClick={() => onChange(clearTraceFilters(state))} variant="ghost">
                  Clear all
                </Button>
              ) : null}
              <Button onClick={onClose} variant="primary">
                Done
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

'use client'

import React, { useMemo, useState } from 'react'
import { IconAlertTriangle, IconX } from '../icons'
import { NATIVE_TOOLS } from './constants'
import { useApprovalToolsDraft } from './hooks'
import type { HostApprovalSectionProps, RowState } from './types'

const ROW_STATE_LABELS: Record<RowState, string> = {
  default: 'Default',
  required: 'Required',
  skip: 'Skip',
}

const KNOWN_TOOL_NAMES = new Set(NATIVE_TOOLS.map(t => t.name))
const CUSTOM_NAME_RE = /^[a-z][a-z0-9_]*$/

function validateCustomName(value: string, existingCustomNames: string[]): string | null {
  if (!value.trim()) return null // empty is "not yet typed", not an error
  if (!CUSTOM_NAME_RE.test(value)) {
    return 'Use lower snake_case (start with a letter; letters, digits, underscore).'
  }
  if (KNOWN_TOOL_NAMES.has(value)) {
    return `"${value}" is already in the always-on list above — toggle that row instead. Custom names must not collide.`
  }
  if (existingCustomNames.includes(value)) {
    return `"${value}" is already in your custom rows below. Edit or remove that row instead.`
  }
  return null
}

export function HostApprovalSection({
  initialTools,
  onSave,
  busy,
  canWrite,
}: HostApprovalSectionProps) {
  const [editing, setEditing] = useState(false)
  const draftAPI = useApprovalToolsDraft(initialTools)

  // Build a sorted view that pairs each known-tool meta with its current state.
  const knownRows = useMemo(
    () =>
      [...NATIVE_TOOLS]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(meta => ({
          meta,
          state: (draftAPI.draft.rows[meta.name] ?? 'default') as RowState,
        })),
    [draftAPI.draft.rows]
  )

  // Read-only summary list (only overridden rows)
  const readOnlyRows = useMemo(() => {
    const rows: Array<{
      name: string
      state: Exclude<RowState, 'default'>
      meta?: (typeof NATIVE_TOOLS)[number]
    }> = []
    for (const k of knownRows) {
      if (k.state !== 'default') {
        rows.push({ name: k.meta.name, state: k.state, meta: k.meta })
      }
    }
    for (const c of draftAPI.draft.customRows) {
      rows.push({ name: c.name, state: c.state })
    }
    return rows
  }, [knownRows, draftAPI.draft.customRows])

  function handleCancel() {
    draftAPI.reset()
    setEditing(false)
  }

  async function handleSave() {
    try {
      await onSave(draftAPI.toToolsMap())
      setEditing(false)
    } catch {
      // Parent surfaced an error banner. Stay in edit mode so the operator's
      // draft survives the failure and they can retry or Cancel.
    }
  }

  return (
    <div
      style={{
        marginTop: '2rem',
        paddingTop: '1.25rem',
        borderTop: '1px solid var(--cu-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <p className="cu-section-title" style={{ marginBottom: '0.5rem' }}>
          Per-tool approval
        </p>
        {!editing && canWrite && (
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            Edit
          </button>
        )}
      </div>

      <p className="cu-muted" style={{ fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
        Skip or require approval for individual tools when an agent calls them. Defaults to the
        safest setting per tool. Changes apply to the next task.
      </p>

      {!editing ? (
        readOnlyRows.length === 0 ? (
          <div className="cu-empty">
            No per-tool overrides configured. All tools use their built-in approval defaults.
          </div>
        ) : (
          <div>
            {readOnlyRows.map(row => (
              <ReadOnlyRow
                key={row.name}
                name={row.name}
                state={row.state}
                riskHint={row.meta?.riskHint}
                codeDefault={row.meta?.codeDefault}
              />
            ))}
          </div>
        )
      ) : (
        <EditMode
          knownRows={knownRows}
          draftAPI={draftAPI}
          busy={busy}
          onCancel={handleCancel}
          onSave={handleSave}
        />
      )}
    </div>
  )
}

function ReadOnlyRow({
  name,
  state,
  riskHint,
  codeDefault,
}: {
  name: string
  state: Exclude<RowState, 'default'>
  riskHint?: string
  codeDefault?: 'required' | 'skip'
}) {
  const isRisky = state === 'skip' && codeDefault === 'required' && !!riskHint
  return (
    <div className="cu-access-row">
      <span>{name}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span>{ROW_STATE_LABELS[state]}</span>
        {isRisky && (
          <span title={riskHint} style={{ color: 'var(--cu-warning)', display: 'inline-flex' }}>
            <IconAlertTriangle />
          </span>
        )}
      </span>
    </div>
  )
}

interface EditModeProps {
  knownRows: Array<{ meta: (typeof NATIVE_TOOLS)[number]; state: RowState }>
  draftAPI: ReturnType<typeof useApprovalToolsDraft>
  busy: boolean
  onCancel: () => void
  onSave: () => void
}

function EditMode({ knownRows, draftAPI, busy, onCancel, onSave }: EditModeProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customState, setCustomState] = useState<Exclude<RowState, 'default'>>('required')

  const customError = validateCustomName(
    customName,
    draftAPI.draft.customRows.map(r => r.name)
  )

  function handleAdd() {
    if (customError || !customName.trim()) return
    draftAPI.addCustomRow(customName.trim(), customState)
    setCustomName('')
    setCustomState('required')
  }

  return (
    <>
      {knownRows.map(row => {
        const isRisky =
          row.state === 'skip' && row.meta.codeDefault === 'required' && !!row.meta.riskHint
        return (
          <div key={row.meta.name} className="cu-access-row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>
                <label htmlFor={`approval-${row.meta.name}`}>{row.meta.name}</label>
              </div>
              <div className="cu-muted" style={{ fontSize: '0.8125rem' }}>
                {row.meta.description}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <select
                id={`approval-${row.meta.name}`}
                value={row.state}
                onChange={e => draftAPI.setRowState(row.meta.name, e.target.value as RowState)}
                disabled={busy}
              >
                {/* "Default" annotates what it resolves to so the operator
                    sees the effective behavior without consulting docs. */}
                <option value="default">
                  {ROW_STATE_LABELS.default} (
                  {row.meta.codeDefault === 'required'
                    ? ROW_STATE_LABELS.required
                    : ROW_STATE_LABELS.skip}
                  )
                </option>
                <option value="required">{ROW_STATE_LABELS.required}</option>
                <option value="skip">{ROW_STATE_LABELS.skip}</option>
              </select>
              {isRisky && (
                <span
                  title={row.meta.riskHint}
                  style={{ color: 'var(--cu-warning)', display: 'inline-flex' }}
                >
                  <IconAlertTriangle />
                </span>
              )}
            </div>
          </div>
        )
      })}

      <div style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className="cu-btn cu-btn--ghost cu-btn--sm"
          onClick={() => setAdvancedOpen(o => !o)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? '▾' : '▸'} Advanced: conditional tools
        </button>

        {advancedOpen && (
          <div style={{ marginTop: '0.5rem' }}>
            <div className="cu-field">
              <label htmlFor="custom-tool-name">Tool name</label>
              <input
                id="custom-tool-name"
                type="text"
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                disabled={busy}
                placeholder="memory_search"
                aria-describedby={customError ? 'custom-tool-name-error' : 'custom-tool-name-hint'}
                aria-invalid={!!customError}
              />
              <div id="custom-tool-name-hint" className="cu-field__hint">
                For tools that register conditionally — memory_*, desktop_*, cron_*. Match the tool
                name as it appears in mcp-host logs.
              </div>
              {customError && (
                <div id="custom-tool-name-error" className="cu-field__error">
                  {customError}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <select
                value={customState}
                onChange={e => setCustomState(e.target.value as Exclude<RowState, 'default'>)}
                disabled={busy}
                aria-label="Approval state for the new custom tool"
              >
                <option value="required">{ROW_STATE_LABELS.required}</option>
                <option value="skip">{ROW_STATE_LABELS.skip}</option>
              </select>
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={handleAdd}
                disabled={busy || !!customError || !customName.trim()}
              >
                Add
              </button>
            </div>

            {draftAPI.draft.customRows.length > 0 && (
              <div style={{ marginTop: '0.5rem' }}>
                {draftAPI.draft.customRows.map((row, idx) => (
                  <div key={`${row.name}-${idx}`} className="cu-access-row">
                    <span>{row.name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span>{ROW_STATE_LABELS[row.state]}</span>
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        aria-label={`Remove ${row.name}`}
                        onClick={() => draftAPI.removeCustomRow(idx)}
                        disabled={busy}
                      >
                        <IconX />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="cu-save-bar">
        <button
          type="button"
          className="cu-btn cu-btn--ghost cu-btn--sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cu-btn cu-btn--primary"
          onClick={onSave}
          disabled={busy || !draftAPI.isDirty}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )
}

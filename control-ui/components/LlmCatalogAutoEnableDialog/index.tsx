'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DataTable, DialogShell, TableStateRow } from '@clerum/frontend-components'
import { LlmProviderIcon } from '@components/LlmProviderIcon'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { useToast } from '@components/Toast'
import { CheckboxField } from '@components/ui'
import {
  getLlmProviderCatalogPolicies,
  isCatalogSyncInProgressError,
  isSilentApiError,
  setLlmProviderCatalogAutoEnable,
} from '@lib/api'
import type { LlmProviderCatalogPolicy } from '@lib/api.types'
import { formatLocalTimestamp, getProviderDisplayLabel } from '@lib/llm'
import type { LlmCatalogAutoEnableDialogProps } from './types'

const COLUMNS: TableHeaderColumn[] = [
  { key: 'provider', label: 'Provider', minWidth: '10rem' },
  { key: 'autoEnable', label: 'Auto-enable new models', width: '11rem' },
  { key: 'setting', label: 'Setting', width: '11rem' },
  { key: 'changed', label: 'Last change', minWidth: '12rem' },
]

function toggleErrorMessage(caught: unknown, label: string): string {
  if (isCatalogSyncInProgressError(caught)) {
    return `A catalog sync is running, so the ${label} setting was not saved. Try again in a moment.`
  }
  const detail = caught instanceof Error ? caught.message : 'unknown error'
  return `The ${label} setting was not saved: ${detail}`
}

export function LlmCatalogAutoEnableDialog({ open, onDismiss }: LlmCatalogAutoEnableDialogProps) {
  const { showToast } = useToast()
  const [policies, setPolicies] = useState<LlmProviderCatalogPolicy[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())
  // Each open (and each retry) starts a new generation so a slow read from an
  // earlier open can never overwrite the rows of the current one.
  const loadGeneration = useRef(0)

  async function load() {
    const generation = ++loadGeneration.current
    setLoading(true)
    setLoadError('')
    setPolicies(null)
    try {
      const next = await getLlmProviderCatalogPolicies()
      if (generation === loadGeneration.current) setPolicies(next)
    } catch (caught) {
      if (isSilentApiError(caught) || generation !== loadGeneration.current) return
      setLoadError(
        caught instanceof Error ? caught.message : 'Failed to load the auto-enable settings'
      )
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  // Rows from a previous open are dropped before the read, so nothing is
  // clickable until this open's GET lands. Otherwise a toggle confirmed while
  // the GET is in flight could be overwritten by that GET's older snapshot.
  useEffect(() => {
    if (!open) return
    setPolicies(null)
    setSaveError('')
    void load()
  }, [open])

  const rows = useMemo(
    () =>
      (policies ?? [])
        .map(policy => ({ policy, label: getProviderDisplayLabel(policy.provider) }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [policies]
  )

  // The row is only ever replaced by the server's response: a failed save
  // leaves the last confirmed state on screen, so there is nothing to roll back.
  async function handleToggle(policy: LlmProviderCatalogPolicy, label: string) {
    const nextValue = !policy.auto_enable
    setPending(current => new Set(current).add(policy.provider))
    setSaveError('')
    try {
      const saved = await setLlmProviderCatalogAutoEnable(policy.provider, nextValue)
      setPolicies(current =>
        current ? current.map(row => (row.provider === saved.provider ? saved : row)) : current
      )
      showToast(
        saved.auto_enable
          ? `${label}: eligible new models that a live catalog sync finds will start enabled.`
          : `${label}: new models that the catalog sync finds will start disabled.`,
        { tone: 'success' }
      )
    } catch (caught) {
      if (isSilentApiError(caught)) return
      setSaveError(toggleErrorMessage(caught, label))
    } finally {
      setPending(current => {
        const next = new Set(current)
        next.delete(policy.provider)
        return next
      })
    }
  }

  const busy = pending.size > 0

  return (
    <DialogShell
      open={open}
      onDismiss={() => onDismiss()}
      title="Auto-enable new models"
      description="Choose, per provider, whether eligible new models that a live catalog sync finds start enabled (text output, tool calling, stable release, runnable model id), when auto-enable is turned on for this deployment. Models already in the catalog keep their current state, and this setting never disables a model."
      error={saveError || undefined}
      busy={busy}
      size="large"
      footer={
        <>
          {loadError ? (
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={() => onDismiss()}
            disabled={busy}
          >
            Done
          </button>
        </>
      }
    >
      <DataTable className="eft-table cu-table cu-table--header-band">
        <thead>
          <TableHeaderRow columns={COLUMNS} />
        </thead>
        <tbody>
          {loading ? (
            <TableStateRow
              colSpan={COLUMNS.length}
              kind="loading"
              message="Loading auto-enable settings…"
            />
          ) : loadError ? (
            <TableStateRow
              colSpan={COLUMNS.length}
              kind="error"
              message={`The auto-enable settings could not be loaded: ${loadError}`}
            />
          ) : rows.length === 0 ? (
            <TableStateRow
              colSpan={COLUMNS.length}
              message="No providers use the public model catalog."
            />
          ) : (
            rows.map(({ policy, label }) => {
              const saving = pending.has(policy.provider)
              return (
                <tr key={policy.provider} className="cu-table__row">
                  <td>
                    <span className="cu-llm-auto-enable__provider">
                      <LlmProviderIcon provider={policy.provider} label={label} />
                      <span>{label}</span>
                    </span>
                  </td>
                  <td>
                    <CheckboxField
                      className="cu-checkbox-field--centered"
                      checked={policy.auto_enable}
                      disabled={saving}
                      onChange={() => void handleToggle(policy, label)}
                      aria-label={`Auto-enable new ${label} models`}
                      label={saving ? 'Saving…' : policy.auto_enable ? 'On' : 'Off'}
                    />
                  </td>
                  <td>
                    {policy.overridden ? (
                      <span className="cu-llm-auto-enable__setting">
                        <span className="cu-px-badge cu-px-badge--info">Custom</span>
                        <span className="cu-llm-auto-enable__hint">
                          Default: {policy.default ? 'On' : 'Off'}
                        </span>
                      </span>
                    ) : (
                      <span className="cu-px-badge cu-px-badge--off">Default</span>
                    )}
                  </td>
                  <td className="cu-llm-auto-enable__hint">
                    {policy.overridden
                      ? `${policy.updated_by ?? 'Unknown admin'} · ${formatLocalTimestamp(
                          policy.updated_at
                        )}`
                      : '—'}
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </DataTable>
    </DialogShell>
  )
}

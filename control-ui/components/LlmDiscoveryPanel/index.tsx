'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { IconModels } from '@components/Sidebar/icons'
import { SkeletonTableRows } from '@components/SkeletonTableRows'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { IconRefresh, IconTrash } from '@components/icons'
import {
  type LlmAllowedModel,
  type LlmDiscoveryStatus,
  deleteLlmModel,
  getDiscoveryStatus,
  getLlmModels,
  isLlmModelConfigMapDeferred,
  isSilentApiError,
  syncDiscovery,
  updateLlmModel,
} from '@lib/api'
import { formatContextWindow, getProviderDisplayLabel } from '@lib/llm'

// Surfaced when a mutation persisted but the runtime ConfigMap write is delayed
// (503 configmap_write_failed): the change is saved, only propagation lags.
const CONFIGMAP_DEFERRED_WARNING =
  'Propagation to the cluster is delayed and will reconcile shortly.'

const REVIEW_COLUMNS: TableHeaderColumn[] = [
  { key: 'provider', label: 'Provider', width: '12%' },
  { key: 'model', label: 'Model', minWidth: '12rem' },
  { key: 'vendor', label: 'Vendor', width: '10rem' },
  { key: 'contextWindow', label: 'Context window', align: 'right', width: '9rem' },
  { key: 'actions', width: '7rem', align: 'right', ariaLabel: 'Actions' },
]

const STALE_COLUMNS: TableHeaderColumn[] = [
  { key: 'provider', label: 'Provider', width: '12%' },
  { key: 'model', label: 'Model', minWidth: '12rem' },
  { key: 'vendor', label: 'Vendor', width: '10rem' },
  { key: 'contextWindow', label: 'Context window', align: 'right', width: '9rem' },
  { key: 'status', label: 'Status', width: '9rem' },
  { key: 'actions', width: '11rem', align: 'right', ariaLabel: 'Actions' },
]

function modelLabel(model: LlmAllowedModel): string {
  return `${getProviderDisplayLabel(model.provider)}/${model.model}`
}

function formatRunAt(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

// The operator's review surface for catalog discovery (spec 09 §7, F2).
// Discovery seeds `llm_allowed_models` with `source='discovery', enabled=false`;
// this panel lets the operator sync a fresh catalog, then enable models out of
// the review queue and triage models that vanished from the catalog (stale).
export function LlmDiscoveryPanel() {
  const { authState } = useAuth()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const [models, setModels] = useState<LlmAllowedModel[]>([])
  const [status, setStatus] = useState<LlmDiscoveryStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [bulkEnabling, setBulkEnabling] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const isInitialLoad = loading && models.length === 0

  // Newly discovered rows awaiting enablement. Stale rows are excluded here and
  // handled in their own list — enabling a model that vanished from the catalog
  // is not the "review a fresh catalog" action, and excluding them keeps a row
  // from appearing in both tables.
  const reviewQueue = useMemo(
    () => models.filter(m => m.source === 'discovery' && !m.enabled && !m.stale),
    [models]
  )
  const staleModels = useMemo(
    () => models.filter(m => m.source === 'discovery' && m.stale),
    [models]
  )

  const selectedCount = useMemo(
    () => reviewQueue.reduce((count, m) => (selectedIds.has(m.id) ? count + 1 : count), 0),
    [reviewQueue, selectedIds]
  )
  const allSelected = reviewQueue.length > 0 && selectedCount === reviewQueue.length

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      // Status is optional (endpoint may not be deployed) — a failure there must
      // not hide the review queue.
      const [modelsResult, statusResult] = await Promise.allSettled([
        getLlmModels(),
        getDiscoveryStatus(),
      ])
      if (modelsResult.status === 'fulfilled') {
        setModels(modelsResult.value.rows ?? [])
      } else if (!isSilentApiError(modelsResult.reason)) {
        throw modelsResult.reason
      }
      setStatus(statusResult.status === 'fulfilled' ? statusResult.value : null)
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load discovered models')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      void loadAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState.isLoggedIn, authState.isLoading])

  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelectedIds(prev => {
      if (reviewQueue.every(m => prev.has(m.id)) && reviewQueue.length > 0) {
        return new Set()
      }
      return new Set(reviewQueue.map(m => m.id))
    })
  }

  async function handleSync() {
    setSyncing(true)
    setError('')
    try {
      const result = await syncDiscovery()
      await loadAll()
      // Seed the "last synced" line from the sync result AFTER loadAll, so it
      // reflects this run even when the optional status endpoint is absent
      // (loadAll would leave `status` null on a 404). `result.ranAt` is the DB
      // commit time — the SAME value the status endpoint reports — so the label
      // is stable across a reload.
      setStatus({
        ranAt: result.ranAt,
        source: result.source,
        added: result.added,
        updated: result.updated,
        staled: result.staled,
      })
      showToast(
        `Synced from ${result.source}: +${result.added} new, ${result.updated} updated, ${result.staled} marked stale`,
        { tone: 'success' }
      )
    } catch (e) {
      if (isSilentApiError(e)) return
      const message = e instanceof Error ? e.message : 'Discovery sync failed'
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setSyncing(false)
    }
  }

  async function handleEnable(model: LlmAllowedModel) {
    const label = modelLabel(model)
    setPendingId(model.id)
    setError('')
    try {
      await updateLlmModel(model.id, { enabled: true })
      await loadAll()
      showToast(`${label} enabled.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      if (isLlmModelConfigMapDeferred(e)) {
        await loadAll()
        showToast(`${label} enabled. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      const message = e instanceof Error ? e.message : `Failed to enable ${label}`
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setPendingId(null)
    }
  }

  async function handleBulkEnable() {
    const targets = reviewQueue.filter(m => selectedIds.has(m.id))
    if (targets.length === 0) return
    setBulkEnabling(true)
    setError('')
    // No batch route exists (lib/api.ts): enable is N independent PUTs.
    // Promise.allSettled never rejects; the finally is defensive so the button
    // never stays stuck if loadAll's contract ever changes.
    let results: PromiseSettledResult<unknown>[] = []
    try {
      results = await Promise.allSettled(targets.map(m => updateLlmModel(m.id, { enabled: true })))
      setSelectedIds(new Set())
      await loadAll()
    } finally {
      setBulkEnabling(false)
    }

    if (results.some(r => r.status === 'rejected' && isSilentApiError(r.reason))) return
    const deferred = results.some(
      r => r.status === 'rejected' && isLlmModelConfigMapDeferred(r.reason)
    )
    const hardFailures = results.filter(
      r => r.status === 'rejected' && !isLlmModelConfigMapDeferred(r.reason)
    ).length
    const succeeded = targets.length - hardFailures
    if (hardFailures === 0) {
      showToast(
        `Enabled ${succeeded} model${succeeded === 1 ? '' : 's'}.${
          deferred ? ` ${CONFIGMAP_DEFERRED_WARNING}` : ''
        }`,
        { tone: deferred ? 'info' : 'success' }
      )
    } else {
      const message = `Enabled ${succeeded} of ${targets.length} models; ${hardFailures} failed.`
      setError(message)
      showToast(message, { tone: 'error' })
    }
  }

  async function handleDisable(model: LlmAllowedModel) {
    const label = modelLabel(model)
    setPendingId(model.id)
    setError('')
    try {
      await updateLlmModel(model.id, { enabled: false })
      await loadAll()
      showToast(`${label} disabled.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      if (isLlmModelConfigMapDeferred(e)) {
        await loadAll()
        showToast(`${label} disabled. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      const message = e instanceof Error ? e.message : `Failed to disable ${label}`
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setPendingId(null)
    }
  }

  async function handleDelete(model: LlmAllowedModel) {
    const label = modelLabel(model)
    const shouldDelete = await confirm({
      title: 'Delete stale model',
      message: `Remove ${label} from the catalog? It already vanished from the provider's catalog. Existing agents keep running, but it can no longer be selected.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setPendingId(model.id)
    setError('')
    try {
      await deleteLlmModel(model.id)
      await loadAll()
      showToast(`${label} removed from the catalog.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      if (isLlmModelConfigMapDeferred(e)) {
        await loadAll()
        showToast(`${label} removed. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      const message = e instanceof Error ? e.message : `Failed to delete ${label}`
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setPendingId(null)
    }
  }

  const lastSyncedLabel = status ? `${formatRunAt(status.ranAt)} (${status.source})` : null

  const reviewColumns: TableHeaderColumn[] = [
    {
      key: 'select',
      width: '2.75rem',
      label: (
        <input
          type="checkbox"
          checked={allSelected}
          ref={el => {
            if (el) el.indeterminate = selectedCount > 0 && !allSelected
          }}
          onChange={toggleAll}
          disabled={reviewQueue.length === 0 || bulkEnabling}
          aria-label={allSelected ? 'Deselect all models' : 'Select all models'}
        />
      ),
    },
    ...REVIEW_COLUMNS,
  ]

  return (
    <>
      {error ? (
        <div className="cu-banner cu-banner--error" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      ) : null}

      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconModels />
              {isInitialLoad ? 'Discovery review' : `Discovery review (${reviewQueue.length})`}
            </>
          }
          subtitle="Models pulled from the public catalog arrive disabled. Review and enable the ones you want available to agents and runtime."
          actions={
            <>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => void loadAll()}
                disabled={loading || isInitialLoad}
                aria-label={loading ? 'Refreshing…' : 'Reload discovered models'}
              >
                <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => void handleSync()}
                disabled={syncing || isInitialLoad}
              >
                {syncing ? 'Syncing…' : 'Sync catalog'}
              </button>
            </>
          }
        />

        <div className="cu-discovery-status" role="status">
          {lastSyncedLabel
            ? `Last synced ${lastSyncedLabel}`
            : 'Not synced yet. Run a sync to pull the latest catalog.'}
        </div>

        {selectedCount > 0 ? (
          <div className="cu-discovery-bulkbar">
            <span className="cu-muted">{selectedCount} selected</span>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => void handleBulkEnable()}
              disabled={bulkEnabling}
            >
              {bulkEnabling ? 'Enabling…' : `Enable ${selectedCount} selected`}
            </button>
          </div>
        ) : null}

        {isInitialLoad ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={reviewColumns} />
              </thead>
              <tbody>
                <SkeletonTableRows columns={reviewColumns.length} rows={4} />
              </tbody>
            </table>
          </div>
        ) : reviewQueue.length === 0 ? (
          <div className="cu-empty">
            No models awaiting review. Sync the catalog to pull newly released models.
          </div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={reviewColumns} />
              </thead>
              <tbody>
                {reviewQueue.map(model => (
                  <tr key={model.id} className="cu-table__row">
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(model.id)}
                        onChange={() => toggleRow(model.id)}
                        disabled={bulkEnabling}
                        aria-label={`Select ${modelLabel(model)}`}
                      />
                    </td>
                    <td>{getProviderDisplayLabel(model.provider)}</td>
                    <td className="cu-px-model">{model.model}</td>
                    <td>{model.vendor || '—'}</td>
                    <td className="cu-px-num">
                      {formatContextWindow(model.context_window_tokens)}
                    </td>
                    <td className="cu-px-actions">
                      <button
                        type="button"
                        className="cu-btn cu-btn--primary cu-btn--sm"
                        onClick={() => void handleEnable(model)}
                        disabled={pendingId === model.id || bulkEnabling}
                      >
                        {pendingId === model.id ? 'Enabling…' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {staleModels.length > 0 ? (
        <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
          <TablePanelHeader
            title={
              <>
                <IconModels />
                {`Stale models (${staleModels.length})`}
              </>
            }
            subtitle="These models vanished from the provider catalog. They are kept, never auto-removed — decide whether to disable or delete them."
          />
          <div className="cu-px-unpriced-slot">
            <div className="cu-banner cu-banner--warning" role="status">
              A stale model that is still <strong>enabled</strong> is <strong>served</strong> at
              runtime. Disable it to stop serving it, or delete it to drop it from the catalog.
            </div>
          </div>
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={STALE_COLUMNS} />
              </thead>
              <tbody>
                {staleModels.map(model => (
                  <tr key={model.id} className="cu-table__row">
                    <td>{getProviderDisplayLabel(model.provider)}</td>
                    <td className="cu-px-model">{model.model}</td>
                    <td>{model.vendor || '—'}</td>
                    <td className="cu-px-num">
                      {formatContextWindow(model.context_window_tokens)}
                    </td>
                    <td>
                      {model.enabled ? (
                        <span
                          className="cu-px-badge cu-px-badge--warn"
                          title="Enabled and still served at runtime despite being stale."
                        >
                          Enabled · served
                        </span>
                      ) : (
                        <span className="cu-px-badge cu-px-badge--off">Disabled</span>
                      )}
                    </td>
                    <td className="cu-px-actions">
                      {model.enabled ? (
                        <button
                          type="button"
                          className="cu-btn cu-btn--secondary cu-btn--sm"
                          onClick={() => void handleDisable(model)}
                          disabled={pendingId === model.id}
                        >
                          {pendingId === model.id ? 'Working…' : 'Disable'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => void handleDelete(model)}
                        disabled={pendingId === model.id}
                        aria-label={`Delete ${modelLabel(model)}`}
                      >
                        <IconTrash width={16} height={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {confirmDialog}
    </>
  )
}

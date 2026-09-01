'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DataTable, TableStateRow, useTableSort } from '@clerum/frontend-table-system'
import { LlmProviderIcon } from '@components/LlmProviderIcon'
import { IconModels } from '@components/Sidebar/icons'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { IconRefresh } from '@components/icons'
import {
  type LlmAllowedModel,
  type LlmDiscoveryStatus,
  getDiscoveryStatus,
  isLlmModelConfigMapDeferred,
  isSilentApiError,
  syncDiscovery,
  updateLlmModel,
} from '@lib/api'
import { formatContextWindow, getProviderDisplayLabel } from '@lib/llm'
import type { LlmDiscoveryPanelProps } from './types'

const CONFIGMAP_DEFERRED_WARNING =
  'Propagation to the cluster is delayed and will reconcile shortly.'

type ReviewSortKey = 'provider' | 'model' | 'vendor' | 'contextWindow'

function modelLabel(model: LlmAllowedModel): string {
  return `${getProviderDisplayLabel(model.provider)}/${model.model}`
}

function formatRunAt(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function LlmDiscoveryPanel({
  items,
  loading,
  navigation,
  onRefresh,
}: LlmDiscoveryPanelProps) {
  const { showToast } = useToast()

  const [status, setStatus] = useState<LlmDiscoveryStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [bulkEnabling, setBulkEnabling] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const statusRequestGeneration = useRef(0)

  const isInitialLoad = loading && items.length === 0
  const reviewQueue = useMemo(
    () => items.filter(model => model.source === 'discovery' && !model.enabled && !model.stale),
    [items]
  )
  const reviewSort = useTableSort<LlmAllowedModel, ReviewSortKey>({
    rows: reviewQueue,
    defaultKey: 'provider',
    defaultDirections: { contextWindow: 'desc' },
    identity: model => model.id,
    accessors: {
      provider: model => getProviderDisplayLabel(model.provider),
      model: model => model.model,
      vendor: model => model.vendor,
      contextWindow: model => model.context_window_tokens,
    },
  })

  const selectedCount = useMemo(
    () => reviewQueue.reduce((count, model) => (selectedIds.has(model.id) ? count + 1 : count), 0),
    [reviewQueue, selectedIds]
  )
  const allSelected = reviewQueue.length > 0 && selectedCount === reviewQueue.length

  useEffect(() => {
    let active = true
    const generation = ++statusRequestGeneration.current
    setStatusLoading(true)
    void getDiscoveryStatus()
      .then(nextStatus => {
        if (active && generation === statusRequestGeneration.current) setStatus(nextStatus)
      })
      .catch(() => {
        // Status is optional while older control-api builds roll forward.
      })
      .finally(() => {
        if (active && generation === statusRequestGeneration.current) setStatusLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const currentIds = new Set(reviewQueue.map(model => model.id))
    setSelectedIds(previous => {
      const next = new Set(Array.from(previous).filter(id => currentIds.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [reviewQueue])

  function toggleRow(id: string) {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelectedIds(previous => {
      if (reviewQueue.length > 0 && reviewQueue.every(model => previous.has(model.id))) {
        return new Set()
      }
      return new Set(reviewQueue.map(model => model.id))
    })
  }

  async function handleRefresh() {
    const generation = ++statusRequestGeneration.current
    setStatusLoading(true)
    setError('')
    try {
      const [, statusResult] = await Promise.allSettled([onRefresh(), getDiscoveryStatus()])
      if (generation === statusRequestGeneration.current && statusResult.status === 'fulfilled') {
        setStatus(statusResult.value)
      }
    } finally {
      if (generation === statusRequestGeneration.current) setStatusLoading(false)
    }
  }

  async function handleSync() {
    const generation = ++statusRequestGeneration.current
    setSyncing(true)
    setError('')
    try {
      const result = await syncDiscovery()
      await onRefresh()
      if (generation === statusRequestGeneration.current) {
        setStatus({
          ranAt: result.ranAt,
          source: result.source,
          added: result.added,
          updated: result.updated,
          staled: result.staled,
        })
      }
      showToast(
        `Synced from ${result.source}: +${result.added} new, ${result.updated} updated, ${result.staled} marked stale`,
        { tone: 'success' }
      )
    } catch (caught) {
      if (isSilentApiError(caught)) return
      const message = caught instanceof Error ? caught.message : 'Discovery sync failed'
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      if (generation === statusRequestGeneration.current) setStatusLoading(false)
      setSyncing(false)
    }
  }

  async function handleEnable(model: LlmAllowedModel) {
    const label = modelLabel(model)
    setPendingId(model.id)
    setError('')
    try {
      await updateLlmModel(model.id, { enabled: true })
      await onRefresh()
      showToast(`${label} enabled.`, { tone: 'success' })
    } catch (caught) {
      if (isSilentApiError(caught)) return
      if (isLlmModelConfigMapDeferred(caught)) {
        await onRefresh()
        showToast(`${label} enabled. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      const message = caught instanceof Error ? caught.message : `Failed to enable ${label}`
      setError(message)
      showToast(message, { tone: 'error' })
    } finally {
      setPendingId(null)
    }
  }

  async function handleBulkEnable() {
    const targets = reviewQueue.filter(model => selectedIds.has(model.id))
    if (targets.length === 0) return

    setBulkEnabling(true)
    setError('')
    let results: PromiseSettledResult<unknown>[] = []
    try {
      results = await Promise.allSettled(
        targets.map(model => updateLlmModel(model.id, { enabled: true }))
      )
      setSelectedIds(new Set())
      await onRefresh()
    } finally {
      setBulkEnabling(false)
    }

    if (results.some(result => result.status === 'rejected' && isSilentApiError(result.reason))) {
      return
    }
    const deferred = results.some(
      result => result.status === 'rejected' && isLlmModelConfigMapDeferred(result.reason)
    )
    const hardFailures = results.filter(
      result => result.status === 'rejected' && !isLlmModelConfigMapDeferred(result.reason)
    ).length
    const succeeded = targets.length - hardFailures
    if (hardFailures === 0) {
      showToast(
        `Enabled ${succeeded} model${succeeded === 1 ? '' : 's'}.${
          deferred ? ` ${CONFIGMAP_DEFERRED_WARNING}` : ''
        }`,
        { tone: deferred ? 'info' : 'success' }
      )
      return
    }

    const message = `Enabled ${succeeded} of ${targets.length} models; ${hardFailures} failed.`
    setError(message)
    showToast(message, { tone: 'error' })
  }

  const reviewColumns: TableHeaderColumn[] = (
    [
      {
        key: 'select',
        width: '2.75rem',
        label: (
          <input
            type="checkbox"
            checked={allSelected}
            ref={element => {
              if (element) element.indeterminate = selectedCount > 0 && !allSelected
            }}
            onChange={toggleAll}
            disabled={reviewQueue.length === 0 || bulkEnabling}
            aria-label={allSelected ? 'Deselect all review models' : 'Select all review models'}
          />
        ),
      },
      { key: 'provider', label: 'Provider', minWidth: '9rem' },
      { key: 'model', label: 'Model', minWidth: '12rem' },
      { key: 'vendor', label: 'Vendor', width: '10rem' },
      {
        key: 'contextWindow',
        label: 'Context window',
        align: 'right',
        width: '9rem',
      },
      { key: 'actions', width: '7rem', align: 'right', ariaLabel: 'Actions' },
    ] satisfies TableHeaderColumn[]
  ).map(column =>
    column.key === 'select' || column.key === 'actions'
      ? column
      : {
          ...column,
          activeDirection: reviewSort.key === column.key ? reviewSort.direction : null,
          defaultDirection: column.key === 'contextWindow' ? 'desc' : 'asc',
          onSort: () => reviewSort.sortBy(column.key as ReviewSortKey),
        }
  )

  return (
    <>
      {error ? (
        <div className="cu-banner cu-banner--error cu-llm-models-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="cu-card cu-card--viewport-fill cu-section-card">
        <TablePanelHeader
          title={
            <>
              <IconModels />
              LLM Models
            </>
          }
          subtitle="Newly synced models land here disabled. Enable only the models you want available to agents and runtime."
          primaryAction={
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => void handleSync()}
              disabled={syncing || isInitialLoad}
            >
              {syncing ? 'Syncing…' : 'Sync catalog'}
            </button>
          }
          refreshAction={
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void handleRefresh()}
              disabled={loading || statusLoading || isInitialLoad}
              aria-label={loading || statusLoading ? 'Refreshing…' : 'Reload discovery review'}
            >
              <IconRefresh
                className={loading || statusLoading ? 'cu-spin' : undefined}
                width={18}
                height={18}
              />
            </button>
          }
        />
        <div className="cu-discovery-bar">
          {navigation}
          <div className="cu-discovery-status" role="status">
            <span>
              {status
                ? `Last synced ${formatRunAt(status.ranAt)}`
                : 'Not synced yet. Run a sync to pull the latest catalog.'}
            </span>
            {status ? (
              <span className="cu-discovery-status__facts">
                <span
                  className={`cu-px-badge ${
                    status.source === 'live' ? 'cu-px-badge--info' : 'cu-px-badge--warn'
                  }`}
                >
                  {status.source === 'live' ? 'Live catalog' : 'Vendored fallback'}
                </span>
                <span>+{status.added} new</span>
                <span>{status.updated} refreshed</span>
                <span>{status.staled} stale</span>
              </span>
            ) : null}
          </div>
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

        <div className="eft-table-viewport cu-table-wrap cu-table-wrap--sticky-header">
          <DataTable className="eft-table cu-table cu-table--header-band cu-llm-review-table">
            <thead>
              <TableHeaderRow columns={reviewColumns} />
            </thead>
            <tbody className="cu-llm-model-group">
              {isInitialLoad ? (
                <TableStateRow
                  colSpan={reviewColumns.length}
                  kind="loading"
                  message="Loading discovery review…"
                />
              ) : reviewQueue.length === 0 ? (
                <TableStateRow
                  colSpan={reviewColumns.length}
                  message="No models awaiting review. Sync the catalog to pull newly released models."
                />
              ) : (
                reviewSort.sortedRows.map(model => (
                  <tr key={model.id} className="cu-table__row cu-llm-model-row">
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(model.id)}
                        onChange={() => toggleRow(model.id)}
                        disabled={bulkEnabling}
                        aria-label={`Select ${modelLabel(model)}`}
                      />
                    </td>
                    <td>
                      <span className="cu-inline-icon-label">
                        <LlmProviderIcon
                          provider={model.provider}
                          label={getProviderDisplayLabel(model.provider)}
                        />
                        {getProviderDisplayLabel(model.provider)}
                      </span>
                    </td>
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
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </div>
    </>
  )
}

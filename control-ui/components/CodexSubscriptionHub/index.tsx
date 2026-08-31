'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { DataTable } from '@clerum/frontend-table-system'
import {
  type CodexSubscriptionConnectionView,
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
  patchCodexCatalogModel,
  patchCodexSubscriptionConnection,
  pollCodexDevice,
  revokeCodexSubscription,
  startCodexDeviceConnect,
  syncCodexSubscriptionCatalog,
} from '@lib/codexSubscription'
import {
  type CodexSubscriptionCapability,
  isCodexSubscriptionUiEnabled,
  loadCodexSubscriptionCapability,
} from '@lib/codexSubscriptionFeature'
import {
  mapConnectionStatus,
  statusLabel,
  statusTagClass,
} from '../CodexSubscriptionConnection/types'
import { useConfirmDialog } from '../ConfirmDialog'
import { LlmProviderIcon } from '../LlmProviderIcon'
import { RowActionsMenu } from '../RowActionsMenu'
import { SecretsScopeTabs } from '../SecretsScopeTabs'
import { SectionSearchInput } from '../SectionSearchInput'
import { SelectionDropdown } from '../SelectionDropdown'
import { IconKey } from '../Sidebar/icons'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'
import { IconRefresh, IconX } from '../icons'

function grantLabel(row: CodexSubscriptionConnectionView): string {
  return row.displayName || row.connectionKey
}

export function CodexSubscriptionHub() {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [capability, setCapability] = useState<CodexSubscriptionCapability | null>(null)
  const [connections, setConnections] = useState<CodexSubscriptionConnectionView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [editing, setEditing] = useState<CodexSubscriptionConnectionView | null>(null)
  const [editName, setEditName] = useState('')
  const [editDefault, setEditDefault] = useState('')
  const [editModels, setEditModels] = useState<
    Array<{ model: string; enabled: boolean; stale: boolean }>
  >([])
  const [userCode, setUserCode] = useState<string | null>(null)
  const [verificationUri, setVerificationUri] = useState<string | null>(null)
  const enabled = isCodexSubscriptionUiEnabled(capability)

  useEffect(() => {
    void loadCodexSubscriptionCapability()
      .then(setCapability)
      .catch(err => {
        setCapability({ enabled: false, error: err instanceof Error ? err.message : 'unavailable' })
        setError(err instanceof Error ? err.message : 'Failed to load ChatGPT subscriptions')
        setLoading(false)
      })
  }, [])

  const load = useCallback(async () => {
    if (!enabled) return
    const rows = await listCodexSubscriptionConnections()
    setConnections(rows)
  }, [enabled])

  useEffect(() => {
    if (capability === null) return
    if (!enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    void load()
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load ChatGPT subscriptions')
      })
      .finally(() => setLoading(false))
  }, [capability, enabled, load])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const rows = connections.filter(row => row.status !== 'revoked')
    if (!q) return rows
    return rows.filter(row =>
      [grantLabel(row), row.connectionKey, row.status].join(' ').toLowerCase().includes(q)
    )
  }, [connections, searchQuery])

  async function handleCreate() {
    const displayName = createName.trim()
    if (!displayName) {
      setError('Subscription name is required.')
      return
    }
    setBusyKey('create')
    try {
      await createCodexSubscriptionConnection({ displayName })
      setCreateName('')
      setCreating(false)
      setError('')
      await load()
      showToast(`Subscription ${displayName} created.`, { tone: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create subscription')
    } finally {
      setBusyKey(null)
    }
  }

  async function openEdit(row: CodexSubscriptionConnectionView) {
    setEditing(row)
    setEditName(grantLabel(row))
    setEditDefault(row.defaultModel ?? '')
    setUserCode(null)
    setVerificationUri(null)
    setError('')
    if (row.status === 'connected') {
      try {
        const models = await listCodexConnectionModels(row.connectionKey)
        setEditModels(models)
      } catch (err) {
        setEditModels([])
        setError(err instanceof Error ? err.message : 'Could not load grant models')
      }
    } else {
      setEditModels([])
    }
  }

  function closeEdit() {
    setEditing(null)
    setEditName('')
    setEditDefault('')
    setEditModels([])
    setUserCode(null)
    setVerificationUri(null)
  }

  async function handleSaveEdit() {
    if (!editing) return
    setBusyKey(editing.connectionKey)
    try {
      const updated = await patchCodexSubscriptionConnection(editing.connectionKey, {
        displayName: editName.trim() || grantLabel(editing),
        defaultModel: editDefault.trim() || null,
      })
      setEditing(updated)
      await load()
      showToast(`Subscription ${grantLabel(updated)} updated.`, { tone: 'success' })
      closeEdit()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update subscription')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleConnect(row: CodexSubscriptionConnectionView) {
    setBusyKey(row.connectionKey)
    try {
      const started = await startCodexDeviceConnect(
        row.status === 'connected' ? 'reconnect' : 'connect',
        row.connectionKey
      )
      setUserCode(started.userCode)
      setVerificationUri(started.verificationUri)
      const deadline = Date.now() + started.intervalSeconds * 1000 * 40
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, started.intervalSeconds * 1000))
        const polled = await pollCodexDevice(started.state, row.connectionKey)
        if (polled.status === 'connected') {
          setUserCode(null)
          setVerificationUri(null)
          const latest = polled.connection
          setEditing(latest)
          const models = await listCodexConnectionModels(latest.connectionKey)
          setEditModels(models)
          await load()
          return
        }
        if (polled.status === 'expired' || polled.status === 'denied') {
          setUserCode(null)
          setVerificationUri(null)
          setError(`ChatGPT sign-in ${polled.status}. Try again.`)
          return
        }
      }
      setUserCode(null)
      setVerificationUri(null)
      setError('ChatGPT sign-in timed out. Try again.')
    } catch (err) {
      setUserCode(null)
      setVerificationUri(null)
      setError(err instanceof Error ? err.message : 'ChatGPT sign-in failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleSync(row: CodexSubscriptionConnectionView) {
    if (row.status !== 'connected') return
    setBusyKey(row.connectionKey)
    try {
      const synced = await syncCodexSubscriptionCatalog(row.connectionKey)
      if (synced.outcome !== 'ready') {
        setError(`Catalog sync ${synced.outcome}`)
        return
      }
      const models = await listCodexConnectionModels(row.connectionKey)
      setEditModels(models)
      await load()
      showToast(`Catalog synced: ${grantLabel(row)}`, { tone: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Catalog sync failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleToggleModel(
    row: CodexSubscriptionConnectionView,
    model: string,
    enabledNext: boolean
  ) {
    setBusyKey(row.connectionKey)
    try {
      const models = await patchCodexCatalogModel(row.connectionKey, model, enabledNext)
      setEditModels(models)
      if (editDefault === model && !enabledNext) setEditDefault('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update model')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRevoke(row: CodexSubscriptionConnectionView) {
    const confirmed = await confirm({
      title: 'Delete ChatGPT subscription',
      message: `Revoke ${grantLabel(row)}? Assigned agents keep the reference and stop authorizing.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusyKey(row.connectionKey)
    try {
      await revokeCodexSubscription(row.connectionKey)
      if (editing?.connectionKey === row.connectionKey) closeEdit()
      await load()
      showToast(`Subscription ${grantLabel(row)} revoked.`, { tone: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke subscription')
    } finally {
      setBusyKey(null)
    }
  }

  const offeredDefaults = editModels.filter(row => row.enabled && !row.stale).map(row => row.model)
  const initialLoad = loading && connections.length === 0
  const uiStatus = editing ? mapConnectionStatus(editing.status) : 'disconnected'

  if (!enabled && capability !== null) {
    return (
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title={
            <>
              <IconKey /> Secrets
            </>
          }
          subtitle="Manage LLM, connector, and recipe credentials in one place."
        />
        <div className="cu-card__body cu-card__body--auto cu-secrets-strip">
          <SecretsScopeTabs activeValue="llm-subscriptions" />
        </div>
        <div className="cu-empty">
          {capability.error || error || 'ChatGPT subscriptions are disabled.'}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconKey />
              {initialLoad ? 'Secrets' : `Secrets (${filtered.length})`}
            </>
          }
          subtitle="Manage LLM, connector, and recipe credentials in one place."
          actions={
            <>
              <SectionSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search secrets"
                ariaLabel="Search ChatGPT subscriptions"
                disabled={initialLoad}
              />
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() =>
                  void load().catch(err => {
                    setError(
                      err instanceof Error ? err.message : 'Failed to load ChatGPT subscriptions'
                    )
                  })
                }
                disabled={initialLoad || loading}
                aria-label={loading ? 'Refreshing...' : 'Reload ChatGPT subscriptions'}
              >
                <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => {
                  setCreating(true)
                  setCreateName('')
                  setError('')
                }}
                disabled={initialLoad}
              >
                Add subscription
              </button>
            </>
          }
        />

        <div className="cu-card__body cu-card__body--auto cu-secrets-strip">
          <SecretsScopeTabs activeValue="llm-subscriptions" />
        </div>

        {error && !creating && !editing ? (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            <div className="cu-banner cu-banner--error">{error}</div>
          </div>
        ) : null}

        {initialLoad ? (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, idx) => (
                  <tr key={idx}>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '55%' }} />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '40%' }} />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '4rem' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        ) : filtered.length === 0 ? (
          <div className="cu-empty">
            {searchQuery.trim()
              ? 'No ChatGPT subscriptions match this search.'
              : 'No ChatGPT subscriptions found.'}
          </div>
        ) : (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const mapped = mapConnectionStatus(row.status)
                  return (
                    <tr key={row.connectionKey}>
                      <td>{grantLabel(row)}</td>
                      <td>
                        <span className={statusTagClass(mapped)}>{statusLabel(mapped)}</span>
                      </td>
                      <td className="cu-table__cell-actions">
                        <RowActionsMenu
                          ariaLabel={`Actions for ChatGPT subscription ${grantLabel(row)}`}
                          actions={[
                            {
                              key: 'edit',
                              label: 'Edit',
                              onClick: () => void openEdit(row),
                            },
                            {
                              key: 'delete',
                              label: busyKey === row.connectionKey ? 'Deleting…' : 'Delete',
                              danger: true,
                              disabled: busyKey === row.connectionKey,
                              onClick: () => void handleRevoke(row),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          </div>
        )}
      </div>

      {creating ? (
        <div
          className="cu-modal-overlay"
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && busyKey !== 'create') {
              setCreating(false)
            }
          }}
        >
          <div
            className="cu-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-create-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="codex-create-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add subscription
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setCreating(false)}
                disabled={busyKey === 'create'}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <div className="cu-form-stack">
              {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
              <div className="cu-field">
                <label htmlFor="codex-new-name">Name</label>
                <input
                  id="codex-new-name"
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  disabled={busyKey === 'create'}
                />
              </div>
            </div>
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setCreating(false)}
                disabled={busyKey === 'create'}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => void handleCreate()}
                disabled={busyKey === 'create'}
              >
                {busyKey === 'create' ? 'Saving…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div
          className="cu-modal-overlay"
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busyKey) closeEdit()
          }}
        >
          <div
            className="cu-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-edit-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="codex-edit-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Update ChatGPT subscription {grantLabel(editing)}
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={closeEdit}
                disabled={Boolean(busyKey)}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <div className="cu-form-stack" style={{ maxWidth: '100%' }}>
              {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
              <div className="cu-field">
                <label htmlFor="codex-edit-name">Name</label>
                <input
                  id="codex-edit-name"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  disabled={Boolean(busyKey)}
                />
              </div>
              <div className="cu-field">
                <span className="cu-field__label">Status</span>
                <span className={statusTagClass(uiStatus)}>{statusLabel(uiStatus)}</span>
              </div>
              <div>
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => void handleConnect(editing)}
                  disabled={Boolean(busyKey)}
                >
                  Sign in with ChatGPT
                </button>{' '}
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => void handleSync(editing)}
                  disabled={Boolean(busyKey) || editing.status !== 'connected'}
                >
                  Sync catalog
                </button>
              </div>
              {userCode ? (
                <p data-testid="codex-device-code">
                  Enter {userCode}
                  {verificationUri ? ` at ${verificationUri}` : ''}
                </p>
              ) : null}
              {editModels.length > 0 ? (
                <fieldset className="cu-field">
                  <legend className="cu-field__label">Enabled models</legend>
                  {editModels.map(model => (
                    <label key={model.model} className="cu-field" style={{ display: 'block' }}>
                      <input
                        type="checkbox"
                        checked={model.enabled}
                        disabled={Boolean(busyKey) || model.stale}
                        onChange={e =>
                          void handleToggleModel(editing, model.model, e.target.checked)
                        }
                      />{' '}
                      {model.model}
                      {model.stale ? ' (stale)' : ''}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <div className="cu-field">
                <label htmlFor="codex-edit-default">Default model</label>
                <SelectionDropdown
                  id="codex-edit-default"
                  value={editDefault ? [editDefault] : []}
                  options={offeredDefaults.map(model => ({
                    value: model,
                    label: model,
                    icon: <LlmProviderIcon provider="codex-subscription" label={model} />,
                  }))}
                  placeholder={offeredDefaults.length === 0 ? 'No enabled models' : 'Select model…'}
                  searchPlaceholder="Search models…"
                  selectionLabel="model"
                  multiple={false}
                  showSelectedChips={false}
                  disabled={Boolean(busyKey) || offeredDefaults.length === 0}
                  onChange={next => setEditDefault(next[0] ?? '')}
                />
              </div>
            </div>
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={closeEdit}
                disabled={Boolean(busyKey)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => void handleSaveEdit()}
                disabled={Boolean(busyKey)}
              >
                {busyKey ? 'Saving…' : 'Update subscription'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmDialog}
    </>
  )
}

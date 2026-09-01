'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DataTable,
  TableHeaderCell,
  TableStateRow,
  useTableSort,
} from '@clerum/frontend-components'
import { copyTextToClipboard } from '@lib/clipboard'
import {
  CODEX_DEVICE_VERIFICATION_URI,
  type CodexSubscriptionConnectionView,
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
  patchCodexCatalogModel,
  patchCodexSubscriptionConnection,
  pollCodexDevice,
  revokeCodexSubscription,
  startCodexDeviceConnect,
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
import { IconCopy, IconRefresh, IconX } from '../icons'
import { CheckboxField } from '../ui'

function grantLabel(row: CodexSubscriptionConnectionView): string {
  return row.displayName || row.connectionKey
}

async function copyDeviceValue(
  value: string,
  label: string,
  showToast: ReturnType<typeof useToast>['showToast']
) {
  const copied = await copyTextToClipboard(value)
  showToast(
    copied
      ? `${label} copied.`
      : `Could not copy the ${label.toLowerCase()} — select it and copy manually.`,
    { tone: copied ? 'success' : 'error' }
  )
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
  const [editing, setEditing] = useState<CodexSubscriptionConnectionView | null>(null)
  const [editName, setEditName] = useState('')
  const [editDefault, setEditDefault] = useState('')
  // True while the open modal is the continuation of the CREATE flow — the
  // grant was just created and the operator is doing first-time setup
  // (sign-in, model picks, default model) instead of updating an existing one.
  const [setupNew, setSetupNew] = useState(false)
  const [editModels, setEditModels] = useState<
    Array<{ model: string; enabled: boolean; stale: boolean }>
  >([])
  const [userCode, setUserCode] = useState<string | null>(null)
  const [verificationUri, setVerificationUri] = useState<string | null>(null)
  // Only true when window.open failed for the sign-in tab, so the card claims
  // a new tab opened only when one actually did.
  const [deviceTabBlocked, setDeviceTabBlocked] = useState(false)
  // Ported from dev: bumps whenever the dialog closes/reopens or a new connect
  // starts, so a stale device-poll loop (closed dialog, switched row) can no
  // longer touch state after it was abandoned.
  const connectEpoch = useRef(0)
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

  useEffect(() => {
    return () => {
      connectEpoch.current += 1
    }
  }, [])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const rows = connections.filter(row => row.status !== 'revoked')
    if (!q) return rows
    return rows.filter(row =>
      [grantLabel(row), row.connectionKey, row.status].join(' ').toLowerCase().includes(q)
    )
  }, [connections, searchQuery])
  const subscriptionSort = useTableSort<CodexSubscriptionConnectionView, 'name' | 'status'>({
    rows: filtered,
    defaultKey: 'name',
    identity: row => row.connectionKey,
    accessors: {
      name: grantLabel,
      status: row => statusLabel(mapConnectionStatus(row.status)),
    },
  })

  // Create makes the grant with the typed display name and starts the device
  // sign-in right away — by the time the operator approves the code, the
  // catalog is already synced server-side (connect handshake) and the models
  // grid is populated.
  // Create is its own phase: once the grant exists, nothing below may report
  // "creation failed" — later failures (table refresh, sign-in) are reported
  // as their own partial outcomes, and sign-in always gets a chance to start.
  async function handleCreate() {
    const displayName = editName.trim()
    if (!displayName) {
      setError('Subscription name is required.')
      return
    }
    setBusyKey('create')
    let created: CodexSubscriptionConnectionView
    try {
      created = await createCodexSubscriptionConnection({ displayName })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create subscription')
      setBusyKey(null)
      return
    }
    setError('')
    openEdit(created)
    setSetupNew(true)
    setBusyKey(null)
    // Sign-in starts regardless of whether the table refresh succeeds.
    void handleConnect(created)
    try {
      await load()
    } catch {
      showToast('Subscription created, but the list could not be refreshed.', { tone: 'info' })
    }
  }

  function beginCreate() {
    setCreating(true)
    setEditing(null)
    setEditName('')
    setEditDefault('')
    setEditModels([])
    setSetupNew(false)
    setUserCode(null)
    setVerificationUri(null)
    setDeviceTabBlocked(false)
    setError('')
  }

  async function openEdit(row: CodexSubscriptionConnectionView) {
    connectEpoch.current += 1
    setEditing(row)
    setEditName(grantLabel(row))
    setEditDefault(row.defaultModel ?? '')
    setSetupNew(false)
    setUserCode(null)
    setVerificationUri(null)
    setDeviceTabBlocked(false)
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
    connectEpoch.current += 1
    setEditing(null)
    setEditName('')
    setEditDefault('')
    setEditModels([])
    setSetupNew(false)
    setUserCode(null)
    setVerificationUri(null)
    setDeviceTabBlocked(false)
    void load().catch(err => {
      setError(err instanceof Error ? err.message : 'Failed to load ChatGPT subscriptions')
    })
  }

  async function handleSaveEdit() {
    if (!editing) return
    if (setupNew && !editName.trim()) {
      setError('Give the subscription a name before finishing.')
      return
    }
    setBusyKey(editing.connectionKey)
    try {
      const updated = await patchCodexSubscriptionConnection(editing.connectionKey, {
        displayName: editName.trim() || grantLabel(editing),
        defaultModel: editDefault.trim() || null,
      })
      setEditing(updated)
      // A refresh failure after a successful patch is partial — the update
      // itself landed, so it must not surface as "update failed".
      await load().catch(() => {})
      showToast(
        setupNew
          ? `Subscription ${grantLabel(updated)} is ready.`
          : `Subscription ${grantLabel(updated)} updated.`,
        { tone: 'success' }
      )
      closeEdit()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update subscription')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleConnect(row: CodexSubscriptionConnectionView) {
    const epoch = ++connectEpoch.current
    setBusyKey(row.connectionKey)
    // Open the verification page synchronously, inside the click handler and
    // before any await — popup blockers honour user activation here, so the
    // tab reliably appears. The device code lands in the card right after.
    // The card only claims the tab opened when open() actually returned one.
    let openedTab: Window | null = null
    try {
      openedTab = window.open(CODEX_DEVICE_VERIFICATION_URI, '_blank', 'noopener,noreferrer')
    } catch {
      openedTab = null
    }
    setDeviceTabBlocked(!openedTab)
    try {
      const started = await startCodexDeviceConnect(
        row.status === 'connected' ? 'reconnect' : 'connect',
        row.connectionKey
      )
      if (epoch !== connectEpoch.current) return
      setUserCode(started.userCode)
      setVerificationUri(started.verificationUri)
      const deadline = Date.now() + started.intervalSeconds * 1000 * 40
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, started.intervalSeconds * 1000))
        if (epoch !== connectEpoch.current) return
        const polled = await pollCodexDevice(started.state, row.connectionKey)
        if (epoch !== connectEpoch.current) return
        if (polled.status === 'connected') {
          setUserCode(null)
          setVerificationUri(null)
          const latest = polled.connection
          setEditing(latest)
          const models = await listCodexConnectionModels(latest.connectionKey)
          if (epoch !== connectEpoch.current) return
          setEditModels(models)
          // A table refresh failure here is partial — connect itself worked,
          // so it must not surface as "sign-in failed".
          await load().catch(() => {})
          if (epoch !== connectEpoch.current) return
          // The backend syncs the catalog during connect — surface the outcome.
          if (latest.catalogStatus === 'ready') {
            showToast('Connected — catalog synced', { tone: 'success' })
          } else {
            showToast('Connected, but catalog sync failed. Sign in again to retry.', {
              tone: 'error',
            })
          }
          return
        }
        if (polled.status === 'expired' || polled.status === 'denied') {
          setUserCode(null)
          setVerificationUri(null)
          setError(`ChatGPT sign-in ${polled.status}. Try again.`)
          return
        }
      }
      if (epoch !== connectEpoch.current) return
      setUserCode(null)
      setVerificationUri(null)
      setError('ChatGPT sign-in timed out. Try again.')
    } catch (err) {
      if (epoch !== connectEpoch.current) return
      setUserCode(null)
      setVerificationUri(null)
      setError(err instanceof Error ? err.message : 'ChatGPT sign-in failed')
    } finally {
      if (epoch === connectEpoch.current) {
        setBusyKey(null)
      }
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
          primaryAction={
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => {
                beginCreate()
              }}
              disabled={initialLoad}
            >
              Add subscription
            </button>
          }
          refreshAction={
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
          }
          search={
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search secrets"
              ariaLabel="Search ChatGPT subscriptions"
              disabled={initialLoad}
            />
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

        <div className="eft-table-viewport cu-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band">
            <thead>
              <tr>
                <TableHeaderCell
                  activeDirection={
                    subscriptionSort.key === 'name' ? subscriptionSort.direction : null
                  }
                  label="Name"
                  onSort={() => subscriptionSort.sortBy('name')}
                />
                <TableHeaderCell
                  activeDirection={
                    subscriptionSort.key === 'status' ? subscriptionSort.direction : null
                  }
                  label="Status"
                  onSort={() => subscriptionSort.sortBy('status')}
                />
                <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {initialLoad ? (
                <TableStateRow
                  colSpan={3}
                  kind="loading"
                  message="Loading ChatGPT subscriptions…"
                />
              ) : error && filtered.length === 0 ? (
                <TableStateRow colSpan={3} kind="error" message={error} />
              ) : filtered.length === 0 ? (
                <TableStateRow
                  colSpan={3}
                  message={
                    searchQuery.trim()
                      ? 'No ChatGPT subscriptions match this search.'
                      : 'No ChatGPT subscriptions found.'
                  }
                />
              ) : (
                subscriptionSort.sortedRows.map(row => {
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
                          horizontalTrigger
                          actions={[
                            {
                              key: 'update',
                              label: 'Update',
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
                })
              )}
            </tbody>
          </DataTable>
        </div>
      </div>
      {creating || editing ? (
        <div
          className="cu-modal-overlay"
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busyKey) {
              setCreating(false)
              closeEdit()
            }
          }}
        >
          <div
            className="cu-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-modal-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="codex-modal-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                {creating
                  ? 'New ChatGPT subscription'
                  : editing && setupNew
                    ? `Set up ChatGPT subscription ${grantLabel(editing)}`
                    : editing
                      ? `Update ChatGPT subscription ${grantLabel(editing)}`
                      : 'New ChatGPT subscription'}
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => {
                  setCreating(false)
                  closeEdit()
                }}
                disabled={Boolean(busyKey)}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <div className="cu-form-stack cu-form-stack--wide" style={{ maxWidth: '100%' }}>
              {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
              <div className="cu-field">
                <label htmlFor="codex-sub-name">Name</label>
                <input
                  id="codex-sub-name"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  disabled={Boolean(busyKey)}
                  placeholder="The name agents see when they pick this subscription"
                />
                <span className="cu-field__hint">
                  The name agents see when they pick this subscription.
                </span>
              </div>
              {setupNew && editing ? (
                <p className="cu-field__hint" style={{ margin: 0 }}>
                  Grant created — sign-in started. Once connected, pick the models to offer and a
                  default to finish setup.
                </p>
              ) : null}
              <section className="cu-llm-config" aria-label="Subscription configuration">
                <div className="cu-llm-config__block">
                  <div className="cu-llm-config__block-head">
                    <span className="cu-llm-config__block-title">ChatGPT sign-in</span>
                    <span className={statusTagClass(uiStatus)}>{statusLabel(uiStatus)}</span>
                  </div>
                  <p className="cu-field__hint" style={{ margin: 0 }}>
                    {setupNew || !editing
                      ? 'Agents authorize through this subscription’s ChatGPT grant. Sign in to connect it — the catalog syncs automatically.'
                      : 'Agents authorize through this subscription’s ChatGPT grant. Reconnect if the grant expired — the catalog refreshes automatically.'}
                  </p>
                  <div className="cu-form-inline">
                    <span
                      title={editing || editName.trim() ? undefined : 'Type a name to get started'}
                      className="cu-hover-hint"
                    >
                      <button
                        type="button"
                        className="cu-btn cu-btn--ghost cu-btn--sm"
                        onClick={() => {
                          // Before the grant exists this creates it (with the
                          // typed name) and chains straight into sign-in, so
                          // the button never sits there dead.
                          if (editing) void handleConnect(editing)
                          else void handleCreate()
                        }}
                        disabled={Boolean(busyKey)}
                      >
                        Sign in with ChatGPT
                      </button>
                    </span>
                  </div>
                  {userCode ? (
                    <div className="cu-device-setup" data-testid="codex-device-code">
                      <p className="cu-device-setup__step">
                        {deviceTabBlocked
                          ? '1. Open the ChatGPT verification page:'
                          : '1. ChatGPT opened in a new tab — if it did not, use this link:'}
                      </p>
                      {(() => {
                        // Locked fallback (from dev): even if the backend
                        // omits the verification URI, the card keeps a link.
                        const deviceUri = verificationUri ?? CODEX_DEVICE_VERIFICATION_URI
                        return (
                          <div className="cu-copy-field">
                            <a
                              className="cu-readonly-field cu-copy-field__value cu-device-setup__link"
                              data-testid="codex-device-verification-link"
                              href={deviceUri}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {deviceUri}
                            </a>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--ghost"
                              onClick={() =>
                                void copyDeviceValue(deviceUri, 'Sign-in link', showToast)
                              }
                              aria-label="Copy sign-in link"
                              title="Copy sign-in link"
                            >
                              <IconCopy width={14} height={14} />
                            </button>
                          </div>
                        )
                      })()}
                      <p className="cu-device-setup__step">2. Enter this code:</p>
                      <div className="cu-copy-field">
                        <div className="cu-readonly-field cu-copy-field__value cu-device-setup__code">
                          {userCode}
                        </div>
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--ghost"
                          onClick={() => void copyDeviceValue(userCode, 'Code', showToast)}
                          aria-label="Copy code"
                          title="Copy code"
                        >
                          <IconCopy width={14} height={14} />
                        </button>
                      </div>
                      <p className="cu-device-setup__note" role="status">
                        Checking automatically — this dialog continues as soon as you approve the
                        code in ChatGPT.
                      </p>
                    </div>
                  ) : null}
                </div>
                {editModels.length > 0 || setupNew ? (
                  <div className="cu-llm-config__block">
                    <div className="cu-llm-config__block-head">
                      <span className="cu-llm-config__block-title">Enabled models</span>
                      {editModels.length > 0 ? (
                        <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">
                          {editModels.filter(model => model.enabled && !model.stale).length} of{' '}
                          {editModels.length} enabled
                        </span>
                      ) : null}
                    </div>
                    {editModels.length > 0 ? (
                      <div className="cu-llm-config__model-row">
                        {editModels.map(model => (
                          <CheckboxField
                            key={model.model}
                            checked={model.enabled}
                            disabled={Boolean(busyKey) || model.stale}
                            label={
                              <span className="cu-px-provider">
                                <LlmProviderIcon
                                  provider="codex-subscription"
                                  label={model.model}
                                />
                                {model.model}
                              </span>
                            }
                            description={
                              model.stale ? 'No longer in the ChatGPT catalog.' : undefined
                            }
                            onChange={e =>
                              editing
                                ? void handleToggleModel(editing, model.model, e.target.checked)
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="cu-field__hint" style={{ margin: 0 }}>
                        No models yet — confirm the name, sign in with ChatGPT, and sync the catalog
                        to load the models this grant offers.
                      </p>
                    )}
                    <span className="cu-field__hint">
                      Synced from the ChatGPT catalog. Disabled models are not offered to agents.
                    </span>
                  </div>
                ) : null}
                <div className="cu-llm-config__block">
                  <div className="cu-llm-config__block-head">
                    <span className="cu-llm-config__block-title">Primary model</span>
                    <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">
                      Optional
                    </span>
                  </div>
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
                      placeholder={
                        offeredDefaults.length === 0 ? 'No enabled models' : 'Select model…'
                      }
                      searchPlaceholder="Search models…"
                      selectionLabel="model"
                      multiple={false}
                      showSelectedChips={false}
                      disabled={Boolean(busyKey) || !editing || offeredDefaults.length === 0}
                      onChange={next => setEditDefault(next[0] ?? '')}
                    />
                    <span className="cu-field__hint">
                      Preselected for new chats; agents can pick any enabled model.
                    </span>
                  </div>
                </div>
              </section>
            </div>
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => {
                  setCreating(false)
                  closeEdit()
                }}
                disabled={Boolean(busyKey)}
              >
                {creating && editing && setupNew ? 'Finish later' : 'Cancel'}
              </button>
              {editing ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--primary"
                  onClick={() => void handleSaveEdit()}
                  disabled={Boolean(busyKey)}
                >
                  {busyKey ? 'Saving…' : setupNew ? 'Finish setup' : 'Update subscription'}
                </button>
              ) : (
                <button
                  type="button"
                  className="cu-btn cu-btn--primary"
                  onClick={() => void handleCreate()}
                  disabled={!editName.trim() || Boolean(busyKey)}
                  title={editName.trim() ? undefined : 'Type a name to create the subscription'}
                >
                  {busyKey === 'create' ? 'Creating…' : 'Create and set up'}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {confirmDialog}
    </>
  )
}

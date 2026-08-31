'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { copyTextToClipboard } from '@lib/clipboard'
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
  // True when the browser blocked the automatic ChatGPT tab, so the card tells
  // the operator to use the manual link instead of assuming the tab opened.
  const [deviceTabBlocked, setDeviceTabBlocked] = useState(false)
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

  // Opening the Add dialog immediately creates a backend draft grant so the
  // FULL setup form (name, sign-in, models, default) is live right away — no
  // name-only gate. If the operator cancels without signing in, the pristine
  // draft is revoked again so no empty rows linger in the table.
  async function createDraft() {
    setBusyKey('create')
    setError('')
    try {
      const created = await createCodexSubscriptionConnection({ displayName: '' })
      openEdit(created)
      setSetupNew(true)
      setEditName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create subscription')
    } finally {
      setBusyKey(null)
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
    void createDraft()
  }

  // Cancel in create mode. A pristine draft (never signed in) is removed again;
  // once the operator signed in the grant is real and is kept.
  function cancelCreate() {
    const draftRow = editing
    const revokePristine = Boolean(draftRow && draftRow.status === 'disconnected')
    setCreating(false)
    closeEdit()
    if (revokePristine && draftRow) {
      void revokeCodexSubscription(draftRow.connectionKey)
        .catch(() => {})
        .then(() => load())
        .catch(() => {})
    }
  }

  async function openEdit(row: CodexSubscriptionConnectionView) {
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
    setEditing(null)
    setEditName('')
    setEditDefault('')
    setEditModels([])
    setSetupNew(false)
    setUserCode(null)
    setVerificationUri(null)
    setDeviceTabBlocked(false)
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
      await load()
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
    setBusyKey(row.connectionKey)
    try {
      const started = await startCodexDeviceConnect(
        row.status === 'connected' ? 'reconnect' : 'connect',
        row.connectionKey
      )
      setUserCode(started.userCode)
      setVerificationUri(started.verificationUri)
      // Open the verification page straight away so the operator never has to
      // copy the URL by hand. Browsers may still block the popup (especially
      // after the await), so remember the failure and surface a manual link.
      let opened: Window | null = null
      try {
        opened = window.open(started.verificationUri, '_blank', 'noopener,noreferrer')
      } catch {
        opened = null
      }
      setDeviceTabBlocked(!opened)
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
                  beginCreate()
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
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
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
            </table>
          </div>
        ) : filtered.length === 0 ? (
          <div className="cu-empty">
            {searchQuery.trim()
              ? 'No ChatGPT subscriptions match this search.'
              : 'No ChatGPT subscriptions found.'}
          </div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
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
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
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
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating || editing ? (
        <div
          className="cu-modal-overlay"
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busyKey) {
              if (creating) cancelCreate()
              else closeEdit()
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
                  if (creating) cancelCreate()
                  else closeEdit()
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
              </div>
              {creating && !editing ? (
                <div className="cu-modal-steps">
                  <span className="cu-modal-steps__title">
                    {busyKey === 'create'
                      ? 'Creating your subscription…'
                      : 'Could not create the subscription.'}
                  </span>
                  <ol className="cu-modal-steps__list">
                    <li>
                      Sign in with ChatGPT — ChatGPT opens in a new tab and you enter a device code.
                    </li>
                    <li>Pick the models to offer and choose a default.</li>
                  </ol>
                  {busyKey !== 'create' ? (
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={() => void createDraft()}
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : editing ? (
                <>
                  {setupNew ? (
                    <p className="cu-field__hint" style={{ margin: 0 }}>
                      Grant created — sign in with ChatGPT, choose the models to offer, and set a
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
                        {setupNew
                          ? 'Agents authorize through this subscription’s ChatGPT grant. Sign in to connect it.'
                          : 'Agents authorize through this subscription’s ChatGPT grant. Reconnect if the grant expired, or sync to refresh the model catalog.'}
                      </p>
                      <div className="cu-form-inline">
                        <button
                          type="button"
                          className="cu-btn cu-btn--ghost cu-btn--sm"
                          onClick={() => void handleConnect(editing)}
                          disabled={Boolean(busyKey)}
                        >
                          Sign in with ChatGPT
                        </button>
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
                        <div className="cu-device-setup" data-testid="codex-device-code">
                          <p className="cu-device-setup__step">
                            {deviceTabBlocked
                              ? '1. Your browser blocked the pop-up — open ChatGPT with this link:'
                              : '1. ChatGPT opened in a new tab. If it did not, use this link:'}
                          </p>
                          {verificationUri ? (
                            <div className="cu-copy-field">
                              <a
                                className="cu-readonly-field cu-copy-field__value cu-device-setup__link"
                                href={verificationUri}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {verificationUri}
                              </a>
                              <button
                                type="button"
                                className="cu-btn cu-btn--icon cu-btn--ghost"
                                onClick={() =>
                                  void copyDeviceValue(verificationUri, 'Sign-in link', showToast)
                                }
                                aria-label="Copy sign-in link"
                                title="Copy sign-in link"
                              >
                                <IconCopy width={14} height={14} />
                              </button>
                            </div>
                          ) : null}
                          <p className="cu-device-setup__step">2. Enter this code:</p>
                          <div className="cu-copy-field">
                            <div className="cu-readonly-field cu-copy-field__value cu-device-setup__code">
                              {userCode}
                            </div>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--ghost"
                              onClick={() =>
                                void copyDeviceValue(userCode, 'Device code', showToast)
                              }
                              aria-label="Copy device code"
                              title="Copy device code"
                            >
                              <IconCopy width={14} height={14} />
                            </button>
                          </div>
                          <p className="cu-device-setup__note" role="status">
                            Checking automatically — this dialog continues as soon as you approve
                            the code in ChatGPT.
                          </p>
                        </div>
                      ) : null}
                    </div>
                    {editModels.length > 0 ? (
                      <div className="cu-llm-config__block">
                        <div className="cu-llm-config__block-head">
                          <span className="cu-llm-config__block-title">Enabled models</span>
                          <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">
                            {editModels.filter(model => model.enabled && !model.stale).length} of{' '}
                            {editModels.length} enabled
                          </span>
                        </div>
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
                                void handleToggleModel(editing, model.model, e.target.checked)
                              }
                            />
                          ))}
                        </div>
                        <span className="cu-field__hint">
                          Synced from the ChatGPT catalog. Disabled models are not offered to
                          agents.
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
                          disabled={Boolean(busyKey) || offeredDefaults.length === 0}
                          onChange={next => setEditDefault(next[0] ?? '')}
                        />
                        <span className="cu-field__hint">
                          Preselected for new chats; agents can pick any enabled model.
                        </span>
                      </div>
                    </div>
                  </section>
                </>
              ) : null}
            </div>
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => {
                  if (creating) {
                    // "Finish later" keeps the draft (the operator already
                    // signed in or configured it); Cancel removes a pristine one.
                    if (editing && setupNew) {
                      setCreating(false)
                      closeEdit()
                    } else {
                      cancelCreate()
                    }
                  } else {
                    closeEdit()
                  }
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
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {confirmDialog}
    </>
  )
}

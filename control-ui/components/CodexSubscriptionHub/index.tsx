'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DataTable,
  TableHeaderCell,
  TableStateRow,
  TableViewport,
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
  GROK_DEVICE_VERIFICATION_ORIGIN,
  type GrokSubscriptionConnectionView,
  createGrokSubscriptionConnection,
  isAllowedGrokVerificationUri,
  listGrokConnectionModels,
  listGrokSubscriptionConnections,
  patchGrokCatalogModel,
  patchGrokSubscriptionConnection,
  pollGrokDevice,
  revokeGrokSubscription,
  startGrokDeviceConnect,
} from '@lib/grokSubscription'
import {
  type GrokSubscriptionCapability,
  isGrokSubscriptionUiEnabled,
  loadGrokSubscriptionCapability,
} from '@lib/grokSubscriptionFeature'
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

type HubBroker = 'codex-subscription' | 'grok-subscription'
type HubConnection = CodexSubscriptionConnectionView & { broker: HubBroker }

// Both brokers let callers choose connection keys in independent namespaces,
// so every row identity (React key, sort identity, busy state, edit matching)
// is provider-qualified.
function hubRowId(row: Pick<HubConnection, 'broker' | 'connectionKey'>): string {
  return `${row.broker}:${row.connectionKey}`
}

type HubProviderCopy = {
  brand: string
  verificationFallback: string
}

const HUB_PROVIDER_COPY: Record<HubBroker, HubProviderCopy> = {
  'codex-subscription': {
    brand: 'ChatGPT',
    verificationFallback: CODEX_DEVICE_VERIFICATION_URI,
  },
  'grok-subscription': {
    brand: 'Grok',
    verificationFallback: GROK_DEVICE_VERIFICATION_ORIGIN,
  },
}

type HubListErrors = Record<HubBroker, string>

const NO_LIST_ERRORS: HubListErrors = { 'codex-subscription': '', 'grok-subscription': '' }

function grantLabel(row: CodexSubscriptionConnectionView): string {
  return row.displayName || row.connectionKey
}

function asHubRow(
  row: CodexSubscriptionConnectionView | GrokSubscriptionConnectionView,
  broker: HubBroker
): HubConnection {
  return { ...row, broker }
}

// RFC 8628 §3.5 device polling for both brokers: honor the interval the server
// returns and add 5 seconds on slow_down. Never poll faster than already agreed.
const DEVICE_SLOW_DOWN_BACKOFF_SECONDS = 5

function nextDevicePollIntervalSeconds(
  currentSeconds: number,
  polled: { status: 'pending' | 'slow_down'; intervalSeconds: number }
): number {
  const next = Math.max(currentSeconds, polled.intervalSeconds)
  return polled.status === 'slow_down'
    ? Math.max(next, currentSeconds + DEVICE_SLOW_DOWN_BACKOFF_SECONDS)
    : next
}

const GROK_TOS =
  'Connecting a Grok subscription authenticates Evenfire to xAI with the SuperGrok / Grok Build coding-plan OAuth client. Inference stays on cli-chat-proxy.grok.com and is not the metered xAI API.'

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
  const [grokCapability, setGrokCapability] = useState<GrokSubscriptionCapability | null>(null)
  const [rowsByBroker, setRowsByBroker] = useState<Record<HubBroker, HubConnection[]>>({
    'codex-subscription': [],
    'grok-subscription': [],
  })
  const [listErrors, setListErrors] = useState<HubListErrors>(NO_LIST_ERRORS)
  const [createBroker, setCreateBroker] = useState<HubBroker>('codex-subscription')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<HubConnection | null>(null)
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
  const grokEnabled = isGrokSubscriptionUiEnabled(grokCapability)

  useEffect(() => {
    // A capability probe that fails for any reason other than "disabled" is
    // kept on the capability itself, so later action-error resets cannot
    // hide it and the other provider still loads.
    void loadCodexSubscriptionCapability()
      .then(setCapability)
      .catch(err => {
        setCapability({
          enabled: false,
          error: err instanceof Error ? err.message : 'Failed to load ChatGPT subscriptions',
        })
        setLoading(false)
      })
    void loadGrokSubscriptionCapability()
      .then(setGrokCapability)
      .catch(err => {
        setGrokCapability({
          enabled: false,
          error: err instanceof Error ? err.message : 'Failed to load Grok subscriptions',
        })
      })
  }, [])

  const connections = useMemo(
    () => [...rowsByBroker['codex-subscription'], ...rowsByBroker['grok-subscription']],
    [rowsByBroker]
  )

  // Each provider loads independently: a failing list keeps that provider's
  // last rows and records its own error, and never discards the healthy
  // provider's result. Resolves with whether any enabled provider failed.
  const load = useCallback(async (): Promise<{ failed: boolean }> => {
    const [codexResult, grokResult] = await Promise.allSettled([
      enabled ? listCodexSubscriptionConnections() : Promise.resolve([]),
      grokEnabled ? listGrokSubscriptionConnections() : Promise.resolve([]),
    ])
    const bothEnabled = enabled && grokEnabled
    const describeFailure = (broker: HubBroker, reason: unknown) => {
      const brand = HUB_PROVIDER_COPY[broker].brand
      const message =
        reason instanceof Error && reason.message
          ? reason.message
          : `Failed to load ${brand} subscriptions`
      return bothEnabled ? `${brand} subscriptions: ${message}` : message
    }
    setRowsByBroker(current => ({
      'codex-subscription':
        codexResult.status === 'fulfilled'
          ? codexResult.value.map(row => asHubRow(row, 'codex-subscription'))
          : current['codex-subscription'],
      'grok-subscription':
        grokResult.status === 'fulfilled'
          ? grokResult.value.map(row => asHubRow(row, 'grok-subscription'))
          : current['grok-subscription'],
    }))
    setListErrors({
      'codex-subscription':
        codexResult.status === 'rejected'
          ? describeFailure('codex-subscription', codexResult.reason)
          : '',
      'grok-subscription':
        grokResult.status === 'rejected'
          ? describeFailure('grok-subscription', grokResult.reason)
          : '',
    })
    return { failed: codexResult.status === 'rejected' || grokResult.status === 'rejected' }
  }, [enabled, grokEnabled])

  useEffect(() => {
    if (capability === null || grokCapability === null) return
    if (!enabled && !grokEnabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    void load().finally(() => setLoading(false))
  }, [capability, grokCapability, enabled, grokEnabled, load])

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
  const subscriptionSort = useTableSort<HubConnection, 'name' | 'status'>({
    rows: filtered,
    defaultKey: 'name',
    identity: hubRowId,
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
    let created: HubConnection
    try {
      created =
        createBroker === 'grok-subscription'
          ? asHubRow(await createGrokSubscriptionConnection({ displayName }), 'grok-subscription')
          : asHubRow(await createCodexSubscriptionConnection({ displayName }), 'codex-subscription')
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
    const refreshed = await load()
    if (refreshed.failed) {
      showToast('Subscription created, but the list could not be refreshed.', { tone: 'info' })
    }
  }

  function beginCreate() {
    setCreating(true)
    setCreateBroker(enabled ? 'codex-subscription' : 'grok-subscription')
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

  async function openEdit(row: HubConnection) {
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
        const models =
          row.broker === 'grok-subscription'
            ? await listGrokConnectionModels(row.connectionKey)
            : await listCodexConnectionModels(row.connectionKey)
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
    setCreating(false)
    setEditing(null)
    setEditName('')
    setEditDefault('')
    setEditModels([])
    setSetupNew(false)
    setUserCode(null)
    setVerificationUri(null)
    setDeviceTabBlocked(false)
    void load()
  }

  async function handleSaveEdit() {
    if (!editing) return
    if (setupNew && !editName.trim()) {
      setError('Give the subscription a name before finishing.')
      return
    }
    setBusyKey(hubRowId(editing))
    try {
      const updated =
        editing.broker === 'grok-subscription'
          ? asHubRow(
              await patchGrokSubscriptionConnection(editing.connectionKey, {
                displayName: editName.trim() || grantLabel(editing),
                defaultModel: editDefault.trim() || null,
              }),
              'grok-subscription'
            )
          : asHubRow(
              await patchCodexSubscriptionConnection(editing.connectionKey, {
                displayName: editName.trim() || grantLabel(editing),
                defaultModel: editDefault.trim() || null,
              }),
              'codex-subscription'
            )
      setEditing(updated)
      // A refresh failure after a successful patch is partial — the update
      // itself landed, so it must not surface as "update failed".
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

  async function handleConnect(row: HubConnection) {
    const epoch = ++connectEpoch.current
    setBusyKey(hubRowId(row))
    const grok = row.broker === 'grok-subscription'
    const brand = HUB_PROVIDER_COPY[row.broker].brand
    // Open the verification page synchronously, inside the click handler and
    // before any await — popup blockers honour user activation here, so the
    // tab reliably appears. The device code lands in the card right after.
    // The card only claims the tab opened when open() actually returned one.
    let openedTab: Window | null = null
    // Grok's verification URI is only known once the device start returns, so
    // Grok opens an empty tab now (detached from this window) and navigates it
    // to the returned, allow-listed URI after the await.
    let pendingGrokTab: Window | null = null
    const discardPendingGrokTab = () => {
      if (!pendingGrokTab) return
      try {
        pendingGrokTab.close()
      } catch {
        // The tab may already be gone; nothing to clean up.
      }
      pendingGrokTab = null
    }
    try {
      if (grok) {
        openedTab = window.open('', '_blank')
        if (openedTab) {
          try {
            openedTab.opener = null
          } catch {
            // Best effort: some browsers expose a read-only opener.
          }
        }
        pendingGrokTab = openedTab
      } else {
        openedTab = window.open(CODEX_DEVICE_VERIFICATION_URI, '_blank', 'noopener,noreferrer')
      }
    } catch {
      openedTab = null
      pendingGrokTab = null
    }
    setDeviceTabBlocked(!openedTab)
    try {
      const started = grok
        ? await startGrokDeviceConnect(
            row.status === 'connected' ? 'reconnect' : 'connect',
            row.connectionKey
          )
        : await startCodexDeviceConnect(
            row.status === 'connected' ? 'reconnect' : 'connect',
            row.connectionKey
          )
      if (epoch !== connectEpoch.current) {
        discardPendingGrokTab()
        return
      }
      if (grok && pendingGrokTab) {
        const tab: Window = pendingGrokTab
        pendingGrokTab = null
        if (isAllowedGrokVerificationUri(started.verificationUri)) {
          try {
            tab.location.replace(started.verificationUri)
          } catch {
            setDeviceTabBlocked(true)
          }
        } else {
          try {
            tab.close()
          } catch {
            // Already closed.
          }
          setDeviceTabBlocked(true)
        }
      }
      setUserCode(started.userCode)
      setVerificationUri(started.verificationUri)
      const deadline = Date.now() + started.intervalSeconds * 1000 * 40
      let pollIntervalSeconds = started.intervalSeconds
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000))
        if (epoch !== connectEpoch.current) return
        const polled = grok
          ? await pollGrokDevice(started.state, row.connectionKey)
          : await pollCodexDevice(started.state, row.connectionKey)
        if (epoch !== connectEpoch.current) return
        if (polled.status === 'connected') {
          setUserCode(null)
          setVerificationUri(null)
          const latest = asHubRow(polled.connection, row.broker)
          setEditing(latest)
          const models = grok
            ? await listGrokConnectionModels(latest.connectionKey)
            : await listCodexConnectionModels(latest.connectionKey)
          if (epoch !== connectEpoch.current) return
          setEditModels(models)
          // A table refresh failure here is partial — connect itself worked,
          // so it must not surface as "sign-in failed".
          await load()
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
          setError(`${brand} sign-in ${polled.status}. Try again.`)
          return
        }
        if ('intervalSeconds' in polled) {
          pollIntervalSeconds = nextDevicePollIntervalSeconds(pollIntervalSeconds, polled)
        }
      }
      if (epoch !== connectEpoch.current) return
      setUserCode(null)
      setVerificationUri(null)
      setError(`${brand} sign-in timed out. Try again.`)
    } catch (err) {
      discardPendingGrokTab()
      if (epoch !== connectEpoch.current) return
      setUserCode(null)
      setVerificationUri(null)
      setError(err instanceof Error ? err.message : `${brand} sign-in failed`)
    } finally {
      if (epoch === connectEpoch.current) {
        setBusyKey(null)
      }
    }
  }

  async function handleToggleModel(row: HubConnection, model: string, enabledNext: boolean) {
    setBusyKey(hubRowId(row))
    try {
      const models =
        row.broker === 'grok-subscription'
          ? await patchGrokCatalogModel(row.connectionKey, model, enabledNext)
          : await patchCodexCatalogModel(row.connectionKey, model, enabledNext)
      setEditModels(models)
      if (editDefault === model && !enabledNext) setEditDefault('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update model')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRevoke(row: HubConnection) {
    const grok = row.broker === 'grok-subscription'
    const confirmed = await confirm({
      title: `Delete ${HUB_PROVIDER_COPY[row.broker].brand} subscription`,
      message: `Revoke ${grantLabel(row)}? Assigned agents keep the reference and stop authorizing.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusyKey(hubRowId(row))
    try {
      if (grok) await revokeGrokSubscription(row.connectionKey)
      else await revokeCodexSubscription(row.connectionKey)
      if (editing && hubRowId(editing) === hubRowId(row)) closeEdit()
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
  const dialogBroker: HubBroker = editing?.broker ?? createBroker
  const dialogCopy = HUB_PROVIDER_COPY[dialogBroker]
  // Table-level copy stays ChatGPT-specific while Grok is off (unchanged Codex
  // hub); once Grok is on the list is provider-neutral.
  const listNoun = grokEnabled
    ? enabled
      ? 'subscriptions'
      : 'Grok subscriptions'
    : 'ChatGPT subscriptions'
  const loadErrors = [
    capability?.error ?? '',
    grokCapability?.error ?? '',
    listErrors['codex-subscription'],
    listErrors['grok-subscription'],
  ].filter(Boolean)

  if (capability !== null && grokCapability !== null && !enabled && !grokEnabled) {
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
          {capability.error ||
            grokCapability.error ||
            error ||
            'Coding-plan subscriptions are disabled.'}
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
              onClick={() => void load()}
              disabled={initialLoad || loading}
              aria-label={loading ? 'Refreshing...' : `Reload ${listNoun}`}
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
          }
          search={
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search secrets"
              ariaLabel={`Search ${listNoun}`}
              disabled={initialLoad}
            />
          }
        />

        <div className="cu-card__body cu-card__body--auto cu-secrets-strip">
          <SecretsScopeTabs activeValue="llm-subscriptions" />
        </div>

        {(loadErrors.length > 0 || error) && !creating && !editing ? (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            {loadErrors.map(message => (
              <div key={message} className="cu-banner cu-banner--error">
                {message}
              </div>
            ))}
            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          </div>
        ) : null}

        <TableViewport className="cu-table-wrap">
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
                <TableStateRow colSpan={3} kind="loading" message={`Loading ${listNoun}…`} />
              ) : (error || loadErrors.length > 0) && filtered.length === 0 ? (
                <TableStateRow colSpan={3} kind="error" message={error || loadErrors[0]} />
              ) : filtered.length === 0 ? (
                <TableStateRow
                  colSpan={3}
                  message={
                    searchQuery.trim()
                      ? `No ${listNoun} match this search.`
                      : `No ${listNoun} found.`
                  }
                />
              ) : (
                subscriptionSort.sortedRows.map(row => {
                  const mapped = mapConnectionStatus(row.status)
                  return (
                    <tr key={hubRowId(row)}>
                      <td>{grantLabel(row)}</td>
                      <td>
                        <span className={statusTagClass(mapped)}>{statusLabel(mapped)}</span>
                      </td>
                      <td className="cu-table__cell-actions">
                        <RowActionsMenu
                          ariaLabel={`Actions for ${HUB_PROVIDER_COPY[row.broker].brand} subscription ${grantLabel(row)}`}
                          horizontalTrigger
                          actions={[
                            {
                              key: 'update',
                              label: 'Update',
                              onClick: () => void openEdit(row),
                            },
                            {
                              key: 'delete',
                              label: busyKey === hubRowId(row) ? 'Deleting…' : 'Delete',
                              danger: true,
                              disabled: busyKey === hubRowId(row),
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
        </TableViewport>
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
                  ? `New ${dialogCopy.brand} subscription`
                  : editing && setupNew
                    ? `Set up ${dialogCopy.brand} subscription ${grantLabel(editing)}`
                    : editing
                      ? `Update ${dialogCopy.brand} subscription ${grantLabel(editing)}`
                      : `New ${dialogCopy.brand} subscription`}
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
              {creating && grokEnabled ? (
                <div className="cu-field">
                  <label htmlFor="subscription-provider">Provider</label>
                  <select
                    id="subscription-provider"
                    value={createBroker}
                    onChange={e =>
                      setCreateBroker(
                        e.target.value === 'grok-subscription'
                          ? 'grok-subscription'
                          : 'codex-subscription'
                      )
                    }
                    disabled={Boolean(busyKey)}
                  >
                    {enabled ? <option value="codex-subscription">ChatGPT</option> : null}
                    <option value="grok-subscription">Grok</option>
                  </select>
                </div>
              ) : null}
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
                    <span className="cu-llm-config__block-title">{dialogCopy.brand} sign-in</span>
                    <span className={statusTagClass(uiStatus)}>{statusLabel(uiStatus)}</span>
                  </div>
                  <p className="cu-field__hint" style={{ margin: 0 }}>
                    {dialogBroker === 'grok-subscription'
                      ? GROK_TOS
                      : setupNew || !editing
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
                        {`Sign in with ${dialogCopy.brand}`}
                      </button>
                    </span>
                  </div>
                  {userCode ? (
                    <div className="cu-device-setup" data-testid="codex-device-code">
                      <p className="cu-device-setup__step">
                        {deviceTabBlocked
                          ? `1. Open the ${dialogCopy.brand} verification page:`
                          : `1. ${dialogCopy.brand} opened in a new tab — if it did not, use this link:`}
                      </p>
                      {(() => {
                        // Locked fallback (from dev): even if the backend
                        // omits the verification URI, the card keeps a link.
                        const deviceUri = verificationUri ?? dialogCopy.verificationFallback
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
                        code in {dialogCopy.brand}.
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
                                <LlmProviderIcon provider={dialogBroker} label={model.model} />
                                {model.model}
                              </span>
                            }
                            description={
                              model.stale
                                ? `No longer in the ${dialogCopy.brand} catalog.`
                                : undefined
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
                        No models yet — confirm the name, sign in with {dialogCopy.brand}, and sync
                        the catalog to load the models this grant offers.
                      </p>
                    )}
                    <span className="cu-field__hint">
                      Synced from the {dialogCopy.brand} catalog. Disabled models are not offered to
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
                        icon: <LlmProviderIcon provider={dialogBroker} label={model} />,
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

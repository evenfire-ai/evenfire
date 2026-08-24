'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CodexAssignableHost,
  type CodexSubscriptionConnectionView,
  bindCodexHost,
  createCodexSubscriptionConnection,
  listCodexSubscriptionFleet,
  pollCodexDevice,
  revokeCodexSubscription,
  startCodexDeviceConnect,
  syncCodexSubscriptionCatalog,
  unbindCodexHost,
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
import { SecretsScopeTabs } from '../SecretsScopeTabs'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'

function grantLabel(row: CodexSubscriptionConnectionView): string {
  return row.displayName || row.connectionKey
}

function otherGrantLabel(
  connections: CodexSubscriptionConnectionView[],
  connectionRef: string
): string {
  return connections.find(row => row.connectionKey === connectionRef)?.displayName || connectionRef
}

export function CodexSubscriptionHub() {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [capability, setCapability] = useState<CodexSubscriptionCapability | null>(null)
  const [connections, setConnections] = useState<CodexSubscriptionConnectionView[]>([])
  const [assignableHosts, setAssignableHosts] = useState<CodexAssignableHost[]>([])
  const [hostsUnavailable, setHostsUnavailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [verificationUri, setVerificationUri] = useState<string | null>(null)
  const enabled = isCodexSubscriptionUiEnabled(capability)

  useEffect(() => {
    void loadCodexSubscriptionCapability().then(setCapability)
  }, [])

  const load = useCallback(async () => {
    if (!enabled) return
    const fleet = await listCodexSubscriptionFleet()
    setConnections(fleet.connections)
    setAssignableHosts(fleet.assignableHosts)
    setHostsUnavailable(fleet.assignableHostsUnavailable)
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
        setError(err instanceof Error ? err.message : 'Could not load ChatGPT subscriptions')
      })
      .finally(() => setLoading(false))
  }, [capability, enabled, load])

  async function handleCreate() {
    setBusyKey('create')
    try {
      await createCodexSubscriptionConnection({
        displayName: displayName.trim() || 'Codex subscription',
      })
      setDisplayName('')
      setCreating(false)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create subscription', {
        tone: 'error',
      })
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
          await load()
          return
        }
        if (polled.status === 'expired' || polled.status === 'denied') {
          setUserCode(null)
          setVerificationUri(null)
          break
        }
      }
      setUserCode(null)
      setVerificationUri(null)
    } catch (err) {
      setUserCode(null)
      setVerificationUri(null)
      showToast(err instanceof Error ? err.message : 'ChatGPT sign-in failed', { tone: 'error' })
    } finally {
      setBusyKey(null)
    }
  }

  async function handleSync(row: CodexSubscriptionConnectionView) {
    setBusyKey(row.connectionKey)
    try {
      await syncCodexSubscriptionCatalog(row.connectionKey)
      await load()
      showToast(`Catalog synced: ${grantLabel(row)}`, { tone: 'success' })
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Catalog sync failed', { tone: 'error' })
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRevoke(row: CodexSubscriptionConnectionView) {
    const assigned = assignableHosts.filter(host => host.connectionRef === row.connectionKey)
    const names = assigned.map(host => host.name)
    const confirmed = await confirm({
      title: 'Revoke this ChatGPT subscription?',
      message: hostsUnavailable
        ? 'The agent assignment list could not be loaded. Revoke still fail-closes every Host that points at this grant.'
        : names.length > 0
          ? `This signs out the subscription itself. All ${names.length} agent(s) using it (${names.join(', ')}) will lose ChatGPT access immediately. Agents keep their assignment and stop authorizing; they are not reassigned automatically. To detach a single agent instead, use Remove agent on its row.${
              row.connectionKey === 'deployment-default'
                ? ' Workflow recipes that use a ChatGPT subscription also fail closed on this grant.'
                : ''
            }`
          : 'Revoke disconnects this ChatGPT grant. Assigned agents keep the reference and stop authorizing. To detach a single agent instead, use Remove agent.',
      confirmLabel: 'Revoke subscription',
    })
    if (!confirmed) return
    setBusyKey(row.connectionKey)
    try {
      await revokeCodexSubscription(row.connectionKey)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Revoke failed', { tone: 'error' })
    } finally {
      setBusyKey(null)
    }
  }

  async function handleUnbind(row: CodexSubscriptionConnectionView, hostName: string) {
    const confirmed = await confirm({
      title: `Remove ${hostName} from this subscription?`,
      message: `${hostName} will stop using "${grantLabel(row)}" and will have no ChatGPT subscription assigned until you pick another one. The subscription stays connected and other agents are not affected.`,
      confirmLabel: 'Remove agent',
    })
    if (!confirmed) return
    setBusyKey(row.connectionKey)
    try {
      await unbindCodexHost(row.connectionKey, hostName)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not remove agent', { tone: 'error' })
    } finally {
      setBusyKey(null)
    }
  }

  async function handleAssign(row: CodexSubscriptionConnectionView, host: CodexAssignableHost) {
    if (host.connectionRef !== 'unassigned' && host.connectionRef !== row.connectionKey) {
      const confirmed = await confirm({
        title: `Switch ${host.name} to this subscription?`,
        message: `${host.name} currently uses "${otherGrantLabel(connections, host.connectionRef)}". Assign it to "${grantLabel(row)}"?`,
        confirmLabel: 'Assign agent',
      })
      if (!confirmed) return
    }
    setBusyKey(row.connectionKey)
    try {
      await bindCodexHost(row.connectionKey, host.name)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not assign agent', { tone: 'error' })
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="cu-card" data-testid="codex-subscription-hub">
      {confirmDialog}
      <TablePanelHeader
        title="Subscriptions"
        subtitle="Manage ChatGPT subscriptions and every agent that can use them."
        actions={
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            onClick={() => setCreating(true)}
            disabled={!enabled || busyKey !== null}
          >
            Add subscription
          </button>
        }
      />
      <div className="cu-card__body cu-card__body--auto cu-secrets-strip">
        <SecretsScopeTabs activeValue="subscription" />
      </div>
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      {hostsUnavailable ? (
        <div className="cu-banner cu-banner--warning">
          Agent assignments could not be loaded. Revoke still works. Assign and Remove agent are
          disabled until hosts are available.
        </div>
      ) : null}
      {userCode ? (
        <div className="cu-banner" data-testid="codex-device-code">
          Enter {userCode} at {verificationUri ?? 'https://auth.openai.com/codex/device'}
        </div>
      ) : null}
      {!enabled ? (
        <div className="cu-empty">ChatGPT subscriptions are not enabled on this cluster.</div>
      ) : loading ? (
        <div className="cu-empty">Loading subscriptions…</div>
      ) : connections.length === 0 && !creating ? (
        <div className="cu-empty">
          No ChatGPT subscriptions yet. Add a subscription to let agents use ChatGPT models.
        </div>
      ) : (
        <div className="cu-form-stack" style={{ padding: '1rem' }}>
          {creating ? (
            <div className="cu-field">
              <label htmlFor="codex-hub-new-name">New subscription name</label>
              <input
                id="codex-hub-new-name"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                disabled={busyKey !== null}
              />
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => void handleCreate()}
                disabled={busyKey !== null}
              >
                Create
              </button>
            </div>
          ) : null}
          {connections.map(row => {
            const uiStatus = mapConnectionStatus(row.status)
            const assigned = assignableHosts.filter(
              host => host.connectionRef === row.connectionKey
            )
            const available = assignableHosts.filter(
              host => host.connectionRef !== row.connectionKey
            )
            const busy = busyKey === row.connectionKey
            return (
              <section
                key={row.connectionKey}
                className="cu-llm-config__block"
                data-testid={`codex-hub-grant-${row.connectionKey}`}
              >
                <div className="cu-settings-row">
                  <strong>{grantLabel(row)}</strong>
                  <span className={statusTagClass(uiStatus)}>{statusLabel(uiStatus)}</span>
                </div>
                <div className="cu-form-actions">
                  <button
                    type="button"
                    className="cu-btn cu-btn--primary"
                    onClick={() => void handleConnect(row)}
                    disabled={busy || row.status === 'revoked'}
                  >
                    Sign in with ChatGPT
                  </button>
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost"
                    onClick={() => void handleSync(row)}
                    disabled={busy || row.status !== 'connected'}
                  >
                    Sync catalog
                  </button>
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost"
                    onClick={() => void handleRevoke(row)}
                    disabled={busy || row.status === 'revoked'}
                  >
                    Revoke subscription
                  </button>
                </div>
                <h3>Assigned</h3>
                {assigned.length === 0 ? (
                  <p>No agents use this subscription.</p>
                ) : (
                  <ul>
                    {assigned.map(host => (
                      <li key={host.name}>
                        <a href={CONTROL_ROUTES.agents.detail(host.name)}>
                          {host.displayName || host.name}
                        </a>{' '}
                        <button
                          type="button"
                          className="cu-btn cu-btn--ghost cu-btn--sm"
                          onClick={() => void handleUnbind(row, host.name)}
                          disabled={busy || hostsUnavailable}
                        >
                          Remove agent
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <h3>Available</h3>
                {available.length === 0 ? (
                  <p>No other ChatGPT-capable agents are available.</p>
                ) : (
                  <ul>
                    {available.map(host => (
                      <li key={host.name}>
                        {host.displayName || host.name}
                        {host.connectionRef === 'unassigned'
                          ? ' (no subscription assigned)'
                          : ` (${otherGrantLabel(connections, host.connectionRef)})`}{' '}
                        <button
                          type="button"
                          className="cu-btn cu-btn--ghost cu-btn--sm"
                          onClick={() => void handleAssign(row, host)}
                          disabled={busy || hostsUnavailable || row.status === 'revoked'}
                        >
                          Assign
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

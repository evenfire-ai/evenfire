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
import { SelectionDropdown } from '../SelectionDropdown'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'
import { IconRefresh, IconX } from '../icons'

function grantLabel(row: CodexSubscriptionConnectionView): string {
  return row.displayName || row.connectionKey
}

function hostLabel(host: CodexAssignableHost): string {
  return host.displayName || host.name
}

function otherGrantLabel(
  connections: CodexSubscriptionConnectionView[],
  connectionRef: string
): string {
  return connections.find(row => row.connectionKey === connectionRef)?.displayName || connectionRef
}

function assignmentCaption(
  host: CodexAssignableHost,
  connections: CodexSubscriptionConnectionView[]
): string {
  if (host.connectionRef === 'unassigned') return 'No subscription'
  return otherGrantLabel(connections, host.connectionRef)
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
  const [pickedByGrant, setPickedByGrant] = useState<Record<string, string[]>>({})
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
          ? `This signs out the subscription itself. All ${names.length} agent(s) using it (${names.join(', ')}) will lose ChatGPT access immediately. Agents keep their assignment and stop authorizing; they are not reassigned automatically. To detach a single agent instead, remove it from the Agents column.${
              row.connectionKey === 'deployment-default'
                ? ' Workflow recipes that use a ChatGPT subscription also fail closed on this grant.'
                : ''
            }`
          : 'Revoke disconnects this ChatGPT grant. Assigned agents keep the reference and stop authorizing. To detach a single agent instead, remove it from the Agents column.',
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

  async function handleAssignMany(
    row: CodexSubscriptionConnectionView,
    hosts: CodexAssignableHost[]
  ) {
    if (hosts.length === 0) return
    const switching = hosts.filter(
      host => host.connectionRef !== 'unassigned' && host.connectionRef !== row.connectionKey
    )
    if (switching.length > 0) {
      const confirmed = await confirm({
        title:
          hosts.length === 1
            ? `Switch ${hosts[0].name} to this subscription?`
            : `Add ${hosts.length} agents to this subscription?`,
        message: `${switching.map(host => hostLabel(host)).join(', ')} currently use another grant. Assign ${
          hosts.length === 1 ? 'it' : 'them'
        } to "${grantLabel(row)}"?`,
        confirmLabel: hosts.length === 1 ? 'Assign agent' : `Add ${hosts.length} agents`,
      })
      if (!confirmed) return
    }
    setBusyKey(row.connectionKey)
    const assigned: string[] = []
    const failed: string[] = []
    try {
      for (const host of hosts) {
        try {
          await bindCodexHost(row.connectionKey, host.name)
          assigned.push(hostLabel(host))
        } catch (err) {
          failed.push(hostLabel(host))
          showToast(err instanceof Error ? err.message : `Could not assign ${hostLabel(host)}`, {
            tone: 'error',
          })
        }
      }
      setPickedByGrant(prev => ({ ...prev, [row.connectionKey]: [] }))
      await load()
      if (assigned.length > 0 && failed.length === 0) {
        showToast(
          assigned.length === 1
            ? `Assigned ${assigned[0]} to ${grantLabel(row)}`
            : `Assigned ${assigned.length} agents to ${grantLabel(row)}`,
          { tone: 'success' }
        )
      } else if (assigned.length > 0) {
        showToast(`Assigned ${assigned.length} of ${hosts.length} agents to ${grantLabel(row)}`, {
          tone: 'success',
        })
      }
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="cu-card cu-card--viewport-fill" data-testid="codex-subscription-hub">
      {confirmDialog}
      <TablePanelHeader
        title="Subscriptions"
        subtitle="ChatGPT grants in the same table as other Secrets. Assign any number of agents per row."
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
          Agent assignments could not be loaded. Revoke still works. Add and Remove are disabled
          until hosts are available.
        </div>
      ) : null}
      {userCode ? (
        <div className="cu-banner" data-testid="codex-device-code">
          Enter {userCode} at {verificationUri ?? 'https://auth.openai.com/codex/device'}
        </div>
      ) : null}
      {creating ? (
        <div className="cu-codex-hub__create">
          <label htmlFor="codex-hub-new-name">New subscription name</label>
          <div className="cu-codex-hub__create-row">
            <input
              id="codex-hub-new-name"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              disabled={busyKey !== null}
            />
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => void handleCreate()}
              disabled={busyKey !== null}
            >
              Create
            </button>
          </div>
        </div>
      ) : null}
      {!enabled ? (
        <div className="cu-empty">ChatGPT subscriptions are not enabled on this cluster.</div>
      ) : loading ? (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Agents</th>
                <th style={{ width: '12rem', textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, idx) => (
                <tr key={idx}>
                  <td>
                    <div
                      className="cu-skeleton cu-skeleton--cell"
                      style={{ width: `${50 + ((idx * 11) % 24)}%` }}
                    />
                  </td>
                  <td>
                    <div className="cu-skeleton cu-skeleton--cell" style={{ width: '5rem' }} />
                  </td>
                  <td>
                    <div className="cu-skeleton cu-skeleton--cell" style={{ width: '70%' }} />
                  </td>
                  <td>
                    <div
                      className="cu-skeleton cu-skeleton--cell"
                      style={{ width: '5rem', marginLeft: 'auto' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : connections.length === 0 ? (
        <div className="cu-empty">
          No ChatGPT subscriptions yet. Add a subscription to let agents use ChatGPT models.
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band" data-testid="codex-hub-table">
            <caption className="sr-only">ChatGPT subscriptions and assigned agents</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" style={{ width: '8rem' }}>
                  Status
                </th>
                <th scope="col">Agents</th>
                <th
                  scope="col"
                  style={{ width: '14rem', textAlign: 'right' }}
                  aria-label="Actions"
                />
              </tr>
            </thead>
            <tbody>
              {connections.map(row => {
                const uiStatus = mapConnectionStatus(row.status)
                const assigned = assignableHosts.filter(
                  host => host.connectionRef === row.connectionKey
                )
                const available = assignableHosts.filter(
                  host => host.connectionRef !== row.connectionKey
                )
                const picked = pickedByGrant[row.connectionKey] ?? []
                const pickedHosts = available.filter(host => picked.includes(host.name))
                const busy = busyKey === row.connectionKey
                return (
                  <tr key={row.connectionKey} data-testid={`codex-hub-grant-${row.connectionKey}`}>
                    <td>{grantLabel(row)}</td>
                    <td>
                      <span className={statusTagClass(uiStatus)}>{statusLabel(uiStatus)}</span>
                    </td>
                    <td>
                      <div className="cu-codex-hub__agents-cell">
                        {assigned.length === 0 ? (
                          <span className="cu-table__cell-muted">No agents assigned</span>
                        ) : (
                          <div
                            className="cu-chip-row"
                            data-testid="codex-hub-agent-chips"
                            aria-label={`Agents on ${grantLabel(row)}`}
                          >
                            {assigned.map(host => (
                              <span key={host.name} className="cu-chip cu-codex-hub__agent-chip">
                                <a href={CONTROL_ROUTES.agents.detail(host.name)}>
                                  {hostLabel(host)}
                                </a>
                                <button
                                  type="button"
                                  className="cu-codex-hub__chip-remove"
                                  onClick={() => void handleUnbind(row, host.name)}
                                  disabled={busy || hostsUnavailable}
                                  aria-label={`Remove agent ${hostLabel(host)}`}
                                >
                                  <IconX width={12} height={12} />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="cu-codex-hub__add" data-testid="codex-hub-add-agents">
                          {available.length === 0 ? (
                            <span className="cu-table__cell-muted">
                              All agents already use this grant.
                            </span>
                          ) : (
                            <>
                              <label
                                className="sr-only"
                                htmlFor={`codex-hub-add-${row.connectionKey}`}
                              >
                                Add agents to this subscription
                              </label>
                              <SelectionDropdown
                                id={`codex-hub-add-${row.connectionKey}`}
                                className="cu-codex-hub__picker"
                                multiple
                                value={picked}
                                options={available.map(host => ({
                                  value: host.name,
                                  label: hostLabel(host),
                                  description: assignmentCaption(host, connections),
                                  badge:
                                    host.connectionRef === 'unassigned'
                                      ? 'unassigned'
                                      : 'other grant',
                                }))}
                                placeholder="Add agents…"
                                searchPlaceholder="Search agents…"
                                selectionLabel="agents"
                                emptyLabel="No ChatGPT-capable agents available."
                                disabled={busy || hostsUnavailable || row.status === 'revoked'}
                                onChange={next =>
                                  setPickedByGrant(prev => ({
                                    ...prev,
                                    [row.connectionKey]: next,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="cu-btn cu-btn--primary cu-btn--sm"
                                onClick={() => void handleAssignMany(row, pickedHosts)}
                                disabled={
                                  busy ||
                                  hostsUnavailable ||
                                  row.status === 'revoked' ||
                                  pickedHosts.length === 0
                                }
                              >
                                {pickedHosts.length > 1
                                  ? `Add ${pickedHosts.length} agents`
                                  : 'Add agents'}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="cu-codex-hub__row-actions">
                        <button
                          type="button"
                          className="cu-btn cu-btn--ghost cu-btn--sm"
                          onClick={() => void handleConnect(row)}
                          disabled={busy || row.status === 'revoked'}
                        >
                          Sign in
                        </button>
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--toolbar"
                          onClick={() => void handleSync(row)}
                          disabled={busy || row.status !== 'connected'}
                          aria-label={`Sync catalog ${grantLabel(row)}`}
                        >
                          <IconRefresh width={16} height={16} />
                        </button>
                        <button
                          type="button"
                          className="cu-btn cu-btn--ghost cu-btn--sm"
                          onClick={() => void handleRevoke(row)}
                          disabled={busy || row.status === 'revoked'}
                        >
                          Revoke subscription
                        </button>
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
  )
}

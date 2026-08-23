'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import {
  type CodexSubscriptionConnectionView,
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
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

export type CodexAgentAssignmentProps = {
  connectionRef: string
  onConnectionRefChange: (connectionKey: string) => void
  onModelsChange?: (models: string[]) => void
  disabled?: boolean
}

function assignedHostNames(connection: CodexSubscriptionConnectionView): string[] {
  return (connection.assignedHosts ?? []).map(host => host.name).filter(Boolean)
}

export function CodexAgentAssignment({
  connectionRef,
  onConnectionRefChange,
  onModelsChange,
  disabled = false,
}: CodexAgentAssignmentProps) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [connections, setConnections] = useState<CodexSubscriptionConnectionView[]>([])
  const [selected, setSelected] = useState<CodexSubscriptionConnectionView | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [verificationUri, setVerificationUri] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [capability, setCapability] = useState<CodexSubscriptionCapability | null>(null)
  const enabled = isCodexSubscriptionUiEnabled(capability)

  useEffect(() => {
    void loadCodexSubscriptionCapability().then(setCapability)
  }, [])

  const load = useCallback(async () => {
    if (!enabled) return
    const rows = await listCodexSubscriptionConnections()
    setConnections(rows)
    const current = rows.find(row => row.connectionKey === connectionRef) ?? null
    setSelected(current)
    if (current?.status === 'connected') {
      const models = await listCodexConnectionModels(current.connectionKey)
      onModelsChange?.(models.filter(row => row.enabled && !row.stale).map(row => row.model))
    } else {
      onModelsChange?.([])
    }
  }, [connectionRef, enabled, onModelsChange])

  useEffect(() => {
    void load().catch(err => {
      showToast(err instanceof Error ? err.message : 'Could not load ChatGPT subscriptions', {
        tone: 'error',
      })
    })
  }, [load, showToast])

  const assignable = connections.filter(
    row => row.status !== 'revoked' || row.connectionKey === connectionRef
  )

  async function handleCreate() {
    setBusy(true)
    try {
      const created = await createCodexSubscriptionConnection({
        displayName: displayName.trim() || 'Codex subscription',
      })
      setCreating(false)
      setDisplayName('')
      onConnectionRefChange(created.connectionKey)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create subscription', {
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleConnect() {
    if (!selected) return
    setBusy(true)
    try {
      const started = await startCodexDeviceConnect(
        selected.status === 'connected' ? 'reconnect' : 'connect',
        selected.connectionKey
      )
      setUserCode(started.userCode)
      setVerificationUri(started.verificationUri)
      const deadline = Date.now() + started.intervalSeconds * 1000 * 40
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, started.intervalSeconds * 1000))
        const polled = await pollCodexDevice(started.state, selected.connectionKey)
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
      setBusy(false)
    }
  }

  async function handleSync() {
    if (!selected || selected.status !== 'connected') return
    setBusy(true)
    try {
      await syncCodexSubscriptionCatalog(selected.connectionKey)
      await load()
      showToast(`Catalog synced: ${selected.displayName ?? selected.connectionKey}`, {
        tone: 'success',
      })
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      showToast(
        err instanceof Error
          ? err.message
          : code === 'no_grant'
            ? 'Connect ChatGPT first'
            : 'Catalog sync failed',
        { tone: 'error' }
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke() {
    if (!selected) return
    const names = assignedHostNames(selected)
    const confirmed = await confirm({
      title: 'Revoke this ChatGPT subscription?',
      message: selected.assignedHostsUnavailable
        ? 'The agent assignment list could not be loaded. Revoke still fail-closes every Host that points at this grant.'
        : names.length > 0
          ? `This subscription is used by ${names.length} agent(s): ${names.join(', ')}. Revoke disconnects all of them.${
              selected.connectionKey === 'deployment-default'
                ? ' Workflow recipes that use a ChatGPT subscription also fail closed on this grant.'
                : ''
            }`
          : 'Revoke disconnects this ChatGPT grant. Assigned agents keep the reference and stop authorizing.',
      confirmLabel: 'Revoke',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await revokeCodexSubscription(selected.connectionKey)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Revoke failed', { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) return null

  const uiStatus = selected ? mapConnectionStatus(selected.status) : 'disconnected'

  return (
    <div className="cu-form-stack" data-testid="codex-agent-assignment">
      {confirmDialog}
      <div className="cu-field">
        <label htmlFor="codex-subscription">ChatGPT subscription</label>
        <select
          id="codex-subscription"
          value={selected?.connectionKey ?? connectionRef}
          disabled={disabled || busy}
          onChange={event => onConnectionRefChange(event.target.value)}
        >
          {!selected && connectionRef ? (
            <option value={connectionRef}>{connectionRef} (unavailable)</option>
          ) : null}
          {assignable.map(row => (
            <option
              key={row.connectionKey}
              value={row.connectionKey}
              disabled={row.status === 'revoked'}
            >
              {row.displayName || row.connectionKey}
              {row.status === 'revoked' ? ' (revoked)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="cu-field">
        <span className="cu-settings-row__label">Status</span>
        <span className={statusTagClass(uiStatus)} data-testid="codex-connection-status">
          {statusLabel(uiStatus)}
        </span>
      </div>
      {creating ? (
        <div className="cu-field">
          <label htmlFor="codex-new-name">New subscription name</label>
          <input
            id="codex-new-name"
            value={displayName}
            onChange={event => setDisplayName(event.target.value)}
            disabled={disabled || busy}
          />
          <button
            type="button"
            className="cu-btn cu-btn--primary"
            onClick={() => void handleCreate()}
            disabled={busy}
          >
            Create
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="cu-btn cu-btn--ghost cu-btn--sm"
          onClick={() => setCreating(true)}
          disabled={disabled || busy}
        >
          New subscription
        </button>
      )}
      <div className="cu-form-actions">
        <button
          type="button"
          className="cu-btn cu-btn--primary"
          onClick={() => void handleConnect()}
          disabled={disabled || busy || !selected}
        >
          Sign in with ChatGPT
        </button>
        <button
          type="button"
          className="cu-btn cu-btn--ghost"
          onClick={() => void handleSync()}
          disabled={disabled || busy || selected?.status !== 'connected'}
        >
          Sync catalog
        </button>
        <button
          type="button"
          className="cu-btn cu-btn--ghost"
          onClick={() => void handleRevoke()}
          disabled={disabled || busy || !selected || selected.status === 'revoked'}
        >
          Revoke
        </button>
      </div>
      {userCode ? (
        <div className="cu-banner" data-testid="codex-device-code">
          Enter {userCode} at {verificationUri ?? 'https://auth.openai.com/codex/device'}
        </div>
      ) : null}
    </div>
  )
}

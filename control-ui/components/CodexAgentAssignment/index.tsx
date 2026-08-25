'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexSubscriptionConnectionView,
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
  pollCodexDevice,
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
  hostName?: string
  onConnectionRefChange: (connectionKey: string) => void
  onModelsChange?: (models: string[]) => void
  disabled?: boolean
}

export function CodexAgentAssignment({
  connectionRef,
  hostName,
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

  async function handleUnbind() {
    if (!selected || !hostName) return
    const confirmed = await confirm({
      title: `Remove ${hostName} from this subscription?`,
      message: `${hostName} will stop using "${selected.displayName ?? selected.connectionKey}" after you Save. Until then this is only a draft. The subscription stays connected and other agents are not affected.`,
      confirmLabel: 'Remove agent',
    })
    if (!confirmed) return
    onConnectionRefChange(CODEX_UNASSIGNED_CONNECTION_KEY)
  }

  if (!enabled) return null

  const unassigned = connectionRef === CODEX_UNASSIGNED_CONNECTION_KEY
  const uiStatus = selected
    ? mapConnectionStatus(selected.status)
    : unassigned
      ? 'disconnected'
      : 'unavailable'

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
          {unassigned || (!selected && connectionRef) ? (
            <option value={connectionRef || CODEX_UNASSIGNED_CONNECTION_KEY}>
              {unassigned ? 'No subscription assigned' : `${connectionRef} (unavailable)`}
            </option>
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
          {unassigned ? 'No subscription assigned' : statusLabel(uiStatus)}
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
          onClick={() => void handleUnbind()}
          disabled={
            disabled ||
            busy ||
            !selected ||
            !hostName ||
            selected.status === 'revoked' ||
            unassigned
          }
        >
          Remove from this agent
        </button>
        <a className="cu-btn cu-btn--ghost" href={CONTROL_ROUTES.secrets.subscription}>
          Manage subscription
        </a>
      </div>
      {userCode ? (
        <div className="cu-banner" data-testid="codex-device-code">
          Enter {userCode} at {verificationUri ?? 'https://auth.openai.com/codex/device'}
        </div>
      ) : null}
    </div>
  )
}

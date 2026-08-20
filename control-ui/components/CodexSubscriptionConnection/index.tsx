'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { IconModels } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { isSilentApiError } from '@lib/api'
import {
  type CodexOAuthIntent,
  type CodexSubscriptionConnectionView,
  getCodexSubscriptionConnection,
  pollCodexDevice,
  refreshCodexSubscriptionConnection,
  revokeCodexSubscription,
  startCodexBrowserConnect,
  startCodexDeviceConnect,
  syncCodexSubscriptionCatalog,
} from '@lib/codexSubscription'
import {
  isCodexSubscriptionUiEnabled,
  loadCodexSubscriptionCapability,
} from '@lib/codexSubscriptionFeature'
import { type CodexSubscriptionUiStatus, mapConnectionStatus } from './types'

function failureClass(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  if (error instanceof Error && error.message.trim()) return 'request_failed'
  return 'unavailable'
}

function statusLabel(status: CodexSubscriptionUiStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'device-pending':
      return 'Device code pending'
    case 'reauth-required':
      return 'Reauthorization required'
    case 'revoking':
      return 'Revoking'
    case 'unavailable':
      return 'Unavailable'
    default:
      return 'Disconnected'
  }
}

export function CodexSubscriptionConnection() {
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [capabilityReady, setCapabilityReady] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [uiStatus, setUiStatus] = useState<CodexSubscriptionUiStatus>('disconnected')
  const [connection, setConnection] = useState<CodexSubscriptionConnectionView | null>(null)
  const [deviceUserCode, setDeviceUserCode] = useState<string | null>(null)
  const [deviceVerificationUri, setDeviceVerificationUri] = useState<string | null>(null)
  const [deviceState, setDeviceState] = useState<string | null>(null)
  const [pollMs, setPollMs] = useState(5000)
  const [syncSummary, setSyncSummary] = useState<string | null>(null)
  const [errorClass, setErrorClass] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function applyConnection(next: CodexSubscriptionConnectionView) {
    setConnection(next)
    setUiStatus(mapConnectionStatus(next.status))
    setErrorClass(null)
  }

  async function loadConnection() {
    try {
      applyConnection(await getCodexSubscriptionConnection())
    } catch (error) {
      if (isSilentApiError(error)) return
      setConnection(null)
      setUiStatus('unavailable')
      setErrorClass(failureClass(error))
    }
  }

  useEffect(() => {
    let cancelled = false
    void loadCodexSubscriptionCapability().then(capability => {
      if (cancelled) return
      const on = isCodexSubscriptionUiEnabled(capability)
      setEnabled(on)
      setCapabilityReady(true)
      if (on) void loadConnection()
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!deviceState || uiStatus !== 'device-pending') return undefined
    const timer = window.setInterval(() => {
      void pollCodexDevice(deviceState)
        .then(result => {
          if (result.status === 'connected') {
            setDeviceState(null)
            setDeviceUserCode(null)
            setDeviceVerificationUri(null)
            applyConnection(result.connection)
            showToast('Codex subscription connected.', { tone: 'success' })
            return
          }
          if (result.status === 'expired' || result.status === 'denied') {
            setDeviceState(null)
            setDeviceUserCode(null)
            setDeviceVerificationUri(null)
            setUiStatus('disconnected')
            setErrorClass(result.status)
            return
          }
          if (result.status === 'pending' || result.status === 'slow_down') {
            setPollMs(result.intervalSeconds * 1000)
          }
        })
        .catch(error => {
          if (isSilentApiError(error)) return
          setErrorClass(failureClass(error))
        })
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [deviceState, pollMs, showToast, uiStatus])

  const fingerprint = useMemo(
    () => connection?.accountFingerprint ?? 'none',
    [connection?.accountFingerprint]
  )

  async function startBrowser(intent: CodexOAuthIntent) {
    setBusy(true)
    setErrorClass(null)
    setUiStatus('connecting')
    try {
      const started = await startCodexBrowserConnect(intent)
      window.open(started.authorizeUrl, '_blank', 'noopener,noreferrer')
      showToast('Complete Codex sign-in in the browser window.', { tone: 'info' })
      await loadConnection()
    } catch (error) {
      if (isSilentApiError(error)) return
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === 'replacement_required'
      ) {
        setErrorClass('replacement_required')
        setUiStatus(connection ? mapConnectionStatus(connection.status) : 'disconnected')
        return
      }
      setUiStatus('unavailable')
      setErrorClass(failureClass(error))
    } finally {
      setBusy(false)
    }
  }

  async function startDevice(intent: CodexOAuthIntent) {
    setBusy(true)
    setErrorClass(null)
    try {
      const started = await startCodexDeviceConnect(intent)
      setDeviceUserCode(started.userCode)
      setDeviceVerificationUri(started.verificationUri)
      setDeviceState(started.state)
      setPollMs(started.intervalSeconds * 1000)
      setUiStatus('device-pending')
    } catch (error) {
      if (isSilentApiError(error)) return
      setUiStatus('unavailable')
      setErrorClass(failureClass(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleReplace() {
    const approved = await confirm({
      title: 'Replace Codex account',
      message:
        'This replaces the current Codex grant. Hosts and recipes using Codex subscription lose the current grant and must use the new account after replacement.',
      confirmLabel: 'Replace account',
      tone: 'danger',
    })
    if (!approved) return
    await startBrowser('replace')
  }

  async function handleRevoke() {
    const approved = await confirm({
      title: 'Revoke Codex subscription',
      message:
        'Revoke the deployment Codex grant? Catalog models stay visible but become unusable until a new connection.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!approved) return
    setBusy(true)
    setUiStatus('revoking')
    try {
      applyConnection(await revokeCodexSubscription())
      showToast('Codex subscription revoked.', { tone: 'success' })
    } catch (error) {
      if (isSilentApiError(error)) return
      setUiStatus('unavailable')
      setErrorClass(failureClass(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleSync() {
    setBusy(true)
    try {
      const synced = await syncCodexSubscriptionCatalog()
      applyConnection(synced.connection)
      setSyncSummary(
        `Catalog ${synced.outcome}: ${synced.added} added, ${synced.refreshed} refreshed, ${synced.staled} stale. New models stay disabled until enabled.`
      )
      showToast('Codex catalog synchronized.', { tone: 'success' })
    } catch (error) {
      if (isSilentApiError(error)) return
      setErrorClass(failureClass(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    setBusy(true)
    try {
      applyConnection(await refreshCodexSubscriptionConnection())
      showToast('Codex connection test succeeded.', { tone: 'success' })
    } catch (error) {
      if (isSilentApiError(error)) return
      setErrorClass(failureClass(error))
      if (connection) setUiStatus(mapConnectionStatus(connection.status))
    } finally {
      setBusy(false)
    }
  }

  function backToModels() {
    router.push(CONTROL_ROUTES.llmModels.root)
  }

  if (!capabilityReady) {
    return <p className="cu-subtitle">Checking Codex subscription availability.</p>
  }

  if (!enabled) {
    return (
      <CreateFlowPanel
        header={
          <CreatePageHeader
            icon={<IconModels />}
            title="Codex subscription"
            subtitle="This provider is not enabled on the control plane."
            backLabel="Back to models"
            onBack={backToModels}
          />
        }
      >
        <div className="cu-banner" role="status">
          Codex subscription is unavailable.
        </div>
      </CreateFlowPanel>
    )
  }

  return (
    <CreateFlowPanel
      header={
        <CreatePageHeader
          icon={<IconModels />}
          title="Codex subscription"
          subtitle="Connect a broker-backed Codex catalog without storing tokens in the browser."
          backLabel="Back to models"
          onBack={backToModels}
          backDisabled={busy}
        />
      }
    >
      <div className="cu-llm-models-layout">
        <p data-testid="codex-connection-status">Status: {statusLabel(uiStatus)}</p>
        {connection ? (
          <dl>
            <div>
              <dt>Fingerprint</dt>
              <dd data-testid="codex-fingerprint">{fingerprint}</dd>
            </div>
            <div>
              <dt>Credential revision</dt>
              <dd>{connection.credentialRevision}</dd>
            </div>
            <div>
              <dt>Catalog revision</dt>
              <dd>{connection.catalogRevision}</dd>
            </div>
            <div>
              <dt>Catalog</dt>
              <dd>{connection.catalogStatus}</dd>
            </div>
          </dl>
        ) : null}
        {deviceUserCode ? (
          <p data-testid="codex-device-code">
            Enter device code {deviceUserCode}
            {deviceVerificationUri ? ` at ${deviceVerificationUri}` : ''}
          </p>
        ) : null}
        {syncSummary ? <p data-testid="codex-sync-summary">{syncSummary}</p> : null}
        {errorClass ? (
          <div className="cu-banner cu-banner--error" role="alert">
            Connection failed ({errorClass}).
          </div>
        ) : null}
        <div>
          <button
            type="button"
            className="cu-btn cu-btn--primary cu-btn--sm"
            disabled={busy}
            onClick={() => void startBrowser('connect')}
          >
            Connect in browser
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={busy}
            onClick={() => void startDevice('connect')}
          >
            Use device code
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={busy || !connection}
            onClick={() => void startBrowser('reconnect')}
          >
            Reconnect
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={busy || !connection}
            onClick={() => void handleReplace()}
          >
            Replace account
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={busy || uiStatus !== 'connected'}
            onClick={() => void handleSync()}
          >
            Sync catalog
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={busy || uiStatus !== 'connected'}
            onClick={() => void handleTest()}
          >
            Test connection
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={busy || uiStatus === 'disconnected'}
            onClick={() => void handleRevoke()}
          >
            Revoke
          </button>
        </div>
      </div>
      {confirmDialog}
    </CreateFlowPanel>
  )
}

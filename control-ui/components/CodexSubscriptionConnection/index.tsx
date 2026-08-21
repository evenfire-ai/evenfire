'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { LlmProviderIcon } from '@components/LlmProviderIcon'
import { useToast } from '@components/Toast'
import { Button, FormSection } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { isSilentApiError } from '@lib/api'
import {
  type CodexOAuthIntent,
  type CodexSubscriptionConnectionView,
  getCodexSubscriptionConnection,
  isCodexBrowserOAuthUnavailableError,
  pollCodexDevice,
  readCodexOAuthQueryParam,
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
import {
  type CodexSubscriptionUiStatus,
  mapConnectionStatus,
  statusLabel,
  statusTagClass,
} from './types'

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

function CodexHeaderIcon() {
  return (
    <span className="cu-codex-subscription-header-icon" aria-hidden="true">
      <LlmProviderIcon provider="openai" label="OpenAI" />
      <LlmProviderIcon provider="codex-subscription" label="Codex subscription" />
    </span>
  )
}

function ConnectionDetailRow({
  label,
  value,
  testId,
}: {
  label: string
  value: React.ReactNode
  testId?: string
}) {
  return (
    <div className="cu-settings-row">
      <div className="cu-settings-row__main">
        <span className="cu-settings-row__label">{label}</span>
        <span className="cu-settings-row__value" {...(testId ? { 'data-testid': testId } : {})}>
          {value}
        </span>
      </div>
    </div>
  )
}

export function CodexSubscriptionConnection() {
  const router = useRouter()
  const searchParams = useSearchParams()
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
  const [browserOAuthBlocked, setBrowserOAuthBlocked] = useState(false)
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
    const outcome = readCodexOAuthQueryParam(searchParams)
    if (!outcome) return
    router.replace(CONTROL_ROUTES.llmModels.codexSubscription)
    if (outcome === 'connected') {
      void loadConnection().then(() => {
        showToast('Codex subscription connected.', { tone: 'success' })
      })
      return
    }
    setErrorClass(outcome)
    if (outcome === 'browser_oauth_unregistered') {
      setBrowserOAuthBlocked(true)
    }
    setUiStatus('disconnected')
  }, [router, searchParams, showToast])

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
    setBrowserOAuthBlocked(false)
    setUiStatus('connecting')
    try {
      const started = await startCodexBrowserConnect(intent)
      window.location.assign(started.authorizeUrl)
    } catch (error) {
      if (isSilentApiError(error)) return
      if (isCodexBrowserOAuthUnavailableError(error)) {
        setBrowserOAuthBlocked(true)
        setErrorClass('browser_oauth_unregistered')
        setUiStatus(connection ? mapConnectionStatus(connection.status) : 'disconnected')
        return
      }
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
            icon={<CodexHeaderIcon />}
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
          icon={<CodexHeaderIcon />}
          title="Codex subscription"
          subtitle="Connect OpenAI Codex through the OAuth broker without storing tokens in the browser."
          backLabel="Back to models"
          onBack={backToModels}
          backDisabled={busy}
        />
      }
    >
      <div className="cu-create-content cu-px-form cu-codex-subscription-panel">
        <FormSection
          title="Connection"
          description="Authorize OpenAI Codex once for this deployment. Tokens stay on the control plane."
        >
          <div className="cu-codex-subscription-panel__status-row">
            <span className="cu-settings-row__label">Status</span>
            <span className={statusTagClass(uiStatus)} data-testid="codex-connection-status">
              {statusLabel(uiStatus)}
            </span>
          </div>

          {connection ? (
            <div className="cu-settings-list">
              <ConnectionDetailRow
                label="Account fingerprint"
                value={fingerprint}
                testId="codex-fingerprint"
              />
              <ConnectionDetailRow
                label="Credential revision"
                value={connection.credentialRevision}
              />
              <ConnectionDetailRow label="Catalog revision" value={connection.catalogRevision} />
              <ConnectionDetailRow label="Catalog status" value={connection.catalogStatus} />
            </div>
          ) : null}

          {deviceUserCode ? (
            <div
              className="cu-banner cu-banner--info"
              role="status"
              data-testid="codex-device-code"
            >
              Enter device code <strong>{deviceUserCode}</strong>
              {deviceVerificationUri ? (
                <>
                  {' '}
                  at{' '}
                  <a href={deviceVerificationUri} target="_blank" rel="noopener noreferrer">
                    {deviceVerificationUri}
                  </a>
                </>
              ) : null}
            </div>
          ) : null}

          {syncSummary ? (
            <div className="cu-banner cu-banner--ok" role="status" data-testid="codex-sync-summary">
              {syncSummary}
            </div>
          ) : null}

          {errorClass ? (
            <div className="cu-banner cu-banner--error" role="alert">
              Connection failed ({errorClass}).
            </div>
          ) : null}

          {browserOAuthBlocked ? (
            <div
              className="cu-banner cu-banner--info"
              role="status"
              data-testid="codex-browser-oauth-blocked"
            >
              Browser sign-in needs a deployment-registered OpenAI OAuth client for this
              cluster&apos;s control-ui callback URL. Use device code to connect with the default
              Codex client.
            </div>
          ) : null}

          <div className="cu-form-inline">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void startBrowser('connect')}
            >
              Connect in browser
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void startDevice('connect')}
            >
              Use device code
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !connection}
              onClick={() => void startBrowser('reconnect')}
            >
              Reconnect
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !connection}
              onClick={() => void handleReplace()}
            >
              Replace account
            </Button>
          </div>
        </FormSection>

        <FormSection
          title="Catalog and health"
          description="Sync discovered models into the allowlist and verify the broker grant."
        >
          <div className="cu-form-inline">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || uiStatus !== 'connected'}
              onClick={() => void handleSync()}
            >
              Sync catalog
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || uiStatus !== 'connected'}
              onClick={() => void handleTest()}
            >
              Test connection
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy || uiStatus === 'disconnected'}
              onClick={() => void handleRevoke()}
            >
              Revoke
            </Button>
          </div>
        </FormSection>
      </div>
      {confirmDialog}
    </CreateFlowPanel>
  )
}

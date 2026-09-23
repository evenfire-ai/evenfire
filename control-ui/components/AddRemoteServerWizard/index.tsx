'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { useToast } from '@components/Toast'
import { Button, Field, SelectInput, TextInput } from '@components/ui'
import { getContexts, isSilentApiError } from '@lib/api'
import type { ContextResource } from '@lib/api'
import { contextResourceName } from '@lib/contextIdentity'
import {
  buildRemoteInstallRequest,
  discoverRemoteServer,
  displayClientMode,
  getRemoteServerNameError,
  installModeForRegistration,
  installRemoteServer,
  mapRemoteDiscoverError,
  mapRemoteInstallError,
  requiresPreRegisteredCredentials,
  shouldWarnNoRefresh,
} from '@lib/remoteMcp'
import type { RemoteDetected, RemoteGrantScope } from '@lib/remoteMcp.types'
import {
  GRANT_SCOPE_OPTIONS,
  REGISTRATION_MODE_HINT,
  REGISTRATION_MODE_LABEL,
  REMOTE_WIZARD_STEPS,
  REMOTE_WIZARD_STEP_DETAILS,
} from './constants'
import type { AddRemoteServerWizardProps } from './types'

const STEP_TITLE_ID = 'add-remote-server-step-title'

export function AddRemoteServerWizard({
  pageHeader,
  onInstalled,
  onCancel,
}: AddRemoteServerWizardProps) {
  const { showToast } = useToast()

  const [step, setStep] = useState(0)

  // Step 0 — identity
  const [baseUrl, setBaseUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [contextRef, setContextRef] = useState('')
  const [contexts, setContexts] = useState<ContextResource[]>([])
  const [contextsError, setContextsError] = useState('')

  // Detection. Editing the URL clears `detected` (see the baseUrl onChange), so
  // a present `detected` always corresponds to the current URL (D-4: the pinned
  // config is authoritative — a re-detect is forced whenever the URL changes).
  const [detecting, setDetecting] = useState(false)
  const [discoverError, setDiscoverError] = useState('')
  const [detected, setDetected] = useState<RemoteDetected | null>(null)

  // Step 1 — configuration
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [grantScope, setGrantScope] = useState<RemoteGrantScope>('user')

  // Step 2 — install
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await getContexts()
        if (!cancelled) setContexts(res.items ?? [])
      } catch (e) {
        if (isSilentApiError(e)) return
        if (!cancelled) {
          setContextsError(e instanceof Error ? e.message : 'Failed to load contexts')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const serverNameError = serverName.length > 0 ? getRemoteServerNameError(serverName) : ''
  const trimmedBaseUrl = baseUrl.trim()
  const identifiersValid =
    trimmedBaseUrl.length > 0 && getRemoteServerNameError(serverName) === '' && contextRef !== ''

  const installMode = detected ? installModeForRegistration(detected.registrationMode) : null
  const needsCredentials = installMode ? requiresPreRegisteredCredentials(installMode) : false
  const noRefresh = detected ? shouldWarnNoRefresh(detected) : false

  const credentialsComplete =
    !needsCredentials || (clientId.trim().length > 0 && clientSecret.length > 0)
  const step1Valid = Boolean(detected) && identifiersValid && credentialsComplete

  function canSelectStep(target: number): boolean {
    if (target === 0) return true
    if (target === 1) return Boolean(detected) && identifiersValid
    return step1Valid
  }

  const contextOptions = useMemo(
    () =>
      contexts
        .map(context => contextResourceName(context))
        .filter(name => name.length > 0)
        .sort((left, right) => left.localeCompare(right)),
    [contexts]
  )

  function resetDetection() {
    setDetected(null)
    setDiscoverError('')
  }

  async function runDetect() {
    setDetecting(true)
    setDiscoverError('')
    try {
      const result = await discoverRemoteServer(trimmedBaseUrl)
      setDetected(result)
      setStep(1)
    } catch (e) {
      if (isSilentApiError(e)) return
      setDetected(null)
      setDiscoverError(mapRemoteDiscoverError(e))
    } finally {
      setDetecting(false)
    }
  }

  async function runInstall() {
    if (!detected || !installMode) return
    setInstalling(true)
    setInstallError('')
    try {
      const body = buildRemoteInstallRequest({
        serverName,
        contextRef,
        baseUrl: trimmedBaseUrl,
        mode: installMode,
        grantScope,
        clientId: needsCredentials ? clientId : undefined,
        clientSecret: needsCredentials ? clientSecret : undefined,
      })
      const res = await installRemoteServer(body)
      showToast(`Remote server ${res.serverName} installed.`, { tone: 'success' })
      onInstalled()
    } catch (e) {
      if (isSilentApiError(e)) return
      setInstallError(mapRemoteInstallError(e))
    } finally {
      setInstalling(false)
    }
  }

  const clientModeLabel = detected ? displayClientMode(detected) : null

  return (
    <CreateFlowPanel header={pageHeader}>
      <form
        onSubmit={event => {
          event.preventDefault()
          if (step === 2) void runInstall()
        }}
      >
        <CreateStepFlow
          ariaLabel="Add remote server steps"
          className="cu-create-step-flow--3"
          currentStep={step}
          onStepChange={target => {
            if (canSelectStep(target)) setStep(target)
          }}
          canSelectStep={canSelectStep}
          steps={REMOTE_WIZARD_STEP_DETAILS}
          stepLabels={REMOTE_WIZARD_STEPS}
          titleId={STEP_TITLE_ID}
        >
          {step === 0 ? (
            <div className="cu-form-stack cu-agent-form-stack">
              <Field
                description="The base URL of the remote MCP server (its OAuth metadata is discovered from here)."
                label="Remote server URL"
                htmlFor="remote-base-url"
                required
              >
                <TextInput
                  id="remote-base-url"
                  monospace
                  onChange={event => {
                    setBaseUrl(event.target.value)
                    // Editing the URL invalidates a prior detection.
                    if (detected) resetDetection()
                  }}
                  placeholder="https://mcp.example.com/mcp"
                  disabled={detecting}
                  autoFocus
                  value={baseUrl}
                />
              </Field>

              <Field
                description="Kubernetes resource name: lowercase alphanumeric and hyphens, max 63 chars."
                error={serverNameError || undefined}
                label="Server name"
                htmlFor="remote-server-name"
                required
              >
                <TextInput
                  id="remote-server-name"
                  invalid={Boolean(serverNameError)}
                  monospace
                  onChange={event =>
                    setServerName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  placeholder="example-remote"
                  disabled={detecting}
                  value={serverName}
                />
              </Field>

              <Field
                description="The context this connector is attached to. Agents using this context can call it."
                error={contextsError || undefined}
                label="Context"
                htmlFor="remote-context-ref"
                required
              >
                <SelectInput
                  id="remote-context-ref"
                  onChange={event => setContextRef(event.target.value)}
                  disabled={detecting || contextOptions.length === 0}
                  value={contextRef}
                >
                  <option value="">Select a context…</option>
                  {contextOptions.map(name => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              {discoverError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {discoverError}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 1 && detected ? (
            <div className="cu-form-stack cu-agent-form-stack">
              {noRefresh ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  This authorization server does not support token refresh, so users will have to
                  re-authorize periodically to keep this connector working.
                </div>
              ) : null}

              <section className="cu-summary-list" aria-label="Detected OAuth configuration">
                <div className="cu-summary-list__row">
                  <span>Registration mode</span>
                  <strong>{REGISTRATION_MODE_LABEL[detected.registrationMode]}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Client mode</span>
                  <strong>{clientModeLabel}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Issuer</span>
                  <strong>{detected.issuer}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Resource</span>
                  <strong>{detected.resource}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Authorization endpoint</span>
                  <strong>{detected.endpoints.authorization}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Token endpoint</span>
                  <strong>{detected.endpoints.token}</strong>
                </div>
                {detected.endpoints.registration ? (
                  <div className="cu-summary-list__row">
                    <span>Registration endpoint</span>
                    <strong>{detected.endpoints.registration}</strong>
                  </div>
                ) : null}
                <div className="cu-summary-list__row">
                  <span>Scopes</span>
                  <strong>{detected.scopes.join(' ') || '—'}</strong>
                </div>
                {detected.quirks.bearerInBody ? (
                  <div className="cu-summary-list__row">
                    <span>Token transport</span>
                    <strong>Sent in the request body</strong>
                  </div>
                ) : null}
              </section>

              <p className="cu-field__hint">{REGISTRATION_MODE_HINT[detected.registrationMode]}</p>

              {needsCredentials ? (
                <div className="cu-form-grid">
                  <Field
                    description="The client_id of the pre-registered OAuth client for this server."
                    label="Client ID"
                    htmlFor="remote-client-id"
                    required
                  >
                    <TextInput
                      id="remote-client-id"
                      monospace
                      onChange={event => setClientId(event.target.value)}
                      placeholder="pre-registered client_id"
                      value={clientId}
                    />
                  </Field>
                  <Field
                    description="Stored as a Kubernetes Secret and only ever sent to the pinned token endpoint."
                    label="Client secret"
                    htmlFor="remote-client-secret"
                    required
                  >
                    <TextInput
                      id="remote-client-secret"
                      type="password"
                      autoComplete="off"
                      onChange={event => setClientSecret(event.target.value)}
                      placeholder="pre-registered client_secret"
                      value={clientSecret}
                    />
                  </Field>
                </div>
              ) : null}

              <Field
                description="Whether each user authorizes their own token or the context shares one."
                label="Grant scope"
                htmlFor="remote-grant-scope"
              >
                <SelectInput
                  id="remote-grant-scope"
                  onChange={event => setGrantScope(event.target.value as RemoteGrantScope)}
                  value={grantScope}
                >
                  {GRANT_SCOPE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label} — {option.description}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </div>
          ) : null}

          {step === 2 && detected && installMode ? (
            <div className="cu-form-stack cu-agent-form-stack">
              <section className="cu-summary-list" aria-label="Install summary">
                <div className="cu-summary-list__row">
                  <span>Server name</span>
                  <strong>{serverName}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Context</span>
                  <strong>{contextRef}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Remote URL</span>
                  <strong>{trimmedBaseUrl}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Registration mode</span>
                  <strong>{REGISTRATION_MODE_LABEL[detected.registrationMode]}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Client mode</span>
                  <strong>{clientModeLabel}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Grant scope</span>
                  <strong>{grantScope === 'user' ? 'Per user' : 'Per context'}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Authorization endpoint</span>
                  <strong>{detected.endpoints.authorization}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Token endpoint</span>
                  <strong>{detected.endpoints.token}</strong>
                </div>
              </section>

              {noRefresh ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  Reminder: this server does not support token refresh — users will re-authorize
                  periodically.
                </div>
              ) : null}

              {installError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {installError}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="cu-create-actions">
            <Button
              disabled={detecting || installing}
              onClick={() => (step === 0 ? onCancel() : setStep(current => current - 1))}
              size="sm"
              variant="ghost"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </Button>

            {step === 0 ? (
              detected ? (
                <Button
                  disabled={!identifiersValid}
                  onClick={() => setStep(1)}
                  size="sm"
                  variant="primary"
                >
                  Continue
                </Button>
              ) : (
                <Button
                  disabled={!identifiersValid || detecting}
                  loading={detecting}
                  onClick={() => void runDetect()}
                  size="sm"
                  variant="primary"
                >
                  {detecting ? 'Detecting…' : 'Detect'}
                </Button>
              )
            ) : null}

            {step === 1 ? (
              <Button disabled={!step1Valid} onClick={() => setStep(2)} size="sm" variant="primary">
                Continue
              </Button>
            ) : null}

            {step === 2 ? (
              <Button
                disabled={!step1Valid || installing}
                loading={installing}
                size="sm"
                type="submit"
                variant="primary"
              >
                {installing ? 'Installing…' : 'Install remote server'}
              </Button>
            ) : null}
          </div>
        </CreateStepFlow>
      </form>
    </CreateFlowPanel>
  )
}

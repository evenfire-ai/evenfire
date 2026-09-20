'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { useToast } from '@components/Toast'
import { IconCheck, IconCopy } from '@components/icons'
import { Button, Field, SelectInput, TextAreaInput, TextInput } from '@components/ui'
import { OAUTH_PROVIDER_DOC_URLS, oauthProviderLabel } from '@constants/oauthProviders'
import { getOAuthCredentialManifest, installFromRegistry, listMcpSecrets } from '@lib/api'
import { copyTextToClipboard } from '@lib/clipboard'
import { isValidK8sName, toK8sName } from '@lib/k8sValidation'
import {
  buildOAuthRedirectUri,
  deriveOAuthClientIdPreview,
  formatScopesForInput,
  oauthCallbackBaseUrl,
  parseScopesInput,
  referenceSecretIssue,
  scopesAreSatisfied,
} from '@lib/oauthInstall'
import type {
  McpSecretSummary,
  OAuthCredentialField,
  OAuthGrantScope,
  OAuthSecretInput,
} from '@lib/oauthInstall.types'
import { createPrivateContext } from '@lib/privateContext'
import type { OAuthInstallFormProps } from './types'

const STEPS = ['Provider', 'Credentials', 'Install'] as const

const STEP_DETAILS = [
  {
    description: 'Register the redirect URI',
    title: 'Provider setup',
    subtitle: 'Register this redirect URI in the provider’s OAuth app before you continue.',
  },
  {
    description: 'Add client credentials',
    title: 'Client credentials',
    subtitle: 'Provide the OAuth client the broker uses to exchange tokens.',
  },
  {
    description: 'Scopes and install',
    title: 'Scopes and install',
    subtitle: 'Set the grant type and scopes, then install the connector.',
  },
] as const

// Canonical field names in every baked provider's credential manifest. control-api
// keys the managed Secret by these exact names (OAUTH_CLIENT_ID_KEY /
// OAUTH_CLIENT_SECRET_KEY in routes/admin/registry.ts), so the manifest field, the
// managed-mode submit, and the default reference keys all use one source.
const CLIENT_ID_FIELD = 'client_id'
const CLIENT_SECRET_FIELD = 'client_secret'

export function OAuthInstallForm({
  entry,
  catalogOAuth,
  onCancel,
  onInstalled,
  onViewConnectors,
}: OAuthInstallFormProps) {
  const { showToast } = useToast()
  const provider = catalogOAuth.provider
  const providerLabel = oauthProviderLabel(provider)
  const docUrl = OAUTH_PROVIDER_DOC_URLS[provider]

  const [step, setStep] = useState(0)
  const [serverName, setServerName] = useState(toK8sName(entry.name))
  const [secretMode, setSecretMode] = useState<'managed' | 'reference'>('managed')
  // Managed-mode values, keyed by manifest field name. The client_secret lives
  // ONLY here (state) and in the submit body — never logged, never re-emitted.
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [refSecretName, setRefSecretName] = useState('')
  const [refClientIdKey, setRefClientIdKey] = useState(CLIENT_ID_FIELD)
  const [refClientSecretKey, setRefClientSecretKey] = useState(CLIENT_SECRET_FIELD)
  const [grantScope, setGrantScope] = useState<OAuthGrantScope>(catalogOAuth.grantScope ?? 'user')
  const [scopesText, setScopesText] = useState(formatScopesForInput(catalogOAuth.scopes ?? []))

  const [manifest, setManifest] = useState<OAuthCredentialField[]>([])
  const [secrets, setSecrets] = useState<McpSecretSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [installed, setInstalled] = useState(false)
  const installInFlightRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    ;(async () => {
      try {
        // The reference-Secret list is best-effort for managed mode: a failure only
        // leaves the dropdown empty. In reference mode an empty list does block the
        // install (referenceSecretIssue can't verify a Secret it can't see) — that
        // is acceptable fail-closed degradation.
        const [manifestResult, secretsResult] = await Promise.allSettled([
          getOAuthCredentialManifest(provider),
          listMcpSecrets(),
        ])
        if (cancelled) return
        if (manifestResult.status === 'fulfilled') {
          setManifest(manifestResult.value.fields ?? [])
        } else {
          setLoadError(
            manifestResult.reason instanceof Error
              ? manifestResult.reason.message
              : 'Failed to load the provider credential form.'
          )
        }
        setSecrets(secretsResult.status === 'fulfilled' ? (secretsResult.value.items ?? []) : [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider])

  const derivedId = useMemo(() => deriveOAuthClientIdPreview(serverName), [serverName])
  const callbackBase = oauthCallbackBaseUrl()
  const callbackConfigured = callbackBase.length > 0
  const redirectUri = useMemo(
    () => buildOAuthRedirectUri(callbackBase, derivedId),
    [callbackBase, derivedId]
  )
  const nameValid = isValidK8sName(serverName)

  const scopes = useMemo(() => parseScopesInput(scopesText), [scopesText])
  const scopesOk = scopesAreSatisfied(scopes)

  const requiredFields = useMemo(() => manifest.filter(field => field.required), [manifest])
  // A missing/failed manifest yields an empty field list; without this guard
  // `[].every(...)` would be vacuously true and let the operator advance and
  // submit empty managed credentials. Require a loaded manifest instead.
  const managedComplete =
    manifest.length > 0 &&
    requiredFields.every(field => (credValues[field.name] ?? '').trim().length > 0)
  const referenceIssue =
    secretMode === 'reference'
      ? referenceSecretIssue(
          {
            secretName: refSecretName,
            clientIdKey: refClientIdKey,
            clientSecretKey: refClientSecretKey,
          },
          secrets
        )
      : null
  const credentialsComplete = secretMode === 'managed' ? managedComplete : referenceIssue === null

  const canInstall =
    callbackConfigured &&
    nameValid &&
    Boolean(derivedId) &&
    credentialsComplete &&
    scopesOk &&
    !installing
  const step0Ready = nameValid && Boolean(derivedId)
  const canContinue = step === 0 ? step0Ready : step === 1 ? credentialsComplete : canInstall

  function canSelectStep(target: number) {
    if (target <= step) return true
    if (target === 1) return step0Ready
    return step0Ready && credentialsComplete
  }

  async function handleCopyRedirectUri() {
    if (!redirectUri) return
    const ok = await copyTextToClipboard(redirectUri)
    showToast(ok ? 'Redirect URI copied.' : 'Copy failed — select and copy the URI manually.', {
      tone: ok ? 'success' : 'error',
    })
  }

  function buildSecretInput(): OAuthSecretInput {
    if (secretMode === 'reference') {
      return {
        mode: 'reference',
        secretName: refSecretName.trim(),
        clientIdKey: refClientIdKey.trim(),
        clientSecretKey: refClientSecretKey.trim(),
      }
    }
    // Read the managed values by the manifest field names rather than a hardcoded
    // pair, so this cannot silently drop the values if a manifest ever labels the
    // fields differently. For the 8 baked providers these resolve to
    // client_id/client_secret (the canonical Secret keys control-api writes).
    const idField = manifest.find(f => !f.secret)?.name ?? CLIENT_ID_FIELD
    const secretField = manifest.find(f => f.secret)?.name ?? CLIENT_SECRET_FIELD
    return {
      mode: 'managed',
      clientId: (credValues[idField] ?? '').trim(),
      clientSecret: credValues[secretField] ?? '',
    }
  }

  async function handleInstall() {
    if (!canInstall || installInFlightRef.current) return
    installInFlightRef.current = true
    setInstalling(true)
    setSubmitError('')
    try {
      const contextRef = await createPrivateContext(
        {
          subject: serverName || entry.name,
          description: `Connector access scope for ${serverName || entry.name}`,
        },
        'We couldn’t prepare this connector’s access — please try again.'
      )
      await installFromRegistry({
        serverName: serverName || undefined,
        contextRef,
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        oauth: {
          scopes,
          grantScope,
          secret: buildSecretInput(),
        },
      })
      // Drop the typed client_secret from component state on success so it is
      // never held in the DOM after the request that consumed it (S-2).
      setCredValues({})
      setInstalled(true)
      onInstalled()
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Installation failed')
    } finally {
      installInFlightRef.current = false
      setInstalling(false)
    }
  }

  return (
    <>
      <CreateStepFlow
        ariaLabel="Install OAuth connector steps"
        className="cu-create-step-flow--3"
        currentStep={step}
        onStepChange={setStep}
        canSelectStep={canSelectStep}
        steps={STEP_DETAILS}
        stepLabels={STEPS}
        titleId="oauth-install-step-title"
      >
        <form
          className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide"
          onSubmit={event => {
            event.preventDefault()
            if (step < STEPS.length - 1) {
              if (canContinue) setStep(current => Math.min(STEPS.length - 1, current + 1))
              return
            }
            void handleInstall()
          }}
        >
          {step === 0 ? (
            <div className="cu-form-section">
              <div className="cu-form-section__header">
                <h3 className="cu-form-section__title">Register the OAuth app</h3>
                <p className="cu-form-section__description">
                  Create an OAuth app for <strong>{providerLabel}</strong> and register the exact
                  redirect URI below. control-api derives the callback id from the connector name.
                </p>
              </div>

              <Field
                htmlFor="oauth-server-name"
                label="Connector name"
                description="Used to derive the OAuth callback id. Lowercase letters, digits, and hyphens."
                error={
                  serverName && !nameValid
                    ? 'Must be a valid Kubernetes name (max 63 chars).'
                    : undefined
                }
              >
                <TextInput
                  id="oauth-server-name"
                  value={serverName}
                  onChange={event =>
                    setServerName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  placeholder="my-oauth-connector"
                />
              </Field>

              <Field
                htmlFor="oauth-derived-id"
                label="Callback id (auto-derived)"
                description="control-api owns this id and checks it is unique; it cannot be typed."
              >
                <TextInput id="oauth-derived-id" value={derivedId} readOnly monospace />
              </Field>

              <Field
                label="Redirect URI"
                description="Register this exact URI in the provider’s OAuth app."
              >
                {!callbackConfigured ? (
                  // Real config error: the deployment has no public callback base URL.
                  <div className="cu-banner cu-banner--warn" role="alert">
                    The public OAuth callback URL is not configured for this deployment
                    (CONTROL_API_OAUTH_CALLBACK_BASE_URL). Configure it before installing an OAuth
                    connector — the install will be rejected otherwise.
                  </div>
                ) : redirectUri ? (
                  <div className="cu-table-actions">
                    <TextInput value={redirectUri} readOnly monospace aria-label="Redirect URI" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon
                      onClick={handleCopyRedirectUri}
                      aria-label="Copy redirect URI"
                    >
                      <IconCopy width={16} height={16} />
                    </Button>
                  </div>
                ) : (
                  // Config is fine; the name is just empty, so there is no id yet.
                  // Prompt for the name instead of a false configuration error.
                  <p className="cu-field__hint" role="status">
                    Enter a connector name above to generate the redirect URI.
                  </p>
                )}
              </Field>

              {docUrl ? (
                <p className="cu-field__hint">
                  <a href={docUrl} target="_blank" rel="noreferrer noopener">
                    {providerLabel} OAuth app documentation
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="cu-form-section">
              <div className="cu-form-section__header">
                <h3 className="cu-form-section__title">Client credentials</h3>
                <p className="cu-form-section__description">
                  Only the broker reads these — they are never mounted in the connector pod.
                </p>
              </div>

              <Field
                htmlFor="oauth-secret-mode"
                label="Secret source"
                description="Type the client credentials, or reference an existing Secret by name and keys."
              >
                <SelectInput
                  id="oauth-secret-mode"
                  value={secretMode}
                  onChange={event => setSecretMode(event.target.value as 'managed' | 'reference')}
                >
                  <option value="managed">Managed — enter client id and secret</option>
                  <option value="reference">Reference — use an existing Secret</option>
                </SelectInput>
              </Field>

              {loadError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {loadError}
                </div>
              ) : null}

              {secretMode === 'managed'
                ? manifest.map(field => (
                    <Field
                      key={field.name}
                      htmlFor={`oauth-cred-${field.name}`}
                      label={field.label}
                      description={field.help}
                      required={field.required}
                    >
                      <TextInput
                        id={`oauth-cred-${field.name}`}
                        type={field.secret ? 'password' : 'text'}
                        autoComplete={field.secret ? 'new-password' : 'off'}
                        value={credValues[field.name] ?? ''}
                        onChange={event =>
                          setCredValues(previous => ({
                            ...previous,
                            [field.name]: event.target.value,
                          }))
                        }
                        placeholder={field.label}
                      />
                    </Field>
                  ))
                : null}

              {secretMode === 'reference' ? (
                <>
                  <Field
                    htmlFor="oauth-ref-secret"
                    label="Existing Secret"
                    description="An existing Secret in the MCP servers namespace."
                    required
                  >
                    <SelectInput
                      id="oauth-ref-secret"
                      value={refSecretName}
                      onChange={event => setRefSecretName(event.target.value)}
                    >
                      <option value="">Select a Secret…</option>
                      {secrets.map(secret => (
                        <option key={secret.name} value={secret.name}>
                          {secret.name}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field htmlFor="oauth-ref-id-key" label="Client ID key" required>
                    <TextInput
                      id="oauth-ref-id-key"
                      value={refClientIdKey}
                      onChange={event => setRefClientIdKey(event.target.value)}
                      monospace
                    />
                  </Field>
                  <Field htmlFor="oauth-ref-secret-key" label="Client Secret key" required>
                    <TextInput
                      id="oauth-ref-secret-key"
                      value={refClientSecretKey}
                      onChange={event => setRefClientSecretKey(event.target.value)}
                      monospace
                    />
                  </Field>
                  {referenceIssue ? (
                    <div className="cu-banner cu-banner--error" role="alert">
                      {referenceIssue}
                    </div>
                  ) : (
                    <div className="cu-banner cu-banner--info" role="status">
                      Secret and keys verified.
                    </div>
                  )}
                </>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="cu-form-section">
              <div className="cu-form-section__header">
                <h3 className="cu-form-section__title">Scopes and install</h3>
                <p className="cu-form-section__description">
                  Grant type is fixed once installed. Scopes prefill from the catalog and can be
                  edited per connector.
                </p>
              </div>

              <Field
                htmlFor="oauth-grant-scope"
                label="Grant type"
                description="user: a token per end user. context: one shared identity."
              >
                <SelectInput
                  id="oauth-grant-scope"
                  value={grantScope}
                  onChange={event => setGrantScope(event.target.value as OAuthGrantScope)}
                >
                  <option value="user">Per user</option>
                  <option value="context">Shared (context)</option>
                </SelectInput>
              </Field>

              <Field
                htmlFor="oauth-scopes"
                label="Scopes"
                description="One scope per line (or space/comma separated). At least one is required."
                required
                error={!scopesOk ? 'Add at least one OAuth scope for this connector.' : undefined}
              >
                <TextAreaInput
                  id="oauth-scopes"
                  value={scopesText}
                  onChange={event => setScopesText(event.target.value)}
                  rows={4}
                  monospace
                  placeholder="offline_access"
                />
              </Field>

              <section className="cu-summary-list" aria-label="OAuth install summary">
                <div className="cu-summary-list__row">
                  <span>Provider</span>
                  <strong>{providerLabel}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Connector</span>
                  <strong>{serverName || '-'}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Callback id</span>
                  <strong>{derivedId || '-'}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Scopes</span>
                  <strong>{scopes.length > 0 ? scopes.join(', ') : '-'}</strong>
                </div>
              </section>

              {!callbackConfigured ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  The public OAuth callback URL is not configured, so this install would be
                  rejected. Configure CONTROL_API_OAUTH_CALLBACK_BASE_URL and reload.
                </div>
              ) : null}
            </div>
          ) : null}

          {submitError ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {submitError}
            </div>
          ) : null}

          <div className="cu-create-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={installing}
              onClick={() => (step === 0 ? onCancel() : setStep(current => current - 1))}
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="submit" variant="primary" size="sm" disabled={loading || !canContinue}>
                Continue
              </Button>
            ) : (
              <Button type="submit" variant="primary" size="sm" disabled={!canInstall}>
                {installing ? 'Installing…' : 'Install connector'}
              </Button>
            )}
          </div>
        </form>
      </CreateStepFlow>

      {installed ? (
        <div className="cu-modal-backdrop" role="presentation">
          <section
            className="cu-modal-panel cu-modal-panel--install-success"
            role="dialog"
            aria-modal="true"
            aria-labelledby="oauth-install-success-title"
            aria-describedby="oauth-install-success-copy"
          >
            <div className="cu-registry-install-success__icon" aria-hidden="true">
              <IconCheck width={26} height={26} />
            </div>
            <div className="cu-registry-install-success__content">
              <p className="cu-registry-install-success__eyebrow">Connector installed</p>
              <h2 id="oauth-install-success-title" className="cu-modal-panel__title">
                OAuth connector installed
              </h2>
              <p id="oauth-install-success-copy" className="cu-modal-copy">
                <strong>{serverName}</strong> is installed. Connect an account and grant agent
                access from the Installed Connectors list whenever you’re ready.
              </p>
            </div>
            <div className="cu-modal-panel__foot cu-registry-install-success__actions">
              <Button
                type="button"
                variant="primary"
                onClick={() => onViewConnectors?.()}
                disabled={!onViewConnectors}
              >
                Go to Connectors
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

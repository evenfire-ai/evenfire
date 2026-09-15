'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { EgressEditor } from '@components/EgressEditor'
import { IconCheck } from '@components/icons'
import { Button } from '@components/ui'
import type { CredentialSchema } from '@lib/api'
import { getRegistryCredentialSchema, installFromRegistry } from '@lib/api'
import { registryEntryToEgressBindings } from '@lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '@lib/egressModel'
import { isValidK8sName, toK8sName } from '@lib/k8sValidation'
import { buildPastedValue } from '@lib/pasteUtils'
import { createPrivateContext } from '@lib/privateContext'
import { getEmbeddedCredentialSchema } from '../registryInstallHelpers'
import type { RegistryInstallFormProps } from './types'

const STEPS = ['Package', 'Credentials', 'Install'] as const

const STEP_DETAILS = [
  {
    description: 'Review Marketplace entry',
    title: 'Marketplace package',
    subtitle: 'Review the package and optionally adjust its installation configuration.',
  },
  {
    description: 'Add connector credentials',
    title: 'Credentials',
    subtitle: 'Optionally add the credentials needed by this connector.',
  },
  {
    description: 'Confirm install',
    title: 'Review install',
    subtitle: 'Check the connector install before applying it.',
  },
] as const

export function RegistryInstallForm({
  entry,
  onCancel,
  onInstalled,
  onViewConnectors,
}: RegistryInstallFormProps) {
  const [step, setStep] = useState(0)
  // Default to a K8s-valid name derived from the scoped registry name (e.g.
  // `@org/name` → `org-name`); `entry.name` itself is not a valid resource name.
  const [serverName, setServerName] = useState(toK8sName(entry.name))
  const [credSchema, setCredSchema] = useState<CredentialSchema | null>(null)
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)
  const [installed, setInstalled] = useState(false)
  const installInFlightRef = useRef(false)
  const registryInitialEgressBindings = useMemo(() => registryEntryToEgressBindings(entry), [entry])

  useEffect(() => {
    installInFlightRef.current = false
    setStep(0)
    setServerName(toK8sName(entry.name))
    setError('')
    setCredValues({})
    setEgressBindings(registryInitialEgressBindings)
    setEgressStatus(null)
    setInstalled(false)
    setLoading(true)
    ;(async () => {
      try {
        const schema = await getRegistryCredentialSchema(entry.name, entry.version).catch(() =>
          getEmbeddedCredentialSchema(entry)
        )
        setCredSchema(schema)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load configuration')
      } finally {
        setLoading(false)
      }
    })()
  }, [entry, registryInitialEgressBindings])

  const nameValid = isValidK8sName(serverName)
  const credHasKeys = (credSchema?.keys?.length ?? 0) > 0
  const credRequired = !!credSchema?.required && credHasKeys
  const credStarted =
    credRequired && credSchema!.keys.some(key => (credValues[key.name] ?? '').trim() !== '')
  const missingCredentialKeys =
    credRequired && credStarted
      ? credSchema!.keys
          .filter(key => !(credValues[key.name] ?? '').trim())
          .map(key => key.label || key.name)
      : []
  const credComplete = !credStarted || missingCredentialKeys.length === 0
  const remoteRequiresEgress = entry.server_mode === 'remote'
  const egressValid =
    egressStatus !== null &&
    egressStatus.errors.length === 0 &&
    !(remoteRequiresEgress && egressStatus.mode === 'none')
  const canSubmit = nameValid && credComplete && egressValid && !installing
  const packageComplete = !loading && nameValid && egressValid
  const canContinue = step === 0 ? packageComplete : step === 1 ? credComplete : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    if (targetStep === 1) return packageComplete
    return packageComplete && credComplete
  }

  async function handleInstall() {
    if (!canSubmit || installInFlightRef.current) return

    installInFlightRef.current = true
    setInstalling(true)
    setError('')

    try {
      const filled = credHasKeys
        ? Object.fromEntries(
            credSchema!.keys
              .map(key => [key.name, credValues[key.name] ?? ''])
              .filter(([, value]) => (value as string).trim() !== '')
          )
        : {}
      const credentials: Record<string, string> | undefined =
        Object.keys(filled).length > 0 ? filled : undefined
      const selectedEgressBindings =
        egressStatus?.mode === 'none' && (registryInitialEgressBindings?.length ?? 0) > 0
          ? []
          : egressBindings

      // The install contract needs an access scope on the wire. It is an
      // implementation detail: a private scope is generated silently (same
      // pattern as agent creation) and the operator grants agents from the
      // Installed Connectors list afterwards.
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
        credentials,
        egressBindings: selectedEgressBindings,
      })

      setInstalled(true)
      onInstalled()
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : 'Installation failed')
    } finally {
      installInFlightRef.current = false
      setInstalling(false)
    }
  }

  function pasteCredentialValue(keyName: string, event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text')
    if (!pasted) return
    event.preventDefault()

    const current = credValues[keyName] ?? ''
    const nextValue = buildPastedValue(current, pasted, event.currentTarget)
    setCredValues(previous => ({ ...previous, [keyName]: nextValue }))
  }

  return (
    <>
      <CreateStepFlow
        ariaLabel="Install connector steps"
        className="cu-create-step-flow--3 cu-registry-install-flow"
        currentStep={step}
        onStepChange={setStep}
        canSelectStep={canSelectStep}
        steps={STEP_DETAILS}
        stepLabels={STEPS}
        titleId="registry-install-step-title"
      >
        {step === 0 ? (
          <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
            <div className="cu-form-section">
              <div className="cu-form-section__header">
                <h3 className="cu-form-section__title">Install Connector from Marketplace</h3>
                <p className="cu-form-section__description">
                  Configure installation details for <strong>{entry.name}</strong> v{entry.version}.
                </p>
              </div>

              <div className="cu-registry-entry-card">
                <div className="cu-registry-entry-card__head">
                  <strong className="cu-registry-name">{entry.name}</strong>
                  <span className="cu-muted">v{entry.version}</span>
                </div>
                {entry.description ? (
                  <p className="cu-registry-description">{entry.description}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="cu-card">
            <div className="cu-card__body cu-muted">Loading installation configuration...</div>
          </div>
        ) : (
          <form
            onSubmit={event => {
              event.preventDefault()
              if (step < STEPS.length - 1) {
                if (canContinue) setStep(current => Math.min(STEPS.length - 1, current + 1))
                return
              }
              void handleInstall()
            }}
            className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide"
          >
            {step === 0 ? (
              <details className="cu-registry-install-configuration">
                <summary>Configuration</summary>
                <div className="cu-registry-install-configuration__body">
                  <div className="cu-field cu-field--compact">
                    <label htmlFor="ri-name">Server name</label>
                    <input
                      id="ri-name"
                      className="cu-input"
                      value={serverName}
                      onChange={event =>
                        setServerName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                      }
                      placeholder="my-mcp-server"
                    />
                    {serverName && !nameValid ? (
                      <p className="cu-field__error">
                        Must be a valid K8s name (lowercase, alphanumeric, hyphens, max 63 chars).
                      </p>
                    ) : null}
                  </div>

                  <EgressEditor
                    allowCidr
                    description="Review and adjust the egress contract that will be installed from this Marketplace entry. The final CRD is created from this selection, not from the Marketplace warning alone."
                    initialBindings={registryInitialEgressBindings}
                    key={`${entry.name}-${entry.version}-${JSON.stringify(registryInitialEgressBindings ?? [])}`}
                    onChange={(nextBindings, status) => {
                      setEgressBindings(nextBindings)
                      setEgressStatus(status)
                    }}
                  />
                  {remoteRequiresEgress && egressStatus?.mode === 'none' ? (
                    <div className="cu-banner cu-banner--error" role="alert">
                      Remote connectors must keep exact-host egress to the selected vendor endpoint.
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}

            {step === 1 ? (
              <div className="cu-agent-form-stack cu-agent-form-stack--wide">
                {credHasKeys ? (
                  <fieldset className="cu-form-section">
                    <legend className="cu-section-title">
                      Credentials ({credSchema!.authType}
                      {credRequired ? '' : ' - optional'})
                    </legend>
                    {credSchema!.keys.map(key => (
                      <div className="cu-field cu-field--compact" key={key.name}>
                        <label htmlFor={`ri-cred-${key.name}`}>{key.label}</label>
                        <input
                          id={`ri-cred-${key.name}`}
                          className="cu-input"
                          type={
                            key.kind === 'api-key' || key.kind === 'password' ? 'password' : 'text'
                          }
                          value={credValues[key.name] ?? ''}
                          onChange={event =>
                            setCredValues(previous => ({
                              ...previous,
                              [key.name]: event.target.value,
                            }))
                          }
                          onPaste={event => pasteCredentialValue(key.name, event)}
                          autoComplete="new-password"
                          placeholder={key.label}
                        />
                      </div>
                    ))}
                    {credRequired ? (
                      <div
                        className={`cu-banner ${credStarted && !credComplete ? 'cu-banner--error' : 'cu-banner--info'}`}
                      >
                        {credStarted && !credComplete
                          ? `Complete all credential fields or clear them all to install pending. Missing: ${missingCredentialKeys.join(', ')}.`
                          : 'Leave all credential fields empty to install now and add this connector secret later from Secrets, or fill every field to create it during install.'}
                      </div>
                    ) : null}
                  </fieldset>
                ) : (
                  <div className="cu-agent-review">
                    This connector does not require credentials.
                  </div>
                )}
              </div>
            ) : null}

            {step === 2 ? (
              <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
                <section className="cu-summary-list" aria-label="Install summary">
                  <div className="cu-summary-list__row">
                    <span>Connector</span>
                    <strong>{serverName || '-'}</strong>
                  </div>
                  <div className="cu-summary-list__row">
                    <span>Marketplace package</span>
                    <strong>{entry.name}</strong>
                  </div>
                  <div className="cu-summary-list__row">
                    <span>Version</span>
                    <strong>{entry.version}</strong>
                  </div>
                </section>
                <section className="cu-form-section" aria-labelledby="connector-access-title">
                  <div className="cu-form-section__header">
                    <h3 id="connector-access-title" className="cu-form-section__title">
                      Connector access
                    </h3>
                    <p className="cu-form-section__description">
                      After installing, choose which agents can use this connector from the
                      Installed Connectors list.
                    </p>
                  </div>
                </section>
              </div>
            ) : null}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <div className="cu-create-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => (step === 0 ? onCancel() : setStep(current => current - 1))}
                disabled={installing}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {step < STEPS.length - 1 ? (
                <Button type="submit" variant="primary" size="sm" disabled={!canContinue}>
                  Continue
                </Button>
              ) : (
                <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
                  {installing ? 'Installing...' : 'Install'}
                </Button>
              )}
            </div>
          </form>
        )}
      </CreateStepFlow>
      {installed ? (
        <div className="cu-modal-backdrop" role="presentation">
          <section
            className="cu-modal-panel cu-modal-panel--install-success"
            role="dialog"
            aria-modal="true"
            aria-labelledby="registry-install-success-title"
            aria-describedby="registry-install-success-copy"
          >
            <div className="cu-registry-install-success__icon" aria-hidden="true">
              <IconCheck width={26} height={26} />
            </div>
            <div className="cu-registry-install-success__content">
              <p className="cu-registry-install-success__eyebrow">Connector installed</p>
              <h2 id="registry-install-success-title" className="cu-modal-panel__title">
                Congratulations — you&apos;re ready to go
              </h2>
              <p id="registry-install-success-copy" className="cu-modal-copy">
                <strong>{serverName}</strong> is installed. Give agents access from the Installed
                Connectors list whenever you&apos;re ready; visit Connectors to check its status or
                adjust its settings.
              </p>
            </div>
            <div className="cu-modal-panel__foot cu-registry-install-success__actions">
              <Button type="button" variant="primary" onClick={onViewConnectors}>
                Go to Connectors
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

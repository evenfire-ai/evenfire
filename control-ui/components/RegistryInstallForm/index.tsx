'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { EgressEditor } from '@components/EgressEditor'
import { useToast } from '@components/Toast'
import { Button } from '@components/ui'
import type { CredentialSchema } from '@lib/api'
import { getContexts, getRegistryCredentialSchema, installFromRegistry } from '@lib/api'
import { registryEntryToEgressBindings } from '@lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '@lib/egressModel'
import { isValidK8sName } from '@lib/k8sValidation'
import { buildPastedValue } from '@lib/pasteUtils'
import { trustBgColor, trustColor } from '@lib/trustLevel'
import { getEmbeddedCredentialSchema, getExternalEgressNotice } from '../registryInstallHelpers'
import type { RegistryInstallFormProps } from './types'

const STEPS = ['Package', 'Configure', 'Network', 'Install'] as const

const STEP_DETAILS = [
  {
    description: 'Review Marketplace entry',
    title: 'Marketplace package',
    subtitle: 'Review trust, version, and egress notices for this connector.',
  },
  {
    description: 'Name and credentials',
    title: 'Installation settings',
    subtitle: 'Set the server name, context, and credentials.',
  },
  {
    description: 'Confirm egress',
    title: 'Network egress',
    subtitle: 'Review and adjust the egress contract that will be installed.',
  },
  {
    description: 'Confirm install',
    title: 'Review install',
    subtitle: 'Check the connector install before applying it.',
  },
] as const

export function RegistryInstallForm({ entry, onCancel, onInstalled }: RegistryInstallFormProps) {
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  const [serverName, setServerName] = useState(entry.name)
  const [contextRef, setContextRef] = useState('')
  const [contexts, setContexts] = useState<Array<{ name: string }>>([])
  const [credSchema, setCredSchema] = useState<CredentialSchema | null>(null)
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)
  const installInFlightRef = useRef(false)
  const registryInitialEgressBindings = useMemo(() => registryEntryToEgressBindings(entry), [entry])

  useEffect(() => {
    installInFlightRef.current = false
    setStep(0)
    setServerName(entry.name)
    setError('')
    setCredValues({})
    setEgressBindings(registryInitialEgressBindings)
    setEgressStatus(null)
    setLoading(true)
    ;(async () => {
      try {
        const [schema, ctxResult] = await Promise.all([
          getRegistryCredentialSchema(entry.name, entry.version).catch(() =>
            getEmbeddedCredentialSchema(entry)
          ),
          getContexts(),
        ])
        setCredSchema(schema)
        const ctxItems = (ctxResult.items ?? [])
          .map(c => ({
            name: (c.metadata as Record<string, string>)?.name ?? '',
          }))
          .filter(c => c.name)
        setContexts(ctxItems)
        if (ctxItems.length > 0) {
          setContextRef(prev => prev || ctxItems[0].name)
        }
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
  const externalEgressNotice = getExternalEgressNotice(entry)
  const remoteRequiresEgress = entry.server_mode === 'remote'
  const egressValid =
    egressStatus !== null &&
    egressStatus.errors.length === 0 &&
    !(remoteRequiresEgress && egressStatus.mode === 'none')
  const canSubmit =
    nameValid && contextRef.trim() !== '' && credComplete && egressValid && !installing
  const canContinue =
    step === 0
      ? !loading
      : step === 1
        ? nameValid && contextRef.trim() !== '' && credComplete
        : step === 2
          ? egressValid
          : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    if (targetStep === 1) return !loading
    if (targetStep === 2) return nameValid && contextRef.trim() !== '' && credComplete
    return nameValid && contextRef.trim() !== '' && credComplete && egressValid
  }

  const externalTargetsText = useMemo(
    () =>
      externalEgressNotice?.targets.length
        ? externalEgressNotice.targets.join(', ')
        : 'public internet',
    [externalEgressNotice]
  )
  const externalPortsText = useMemo(
    () => externalEgressNotice?.ports.join(', ') ?? '',
    [externalEgressNotice]
  )

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

      await installFromRegistry({
        serverName: serverName || undefined,
        contextRef,
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        credentials,
        egressBindings: selectedEgressBindings,
      })

      showToast(`"${serverName}" was installed and added to context "${contextRef}".`, {
        tone: 'success',
      })
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
        className="cu-create-step-flow--4"
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

              {externalEgressNotice && (
                <div className="cu-warning-card" role="alert">
                  <span>
                    {externalEgressNotice.isRemote
                      ? 'Remote connector.'
                      : externalEgressNotice.wideCidr
                        ? 'Public web egress required.'
                        : 'External API access required.'}{' '}
                    {externalEgressNotice.wideCidr
                      ? 'Installing this CRD authorizes public web egress on TCP ports '
                      : 'Installing this CRD authorizes outbound egress to '}
                    {!externalEgressNotice.wideCidr && <strong>{externalTargetsText}</strong>}
                    {!externalEgressNotice.wideCidr && ' on port'}
                    {!externalEgressNotice.wideCidr &&
                      (externalEgressNotice.ports.length > 1 ? 's ' : ' ')}
                    {externalEgressNotice.wideCidr && (
                      <>
                        <strong>{externalPortsText}</strong>. Private, metadata, cluster-internal,
                        link-local, multicast, and reserved ranges remain blocked.
                        {externalEgressNotice.targets.length > 0 && (
                          <>
                            {' '}
                            Listed domains ({externalTargetsText}) are examples and not the complete
                            enforcement boundary.
                          </>
                        )}
                      </>
                    )}
                    {!externalEgressNotice.wideCidr && <strong>{externalPortsText}</strong>}
                    {!externalEgressNotice.wideCidr && '.'} This expands to{' '}
                    <strong>{externalEgressNotice.bindingCount}</strong> egress binding
                    {externalEgressNotice.bindingCount === 1 ? '' : 's'}.
                    {externalEgressNotice.isRemote && (
                      <>
                        {' '}
                        Credentials are stored in Kubernetes and forwarded via the egress proxy. The
                        pod runs nginx in our cluster, NOT the vendor&apos;s image.
                      </>
                    )}
                  </span>
                  {externalEgressNotice.blockingError ? (
                    <div className="cu-field__error">{externalEgressNotice.blockingError}</div>
                  ) : null}
                </div>
              )}

              <div className="cu-registry-entry-card">
                <div className="cu-registry-entry-card__head">
                  <strong className="cu-registry-name">{entry.name}</strong>
                  <span className="cu-muted">v{entry.version}</span>
                  <span
                    className="cu-registry-trust-chip"
                    style={{
                      background: trustBgColor(entry.trust_level),
                      color: trustColor(entry.trust_level),
                    }}
                  >
                    {entry.trust_level}
                  </span>
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
            {step === 1 ? (
              <>
                <div className="cu-field cu-field--compact">
                  <label htmlFor="ri-name">Server name</label>
                  <input
                    id="ri-name"
                    className="cu-input"
                    value={serverName}
                    onChange={event => setServerName(event.target.value.toLowerCase())}
                    placeholder="my-mcp-server"
                  />
                  {serverName && !nameValid ? (
                    <p className="cu-field__error">
                      Must be a valid K8s name (lowercase, alphanumeric, hyphens, max 63 chars).
                    </p>
                  ) : null}
                </div>

                <div className="cu-field cu-field--compact">
                  <label htmlFor="ri-context">Context</label>
                  <select
                    id="ri-context"
                    className="cu-input"
                    value={contextRef}
                    onChange={event => setContextRef(event.target.value)}
                  >
                    <option value="">Select a context...</option>
                    {contexts.map(context => (
                      <option key={context.name} value={context.name}>
                        {context.name}
                      </option>
                    ))}
                  </select>
                </div>

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
                          placeholder={key.description}
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
                ) : null}
              </>
            ) : null}

            {step === 2 ? (
              <>
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
              </>
            ) : null}

            {step === 3 ? (
              <div className="cu-agent-review">
                Connector <b>{serverName || '-'}</b> will be installed into context{' '}
                <b>{contextRef || '-'}</b> from <b>{entry.name}</b> v{entry.version}.
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
    </>
  )
}

'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { EgressEditor } from '@components/EgressEditor'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconCheck } from '@components/icons'
import { Button } from '@components/ui'
import { getAgentDisplayName } from '@lib/agentName'
import type { CredentialSchema } from '@lib/api'
import {
  getContextTeams,
  getContextUsers,
  getContexts,
  getHosts,
  getRegistryCredentialSchema,
  installFromRegistry,
} from '@lib/api'
import { registryEntryToEgressBindings } from '@lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '@lib/egressModel'
import { isValidK8sName, toK8sName } from '@lib/k8sValidation'
import { buildPastedValue } from '@lib/pasteUtils'
import { getEmbeddedCredentialSchema } from '../registryInstallHelpers'
import type { RegistryInstallFormProps } from './types'

const STEPS = ['Package', 'Context', 'Credentials', 'Install'] as const

const STEP_DETAILS = [
  {
    description: 'Review Marketplace entry',
    title: 'Marketplace package',
    subtitle: 'Review the package and optionally adjust its installation configuration.',
  },
  {
    description: 'Choose connector access',
    title: 'Context',
    subtitle: 'Choose where to install this connector and review who can use it.',
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

type ContextAccess = {
  agents: Array<{ id: string; label: string }>
  teams: Array<{ id: string; label: string }>
  users: Array<{ id: string; label: string }>
}

const EMPTY_CONTEXT_ACCESS: ContextAccess = { agents: [], teams: [], users: [] }

const CONTEXT_ACCESS_GROUPS: Array<{ key: keyof ContextAccess; title: string }> = [
  { key: 'users', title: 'Users' },
  { key: 'teams', title: 'Teams' },
  { key: 'agents', title: 'Agents' },
]

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
  const [contextRef, setContextRef] = useState('')
  const [contexts, setContexts] = useState<Array<{ name: string }>>([])
  const [credSchema, setCredSchema] = useState<CredentialSchema | null>(null)
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)
  const [contextAccess, setContextAccess] = useState<ContextAccess>(EMPTY_CONTEXT_ACCESS)
  const [contextAccessError, setContextAccessError] = useState('')
  const [loadingContextAccess, setLoadingContextAccess] = useState(false)
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
    setContextAccess(EMPTY_CONTEXT_ACCESS)
    setContextAccessError('')
    setInstalled(false)
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

  useEffect(() => {
    const selectedContext = contextRef.trim()
    if (!selectedContext) {
      setContextAccess(EMPTY_CONTEXT_ACCESS)
      setContextAccessError('')
      setLoadingContextAccess(false)
      return
    }

    let cancelled = false
    setLoadingContextAccess(true)
    setContextAccessError('')

    void (async () => {
      const [usersResult, teamsResult, hostsResult] = await Promise.allSettled([
        getContextUsers(selectedContext),
        getContextTeams(selectedContext),
        getHosts(),
      ])
      if (cancelled) return

      const failed =
        usersResult.status === 'rejected' ||
        teamsResult.status === 'rejected' ||
        hostsResult.status === 'rejected'
      setContextAccess({
        users:
          usersResult.status === 'fulfilled'
            ? (usersResult.value.items ?? []).map(user => ({
                id: user.id,
                label: user.displayName || user.name || user.email || user.id,
              }))
            : [],
        teams:
          teamsResult.status === 'fulfilled'
            ? (teamsResult.value.items ?? []).map(team => ({ id: team.id, label: team.name }))
            : [],
        agents:
          hostsResult.status === 'fulfilled'
            ? (hostsResult.value.items ?? [])
                .filter(host => String(host.spec?.contextRef ?? '').trim() === selectedContext)
                .map(host => {
                  const name = host.metadata?.name || 'unknown'
                  return { id: name, label: getAgentDisplayName(name) || name }
                })
            : [],
      })
      setContextAccessError(
        failed
          ? 'Some access information could not be loaded. The lists below may be incomplete.'
          : ''
      )
      setLoadingContextAccess(false)
    })()

    return () => {
      cancelled = true
    }
  }, [contextRef])

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
  const canSubmit =
    nameValid && contextRef.trim() !== '' && credComplete && egressValid && !installing
  const packageComplete = !loading && nameValid && egressValid
  const contextComplete = contextRef.trim() !== ''
  const canContinue =
    step === 0 ? packageComplete : step === 1 ? contextComplete : step === 2 ? credComplete : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    if (targetStep === 1) return packageComplete
    if (targetStep === 2) return packageComplete && contextComplete
    return packageComplete && contextComplete && credComplete
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
        className="cu-create-step-flow--4 cu-registry-install-flow"
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
                <section className="cu-form-section">
                  <div className="cu-form-section__header">
                    <h3 className="cu-form-section__title">Context access</h3>
                    <p className="cu-form-section__description">
                      Choose the context where this connector will be available. The access lists
                      update for the selected context.
                    </p>
                  </div>
                  <div className="cu-field cu-field--compact">
                    <label>Context</label>
                    <SelectionDropdown
                      id="ri-context"
                      multiple={false}
                      value={contextRef ? [contextRef] : []}
                      onChange={next => setContextRef(next[0] ?? '')}
                      options={contexts.map(context => ({
                        value: context.name,
                        label: context.name,
                      }))}
                      placeholder="Select a context..."
                      searchPlaceholder="Search contexts..."
                      selectionLabel="Context"
                      showSelectedChips={false}
                      emptyLabel="No contexts available."
                    />
                  </div>

                  {loadingContextAccess ? (
                    <p className="cu-muted">Loading context access…</p>
                  ) : contextRef ? (
                    <>
                      {contextAccessError ? (
                        <p className="cu-banner cu-banner--warn" role="status">
                          {contextAccessError}
                        </p>
                      ) : null}
                      <div className="cu-registry-context-access__intro">
                        <span>Access preview</span>
                        <p>These people and agents can use this connector in {contextRef}.</p>
                      </div>
                      <section className="cu-registry-context-access" aria-label="Context access">
                        {CONTEXT_ACCESS_GROUPS.map(group => (
                          <section
                            className="cu-registry-context-access__group"
                            data-kind={group.key}
                            key={group.key}
                          >
                            <div className="cu-registry-context-access__heading">
                              <h4>{group.title}</h4>
                              <span>{contextAccess[group.key].length}</span>
                            </div>
                            {contextAccess[group.key].length > 0 ? (
                              <ul className="cu-registry-context-access__list">
                                {contextAccess[group.key].map(principal => (
                                  <li key={principal.id}>
                                    <span>{principal.label}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="cu-muted">
                                No {group.title.toLowerCase()} have access.
                              </p>
                            )}
                          </section>
                        ))}
                      </section>
                    </>
                  ) : null}
                </section>
              </div>
            ) : null}

            {step === 2 ? (
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

            {step === 3 ? (
              <div className="cu-form-stack cu-agent-form-stack--wide">
                <section className="cu-summary-list" aria-label="Install summary">
                  <div className="cu-summary-list__row">
                    <span>Connector</span>
                    <strong>{serverName || '-'}</strong>
                  </div>
                  <div className="cu-summary-list__row">
                    <span>Context</span>
                    <strong>{contextRef || '-'}</strong>
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
                      Members, teams, and agents with access to <strong>{contextRef}</strong> will
                      be able to use this connector.
                    </p>
                  </div>
                  {loadingContextAccess ? (
                    <p className="cu-muted">Loading connector access…</p>
                  ) : (
                    <section
                      className="cu-registry-install-access-summary"
                      aria-label="Connector access principals"
                    >
                      {CONTEXT_ACCESS_GROUPS.map(group => (
                        <div className="cu-registry-install-access-summary__row" key={group.key}>
                          <span>{group.key === 'users' ? 'Members' : group.title}</span>
                          <strong>
                            {contextAccess[group.key].length > 0
                              ? contextAccess[group.key]
                                  .map(principal => principal.label)
                                  .join(', ')
                              : `No ${group.key === 'users' ? 'members' : group.title.toLowerCase()}`}
                          </strong>
                        </div>
                      ))}
                    </section>
                  )}
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
                <strong>{serverName}</strong> is available in <strong>{contextRef}</strong>. You can
                now use it in the desktop app; visit Connectors to check its status or adjust its
                settings.
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

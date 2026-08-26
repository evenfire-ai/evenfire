'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { useToast } from '@components/Toast'
import { Button, CheckboxField, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import type { CredentialSchema, HookCapability, HostResource } from '@lib/api'
import { getHosts, getRegistryCredentialSchema, installHookFromRegistry } from '@lib/api'
import { buildPastedValue } from '@lib/pasteUtils'
import { getEmbeddedHookCredentialSchema } from '../registryInstallHelpers'
import {
  ALL_HOOK_CAPABILITIES,
  DEFAULT_HOOK_ORDER,
  ENFORCED_HOOK_CAPABILITIES,
  HOOK_CAPABILITY_OPTIONS,
  HOOK_INSTALL_ERROR_LABELS,
  ORDER_HINT_LABELS,
} from './constants'
import type { HookInstallFormProps } from './types'

const STEPS = ['Configure', 'Install'] as const

const STEP_DETAILS = [
  {
    description: 'Bind the guardrail hook',
    title: 'Guardrail hook',
    subtitle: 'Pick the target agent and configure how this hook runs.',
  },
  {
    description: 'Confirm install',
    title: 'Review install',
    subtitle: 'Check the guardrail hook install before applying it.',
  },
] as const

// A Host's guardrails.capabilityCeiling bounds which capabilities a hook may be
// granted. An absent ceiling is the empty set, not "unbounded": the install
// route reads it as `capabilityCeiling ?? []` and rejects anything requested
// against it, so granting must narrow to nothing here for the same Host.
//
// `null` means "no agent resolved yet" and is the one case that must not
// narrow, so the author's seed survives the load rather than being cleared
// before the selected Host has arrived. spec is typed AnyRecord in lib/api, so
// read it defensively and keep only the four known capability values.
function hostCapabilityCeiling(host: HostResource | undefined): HookCapability[] | null {
  if (!host) return null
  const guardrails = (host.spec as { guardrails?: { capabilityCeiling?: unknown } } | undefined)
    ?.guardrails
  const ceiling = guardrails?.capabilityCeiling
  if (!Array.isArray(ceiling)) return []
  return ceiling.filter((c): c is HookCapability =>
    ALL_HOOK_CAPABILITIES.includes(c as HookCapability)
  )
}

// Surface the install-hook route's { error, reason? } body. formatApiError stashes
// the parsed JSON on `.body` and the code on `.code`; fall back to the message.
function describeHookInstallError(err: unknown): string {
  const withBody = err as { code?: string; body?: Record<string, unknown>; message?: string }
  const code =
    withBody.code ?? (typeof withBody.body?.error === 'string' ? withBody.body.error : '')
  const reason = typeof withBody.body?.reason === 'string' ? withBody.body.reason : ''
  const base =
    (code && HOOK_INSTALL_ERROR_LABELS[code]) || (err instanceof Error ? err.message : '')
  const message = base || 'Failed to install guardrail hook'
  return reason ? `${message} (${reason})` : message
}

export function HookInstallForm({ entry, onCancel, onInstalled }: HookInstallFormProps) {
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [hostRef, setHostRef] = useState('')
  const [credSchema, setCredSchema] = useState<CredentialSchema | null>(null)
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [capabilities, setCapabilities] = useState<Set<HookCapability>>(new Set())
  const [order, setOrder] = useState(String(DEFAULT_HOOK_ORDER))
  const [failMode, setFailMode] = useState<'open' | 'closed'>('open')
  // Owned here rather than inside FormSection: step 0's subtree unmounts on
  // Continue, so a disclosure holding its own state would forget it and come
  // back closed on Back, hiding the capabilities the operator just reviewed.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const installInFlightRef = useRef(false)

  const hookMeta = entry.hook_meta ?? null
  const lifecyclePoints = useMemo(
    () => (Array.isArray(hookMeta?.lifecyclePoints) ? hookMeta.lifecyclePoints : []),
    [hookMeta]
  )
  // target.{image,service,remote} are objects on the wire — derive display strings.
  const targetImage = hookMeta?.target?.image?.ref ?? ''
  const svc = hookMeta?.target?.service
  const targetService = svc
    ? `${svc.namespace ? `${svc.namespace}/` : ''}${svc.name ?? ''}${svc.port ? `:${svc.port}` : ''}`
    : ''
  const targetRemote = hookMeta?.target?.remote?.baseUrl ?? ''

  // What the author says the hook needs. Publisher-supplied, so filter to the
  // known capability values — an unrecognised entry must degrade to "declared
  // nothing", never widen what the operator can grant.
  const declaredCapabilities = useMemo<HookCapability[]>(() => {
    const raw = hookMeta?.requiredCapabilities
    if (!Array.isArray(raw)) return []
    return raw.filter((c): c is HookCapability =>
      ALL_HOOK_CAPABILITIES.includes(c as HookCapability)
    )
  }, [hookMeta])

  const authorDefaults = hookMeta?.authorDefaults ?? null
  const authorFailMode =
    authorDefaults?.failMode === 'open' || authorDefaults?.failMode === 'closed'
      ? authorDefaults.failMode
      : null
  const authorOrderHint =
    typeof authorDefaults?.orderHint === 'string' ? authorDefaults.orderHint.trim() : ''

  useEffect(() => {
    installInFlightRef.current = false
    setStep(0)
    setError('')
    setCredValues({})
    setAdvancedOpen(false)
    // Seed from the author's declaration so the default install is the working
    // one. The ceiling effect below narrows this once an agent is selected, and
    // the operator can still untick anything.
    setCapabilities(new Set(declaredCapabilities))
    setOrder(String(DEFAULT_HOOK_ORDER))
    setFailMode(authorFailMode ?? 'open')
    setLoading(true)
    ;(async () => {
      try {
        const [schema, hostResult] = await Promise.all([
          getRegistryCredentialSchema(entry.name, entry.version).catch(() =>
            getEmbeddedHookCredentialSchema(entry)
          ),
          getHosts(),
        ])
        setCredSchema(schema)
        const hostItems = (hostResult.items ?? []).filter(h => !!h.metadata?.name)
        setHosts(hostItems)
        if (hostItems.length > 0) {
          setHostRef(prev => prev || (hostItems[0].metadata?.name ?? ''))
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load configuration')
      } finally {
        setLoading(false)
      }
    })()
  }, [entry])

  const selectedHost = useMemo(
    () => hosts.find(h => h.metadata?.name === hostRef),
    [hosts, hostRef]
  )
  const ceiling = useMemo(() => hostCapabilityCeiling(selectedHost), [selectedHost])

  // Drop any selected capability the newly selected agent does not allow. A
  // null ceiling is the not-yet-resolved agent, which narrows nothing.
  useEffect(() => {
    if (!ceiling) return
    setCapabilities(prev => {
      const next = new Set([...prev].filter(c => ceiling.includes(c)))
      return next.size === prev.size ? prev : next
    })
  }, [ceiling])

  // What is ticked, then what the agent permits — the second sentence applies
  // whether or not the author declared anything, so it is appended rather than
  // chosen between. An agent with no ceiling can grant nothing, so say that
  // plainly instead of pointing at a ceiling it does not have.
  const capabilitiesDescription = [
    declaredCapabilities.length > 0
      ? "Pre-selected from what the hook's author says it needs. Removing one does not stop the install — the hook runs without that power."
      : 'Grant only the capabilities this hook needs.',
    ceiling === null
      ? ''
      : ceiling.length === 0
        ? 'This agent has no capability ceiling, so no capability can be granted until one is set on the agent.'
        : "Only the capabilities within this agent's capability ceiling can be granted.",
  ]
    .filter(Boolean)
    .join(' ')

  // Declared capabilities the hook will not get — either the operator unticked
  // them or the agent's ceiling forbids them. Either way the hook is installed
  // less capable than its author says it needs.
  const missingDeclared = useMemo(
    () => declaredCapabilities.filter(c => !capabilities.has(c)),
    [declaredCapabilities, capabilities]
  )

  // Split by whether mcp-host actually withholds the action. The two cases
  // deserve different words: one silently breaks the hook, the other changes
  // nothing about how it runs today.
  const missingEnforced = missingDeclared.filter(c => ENFORCED_HOOK_CAPABILITIES.includes(c))
  const missingUnenforced = missingDeclared.filter(c => !ENFORCED_HOOK_CAPABILITIES.includes(c))

  // may_deny ⇒ fail-closed, matching the backend deny_requires_fail_closed rule.
  const mustFailClosed = capabilities.has('may_deny')
  const effectiveFailMode: 'open' | 'closed' = mustFailClosed ? 'closed' : failMode

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

  const orderValid = order.trim() === '' || Number.isFinite(Number(order))
  const canSubmit = hostRef.trim() !== '' && credComplete && orderValid && !installing
  const canContinue = step === 0 ? !loading && canSubmit : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return hostRef.trim() !== '' && credComplete && orderValid
  }

  function toggleCapability(value: HookCapability) {
    setCapabilities(prev => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function pasteCredentialValue(keyName: string, event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text')
    if (!pasted) return
    event.preventDefault()
    const current = credValues[keyName] ?? ''
    const nextValue = buildPastedValue(current, pasted, event.currentTarget)
    setCredValues(previous => ({ ...previous, [keyName]: nextValue }))
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
      const credentials = Object.keys(filled).length > 0 ? filled : undefined
      const selectedCapabilities = [...capabilities]
      const parsedOrder = order.trim() === '' ? undefined : Number(order)

      const result = await installHookFromRegistry({
        hostRef,
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        capabilities: selectedCapabilities.length > 0 ? selectedCapabilities : undefined,
        order: parsedOrder,
        failMode: effectiveFailMode,
        credentials,
      })
      showToast(
        `Installed guardrail hook "${result.hookName}" (trust: ${result.trustLevel}) on ${hostRef}.`,
        { tone: 'success' }
      )
      onInstalled(result.hookName)
    } catch (installError) {
      setError(describeHookInstallError(installError))
    } finally {
      installInFlightRef.current = false
      setInstalling(false)
    }
  }

  return (
    <CreateStepFlow
      ariaLabel="Install guardrail hook steps"
      className="cu-create-step-flow--2"
      currentStep={step}
      onStepChange={setStep}
      canSelectStep={canSelectStep}
      steps={STEP_DETAILS}
      stepLabels={STEPS}
      titleId="registry-hook-install-step-title"
    >
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
            <>
              <FormSection
                title="Install guardrail hook from Marketplace"
                description={
                  <>
                    Bind <strong>{entry.name}</strong> v{entry.version} to a target agent as a
                    guardrail hook.
                  </>
                }
              >
                <div className="cu-registry-entry-card">
                  <div className="cu-registry-entry-card__head">
                    <strong className="cu-registry-name">{entry.name}</strong>
                    <span className="cu-muted">v{entry.version}</span>
                  </div>
                  {entry.description ? (
                    <p className="cu-registry-description">{entry.description}</p>
                  ) : null}
                </div>
              </FormSection>

              <FormSection
                title="Target agent"
                description="Choose the agent to bind this hook to."
              >
                <Field htmlFor="hif-host" label="Agent" required>
                  <SelectInput
                    id="hif-host"
                    value={hostRef}
                    onChange={event => setHostRef(event.target.value)}
                  >
                    <option value="">Select an agent...</option>
                    {hosts.map(host => (
                      <option key={host.metadata?.name} value={host.metadata?.name}>
                        {host.metadata?.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </FormSection>

              {credHasKeys ? (
                <FormSection
                  title={`Credentials (${credSchema!.authType}${credRequired ? '' : ' - optional'})`}
                  description="Provided per this hook's credential schema."
                >
                  {credSchema!.keys.map(key => (
                    <Field key={key.name} htmlFor={`hif-cred-${key.name}`} label={key.label}>
                      <TextInput
                        id={`hif-cred-${key.name}`}
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
                    </Field>
                  ))}
                  {credRequired ? (
                    <div
                      className={`cu-banner ${credStarted && !credComplete ? 'cu-banner--error' : 'cu-banner--info'}`}
                    >
                      {credStarted && !credComplete
                        ? `Complete all credential fields or clear them all to install pending. Missing: ${missingCredentialKeys.join(', ')}.`
                        : 'Leave all credential fields empty to install and add the secret later, or fill every field to create it during install.'}
                    </div>
                  ) : null}
                </FormSection>
              ) : null}

              {/* Everything an install can leave at its default lives behind one
                  disclosure: the entry's own facts, which are applied as-is, the
                  granted capabilities, and the ordering/fail-mode knobs. */}
              <FormSection
                title="Advanced details"
                collapsible
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
              >
                <div className="cu-summary-list cu-summary-list--flush">
                  {targetImage ? (
                    <div className="cu-summary-list__row">
                      <span>Target image</span>
                      <strong>{targetImage}</strong>
                    </div>
                  ) : null}
                  {targetService ? (
                    <div className="cu-summary-list__row">
                      <span>Target service</span>
                      <strong>{targetService}</strong>
                    </div>
                  ) : null}
                  {targetRemote ? (
                    <div className="cu-summary-list__row">
                      <span>Target remote</span>
                      <strong>{targetRemote}</strong>
                    </div>
                  ) : null}
                  <div className="cu-summary-list__row">
                    <span>Lifecycle points</span>
                    <strong>{lifecyclePoints.length > 0 ? lifecyclePoints.join(', ') : '—'}</strong>
                  </div>
                  {hookMeta?.path ? (
                    <div className="cu-summary-list__row">
                      <span>Path</span>
                      <strong>{hookMeta.path}</strong>
                    </div>
                  ) : null}
                </div>

                {/* Grouped rather than left as four loose checkboxes: they are a
                    single decision, and fail mode below is constrained by it. */}
                <fieldset className="cu-form-section__group">
                  <legend className="cu-form-section__subheading">Capabilities</legend>
                  <p className="cu-form-section__description">{capabilitiesDescription}</p>
                  {HOOK_CAPABILITY_OPTIONS.map(option => {
                    const outsideCeiling = !!ceiling && !ceiling.includes(option.value)
                    const declared = declaredCapabilities.includes(option.value)
                    const suffix = outsideCeiling
                      ? declared
                        ? " (required by this hook, but outside the agent's ceiling)"
                        : " (outside the agent's ceiling)"
                      : declared
                        ? ' (required by this hook)'
                        : ''
                    return (
                      <CheckboxField
                        key={option.value}
                        label={option.label}
                        description={`${option.description}${suffix}`}
                        checked={capabilities.has(option.value)}
                        disabled={outsideCeiling}
                        onChange={() => toggleCapability(option.value)}
                      />
                    )
                  })}
                  {missingEnforced.length > 0 ? (
                    <div className="cu-banner cu-banner--warning" role="status">
                      This hook needs {missingEnforced.join(', ')} to function. Without{' '}
                      {missingEnforced.length > 1 ? 'them' : 'it'}, it installs and reports Ready,
                      but the actions it takes are discarded.
                    </div>
                  ) : null}
                  {missingUnenforced.length > 0 ? (
                    <div className="cu-banner cu-banner--info">
                      {missingEnforced.length > 0 ? 'The author also lists' : 'The author lists'}{' '}
                      {missingUnenforced.join(', ')}, which the runtime does not enforce today: the
                      hook behaves the same whether or not{' '}
                      {missingUnenforced.length > 1 ? 'they are' : 'it is'} granted.
                    </div>
                  ) : null}
                </fieldset>

                <Field
                  htmlFor="hif-order"
                  label="Order"
                  description={
                    ORDER_HINT_LABELS[authorOrderHint]
                      ? `Lower runs first. Defaults to 100 when left blank. ${ORDER_HINT_LABELS[authorOrderHint]}`
                      : 'Lower runs first. Defaults to 100 when left blank.'
                  }
                  error={orderValid ? undefined : 'Order must be a number.'}
                >
                  <TextInput
                    id="hif-order"
                    type="number"
                    value={order}
                    invalid={!orderValid}
                    onChange={event => setOrder(event.target.value)}
                    placeholder={String(DEFAULT_HOOK_ORDER)}
                  />
                </Field>
                <Field
                  htmlFor="hif-failmode"
                  label="Fail mode"
                  description={
                    mustFailClosed
                      ? 'A hook that may deny must fail closed.'
                      : authorFailMode
                        ? `Fail open lets calls proceed when the hook errors; fail closed blocks them. The author suggests fail ${authorFailMode}.`
                        : 'Fail open lets calls proceed when the hook errors; fail closed blocks them.'
                  }
                >
                  <SelectInput
                    id="hif-failmode"
                    value={effectiveFailMode}
                    disabled={mustFailClosed}
                    onChange={event => setFailMode(event.target.value as 'open' | 'closed')}
                  >
                    <option value="open">Fail open</option>
                    <option value="closed">Fail closed</option>
                  </SelectInput>
                </Field>
              </FormSection>
            </>
          ) : null}

          {step === 1 ? (
            <div className="cu-agent-review">
              Guardrail hook <b>{entry.name}</b> v{entry.version} will be installed on agent{' '}
              <b>{hostRef || '-'}</b> with{' '}
              <b>
                {capabilities.size > 0 ? [...capabilities].join(', ') : 'no extra capabilities'}
              </b>
              , order <b>{order.trim() === '' ? DEFAULT_HOOK_ORDER : order}</b>, fail mode{' '}
              <b>{effectiveFailMode}</b>.
            </div>
          ) : null}

          {error ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {error}
            </div>
          ) : null}

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
  )
}

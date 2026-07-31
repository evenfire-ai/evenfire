'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CreateFlowPanel } from '@/components/CreateFlowPanel'
import { CreateStepFlow } from '@/components/CreateStepFlow'
import { SelectionDropdown } from '@/components/SelectionDropdown'
import { useToast } from '@/components/Toast'
import { IconX } from '@/components/icons'
import { Button, CheckboxField, Field, FormSection, SelectInput, TextInput } from '@/components/ui'
import {
  createMcpSecret,
  createMcpServer,
  deleteMcpSecret,
  getContext,
  getContexts,
  updateContext,
} from '@/lib/api'
import type { EnvSecretKeyMapping, EnvVar } from '@/lib/api'
import type { EgressBinding } from '@/lib/api'
import type { EgressEditorStatus } from '@/lib/egressModel'
import { EgressEditor } from '../EgressEditor'
import { MCP_SERVER_NAME_PATTERN, TRANSPORT_TYPES } from './constants'
import type { CreateMcpServerFormProps, TransportType } from './types'

const STEPS = ['Connector', 'Secrets'] as const

const STEP_DETAILS = [
  {
    description: 'Name, image, and context',
    title: 'Connector identity',
    subtitle: 'Register the connector name, image, and Context allowlist target.',
  },
  {
    description: 'Environment and credentials',
    title: 'Secrets and environment',
    subtitle: 'Add environment variables and optional Secret-backed credentials.',
  },
] as const

function parseCommaSeparated(input: string): string[] {
  if (!input.trim()) return []

  return input
    .split(',')
    .map(segment => segment.trim())
    .filter(Boolean)
}

function formatCreateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const bodyStart = message.indexOf(' - ')
  if (bodyStart === -1) return message || 'Failed to create connector'

  const body = message.slice(bodyStart + 3).trim()
  try {
    const parsed = JSON.parse(body) as { message?: string }
    if (parsed?.message) return parsed.message
  } catch {
    // Fall through to the raw apiSend error when the response body is not JSON.
  }
  return message
}

export function CreateMcpServerForm({
  mode = 'inline',
  onCancel,
  onCreated,
  pageHeader,
}: CreateMcpServerFormProps) {
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [transportType, setTransportType] = useState<TransportType>('streamableHttp')
  const [port, setPort] = useState(3000)
  const [description, setDescription] = useState('')
  const [contextRef, setContextRef] = useState('')
  const [contexts, setContexts] = useState<Array<{ name: string }>>([])
  const [contextsLoading, setContextsLoading] = useState(true)
  const [contextsError, setContextsError] = useState('')
  const [managed, setManaged] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [useEnvSecret, setUseEnvSecret] = useState(false)
  const [envSecretName, setEnvSecretName] = useState('')
  const [envSecretKeys, setEnvSecretKeys] = useState<EnvSecretKeyMapping[]>([])
  const [secretValues, setSecretValues] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)

  const nameValid = MCP_SERVER_NAME_PATTERN.test(name) && name.length <= 63
  const egressValid = !egressStatus || egressStatus.errors.length === 0
  const canSubmit = Boolean(name && image && contextRef) && nameValid && egressValid && !submitting
  const canContinue =
    step === 0 ? Boolean(name && image && contextRef && nameValid) && egressValid : egressValid
  const contextOptions = useMemo(
    () => contexts.map(context => ({ value: context.name, label: context.name })),
    [contexts]
  )

  useEffect(() => {
    let cancelled = false
    setContextsLoading(true)
    setContextsError('')

    getContexts()
      .then(result => {
        if (cancelled) return
        const nextContexts = (result.items ?? [])
          .map(context => ({
            name: context.metadata?.name ?? context.spec?.contextId ?? '',
          }))
          .filter(context => context.name)
        setContexts(nextContexts)
        setContextRef(previous => previous || nextContexts[0]?.name || '')
      })
      .catch(loadError => {
        if (cancelled) return
        setContexts([])
        setContextsError(loadError instanceof Error ? loadError.message : 'Failed to load contexts')
      })
      .finally(() => {
        if (!cancelled) setContextsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return Boolean(name && image && contextRef && nameValid && egressValid)
  }

  const handleEgressChange = useCallback(
    (nextBindings: EgressBinding[] | undefined, nextStatus: EgressEditorStatus) => {
      setEgressBindings(nextBindings)
      setEgressStatus(nextStatus)
    },
    []
  )

  function addEnvVar() {
    setEnvVars(previous => [...previous, { name: '', value: '' }])
  }

  function removeEnvVar(index: number) {
    setEnvVars(previous => previous.filter((_, itemIndex) => itemIndex !== index))
  }

  function updateEnvVar(index: number, field: 'name' | 'value', value: string) {
    setEnvVars(previous =>
      previous.map((row, itemIndex) => (itemIndex === index ? { ...row, [field]: value } : row))
    )
  }

  function addSecretKey() {
    setEnvSecretKeys(previous => [...previous, { secretKey: '', envVar: '' }])
    setSecretValues(previous => [...previous, ''])
  }

  function removeSecretKey(index: number) {
    setEnvSecretKeys(previous => previous.filter((_, itemIndex) => itemIndex !== index))
    setSecretValues(previous => previous.filter((_, itemIndex) => itemIndex !== index))
  }

  function updateSecretKey(index: number, field: 'secretKey' | 'envVar', value: string) {
    setEnvSecretKeys(previous =>
      previous.map((row, itemIndex) => (itemIndex === index ? { ...row, [field]: value } : row))
    )
  }

  function updateSecretValue(index: number, value: string) {
    setSecretValues(previous =>
      previous.map((row, itemIndex) => (itemIndex === index ? value : row))
    )
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step < STEPS.length - 1) {
      if (canContinue) setStep(current => Math.min(STEPS.length - 1, current + 1))
      return
    }
    if (!canSubmit) return

    // ── Client-side envSecret validation (PR-A / A2) ─────────────────────────
    // If the operator enabled envSecret with a Secret name, they must provide
    // at least one key-value pair so we actually create the Secret in-band.
    // Referencing a pre-existing Secret from this form is not supported here:
    // it's the exact "Secret missing → HCC silent hang" class we're closing.
    // Operators who need to reference an existing Secret should disable the
    // envSecret checkbox and manage it via kubectl / the API directly.
    if (useEnvSecret && envSecretName.trim()) {
      const builtSecretData: Record<string, string> = {}
      envSecretKeys.forEach((row, index) => {
        const key = row.secretKey.trim()
        const value = secretValues[index] ?? ''
        if (key && value) {
          builtSecretData[key] = value
        }
      })

      // Any row with a key set but an empty value is a hard error — the user
      // clearly meant to provide credentials and forgot one.
      const hasRowWithEmptyValue = envSecretKeys.some(
        (row, index) => row.secretKey.trim() !== '' && (secretValues[index] ?? '') === ''
      )
      if (hasRowWithEmptyValue) {
        setError('All envSecret values must be non-empty')
        return
      }
      if (Object.keys(builtSecretData).length === 0) {
        setError('Add at least one key-value pair or disable envSecret')
        return
      }
    }

    setSubmitting(true)
    setError('')

    const spec: Parameters<typeof createMcpServer>[0]['spec'] = {
      image,
      contextRef,
      description: description || undefined,
      enabled: true,
      managed,
      transport: {
        type: transportType,
        ...(transportType !== 'stdio' ? { port } : {}),
        ...(transportType !== 'stdio'
          ? { url: `http://${name}.mcp-server.svc.cluster.local:${port}/mcp` }
          : {}),
      },
    }

    const filteredEnv = envVars.filter(row => row.name.trim() !== '')
    if (filteredEnv.length > 0) {
      spec.env = filteredEnv
    }

    if (useEnvSecret) {
      const filteredKeys = envSecretKeys.filter(
        row => row.secretKey.trim() !== '' && row.envVar.trim() !== ''
      )
      if (envSecretName.trim() && filteredKeys.length > 0) {
        spec.envSecret = { name: envSecretName.trim(), keys: filteredKeys }
      }
    }

    const parsedCommand = parseCommaSeparated(command)
    if (parsedCommand.length > 0) {
      spec.command = parsedCommand
    }

    const parsedArgs = parseCommaSeparated(args)
    if (parsedArgs.length > 0) {
      spec.args = parsedArgs
    }

    if (egressBindings && egressBindings.length > 0) {
      spec.egressBindings = egressBindings
    }

    // Pre-compute the Secret payload once so rollback and creation agree on
    // "did we actually create a Secret?".
    const secretData: Record<string, string> = {}
    if (useEnvSecret && envSecretName.trim()) {
      envSecretKeys.forEach((row, index) => {
        const value = secretValues[index] || ''
        if (row.secretKey.trim() && value) {
          secretData[row.secretKey.trim()] = value
        }
      })
    }
    const willCreateSecret =
      useEnvSecret && envSecretName.trim().length > 0 && Object.keys(secretData).length > 0

    let secretCreated = false
    try {
      if (willCreateSecret) {
        await createMcpSecret(envSecretName.trim(), secretData)
        secretCreated = true
      }

      await createMcpServer({
        metadata: { name },
        spec,
      })

      try {
        const context = await getContext(contextRef)
        const existingServers = context.spec?.mcpServers ?? []

        if (!existingServers.includes(name)) {
          await updateContext(contextRef, {
            spec: {
              contextId: context.spec?.contextId ?? contextRef,
              description: context.spec?.description,
              mcpServers: [...existingServers, name],
            },
          })
        }
      } catch (contextError) {
        setError(
          `Connector created, but failed to add it to Context "${contextRef}" allowlist. ` +
            `Please add "${name}" to the Context manually. (${
              contextError instanceof Error ? contextError.message : String(contextError)
            })`
        )
        setSubmitting(false)
        return
      }

      showToast('Connector created successfully.', { tone: 'success' })
      window.setTimeout(() => {
        onCreated()
      }, 600)
    } catch (submitError) {
      // Rollback: if we created the Secret but the CRD (or anything after)
      // failed, the Secret is orphan — best-effort delete.
      if (secretCreated) {
        try {
          await deleteMcpSecret(envSecretName.trim())
        } catch {
          // best-effort rollback; swallow — the operator already sees the
          // primary error below.
        }
      }
      setError(formatCreateError(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  const formContent = (
    <>
      {mode === 'inline' ? (
        <div className="cu-modal-panel__head">
          <div>
            <h3 className="cu-form-section__title">Create connector</h3>
            <p className="cu-form-section__description">
              Register a new connector and optionally create its managed deployment metadata.
            </p>
          </div>
          <Button
            aria-label="Close"
            className="cu-btn--icon"
            disabled={submitting}
            onClick={onCancel}
            variant="ghost"
          >
            <IconX height={18} width={18} />
          </Button>
        </div>
      ) : null}

      <form onSubmit={handleSubmit}>
        <CreateStepFlow
          ariaLabel="Create connector steps"
          className="cu-create-step-flow--2"
          currentStep={step}
          onStepChange={setStep}
          canSelectStep={canSelectStep}
          steps={STEP_DETAILS}
          stepLabels={STEPS}
          titleId="create-connector-step-title"
        >
          {step === 0 ? (
            <div className="cu-form-stack cu-agent-form-stack">
              <Field
                description="Kubernetes resource name: lowercase alphanumeric and hyphens, max 63 chars."
                error={
                  name.length > 0 && !nameValid
                    ? 'Name must match the Kubernetes DNS label format.'
                    : undefined
                }
                label="Name"
                required
              >
                <TextInput
                  invalid={name.length > 0 && !nameValid}
                  monospace
                  onChange={event =>
                    setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  placeholder="my-mcp-server"
                  disabled={submitting}
                  autoFocus
                  value={name}
                />
              </Field>

              <Field description="Container image for the connector." label="Image" required>
                <TextInput
                  monospace
                  onChange={event => setImage(event.target.value)}
                  placeholder="us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest"
                  disabled={submitting}
                  value={image}
                />
              </Field>

              <Field
                description={
                  contextsLoading
                    ? 'Loading available contexts...'
                    : contexts.length > 0
                      ? "The server will be added to this context's allowlist."
                      : 'Create a context before creating a connector.'
                }
                error={contextsError || undefined}
                label="Context"
                required
              >
                <SelectionDropdown
                  multiple={false}
                  onChange={next => setContextRef(next[0] ?? '')}
                  disabled={submitting || contextsLoading || contexts.length === 0}
                  value={contextRef ? [contextRef] : []}
                  options={contextOptions}
                  placeholder={contextsLoading ? 'Loading contexts...' : 'Select a context...'}
                  searchPlaceholder="Search contexts..."
                  emptyLabel="No contexts available."
                  selectionLabel="Context"
                />
              </Field>

              <Field label="Description">
                <TextInput
                  onChange={event => setDescription(event.target.value)}
                  placeholder="Optional description of this connector"
                  disabled={submitting}
                  value={description}
                />
              </Field>

              <details className="cu-advanced-details">
                <summary>Advanced options</summary>
                <p className="cu-advanced-details__hint">
                  Runtime, container overrides, and network egress. The defaults work for most
                  connectors.
                </p>
                <div className="cu-form-stack cu-agent-form-stack">
                  <div className="cu-form-grid cu-form-grid--2">
                    <Field label="Transport Type">
                      <SelectInput
                        onChange={event => setTransportType(event.target.value as TransportType)}
                        disabled={submitting}
                        value={transportType}
                      >
                        {TRANSPORT_TYPES.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>

                    {transportType !== 'stdio' ? (
                      <Field description="Port the connector listens on." label="Port">
                        <TextInput
                          narrow
                          onChange={event => setPort(parseInt(event.target.value, 10) || 3000)}
                          type="number"
                          disabled={submitting}
                          value={port}
                        />
                      </Field>
                    ) : null}
                  </div>

                  <Field
                    description={
                      <>
                        <strong>Managed:</strong> Evenfire creates the Deployment, Service, and
                        NetworkPolicies. <strong>Not managed:</strong> you deploy the pod yourself
                        and Evenfire only registers it for discovery.
                      </>
                    }
                    label="Managed"
                  >
                    <SelectInput
                      onChange={event => setManaged(event.target.value === 'true')}
                      disabled={submitting}
                      value={managed ? 'true' : 'false'}
                    >
                      <option value="true">
                        Yes — Evenfire creates and manages the Deployment, Service, and
                        NetworkPolicies
                      </option>
                      <option value="false">No — I will deploy the pod myself (discovery only)</option>
                    </SelectInput>
                  </Field>

                  <FormSection
                    description="Optional container entrypoint and command overrides."
                    title="Container Overrides"
                  >
                    <Field
                      description='Comma-separated values, for example "node, server.js".'
                      label="Command"
                    >
                      <TextInput
                        monospace
                        onChange={event => setCommand(event.target.value)}
                        placeholder="node, server.js"
                        disabled={submitting}
                        value={command}
                      />
                    </Field>

                    <Field
                      description='Comma-separated values, for example "--port, 3000, --headless".'
                      label="Args"
                    >
                      <TextInput
                        monospace
                        onChange={event => setArgs(event.target.value)}
                        placeholder="--port, 3000, --headless"
                        disabled={submitting}
                        value={args}
                      />
                    </Field>
                  </FormSection>

                  <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
                    <EgressEditor allowCidr onChange={handleEgressChange} />
                  </div>
                </div>
              </details>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
              <FormSection
                description="Additional environment variables injected into the container."
                title="Environment Variables"
              >
                {envVars.length > 0 ? (
                  <div className="cu-form-grid">
                    {envVars.map((row, index) => (
                      <div className="cu-form-inline" key={`env-${index}`}>
                        <TextInput
                          className="cu-input--monospace"
                          onChange={event => updateEnvVar(index, 'name', event.target.value)}
                          placeholder="NAME"
                          disabled={submitting}
                          value={row.name}
                        />
                        <TextInput
                          className="cu-input--monospace"
                          onChange={event => updateEnvVar(index, 'value', event.target.value)}
                          placeholder="value"
                          disabled={submitting}
                          value={row.value}
                        />
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--danger-icon"
                          onClick={() => removeEnvVar(index)}
                          disabled={submitting}
                          aria-label={`Remove environment variable row ${index + 1}`}
                          title={`Remove environment variable row ${index + 1}`}
                        >
                          <IconX width={16} height={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <Button onClick={addEnvVar} size="sm" disabled={submitting}>
                  Add Env Var
                </Button>
              </FormSection>

              <FormSection title="Secret Reference">
                <CheckboxField
                  checked={useEnvSecret}
                  label="Use Kubernetes Secret for credentials"
                  disabled={submitting}
                  onChange={event => setUseEnvSecret(event.target.checked)}
                />

                {useEnvSecret ? (
                  <>
                    <Field
                      description={
                        <>
                          Name of an existing Secret in the <code>mcp-server</code> namespace that
                          contains your credentials.
                        </>
                      }
                      label="Kubernetes Secret Name"
                    >
                      <TextInput
                        monospace
                        onChange={event => setEnvSecretName(event.target.value)}
                        placeholder="brave-search-credentials"
                        disabled={submitting}
                        value={envSecretName}
                      />
                    </Field>

                    <div className="cu-form-grid">
                      {envSecretKeys.map((row, index) => (
                        <div className="cu-form-inline" key={`secret-${index}`}>
                          <TextInput
                            monospace
                            onChange={event =>
                              updateSecretKey(index, 'secretKey', event.target.value)
                            }
                            placeholder="api-key"
                            disabled={submitting}
                            value={row.secretKey}
                          />
                          <TextInput
                            monospace
                            onChange={event => updateSecretKey(index, 'envVar', event.target.value)}
                            placeholder="BRAVE_API_KEY"
                            disabled={submitting}
                            value={row.envVar}
                          />
                          <TextInput
                            autoComplete="off"
                            monospace
                            onChange={event => updateSecretValue(index, event.target.value)}
                            placeholder="sk-..."
                            type="password"
                            disabled={submitting}
                            value={secretValues[index] || ''}
                          />
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => removeSecretKey(index)}
                            disabled={submitting}
                            aria-label={`Remove secret key mapping row ${index + 1}`}
                            title={`Remove secret key mapping row ${index + 1}`}
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      ))}
                    </div>

                    <Button onClick={addSecretKey} size="sm" disabled={submitting}>
                      Add Key Mapping
                    </Button>

                    <p className="cu-form-section__description">
                      Enter each secret value here to create a Kubernetes Opaque Secret in the{' '}
                      <code>mcp-server</code> namespace. All values are required — the form creates
                      the Secret in-band before the connector resource to avoid a missing-Secret
                      reconcile hang.
                    </p>
                  </>
                ) : null}
              </FormSection>
            </div>
          ) : null}

          {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

          <div className={mode === 'page' ? 'cu-create-actions' : 'cu-modal-panel__foot'}>
            <Button
              disabled={submitting}
              onClick={() => (step === 0 ? onCancel() : setStep(current => current - 1))}
              size="sm"
              variant="ghost"
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                disabled={submitting || !canContinue}
                onClick={() => setStep(current => Math.min(STEPS.length - 1, current + 1))}
                size="sm"
                variant="primary"
              >
                Continue
              </Button>
            ) : (
              <Button disabled={!canSubmit} size="sm" type="submit" variant="primary">
                {submitting ? 'Creating…' : 'Create connector'}
              </Button>
            )}
          </div>
        </CreateStepFlow>
      </form>
    </>
  )

  if (mode === 'page' && pageHeader) {
    return <CreateFlowPanel header={pageHeader}>{formContent}</CreateFlowPanel>
  }

  return (
    <div className={mode === 'page' ? 'cu-agent-create-panel' : 'cu-form-section'}>
      {formContent}
    </div>
  )
}

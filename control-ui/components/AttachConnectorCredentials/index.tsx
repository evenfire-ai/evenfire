'use client'

import React, { useEffect, useId, useRef, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { useRolloutWait } from '@components/UpdateConnectorCredentials/useRolloutWait'
import { Button, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import { getMcpServers, getRegistryCredentialSchema, listMcpSecrets } from '@lib/api'
import {
  CredentialAttachError,
  attachConnectorCredentials,
  suggestedCredentialEnvVar,
  validateCredentialAttach,
} from '@lib/connectorCredentials'
import type {
  AttachCredentialRow,
  AttachMode,
  AttachValidation,
  AttachedCredentials,
} from '@lib/connectorCredentials.types'
import type { McpSecretSummary } from '@lib/oauthInstall.types'
import type { AttachConnectorCredentialsProps } from './types'

export function AttachConnectorCredentials({
  serverName,
  server,
  registryCredentialSource,
  blockedReason,
  onBusyChange,
  onSpecSaved,
  onFinished,
}: AttachConnectorCredentialsProps) {
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const prefix = useId()
  const nextRow = useRef(0)
  function newRow(secretKey = ''): AttachCredentialRow {
    return {
      id: `${prefix}-${nextRow.current++}`,
      secretKey,
      envVar: suggestedCredentialEnvVar(secretKey),
      value: '',
    }
  }
  const [mode, setMode] = useState<AttachMode>('create-new')
  const [secretName, setSecretName] = useState('')
  const [rows, setRows] = useState<AttachCredentialRow[]>(() => [newRow()])
  const [secrets, setSecrets] = useState<McpSecretSummary[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('ready')
  const [listTick, setListTick] = useState(0)
  const [labels, setLabels] = useState<Record<string, string>>(() => Object.create(null))
  const [validation, setValidation] = useState<AttachValidation | undefined>()
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState<AttachedCredentials | null>(null)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [collision, setCollision] = useState(false)
  const submitLock = useRef(false)
  const touched = useRef(false)
  const mounted = useRef(true)
  const completed = useRef(false)
  const callbacks = useRef({ onBusyChange, onSpecSaved, onFinished })
  callbacks.current = { onBusyChange, onSpecSaved, onFinished }
  const { phase, phaseMessage, setPhase, setPhaseMessage } = useRolloutWait({
    serverName,
    cutoff: saved?.cutoff ?? null,
    expectedUid: saved?.server.metadata?.uid,
    expectedGeneration: saved?.server.metadata?.generation,
  })
  const selectedSecret = secrets.find(item => item.name === secretName)
  const busy = submitting || phase === 'rotating'
  const locked = busy || Boolean(saved) || refreshRequired
  const errorId = `${prefix}-error`

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    callbacks.current.onBusyChange?.(busy || Boolean(saved) || refreshRequired)
    return () => {
      callbacks.current.onBusyChange?.(false)
    }
  }, [busy, saved, refreshRequired])

  useEffect(() => {
    if (mode !== 'use-existing') return
    let cancelled = false
    setListState('loading')
    void listMcpSecrets()
      .then(({ items }) => {
        if (cancelled) return
        setSecrets(items)
        setListState('ready')
      })
      .catch(() => {
        if (!cancelled) setListState('error')
      })
    return () => {
      cancelled = true
    }
  }, [mode, listTick])

  useEffect(() => {
    if (!registryCredentialSource) return
    let cancelled = false
    void getRegistryCredentialSchema(
      registryCredentialSource.name,
      registryCredentialSource.version
    )
      .then(schema => {
        if (cancelled) return
        const names = Object.create(null) as Record<string, string>
        for (const key of schema.keys) names[key.name] = key.label || key.name
        setLabels(names)
        if (!touched.current && schema.keys.length)
          setRows(schema.keys.map(key => newRow(key.name)))
      })
      .catch(() => {
        /* Optional labels never prevent manual entry. */
      })
    return () => {
      cancelled = true
    }
  }, [registryCredentialSource?.name, registryCredentialSource?.version])

  useEffect(() => {
    if (phase !== 'success' || completed.current) return
    completed.current = true
    showToast(`Credentials attached. ${serverName} is ready.`, { tone: 'success' })
    callbacks.current.onFinished()
  }, [phase, serverName, showToast])

  function changeMode(next: AttachMode) {
    touched.current = true
    setMode(next)
    setSecretName('')
    setRows(next === 'create-new' ? [newRow()] : [])
    setValidation(undefined)
    setCollision(false)
    setPhase('idle')
    setPhaseMessage('')
  }

  function updateRow(id: string, field: 'secretKey' | 'envVar' | 'value', value: string) {
    touched.current = true
    setRows(previous => previous.map(row => (row.id === id ? { ...row, [field]: value } : row)))
    setValidation(undefined)
  }

  function clearValues() {
    if (mounted.current) setRows(previous => previous.map(row => ({ ...row, value: '' })))
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      submitLock.current ||
      locked ||
      blockedReason ||
      (mode === 'use-existing' && listState !== 'ready')
    )
      return
    const invalid = validateCredentialAttach(mode, secretName, rows, server, selectedSecret)
    setValidation(invalid)
    if (invalid) {
      document.getElementById(`${prefix}-${invalid.field ?? 'add'}`)?.focus()
      return
    }
    submitLock.current = true
    setSubmitting(true)
    setCollision(false)
    setPhase('idle')
    setPhaseMessage('')
    try {
      let warning = ''
      if (mode === 'use-existing' && rows.some(row => row.value !== '')) {
        warning =
          ' Entered values update the shared Secret and may restart any connector that references it.'
        try {
          const { items } = await getMcpServers()
          const affected = (items ?? [])
            .filter(item => (item.spec?.envSecret as { name?: string })?.name === secretName)
            .map(item => item.metadata?.name)
            .filter(Boolean)
            .sort()
          if (affected.length) warning += ` Current references: ${affected.join(', ')}.`
        } catch {
          /* Keep the generic warning if the preview is unavailable. */
        }
      }
      if (!mounted.current) return
      const confirmed = await confirm({
        title: 'Attach credentials',
        confirmLabel: 'Attach and restart',
        message:
          mode === 'create-new'
            ? `Create Secret "${secretName.trim()}" and restart ${serverName} with these credentials?`
            : `Connect ${serverName} to Secret "${secretName}" and restart it?${warning}`,
      })
      if (!confirmed || !mounted.current) return
      setPhase('saving')
      const result = await attachConnectorCredentials({
        serverName,
        expectedUid: server.metadata?.uid,
        mode,
        secretName,
        rows,
        selectedSecret,
        onSecretWritten: clearValues,
      })
      if (!mounted.current) return
      clearValues()
      setSaved(result)
      callbacks.current.onSpecSaved(result.server)
      const metadata = result.server.metadata
      if (!metadata?.uid || !Number.isInteger(metadata.generation)) {
        setPhase('timeout')
        setPhaseMessage(
          'Credentials were attached, but rollout identity could not be verified. Refresh to check status.'
        )
      } else {
        setPhase('rotating')
      }
    } catch (error) {
      if (!mounted.current) return
      const known = error instanceof CredentialAttachError
      setPhase('failed')
      setPhaseMessage(
        known
          ? error.message
          : 'The connector settings could not be checked. Refresh before trying again.'
      )
      setRefreshRequired(!known || error.refreshRequired)
      setCollision(known && error.collision)
      if (!known || error.refreshRequired) clearValues()
    } finally {
      submitLock.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  function fieldFeedback(field: string) {
    const invalid = validation?.field === field
    return {
      invalid,
      'aria-invalid': invalid || undefined,
      'aria-describedby': invalid ? errorId : undefined,
    }
  }

  return (
    <FormSection
      title="Attach credentials"
      description="Choose a Secret and map its keys to the connector's environment variables. Stored values are never shown."
    >
      {confirmDialog}
      <form
        className="cu-connector-credentials-form cu-form-stack--wide"
        onSubmit={submit}
        noValidate
      >
        {server.spec?.remote ? (
          <p className="cu-muted">
            Remote connectors use credentials only through existing authentication header
            placeholders. Map keys to those variable names; attaching does not add headers.
          </p>
        ) : null}
        {blockedReason ? (
          <p className="cu-banner cu-banner--warn" role="status">
            {blockedReason}
          </p>
        ) : null}
        <fieldset className="cu-form-section__group" disabled={locked}>
          <legend className="cu-form-section__subheading">Credential source</legend>
          <div className="cu-agent-radio-group">
            <label className="cu-agent-radio cu-agent-radio--card">
              <input
                type="radio"
                name={`${prefix}-mode`}
                checked={mode === 'create-new'}
                onChange={() => changeMode('create-new')}
              />
              <span className="cu-agent-radio__title">Create a new Secret</span>
            </label>
            <label className="cu-agent-radio cu-agent-radio--card">
              <input
                type="radio"
                name={`${prefix}-mode`}
                checked={mode === 'use-existing'}
                onChange={() => changeMode('use-existing')}
              />
              <span className="cu-agent-radio__title">Use an existing Secret</span>
            </label>
          </div>
          <Field
            label={mode === 'create-new' ? 'Secret name' : 'Existing Secret'}
            htmlFor={`${prefix}-secret`}
            required
          >
            {mode === 'create-new' ? (
              <TextInput
                id={`${prefix}-secret`}
                required
                monospace
                maxLength={253}
                value={secretName}
                onChange={event => {
                  touched.current = true
                  setSecretName(event.target.value)
                  setValidation(undefined)
                }}
                {...fieldFeedback('secret')}
              />
            ) : (
              <SelectInput
                id={`${prefix}-secret`}
                required
                value={secretName}
                disabled={listState !== 'ready'}
                onChange={event => {
                  touched.current = true
                  setSecretName(event.target.value)
                  setRows(
                    (secrets.find(item => item.name === event.target.value)?.keys ?? []).map(key =>
                      newRow(key)
                    )
                  )
                  setValidation(undefined)
                }}
                {...fieldFeedback('secret')}
              >
                <option value="">Choose a Secret</option>
                {secrets.map(item => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
          {mode === 'use-existing' && listState === 'loading' ? (
            <p role="status">Loading Secrets…</p>
          ) : null}
          {mode === 'use-existing' && listState === 'error' ? (
            <div role="alert">
              Could not load Secrets.{' '}
              <Button onClick={() => setListTick(tick => tick + 1)}>Retry loading Secrets</Button>
            </div>
          ) : null}
          {mode === 'use-existing' ? (
            <p className="cu-muted">
              Leave a value blank to keep its stored value. New keys require a value. Entered values
              may restart other connectors sharing this Secret.
            </p>
          ) : null}
          {rows.map((row, index) => (
            <fieldset className="cu-form-section__group" key={row.id}>
              <legend className="cu-form-section__subheading">Key mapping {index + 1}</legend>
              <div className="cu-form-grid cu-form-grid--2">
                <Field
                  label={`Secret key ${index + 1}`}
                  htmlFor={`${prefix}-${row.id}-key`}
                  required
                >
                  <TextInput
                    id={`${prefix}-${row.id}-key`}
                    required
                    monospace
                    value={row.secretKey}
                    onChange={event => updateRow(row.id, 'secretKey', event.target.value)}
                    {...fieldFeedback(`${row.id}-key`)}
                  />
                </Field>
                <Field
                  label={`Environment variable ${index + 1}`}
                  htmlFor={`${prefix}-${row.id}-env`}
                  required
                >
                  <TextInput
                    id={`${prefix}-${row.id}-env`}
                    required
                    monospace
                    value={row.envVar}
                    onChange={event => updateRow(row.id, 'envVar', event.target.value)}
                    {...fieldFeedback(`${row.id}-env`)}
                  />
                </Field>
              </div>
              <Field
                label={
                  Object.hasOwn(labels, row.secretKey)
                    ? `Value for ${labels[row.secretKey]}`
                    : `Credential value ${index + 1}`
                }
                htmlFor={`${prefix}-${row.id}-value`}
                required={
                  mode === 'create-new' || !selectedSecret?.keys.includes(row.secretKey.trim())
                }
              >
                <TextInput
                  id={`${prefix}-${row.id}-value`}
                  type="password"
                  required={
                    mode === 'create-new' || !selectedSecret?.keys.includes(row.secretKey.trim())
                  }
                  autoComplete="new-password"
                  value={row.value}
                  placeholder={
                    mode === 'create-new' ? 'Required' : 'Leave blank to keep current value'
                  }
                  onChange={event => updateRow(row.id, 'value', event.target.value)}
                  {...fieldFeedback(`${row.id}-value`)}
                />
              </Field>
              <Button
                variant="ghost-danger"
                onClick={() => {
                  touched.current = true
                  setRows(previous => previous.filter(item => item.id !== row.id))
                  setValidation(undefined)
                }}
                aria-label={`Remove mapping ${index + 1}`}
              >
                Remove mapping
              </Button>
            </fieldset>
          ))}
          <Button
            id={`${prefix}-add`}
            onClick={() => {
              touched.current = true
              setRows(previous => [...previous, newRow()])
              setValidation(undefined)
            }}
          >
            Add key mapping
          </Button>
        </fieldset>
        {validation ? (
          <div id={errorId} role="alert" className="cu-banner cu-banner--error">
            {validation.message}
          </div>
        ) : null}
        {phase === 'rotating' ? (
          <div role="status" className="cu-banner cu-banner--info">
            Credentials attached. Waiting for {serverName} to become ready… {phaseMessage}
          </div>
        ) : null}
        {phase === 'failed' ? (
          <div role="alert" className="cu-banner cu-banner--error">
            {saved ? 'Credentials were attached, but readiness could not be verified: ' : ''}
            {phaseMessage}
          </div>
        ) : null}
        {phase === 'timeout' ? (
          <div role="alert" className="cu-banner cu-banner--warning">
            Credentials were attached, but readiness could not be verified within the observation
            window. Refresh to check status or update credentials. {phaseMessage}
          </div>
        ) : null}
        {saved?.affectedConnectors.filter(name => name !== serverName).length ? (
          <p className="cu-muted">
            Other connectors sharing this Secret roll out separately:{' '}
            {saved.affectedConnectors.filter(name => name !== serverName).join(', ')}.
          </p>
        ) : null}
        <div className="cu-create-actions">
          {saved || refreshRequired ? (
            <Button onClick={onFinished}>
              {phase === 'rotating' ? 'Check credentials later' : 'Refresh credentials'}
            </Button>
          ) : (
            <>
              {collision ? (
                <Button onClick={() => changeMode('use-existing')}>Choose existing Secret</Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  Boolean(blockedReason) ||
                  (mode === 'use-existing' && listState !== 'ready')
                }
                loading={submitting}
              >
                {submitting ? 'Attaching…' : 'Attach and restart'}
              </Button>
            </>
          )}
        </div>
      </form>
    </FormSection>
  )
}

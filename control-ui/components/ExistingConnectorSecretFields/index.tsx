'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconRefresh } from '@components/icons'
import { Button, Field, SelectInput, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { listMcpSecrets } from '@lib/api'
import { suggestedCredentialEnvVar, validateCredentialAttach } from '@lib/connectorCredentials'
import type { AttachCredentialRow } from '@lib/connectorCredentials.types'
import type { McpSecretSummary } from '@lib/oauthInstall.types'
import type { ExistingConnectorSecretFieldsProps } from './types'

export function ExistingConnectorSecretFields({
  server,
  initialReference,
  disabled = false,
  onChange,
}: ExistingConnectorSecretFieldsProps) {
  const router = useRouter()
  const prefix = useId()
  const counter = useRef(0)
  const [secrets, setSecrets] = useState<McpSecretSummary[]>([])
  const [name, setName] = useState('')
  const [rows, setRows] = useState<AttachCredentialRow[]>([])
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [refresh, setRefresh] = useState(0)
  const callback = useRef(onChange)
  callback.current = onChange
  const selected = secrets.find(secret => secret.name === name)
  const invalid = name
    ? validateCredentialAttach('use-existing', name, rows, server, selected, {
        storedKeysOnly: true,
      })
    : undefined
  const errorId = `${prefix}-validation`

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void listMcpSecrets()
      .then(({ items }) => {
        if (cancelled) return
        setSecrets([...items].sort((a, b) => a.name.localeCompare(b.name)))
        setState('ready')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  useEffect(() => {
    callback.current({ secret: selected, rows, ready: state === 'ready' })
  }, [selected, rows, state])

  function newRow(
    secretKey: string,
    envVar = suggestedCredentialEnvVar(secretKey)
  ): AttachCredentialRow {
    return { id: `${prefix}-${counter.current++}`, secretKey, envVar, value: '' }
  }

  function selectSecret(nextName: string) {
    setName(nextName)
    const keys = secrets.find(secret => secret.name === nextName)?.keys ?? []
    // Existing destinations are the connector's contract. A missing source key
    // needs an explicit choice; never silently replace or drop its destination.
    setRows(
      initialReference?.keys.length
        ? initialReference.keys.map(mapping =>
            newRow(keys.includes(mapping.secretKey) ? mapping.secretKey : '', mapping.envVar)
          )
        : keys.map(key => newRow(key))
    )
  }

  function feedback(field: string) {
    const isInvalid = invalid?.field === field
    return {
      'aria-invalid': isInvalid || undefined,
      'aria-describedby': isInvalid ? errorId : undefined,
    }
  }

  return (
    <fieldset className="cu-form-section__group" disabled={disabled}>
      <legend className="cu-form-section__subheading">Existing Secret and key mappings</legend>
      <p className="cu-muted">
        Reuse a Secret from Secrets → Connectors. Stored values stay unchanged and are never shown.
      </p>
      <div className="cu-existing-secret-control">
        <Field label="Existing Secret" htmlFor={`${prefix}-secret`} required>
          <SelectionDropdown
            id={`${prefix}-secret`}
            ariaLabel="Existing Secret"
            placeholder="Choose a Secret"
            multiple={false}
            searchable={false}
            showSelectedChips={false}
            disabled={state !== 'ready'}
            invalid={invalid?.field === 'secret'}
            options={secrets.map(secret => ({ label: secret.name, value: secret.name }))}
            value={name ? [name] : []}
            onChange={values => selectSecret(values[0] ?? '')}
          />
        </Field>
        <Button
          icon
          aria-label="Refresh secrets"
          title="Refresh secrets"
          onClick={() => setRefresh(value => value + 1)}
          disabled={disabled || state === 'loading'}
        >
          <IconRefresh width={16} height={16} />
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => router.push(CONTROL_ROUTES.secrets.connector)}
        >
          Manage connector Secrets
        </Button>
      </div>
      {state === 'loading' ? <p role="status">Loading Secrets…</p> : null}
      {state === 'error' ? (
        <div role="alert">
          Could not load Secrets.{' '}
          <Button onClick={() => setRefresh(value => value + 1)}>Retry loading Secrets</Button>
        </div>
      ) : null}
      {state === 'ready' && !secrets.length ? (
        <p role="status">
          No connector Secrets are available. Create one in Secrets → Connectors, then refresh this
          list.
        </p>
      ) : null}
      {selected && !selected.keys.length ? (
        <p role="alert">
          This Secret has no stored keys. Add keys in Secrets → Connectors, then refresh.
        </p>
      ) : null}
      {rows.map((row, index) => (
        <fieldset className="cu-form-section__group" key={row.id}>
          <legend className="cu-form-section__subheading">Key mapping {index + 1}</legend>
          <div className="cu-form-grid cu-form-grid--2">
            <Field label={`Secret key ${index + 1}`} htmlFor={`${row.id}-key`} required>
              <SelectInput
                id={`${row.id}-key`}
                value={row.secretKey}
                onChange={event =>
                  setRows(current =>
                    current.map(item =>
                      item.id === row.id ? { ...item, secretKey: event.target.value } : item
                    )
                  )
                }
                {...feedback(`${row.id}-key`)}
              >
                <option value="">Choose a stored key</option>
                {selected?.keys.map(key => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={`Environment variable ${index + 1}`} htmlFor={`${row.id}-env`} required>
              <TextInput
                id={`${row.id}-env`}
                monospace
                value={row.envVar}
                onChange={event =>
                  setRows(current =>
                    current.map(item =>
                      item.id === row.id ? { ...item, envVar: event.target.value } : item
                    )
                  )
                }
                {...feedback(`${row.id}-env`)}
              />
            </Field>
          </div>
          <Button
            variant="ghost-danger"
            onClick={() => setRows(current => current.filter(item => item.id !== row.id))}
            aria-label={`Remove mapping ${index + 1}`}
          >
            Remove mapping
          </Button>
        </fieldset>
      ))}
      {selected?.keys.length ? (
        <Button onClick={() => setRows(current => [...current, newRow('')])}>
          Add key mapping
        </Button>
      ) : null}
      {invalid ? (
        <p id={errorId} className="cu-banner cu-banner--error" role="alert">
          {invalid.message}
        </p>
      ) : null}
    </fieldset>
  )
}

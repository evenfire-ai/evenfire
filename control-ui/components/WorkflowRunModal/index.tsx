'use client'

import { useMemo, useRef, useState } from 'react'
import { triggerWorkflow } from '@lib/api'
import type { InputContractProperty, WorkflowRunModalProps } from './types'

type FieldValue = string | number | boolean

function defaultValueFor(prop: InputContractProperty): FieldValue {
  if (prop.type === 'boolean') {
    return typeof prop.default === 'boolean' ? prop.default : false
  }
  if (prop.type === 'number') {
    return typeof prop.default === 'number' ? prop.default : 0
  }
  return typeof prop.default === 'string' ? prop.default : ''
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `wf-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function operatorRunErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Failed to trigger run'
  if (message.includes('on_demand_approval_requires_user_session')) {
    // Compatibility for clusters still rolling from the pre-operator-run Control API.
    return 'This cluster is still running an older Control API that blocks operator runs for approval-gated workflows. Redeploy control-api and retry.'
  }
  if (message.includes('workflow_runtime_not_ready')) {
    return 'Workflow runtime infrastructure is still preparing. Wait for the recipe workload, MCP server, connector access, and ready endpoints, then retry.'
  }
  return message
}

export function WorkflowRunModal({
  name,
  namespace,
  inputs,
  requiresApproval = false,
  onClose,
  onStarted,
}: WorkflowRunModalProps): JSX.Element {
  const inFlightRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const propertyEntries = useMemo(() => (inputs ? Object.entries(inputs) : []), [inputs])

  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const initial: Record<string, FieldValue> = {}
    for (const [key, prop] of propertyEntries) {
      initial[key] = defaultValueFor(prop)
    }
    return initial
  })

  function setField(key: string, value: FieldValue) {
    setValues(current => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting || inFlightRef.current) return
    inFlightRef.current = true
    setSubmitting(true)
    setError('')

    try {
      const payloadInputs: Record<string, unknown> = {}
      for (const [key, prop] of propertyEntries) {
        const v = values[key]
        if (prop.type === 'boolean') {
          payloadInputs[key] = Boolean(v)
        } else if (prop.type === 'number') {
          payloadInputs[key] = Number(v)
        } else {
          // Skip empty strings so the server-side defaults from inputContract
          // take over rather than us sending "".
          if (typeof v === 'string' && v.trim() === '') continue
          payloadInputs[key] = v
        }
      }

      const result = await triggerWorkflow(
        namespace,
        name,
        Object.keys(payloadInputs).length > 0 ? { inputs: payloadInputs } : {},
        generateIdempotencyKey()
      )
      onStarted({ recipeName: name, namespace, runId: result.runId })
      onClose()
    } catch (err) {
      setError(operatorRunErrorMessage(err))
    } finally {
      inFlightRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div
      role="presentation"
      className="cu-modal-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget && !submitting) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-run-modal-title"
        className="cu-modal-panel"
        onClick={event => event.stopPropagation()}
      >
        <h3 id="workflow-run-modal-title">
          Run <code>{name}</code> as operator
        </h3>
        <p className="cu-muted">
          Starts an on-demand operator run in <code>{namespace}</code>. Usage is attributed to
          Control UI.
        </p>
        {requiresApproval ? (
          <div className="cu-banner cu-banner--info" role="status">
            This recipe requires Desktop approval for end-user runs. Control UI runs execute as
            operator runs and are billed to control-plane-admin-ui.
          </div>
        ) : null}

        <form className="cu-create-content" onSubmit={handleSubmit}>
          {propertyEntries.length === 0 ? (
            <p className="cu-muted">
              This recipe declares no inputs. Run will use the recipe spec defaults.
            </p>
          ) : (
            propertyEntries.map(([key, prop]) => {
              const fieldId = `wf-run-input-${key}`
              const v = values[key]
              if (prop.type === 'boolean') {
                return (
                  <div key={key} className="cu-field">
                    <label htmlFor={fieldId}>
                      <input
                        id={fieldId}
                        type="checkbox"
                        checked={Boolean(v)}
                        onChange={e => setField(key, e.target.checked)}
                        disabled={submitting}
                      />{' '}
                      {key}
                    </label>
                    {prop.description && <span className="cu-field__hint">{prop.description}</span>}
                  </div>
                )
              }
              if (prop.type === 'number') {
                return (
                  <div key={key} className="cu-field">
                    <label htmlFor={fieldId}>{key}</label>
                    <input
                      id={fieldId}
                      type="number"
                      className="cu-input"
                      value={typeof v === 'number' ? v : 0}
                      onChange={e => setField(key, Number(e.target.value))}
                      disabled={submitting}
                    />
                    {prop.description && <span className="cu-field__hint">{prop.description}</span>}
                  </div>
                )
              }
              return (
                <div key={key} className="cu-field">
                  <label htmlFor={fieldId}>{key}</label>
                  <input
                    id={fieldId}
                    type="text"
                    className="cu-input"
                    value={typeof v === 'string' ? v : String(v ?? '')}
                    onChange={e => setField(key, e.target.value)}
                    disabled={submitting}
                  />
                  {prop.description && <span className="cu-field__hint">{prop.description}</span>}
                </div>
              )
            })
          )}

          {error && (
            <div className="cu-banner cu-banner--error" role="alert">
              {error}
            </div>
          )}

          <div className="cu-create-actions">
            <button
              type="button"
              className="cu-btn cu-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className="cu-btn cu-btn--primary" disabled={submitting}>
              {submitting ? 'Starting…' : 'Run as operator'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

'use client'

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import { IconX } from '../icons'
import { Button, SelectInput, TextInput } from '../ui'
import { GUARDRAIL_BUILTIN_OPTIONS, GUARDRAIL_PHASES, GUARDRAIL_PHASE_LABELS } from './constants'
import type {
  GuardrailBuiltin,
  GuardrailBuiltinType,
  GuardrailHookRef,
  GuardrailPhase,
  HostGuardrails,
  HostGuardrailsSectionProps,
} from './types'

function cloneGuardrails(source: HostGuardrails | undefined): HostGuardrails {
  return {
    ...source,
    hooks: source?.hooks ? { ...source.hooks } : {},
    builtins: source?.builtins ? source.builtins.map(builtin => ({ ...builtin })) : [],
  }
}

export function HostGuardrailsSection({
  initialGuardrails,
  onSave,
  busy,
  canWrite,
  defaultEditing = false,
}: HostGuardrailsSectionProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(defaultEditing)
  const [draft, setDraft] = useState<HostGuardrails>(() => cloneGuardrails(initialGuardrails))

  // Re-seed the draft whenever the saved guardrails change (reload after save).
  const initialKey = JSON.stringify(initialGuardrails ?? {})
  React.useEffect(() => {
    setDraft(cloneGuardrails(initialGuardrails))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey])

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(cloneGuardrails(initialGuardrails)),
    [draft, initialGuardrails]
  )

  const hookPhases = useMemo(
    () =>
      GUARDRAIL_PHASES.map(phase => ({
        phase,
        refs: draft.hooks?.[phase] ?? [],
      })).filter(entry => entry.refs.length > 0),
    [draft.hooks]
  )
  const builtins = draft.builtins ?? []
  const hasAny = hookPhases.length > 0 || builtins.length > 0

  function removeHookRef(phase: GuardrailPhase, id: string) {
    setDraft(current => {
      const currentRefs = current.hooks?.[phase] ?? []
      const nextRefs = currentRefs.filter(ref => ref.id !== id)
      const nextHooks: HostGuardrails['hooks'] = { ...current.hooks }
      if (nextRefs.length > 0) nextHooks[phase] = nextRefs
      else delete nextHooks[phase]
      return { ...current, hooks: nextHooks }
    })
  }

  function addBuiltin(builtin: GuardrailBuiltin) {
    setDraft(current => ({
      ...current,
      builtins: [...(current.builtins ?? []), builtin],
    }))
  }

  function removeBuiltin(index: number) {
    setDraft(current => ({
      ...current,
      builtins: (current.builtins ?? []).filter((_, i) => i !== index),
    }))
  }

  function handleCancel() {
    setDraft(cloneGuardrails(initialGuardrails))
    setEditing(defaultEditing)
  }

  async function handleSave() {
    try {
      await onSave(draft)
      setEditing(defaultEditing)
    } catch {
      // Parent surfaced an error/conflict banner. Stay in edit mode so the
      // operator's draft survives the failure.
    }
  }

  return (
    <div className="cu-host-approval-section">
      <p className="cu-muted cu-host-approval-section__description">
        Installed guardrail hooks referenced by this agent, plus built-in guardrails. Use{' '}
        <strong>Add hook</strong> to install a guardrail from the Marketplace onto this agent, add a
        built-in, or remove a hook reference. Manage installed guardrails cluster-wide from the
        Installed Guardrails section.
      </p>

      <div className="cu-host-approval-section__content">
        {!editing ? (
          !hasAny ? (
            <div className="cu-empty">
              No guardrail hooks or built-ins configured for this agent.
            </div>
          ) : (
            <div>
              {hookPhases.map(({ phase, refs }) => (
                <div key={phase} className="cu-access-row">
                  <span>{GUARDRAIL_PHASE_LABELS[phase]}</span>
                  <div className="cu-expandable-tags">
                    {refs.map(ref => (
                      <span
                        key={ref.id}
                        className="cu-registry-tag"
                        title={ref.digest ? `digest ${ref.digest}` : undefined}
                      >
                        {ref.id}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {builtins.map((builtin, index) => (
                <div key={`${builtin.type}-${index}`} className="cu-access-row">
                  <span>Built-in · {builtin.type}</span>
                  <span>
                    order {typeof builtin.order === 'number' ? builtin.order : '—'} · fail{' '}
                    {builtin.failMode ?? 'open'}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : (
          <EditMode
            hookPhases={hookPhases}
            builtins={builtins}
            busy={busy}
            onRemoveHookRef={removeHookRef}
            onAddBuiltin={addBuiltin}
            onRemoveBuiltin={removeBuiltin}
          />
        )}
      </div>

      <div className="cu-host-approval-section__actions">
        {editing ? (
          <>
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary"
              onClick={handleSave}
              disabled={busy || !isDirty}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : canWrite ? (
          <>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => router.push(CONTROL_ROUTES.marketplace.orgEntries)}
              disabled={busy}
            >
              Add hook
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              Edit
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

interface EditModeProps {
  hookPhases: Array<{ phase: GuardrailPhase; refs: GuardrailHookRef[] }>
  builtins: GuardrailBuiltin[]
  busy: boolean
  onRemoveHookRef: (phase: GuardrailPhase, id: string) => void
  onAddBuiltin: (builtin: GuardrailBuiltin) => void
  onRemoveBuiltin: (index: number) => void
}

function EditMode({
  hookPhases,
  builtins,
  busy,
  onRemoveHookRef,
  onAddBuiltin,
  onRemoveBuiltin,
}: EditModeProps) {
  const [builtinType, setBuiltinType] = useState<GuardrailBuiltinType>('prompt-shaping')
  const [orderValue, setOrderValue] = useState('0')
  const [failMode, setFailMode] = useState<'open' | 'closed'>('open')

  function handleAdd() {
    const parsedOrder = Number.parseInt(orderValue, 10)
    onAddBuiltin({
      type: builtinType,
      order: Number.isFinite(parsedOrder) ? parsedOrder : 0,
      failMode,
    })
    setOrderValue('0')
    setFailMode('open')
    setBuiltinType('prompt-shaping')
  }

  return (
    <>
      <div className="cu-field">
        <label>Referenced hooks</label>
        {hookPhases.length === 0 ? (
          <div className="cu-empty">No installed hooks are referenced by this agent.</div>
        ) : (
          hookPhases.map(({ phase, refs }) => (
            <div key={phase} className="cu-access-row">
              <span>{GUARDRAIL_PHASE_LABELS[phase]}</span>
              <div className="cu-expandable-tags">
                {refs.map(ref => (
                  <span key={ref.id} className="cu-guardrails-ref-chip">
                    <span
                      className="cu-registry-tag"
                      title={ref.digest ? `digest ${ref.digest}` : undefined}
                    >
                      {ref.id}
                    </span>
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--danger-icon"
                      aria-label={`Remove hook ${ref.id} from ${GUARDRAIL_PHASE_LABELS[phase]}`}
                      onClick={() => onRemoveHookRef(phase, ref.id)}
                      disabled={busy}
                    >
                      <IconX />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="cu-field">
        <label>Built-in guardrails</label>
        {builtins.length === 0 ? (
          <div className="cu-empty">No built-in guardrails configured.</div>
        ) : (
          builtins.map((builtin, index) => (
            <div key={`${builtin.type}-${index}`} className="cu-access-row">
              <span>
                {builtin.type} · order {typeof builtin.order === 'number' ? builtin.order : '—'} ·
                fail {builtin.failMode ?? 'open'}
              </span>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--danger-icon"
                aria-label={`Remove built-in ${builtin.type}`}
                onClick={() => onRemoveBuiltin(index)}
                disabled={busy}
              >
                <IconX />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="cu-field">
        <label htmlFor="guardrail-builtin-type">Add built-in</label>
        <div className="cu-guardrails-add-row">
          <SelectInput
            id="guardrail-builtin-type"
            compact
            value={builtinType}
            onChange={e => setBuiltinType(e.target.value as GuardrailBuiltinType)}
            disabled={busy}
          >
            {GUARDRAIL_BUILTIN_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
          <TextInput
            type="number"
            compact
            narrow
            value={orderValue}
            onChange={e => setOrderValue(e.target.value)}
            disabled={busy}
            aria-label="Built-in order"
          />
          <SelectInput
            compact
            value={failMode}
            onChange={e => setFailMode(e.target.value as 'open' | 'closed')}
            disabled={busy}
            aria-label="Built-in fail mode"
          >
            <option value="open">Fail open</option>
            <option value="closed">Fail closed</option>
          </SelectInput>
          <Button variant="ghost" size="sm" onClick={handleAdd} disabled={busy}>
            Add
          </Button>
        </div>
      </div>
    </>
  )
}

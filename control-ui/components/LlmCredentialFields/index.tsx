'use client'

import React, { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { IconX } from '@/components/icons'
import { Button, Field, TextAreaInput, TextInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { LLM_CREDENTIAL_GROUPS, type LlmCredentialGroup, getLlmGroupCompleteness } from '@/lib/llm'

// Where the non-secret per-Host env vars (VERTEX_PROJECT_ID/-LOCATION,
// AWS_REGION) are configured — the secrets form only links to it, it never
// duplicates that editor (spec R4.5.4).
const HOST_ENV_HREF = CONTROL_ROUTES.agents.root

// A Kubernetes Secret data key. We keep the suggested `<provider>-api-key-fb1`
// shape and validate operator edits against it (spec R4.5.6 — "validated as a
// dataKey", never free-form).
const DATA_KEY_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

// An operator-created extra credential slot (spec R4.5.6). The slot OWNS its
// name draft and value; only a validated, non-colliding key is ever projected
// into the parent `draft` (`committedKey`). This guarantees editing an extra
// slot can never write to — and clobber — a real provider slot, and that an
// invalid/colliding key never reaches submit.
type ExtraSlot = {
  id: string
  provider: string
  nameInput: string
  value: string
  committedKey: string | null
}

export type LlmCredentialFieldsProps = {
  // dataKey -> value. Write-only: existing values are NEVER passed in here (the
  // status-only listing returns names only, spec R4.5.3).
  draft: Record<string, string>
  onChange: (dataKey: string, value: string) => void
  disabled?: boolean
  // Keys already stored in the Secret (edit mode) — light up the present chips
  // without ever exposing a value. Create flows omit it.
  existingKeys?: string[]
}

// Input-id prefix. Only one LlmCredentialFields renders per page and every slot
// id already ends in a unique dataKey/slot id, so this is a fixed constant.
const ID_PREFIX = 'llm-secret'

function completenessChip(group: LlmCredentialGroup, present: (dataKey: string) => boolean) {
  const { present: filled, total, usable } = getLlmGroupCompleteness(group, present)
  // Single-slot providers read as present/absent; multi-slot providers show the
  // filled/required ratio (spec R4.5.5 mockup: "● present / ○ absent", "● 2/2").
  if (total <= 1) {
    return {
      symbol: usable ? '●' : '○',
      text: usable ? 'present' : 'absent',
      state: usable ? 'present' : 'absent',
    } as const
  }
  const symbol = usable ? '●' : filled > 0 ? '◐' : '○'
  return {
    symbol,
    text: `${filled}/${total}`,
    state: usable ? 'present' : filled > 0 ? 'partial' : 'absent',
  } as const
}

export function LlmCredentialFields({
  draft,
  onChange,
  disabled = false,
  existingKeys,
}: LlmCredentialFieldsProps) {
  const [extraSlots, setExtraSlots] = useState<ExtraSlot[]>([])
  const nextExtraId = useRef(0)

  const existingKeySet = useMemo(() => new Set(existingKeys ?? []), [existingKeys])
  const present = (dataKey: string): boolean =>
    (draft[dataKey] ?? '').trim().length > 0 || existingKeySet.has(dataKey)

  // The full set of keys the form already knows (package slots + created extra
  // slots) — used to flag duplicate extra-slot names.
  const knownKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const group of LLM_CREDENTIAL_GROUPS) {
      for (const slot of group.slots) keys.add(slot.dataKey)
    }
    for (const key of existingKeySet) keys.add(key)
    return keys
  }, [existingKeySet])

  function extraSlotError(id: string, nameInput: string): string | null {
    const trimmed = nameInput.trim()
    if (!trimmed) return 'Key name is required.'
    if (!DATA_KEY_PATTERN.test(trimmed)) return 'Use lowercase letters, numbers, and - . _'
    if (knownKeys.has(trimmed)) return 'This key already exists as a provider slot.'
    if (extraSlots.some(slot => slot.id !== id && slot.nameInput.trim() === trimmed)) {
      return 'Duplicate key name.'
    }
    return null
  }

  // Reconcile an extra slot's committed key/value into the parent draft. Only a
  // valid, non-colliding key is committed; the previously-committed key (always
  // itself a validated key, never a real provider slot) is cleared on change.
  function commitExtraSlot(slot: ExtraSlot, nextName: string, nextValue: string) {
    const nextCommitted = extraSlotError(slot.id, nextName) === null ? nextName.trim() : null
    if (slot.committedKey && slot.committedKey !== nextCommitted) {
      onChange(slot.committedKey, '')
    }
    if (nextCommitted) onChange(nextCommitted, nextValue)
    setExtraSlots(prev =>
      prev.map(item =>
        item.id === slot.id
          ? { ...item, nameInput: nextName, value: nextValue, committedKey: nextCommitted }
          : item
      )
    )
  }

  function addExtraSlot(provider: string) {
    const existingForProvider = extraSlots.filter(slot => slot.provider === provider).length
    const suggested = `${provider}-api-key-fb${existingForProvider + 1}`
    const id = `extra-${provider}-${nextExtraId.current++}`
    setExtraSlots(prev => [
      ...prev,
      { id, provider, nameInput: suggested, value: '', committedKey: null },
    ])
  }

  function removeExtraSlot(id: string) {
    const slot = extraSlots.find(item => item.id === id)
    if (!slot) return
    if (slot.committedKey) onChange(slot.committedKey, '')
    setExtraSlots(prev => prev.filter(item => item.id !== id))
  }

  return (
    <div className="cu-llm-cred-groups">
      {LLM_CREDENTIAL_GROUPS.map(group => {
        const chip = completenessChip(group, present)
        const providerExtras = extraSlots.filter(slot => slot.provider === group.provider)
        return (
          <section className="cu-llm-cred-group" key={group.provider}>
            <div className="cu-llm-cred-group__head">
              <span className="cu-llm-cred-group__title">{group.label}</span>
              <span
                className={cn('cu-slot-chip', `cu-slot-chip--${chip.state}`)}
                aria-label={`${group.label} credentials ${chip.text}`}
              >
                <span aria-hidden="true">{chip.symbol}</span>
                {chip.text}
              </span>
            </div>

            {group.slots.map(slot => {
              const inputId = `${ID_PREFIX}-${slot.dataKey}`
              const slotPresent = present(slot.dataKey)
              return (
                <Field
                  key={slot.dataKey}
                  htmlFor={inputId}
                  label={
                    <>
                      {slot.label}
                      <span
                        className={cn(
                          'cu-slot-status',
                          slotPresent ? 'cu-slot-status--present' : 'cu-slot-status--absent'
                        )}
                        aria-label={slotPresent ? 'present' : 'absent'}
                        title={slotPresent ? 'present' : 'absent'}
                      >
                        {slotPresent ? '●' : '○'}
                      </span>
                    </>
                  }
                >
                  {slot.multiline ? (
                    <TextAreaInput
                      id={inputId}
                      monospace
                      rows={5}
                      value={draft[slot.dataKey] ?? ''}
                      onChange={event => onChange(slot.dataKey, event.target.value)}
                      placeholder={slot.placeholder}
                      autoComplete="off"
                      disabled={disabled}
                    />
                  ) : (
                    <TextInput
                      id={inputId}
                      type="password"
                      autoComplete="off"
                      value={draft[slot.dataKey] ?? ''}
                      onChange={event => onChange(slot.dataKey, event.target.value)}
                      placeholder={slot.placeholder}
                      disabled={disabled}
                    />
                  )}
                </Field>
              )
            })}

            {group.nonSecretEnv.length > 0 ? (
              <p className="cu-field__hint cu-llm-cred-group__env-hint">
                {group.nonSecretEnv.join(', ')} {group.nonSecretEnv.length > 1 ? 'are' : 'is'} not a
                secret — configure {group.nonSecretEnv.length > 1 ? 'them' : 'it'} in{' '}
                <Link href={HOST_ENV_HREF}>Host → Environment</Link>.
              </p>
            ) : null}

            {providerExtras.map(slot => {
              const inputId = `${ID_PREFIX}-extra-${slot.id}`
              const error = extraSlotError(slot.id, slot.nameInput)
              return (
                <Field
                  key={slot.id}
                  htmlFor={inputId}
                  label={`Additional credential slot`}
                  error={error ?? undefined}
                >
                  <div className="cu-llm-cred-extra">
                    <TextInput
                      monospace
                      value={slot.nameInput}
                      onChange={event => commitExtraSlot(slot, event.target.value, slot.value)}
                      placeholder={`${group.provider}-api-key-fb1`}
                      aria-label="Extra credential slot key name"
                      invalid={Boolean(error)}
                      disabled={disabled}
                    />
                    <TextInput
                      id={inputId}
                      type="password"
                      autoComplete="off"
                      value={slot.value}
                      onChange={event => commitExtraSlot(slot, slot.nameInput, event.target.value)}
                      placeholder="credential value"
                      aria-label="Extra credential slot value"
                      disabled={disabled}
                    />
                    <button
                      type="button"
                      className="cu-btn cu-btn--icon cu-btn--danger-icon"
                      onClick={() => removeExtraSlot(slot.id)}
                      disabled={disabled}
                      aria-label="Remove extra credential slot"
                      title="Remove extra credential slot"
                    >
                      <IconX width={16} height={16} />
                    </button>
                  </div>
                </Field>
              )
            })}

            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => addExtraSlot(group.provider)}
              disabled={disabled}
            >
              Add credential slot
            </Button>
          </section>
        )
      })}
    </div>
  )
}

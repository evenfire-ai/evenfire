'use client'

import React, { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { LlmProviderIcon } from '@/components/LlmProviderIcon'
import { SelectionDropdown } from '@/components/SelectionDropdown'
import type { SelectionDropdownOption } from '@/components/SelectionDropdown/types'
import { IconX } from '@/components/icons'
import { Button, Field, TextAreaInput, TextInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  LLM_CREDENTIAL_GROUPS,
  type LlmCredentialGroup,
  type LlmProvider,
  getLlmGroupCompleteness,
  mintFallbackSlot,
  providerForDataKey,
} from '@/lib/llm'
import type { ExtraSlot, LlmCredentialFieldsProps } from './types'

export type { LlmCredentialFieldsProps } from './types'

// Where the non-secret per-Host env vars (VERTEX_PROJECT_ID/-LOCATION,
// AWS_REGION) are configured — the secrets form only links to it, it never
// duplicates that editor (spec R4.5.4).
const HOST_ENV_HREF = CONTROL_ROUTES.agents.root

// A Kubernetes Secret data key. We keep the suggested `<provider>-api-key-fb1`
// shape and validate operator edits against it (spec R4.5.6 — "validated as a
// dataKey", never free-form).
const DATA_KEY_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

// Input-id prefix. Only one LlmCredentialFields renders per page and every slot
// id already ends in a unique dataKey/slot id, so this is a fixed constant.
const ID_PREFIX = 'llm-secret'

// Stable id for the "＋ Add provider" picker so its <Field> label points at the
// dropdown's trigger button.
const ADD_PROVIDER_ID = `${ID_PREFIX}-add-provider`

// Every canonical (registry) slot dataKey across providers. An existing Secret
// key outside this set is an operator-minted extra slot (`claude-api-key-fb1`).
const CANONICAL_SLOT_KEYS: ReadonlySet<string> = new Set(
  LLM_CREDENTIAL_GROUPS.flatMap(group => group.slots.map(slot => slot.dataKey))
)

// Seed one ExtraSlot per stored NON-canonical key so a Secret that only holds
// an extra slot of a provider (e.g. `claude-api-key-fb1` minted by the agents
// flow) still shows that key visible and editable inside its provider section
// (additive editor spec B1). `committedKey` starts null: stored values never
// enter the write-only draft until the operator types a replacement.
function seedExistingExtraSlots(existingKeys: string[] | undefined): ExtraSlot[] {
  const slots: ExtraSlot[] = []
  for (const key of new Set(existingKeys ?? [])) {
    if (CANONICAL_SLOT_KEYS.has(key)) continue
    const provider = providerForDataKey(key)
    if (!provider) continue
    slots.push({
      id: `existing-${key}`,
      provider,
      nameInput: key,
      value: '',
      committedKey: null,
      existingKey: key,
    })
  }
  return slots
}

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
  pickerInline = false,
}: LlmCredentialFieldsProps) {
  const [extraSlots, setExtraSlots] = useState<ExtraSlot[]>(() =>
    seedExistingExtraSlots(existingKeys)
  )
  // Providers the operator surfaced with "＋ Add provider" this session. Resets
  // with the mount (the update modal mounts fresh per row; the create flow
  // remounts per step) — a remount is auto-cured by the draft term below.
  const [manuallyAdded, setManuallyAdded] = useState<ReadonlySet<LlmProvider>>(() => new Set())
  const nextExtraId = useRef(0)

  const existingKeySet = useMemo(() => new Set(existingKeys ?? []), [existingKeys])
  const present = (dataKey: string): boolean =>
    (draft[dataKey] ?? '').trim().length > 0 || existingKeySet.has(dataKey)

  // Additive visibility (spec S1) — a provider section renders only when:
  //   - the Secret already stores one of its keys (canonical or extra), or
  //   - the draft carries a non-empty value for one of its keys (typed now, or
  //     surviving a create-flow step remount — never "key present in draft":
  //     createEmptyLlmKeyDraft seeds '' under EVERY canonical key), or
  //   - the operator added it this session.
  // Everything else stays hidden behind "＋ Add provider".
  const visibleProviders = useMemo(() => {
    const visible = new Set<LlmProvider>()
    for (const key of existingKeySet) {
      const provider = providerForDataKey(key)
      if (provider) visible.add(provider)
    }
    for (const [key, value] of Object.entries(draft)) {
      if (value.trim().length === 0) continue
      const provider = providerForDataKey(key)
      if (provider) visible.add(provider)
    }
    for (const provider of manuallyAdded) visible.add(provider)
    return visible
  }, [draft, existingKeySet, manuallyAdded])

  // Filtering LLM_CREDENTIAL_GROUPS (instead of iterating the sets) keeps the
  // canonical package order regardless of the order providers were added.
  const visibleGroups = LLM_CREDENTIAL_GROUPS.filter(group => visibleProviders.has(group.provider))
  const addableGroups = LLM_CREDENTIAL_GROUPS.filter(group => !visibleProviders.has(group.provider))

  // The picker is a MENU, not a selection: it never holds a value (see the
  // `value={[]}` below), so each addable provider is just an entry with its
  // brand mark, mirroring the agents LLM provider selector.
  const addProviderOptions: SelectionDropdownOption[] = addableGroups.map(group => ({
    value: group.provider,
    label: group.label,
    icon: <LlmProviderIcon provider={group.provider} label={group.label} />,
  }))

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

  function extraSlotError(slot: ExtraSlot, nameInput: string): string | null {
    const trimmed = nameInput.trim()
    if (!trimmed) return 'Key name is required.'
    if (!DATA_KEY_PATTERN.test(trimmed)) return 'Use lowercase letters, numbers, and - . _'
    // A slot seeded from a stored key may keep (and rewrite) its own name; any
    // OTHER known key is still a collision.
    if (knownKeys.has(trimmed) && trimmed !== slot.existingKey) {
      return 'This key already exists as a provider slot.'
    }
    if (extraSlots.some(item => item.id !== slot.id && item.nameInput.trim() === trimmed)) {
      return 'Duplicate key name.'
    }
    return null
  }

  // Reconcile an extra slot's committed key/value into the parent draft. Only a
  // valid, non-colliding key is committed; the previously-committed key (always
  // itself a validated key, never a real provider slot) is cleared on change.
  function commitExtraSlot(slot: ExtraSlot, nextName: string, nextValue: string) {
    const nextCommitted = extraSlotError(slot, nextName) === null ? nextName.trim() : null
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

  function addExtraSlot(provider: LlmProvider) {
    // Suggest the first `${provider}-api-key-fbN` not already claimed by the
    // stored Secret or another slot in the form (mirrors mintFallbackSlot in
    // the agents flow), so a seeded `-fb1` never collides with the suggestion.
    const claimed = new Set<string>([
      ...existingKeySet,
      ...extraSlots.map(slot => slot.nameInput.trim()),
    ])
    const suggested = mintFallbackSlot(provider, claimed)
    const id = `extra-${provider}-${nextExtraId.current++}`
    setExtraSlots(prev => [
      ...prev,
      { id, provider, nameInput: suggested, value: '', committedKey: null, existingKey: null },
    ])
  }

  function removeExtraSlot(id: string) {
    const slot = extraSlots.find(item => item.id === id)
    if (!slot) return
    if (slot.committedKey) onChange(slot.committedKey, '')
    setExtraSlots(prev => prev.filter(item => item.id !== id))
  }

  function addProvider(value: string) {
    const group = LLM_CREDENTIAL_GROUPS.find(item => item.provider === value)
    if (!group) return
    setManuallyAdded(prev => new Set(prev).add(group.provider))
  }

  // Removable only when hiding the section cannot lose anything (spec S2): the
  // provider was added this session AND no key of it carries a committed value
  // (canonical or extra). Two terms compose the value check:
  //   - draft scan via providerForDataKey — canonical slots and extras whose
  //     key still carries a recognizable provider prefix;
  //   - the extra-slot STATE — an extra slot renamed to a custom key (e.g.
  //     `team1.key`) commits to the draft under a key providerForDataKey can't
  //     attribute, so the slot's own committedKey/value must gate too.
  // A provider with a stored key never reaches `manuallyAdded` — it is already
  // visible, so "＋ Add provider" never offers it. Deleting a stored key stays
  // on removeSecretKey, not here.
  function isProviderRemovable(provider: LlmProvider): boolean {
    if (!manuallyAdded.has(provider)) return false
    const hasDraftValue = Object.entries(draft).some(
      ([key, value]) => value.trim().length > 0 && providerForDataKey(key) === provider
    )
    if (hasDraftValue) return false
    return !extraSlots.some(
      slot =>
        slot.provider === provider && slot.committedKey !== null && slot.value.trim().length > 0
    )
  }

  function removeProvider(provider: LlmProvider) {
    // Clear the provider's extra slots first so no committedKey stays orphaned
    // in the parent draft (spec §5 — their values are empty per the gate, but
    // the committed keys themselves must not linger).
    for (const slot of extraSlots.filter(item => item.provider === provider)) {
      removeExtraSlot(slot.id)
    }
    setManuallyAdded(prev => {
      const next = new Set(prev)
      next.delete(provider)
      return next
    })
  }

  return (
    <div className="cu-llm-cred-groups">
      {visibleGroups.length === 0 ? (
        <p className="cu-field__hint cu-llm-cred-empty">
          No providers added yet — add a provider below to enter its credentials.
        </p>
      ) : null}

      {visibleGroups.map(group => {
        const chip = completenessChip(group, present)
        const providerExtras = extraSlots.filter(slot => slot.provider === group.provider)
        const removable = isProviderRemovable(group.provider)
        return (
          <section className="cu-llm-cred-group" key={group.provider}>
            <div className="cu-llm-cred-group__head">
              <span className="cu-llm-cred-group__title">{group.label}</span>
              <span className="cu-llm-cred-group__head-actions">
                <span
                  className={cn('cu-slot-chip', `cu-slot-chip--${chip.state}`)}
                  aria-label={`${group.label} credentials ${chip.text}`}
                >
                  <span aria-hidden="true">{chip.symbol}</span>
                  {chip.text}
                </span>
                {removable ? (
                  <button
                    type="button"
                    className="cu-btn cu-btn--icon cu-btn--danger-icon"
                    onClick={() => removeProvider(group.provider)}
                    disabled={disabled}
                    aria-label={`Remove ${group.label} provider`}
                    title={`Remove ${group.label} provider`}
                  >
                    <IconX width={16} height={16} />
                  </button>
                ) : null}
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
              const error = extraSlotError(slot, slot.nameInput)
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

      {addableGroups.length > 0 ? (
        <Field htmlFor={ADD_PROVIDER_ID} label="Add provider">
          <SelectionDropdown
            id={ADD_PROVIDER_ID}
            className="cu-llm-cred-add"
            inline={pickerInline}
            // Always empty: picking a provider MOUNTS its section, it does not
            // leave the picker "holding" that provider — the entry disappears
            // from the options instead. Single-select closes the menu itself.
            value={[]}
            options={addProviderOptions}
            placeholder="Select a provider…"
            searchPlaceholder="Search providers…"
            selectionLabel="provider"
            multiple={false}
            showSelectedChips={false}
            disabled={disabled}
            onChange={next => {
              if (next[0]) addProvider(next[0])
            }}
          />
        </Field>
      ) : null}
    </div>
  )
}

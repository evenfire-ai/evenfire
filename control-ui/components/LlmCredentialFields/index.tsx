'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
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
  LLM_SECRET_EDITOR_GROUPS,
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
  onRemovedKeysChange,
  pickerInline = false,
}: LlmCredentialFieldsProps) {
  const [extraSlots, setExtraSlots] = useState<ExtraSlot[]>(() =>
    seedExistingExtraSlots(existingKeys)
  )
  // Stored keys whose seeded ROW was deleted with the X. Rename-driven
  // retirement is NOT tracked here — it is derived from `extraSlots` below, so
  // renaming back to the original name un-retires the key without any undo
  // bookkeeping (one source of truth per retirement cause).
  const [removedSeededKeys, setRemovedSeededKeys] = useState<ReadonlySet<string>>(() => new Set())
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
  const visibleGroups = LLM_SECRET_EDITOR_GROUPS.filter(group =>
    visibleProviders.has(group.provider)
  )
  const addableGroups = LLM_SECRET_EDITOR_GROUPS.filter(
    group => !visibleProviders.has(group.provider)
  )

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

  // Stored keys pending retirement on save. Two causes, one derivation:
  //   - REMOVED: the seeded row was deleted with its X (`removedSeededKeys`).
  //   - RENAMED: a seeded row still on screen whose committed key differs from
  //     the stored one AND carries a typed value. The value term matters — a
  //     rename with no value writes nothing, so retiring the old key would
  //     delete the credential outright instead of replacing it. Renaming back
  //     to `existingKey` naturally drops out of this set.
  // Finally, a key the draft is currently writing is never retired: the server
  // resolves "in data AND in removeKeys" as retirement-wins, which would throw
  // away the value the operator just typed.
  const removedKeys = useMemo(() => {
    const keys = new Set<string>(removedSeededKeys)
    for (const slot of extraSlots) {
      if (!slot.existingKey) continue
      if (!slot.committedKey || slot.committedKey === slot.existingKey) continue
      if (slot.value.trim().length === 0) continue
      keys.add(slot.existingKey)
    }
    return Array.from(keys)
      .filter(key => (draft[key] ?? '').trim().length === 0)
      .sort((a, b) => a.localeCompare(b))
  }, [draft, extraSlots, removedSeededKeys])

  // Report only on real change. `removedKeys` is a fresh array every render, so
  // the SIGNATURE is the effect's dependency (a k8s data key cannot contain a
  // newline, so the join is unambiguous). The callback reaches the effect
  // through a ref latch rather than the dependency array: parents pass an
  // inline closure, and depending on that identity would re-fire the effect on
  // every render the report itself causes.
  const notifyRemovedKeys = useRef(onRemovedKeysChange)
  notifyRemovedKeys.current = onRemovedKeysChange
  const removedKeysSignature = removedKeys.join('\n')
  useEffect(() => {
    notifyRemovedKeys.current?.(
      removedKeysSignature.length > 0 ? removedKeysSignature.split('\n') : []
    )
  }, [removedKeysSignature])

  function extraSlotError(slot: ExtraSlot, nameInput: string): string | null {
    const trimmed = nameInput.trim()
    if (!trimmed) return 'Key name is required.'
    if (!DATA_KEY_PATTERN.test(trimmed)) return 'Use lowercase letters, numbers, and - . _'
    // A slot seeded from a stored key may keep (and rewrite) its own name; any
    // OTHER known key is still a collision — EXCEPT one queued for retirement.
    // That key is on its way out, so re-typing it is not a collision, it is the
    // operator taking the removal back (see commitExtraSlot). Without this
    // exemption the name would never commit, the value would never reach the
    // draft, and the save would still carry the retirement — deleting the key
    // and silently discarding the credential just typed under it.
    if (knownKeys.has(trimmed) && trimmed !== slot.existingKey && !removedSeededKeys.has(trimmed)) {
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
    // Committing a key that was queued for retirement takes the removal back:
    // this row is once again the editor's representation of that STORED key, so
    // it re-adopts it as `existingKey` (becoming an ordinary seeded row) and the
    // key leaves the removal set. With no value typed the key simply survives
    // untouched; with a value it is rewritten through the normal merge.
    const unretiredKey =
      nextCommitted !== null && removedSeededKeys.has(nextCommitted) ? nextCommitted : null
    if (unretiredKey) {
      setRemovedSeededKeys(prev => {
        const next = new Set(prev)
        next.delete(unretiredKey)
        return next
      })
    }
    setExtraSlots(prev =>
      prev.map(item =>
        item.id === slot.id
          ? {
              ...item,
              nameInput: nextName,
              value: nextValue,
              committedKey: nextCommitted,
              existingKey: unretiredKey ?? item.existingKey,
            }
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
    // A slot seeded from the Secret leaves a STORED key behind: dropping the
    // row only hides it, so the key is queued for retirement on save. A slot
    // created in this session has nothing stored — clearing the draft above is
    // the whole removal.
    if (slot.existingKey) {
      const retired = slot.existingKey
      setRemovedSeededKeys(prev => new Set(prev).add(retired))
    }
    setExtraSlots(prev => prev.filter(item => item.id !== id))
  }

  function addProvider(value: string) {
    const group = LLM_SECRET_EDITOR_GROUPS.find(item => item.provider === value)
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
  // visible, so "＋ Add provider" never offers it. Retiring a stored key is the
  // per-slot X (which queues it into `removedKeys`), never this section-level
  // control.
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
      {/* Retirement is applied on SAVE, not on click — a row vanishing is not by
          itself proof anything will be deleted, so the queued keys are named.
          First child, above the provider sections: in the scroll-clipped update
          modal anything after them lands below the fold. Always mounted (empty
          when nothing is queued, and hidden by :empty) so the live region is
          present before the first announcement — a region inserted together
          with its text is not reliably announced. */}
      <p className="cu-field__hint cu-llm-cred-removed" role="status">
        {removedKeys.length > 0 ? (
          <>
            Will be removed from the stored secret on save:{' '}
            {removedKeys.map((key, index) => (
              <React.Fragment key={key}>
                {index > 0 ? ', ' : null}
                <code>{key}</code>
              </React.Fragment>
            ))}
            .
          </>
        ) : null}
      </p>

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
              // A seeded slot renamed but left valueless is a MUTE state: the
              // rename writes nothing, so the old key is deliberately not
              // retired (see `removedKeys`) and saving does nothing at all to
              // this row. Say so, instead of letting the operator believe the
              // rename landed.
              const renameNeedsValue =
                slot.existingKey !== null &&
                slot.committedKey !== null &&
                slot.committedKey !== slot.existingKey &&
                slot.value.trim().length === 0
              return (
                <Field
                  key={slot.id}
                  htmlFor={inputId}
                  label={`Additional credential slot`}
                  description={
                    renameNeedsValue
                      ? `Type a value to complete the rename — the stored key keeps its old name (${slot.existingKey}) until then.`
                      : undefined
                  }
                  error={error ?? undefined}
                >
                  <div className="cu-llm-cred-extra">
                    <TextInput
                      monospace
                      value={slot.nameInput}
                      onChange={event => commitExtraSlot(slot, event.target.value, slot.value)}
                      placeholder={`${group.slots[0]?.dataKey ?? group.provider}-fb1`}
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

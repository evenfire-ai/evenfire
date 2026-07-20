'use client'

import React, { useEffect, useMemo } from 'react'
import { IconTrash } from '@/components/icons'
import { Button, CheckboxField, Field, SelectInput, TextInput } from '@/components/ui'
import {
  LLM_DEFAULT_COOLDOWN_SECONDS,
  LLM_PROVIDER_OPTIONS,
  LLM_TRIGGER_CLASSES,
  LLM_TRIGGER_LABELS,
  type LlmFallbackEntry,
  type LlmPolicy,
  type LlmProvider,
  type LlmTriggerClass,
  constrainModelOptions,
  getCredentialSlotOptions,
  getProviderDisplayLabel,
  normalizeProvider,
  providerSupportsFallbackCredentialSlot,
  resolveDefaultModel,
} from '@/lib/llm'
import type { LlmPolicyEditorProps } from './types'

// Empty triggerOn on a fresh policy means "all four" (the CRD default); we seed
// the full set explicitly so the operator sees what is active and can pare down.
function newPolicy(entry: LlmFallbackEntry): LlmPolicy {
  return {
    cooldownSeconds: LLM_DEFAULT_COOLDOWN_SECONDS,
    triggerOn: [...LLM_TRIGGER_CLASSES],
    fallbacks: [entry],
  }
}

/**
 * Editor for a Host's `spec.llmPolicy` (spec §3-R5): an ordered, opt-in list of
 * fallback (provider, model, credentialSlot?) entries plus a cooldown and the
 * set of error classes that trigger a failover. Controlled: `value`/`onChange`.
 *
 * UX decisions:
 *   - The whole section is optional. With no fallbacks the policy is `undefined`
 *     (the parent drops `spec.llmPolicy` on save → zero behavior change).
 *   - `credentialSlot` is a dropdown of real Secret keys, NEVER free text
 *     (spec R4.5.6) — the registry slots plus any extra keys detected in the
 *     Host's LLM Secret.
 *   - Model options are the enabled allowlist for that entry's provider (R3); a
 *     saved model that fell out of the allowlist stays selectable and is flagged.
 */
export function LlmPolicyEditor({
  value,
  onChange,
  catalog,
  allowedModels = [],
  secretKeys = [],
  defaultProvider,
  disabled = false,
}: LlmPolicyEditorProps) {
  const fallbacks = value?.fallbacks ?? []
  const triggerOn = value?.triggerOn ?? [...LLM_TRIGGER_CLASSES]
  const cooldownSeconds = value?.cooldownSeconds ?? LLM_DEFAULT_COOLDOWN_SECONDS

  const emit = (next: Partial<LlmPolicy>) => {
    const merged: LlmPolicy = {
      cooldownSeconds,
      triggerOn,
      fallbacks,
      ...next,
    }
    onChange(merged.fallbacks.length === 0 ? undefined : merged)
  }

  const addFallback = () => {
    const model = resolveDefaultModel(
      defaultProvider,
      constrainModelOptions(catalog, allowedModels, defaultProvider)
    )
    const entry: LlmFallbackEntry = { provider: defaultProvider, model }
    if (fallbacks.length === 0) {
      onChange(newPolicy(entry))
    } else {
      emit({ fallbacks: [...fallbacks, entry] })
    }
  }

  const updateEntry = (index: number, patch: Partial<LlmFallbackEntry>) => {
    emit({
      fallbacks: fallbacks.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    })
  }

  const removeEntry = (index: number) => {
    emit({ fallbacks: fallbacks.filter((_, i) => i !== index) })
  }

  const moveEntry = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= fallbacks.length) return
    const next = [...fallbacks]
    ;[next[index], next[target]] = [next[target], next[index]]
    emit({ fallbacks: next })
  }

  const toggleTrigger = (cls: LlmTriggerClass, checked: boolean) => {
    const set = new Set(triggerOn)
    if (checked) set.add(cls)
    else set.delete(cls)
    // Preserve canonical order.
    emit({ triggerOn: LLM_TRIGGER_CLASSES.filter(c => set.has(c)) })
  }

  return (
    <section className="cu-llm-policy" aria-label="Fallback policy">
      <div className="cu-llm-policy__intro">
        <p className="cu-muted" style={{ fontSize: '0.8125rem', margin: 0 }}>
          Optional. When the primary model fails with an eligible error, the agent switches to the
          first available fallback below, then lazily retries the primary after the cooldown. No
          fallback = the agent behaves exactly as today.
        </p>
      </div>

      {fallbacks.length === 0 ? (
        <div className="cu-llm-policy__empty">
          <span className="cu-muted" style={{ fontSize: '0.8125rem' }}>
            No fallback configured.
          </span>
        </div>
      ) : (
        <>
          <div className="cu-llm-policy__globals">
            <Field
              htmlFor="llm-policy-cooldown"
              label="Cooldown (seconds)"
              description="How long the primary stays out of rotation after an eligible failure before it is retried."
            >
              <TextInput
                id="llm-policy-cooldown"
                type="number"
                min={0}
                narrow
                value={String(cooldownSeconds)}
                onChange={e => {
                  const parsed = Number.parseInt(e.target.value, 10)
                  emit({
                    cooldownSeconds: Number.isNaN(parsed)
                      ? LLM_DEFAULT_COOLDOWN_SECONDS
                      : Math.max(0, parsed),
                  })
                }}
                disabled={disabled}
              />
            </Field>

            <fieldset className="cu-llm-policy__triggers">
              <legend>Trigger on</legend>
              {LLM_TRIGGER_CLASSES.map(cls => (
                <CheckboxField
                  key={cls}
                  checked={triggerOn.includes(cls)}
                  label={LLM_TRIGGER_LABELS[cls]}
                  disabled={disabled}
                  onChange={e => toggleTrigger(cls, e.target.checked)}
                />
              ))}
              {triggerOn.length === 0 ? (
                <span className="cu-field__error">Select at least one trigger.</span>
              ) : null}
            </fieldset>
          </div>

          <ol className="cu-llm-policy__list">
            {fallbacks.map((entry, index) => (
              <FallbackRow
                key={index}
                index={index}
                entry={entry}
                catalog={catalog}
                allowedModels={allowedModels}
                secretKeys={secretKeys}
                disabled={disabled}
                isFirst={index === 0}
                isLast={index === fallbacks.length - 1}
                onChange={patch => updateEntry(index, patch)}
                onRemove={() => removeEntry(index)}
                onMove={direction => moveEntry(index, direction)}
              />
            ))}
          </ol>
        </>
      )}

      <div className="cu-llm-policy__actions">
        <Button type="button" variant="ghost" size="sm" onClick={addFallback} disabled={disabled}>
          Add fallback provider
        </Button>
      </div>
    </section>
  )
}

type FallbackRowProps = {
  index: number
  entry: LlmFallbackEntry
  catalog: LlmPolicyEditorProps['catalog']
  allowedModels: LlmPolicyEditorProps['allowedModels']
  secretKeys: string[]
  disabled: boolean
  isFirst: boolean
  isLast: boolean
  onChange: (patch: Partial<LlmFallbackEntry>) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}

function FallbackRow({
  index,
  entry,
  catalog,
  allowedModels = [],
  secretKeys,
  disabled,
  isFirst,
  isLast,
  onChange,
  onRemove,
  onMove,
}: FallbackRowProps) {
  // Constrain to the host's per-provider subset when set (Topic 3a); otherwise
  // the full enabled allowlist for the provider.
  const modelOptions = useMemo(
    () => constrainModelOptions(catalog, allowedModels, entry.provider),
    [catalog, allowedModels, entry.provider]
  )
  const slotOptions = useMemo(
    () => getCredentialSlotOptions(entry.provider, secretKeys),
    [entry.provider, secretKeys]
  )
  // Bedrock/Vertex can't express a single-key credentialSlot, so the backend
  // rejects one (422). Suppress the whole slot control for those providers — the
  // fallback reuses the primary credentials (mirrors the credentials-block gate).
  const supportsCredentialSlot = providerSupportsFallbackCredentialSlot(entry.provider)
  // Self-heal legacy data: a pre-gate policy may carry a credentialSlot on a
  // provider that no longer supports one. The control is suppressed, so clear the
  // stale value to match the reuse-primary note and turn a blocked save into a
  // self-healing one (the provider switch clears it too; this covers loaded data).
  useEffect(() => {
    if (!supportsCredentialSlot && entry.credentialSlot) {
      onChange({ credentialSlot: undefined })
    }
  }, [supportsCredentialSlot, entry.credentialSlot, onChange])
  const modelOutOfAllowlist = Boolean(entry.model) && !modelOptions.includes(entry.model)
  const slot = entry.credentialSlot ?? ''
  const slotOutOfSecret = Boolean(slot) && !slotOptions.includes(slot)

  const rowId = `llm-fallback-${index}`

  return (
    <li className="cu-llm-policy__row">
      <div className="cu-llm-policy__row-head">
        <span className="cu-llm-policy__row-index">Fallback #{index + 1}</span>
        <div className="cu-llm-policy__row-controls">
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => onMove(-1)}
            disabled={disabled || isFirst}
            aria-label={`Move fallback ${index + 1} up`}
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => onMove(1)}
            disabled={disabled || isLast}
            aria-label={`Move fallback ${index + 1} down`}
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--danger-icon"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove fallback ${index + 1}`}
            title="Remove"
          >
            <IconTrash width={16} height={16} />
          </button>
        </div>
      </div>

      <div className="cu-llm-policy__row-fields">
        <Field htmlFor={`${rowId}-provider`} label="Provider">
          <SelectInput
            id={`${rowId}-provider`}
            value={entry.provider}
            disabled={disabled}
            onChange={e => {
              const nextProvider = normalizeProvider(e.target.value)
              // Re-default the model to the new provider's allowlist and drop a
              // credentialSlot that no longer applies to the new provider.
              onChange({
                provider: nextProvider,
                model: resolveDefaultModel(
                  nextProvider,
                  constrainModelOptions(catalog, allowedModels, nextProvider)
                ),
                credentialSlot: undefined,
              })
            }}
          >
            {LLM_PROVIDER_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field htmlFor={`${rowId}-model`} label="Model">
          <SelectInput
            id={`${rowId}-model`}
            value={entry.model}
            disabled={disabled}
            invalid={modelOutOfAllowlist}
            onChange={e => onChange({ model: e.target.value })}
          >
            {!entry.model ? (
              <option value="">
                {modelOptions.length === 0 ? 'No enabled models' : 'Select model…'}
              </option>
            ) : null}
            {modelOptions.map(model => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            {modelOutOfAllowlist ? (
              <option value={entry.model}>{entry.model} (out of allowlist)</option>
            ) : null}
          </SelectInput>
          {modelOutOfAllowlist ? (
            <span className="cu-llm-policy__warn">
              {entry.model} isn&apos;t in the models offered for{' '}
              {getProviderDisplayLabel(entry.provider)} — pick one from the list.
            </span>
          ) : null}
        </Field>

        {supportsCredentialSlot ? (
          <Field
            htmlFor={`${rowId}-slot`}
            label="Credential slot"
            description="Optional key of the same LLM Secret (e.g. another key for the same provider). Empty = the provider's normal slot."
          >
            <SelectInput
              id={`${rowId}-slot`}
              value={slot}
              disabled={disabled}
              onChange={e =>
                onChange({ credentialSlot: e.target.value ? e.target.value : undefined })
              }
            >
              <option value="">Provider default slot</option>
              {slotOptions.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {slotOutOfSecret ? <option value={slot}>{slot} (not found in Secret)</option> : null}
            </SelectInput>
          </Field>
        ) : (
          <Field label="Credential slot">
            <p className="cu-field__hint cu-llm-policy__slot-note">
              {getProviderDisplayLabel(entry.provider)} fallbacks reuse the primary credentials — a
              separate key slot isn&apos;t supported.
            </p>
          </Field>
        )}
      </div>
    </li>
  )
}

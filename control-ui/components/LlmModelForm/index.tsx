'use client'

import React, { useState } from 'react'
import { Button, CheckboxField, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import type { CreateLlmModelInput } from '@lib/api'
import { LLM_PROVIDER_OPTIONS, isKnownProvider } from '@lib/llm'
import type { LlmModelFormProps } from './types'

// Returns a positive integer, or null when empty. Returns undefined when the
// value is present but not a valid positive integer (surfaced as a field error).
function parseContextWindow(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}

export function LlmModelForm({
  mode,
  initial,
  prefill,
  saving,
  error,
  onSubmit,
  onCancel,
}: LlmModelFormProps) {
  // Keep the provider verbatim: it is a free `string`, not the 4-value
  // LlmProvider enum. Collapsing an unrecognized provider to a known one would
  // silently rewrite it on edit.
  const [provider, setProvider] = useState<string>(
    initial?.provider ?? prefill?.provider ?? LLM_PROVIDER_OPTIONS[0].value
  )
  const [model, setModel] = useState(initial?.model ?? prefill?.model ?? '')
  const [vendor, setVendor] = useState(initial?.vendor ?? '')
  const [displayName, setDisplayName] = useState(initial?.display_name ?? '')
  const [contextWindow, setContextWindow] = useState(
    initial?.context_window_tokens != null ? String(initial.context_window_tokens) : ''
  )
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [showErrors, setShowErrors] = useState(false)

  const providerIsKnown = isKnownProvider(provider)
  const modelInvalid = model.trim().length === 0
  const contextWindowInvalid = parseContextWindow(contextWindow) === undefined
  const hasErrors = modelInvalid || contextWindowInvalid

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    if (hasErrors) {
      setShowErrors(true)
      return
    }
    const parsedContext = parseContextWindow(contextWindow)
    const input: CreateLlmModelInput = {
      provider,
      model: model.trim(),
      // Send null (not '') so an empty optional clears the column on edit.
      vendor: vendor.trim() || null,
      display_name: displayName.trim() || null,
      context_window_tokens: parsedContext === undefined ? null : parsedContext,
      enabled,
    }
    onSubmit(input)
  }

  return (
    <form className="cu-create-content cu-px-form" onSubmit={handleSubmit}>
      <FormSection
        title="Model"
        description="Provider (runtime/platform id) and the exact model name callers request."
      >
        <div className="cu-form-grid cu-form-grid--2">
          <Field htmlFor="llm-model-provider" label="Provider" required>
            <SelectInput
              id="llm-model-provider"
              value={provider}
              onChange={event => setProvider(event.target.value)}
              disabled={saving}
            >
              {LLM_PROVIDER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {!providerIsKnown && <option value={provider}>{provider} (unrecognized)</option>}
            </SelectInput>
          </Field>
          <Field
            htmlFor="llm-model-name"
            label="Model"
            required
            error={showErrors && modelInvalid ? 'Model is required.' : undefined}
          >
            <TextInput
              id="llm-model-name"
              monospace
              value={model}
              onChange={event => setModel(event.target.value)}
              placeholder="claude-haiku-4-5"
              invalid={showErrors && modelInvalid}
              disabled={saving}
              autoFocus
            />
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="Metadata"
        description="Optional. Vendor is the model creator (e.g. Anthropic); display name and context window are shown in pickers."
      >
        <div className="cu-form-grid cu-form-grid--2">
          <Field htmlFor="llm-model-vendor" label="Vendor">
            <TextInput
              id="llm-model-vendor"
              value={vendor}
              onChange={event => setVendor(event.target.value)}
              placeholder="Anthropic"
              disabled={saving}
            />
          </Field>
          <Field htmlFor="llm-model-display" label="Display name">
            <TextInput
              id="llm-model-display"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder="Claude Haiku 4.5"
              disabled={saving}
            />
          </Field>
          <Field
            htmlFor="llm-model-context"
            label="Context window (tokens)"
            error={
              showErrors && contextWindowInvalid
                ? 'Enter a whole number greater than 0, or leave blank.'
                : undefined
            }
          >
            <TextInput
              id="llm-model-context"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={contextWindow}
              onChange={event => setContextWindow(event.target.value)}
              placeholder="200000"
              invalid={showErrors && contextWindowInvalid}
              disabled={saving}
            />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Settings">
        <CheckboxField
          label="Enabled"
          description="Only enabled models can be selected for agents and served at runtime. Disable to retire a model without deleting it."
          checked={enabled}
          onChange={event => setEnabled(event.target.checked)}
          disabled={saving}
        />
      </FormSection>

      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="cu-create-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? 'Saving…' : mode === 'create' ? 'Add model' : 'Save model'}
        </Button>
      </div>
    </form>
  )
}

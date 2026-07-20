'use client'

import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import { Button, CheckboxField, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import type { CreateLlmPriceInput, LlmModelPrice } from '@lib/api'
import { useLlmAllowedModels } from '@lib/hooks/useLlmAllowedModels'
import { LLM_PROVIDER_OPTIONS, getModelOptions, isKnownProvider } from '@lib/llm'
import { DEFAULT_CURRENCY, PRICE_FIELDS } from './constants'
import type { LlmPriceFormProps, PriceFieldKey } from './types'

type PriceDraft = Record<PriceFieldKey, string>

function initialPriceDraft(initial?: LlmModelPrice | null): PriceDraft {
  return {
    input_token_price: initial ? String(initial.input_token_price) : '0',
    output_token_price: initial ? String(initial.output_token_price) : '0',
    cache_read_token_price: initial ? String(initial.cache_read_token_price) : '0',
    cache_write_token_price: initial ? String(initial.cache_write_token_price) : '0',
  }
}

// Returns a non-negative finite number, or null when the field is invalid.
function parsePrice(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

export function LlmPriceForm({
  mode,
  initial,
  prefill,
  saving,
  error,
  budgetsUsingPrice,
  onSubmit,
  onCancel,
}: LlmPriceFormProps) {
  // Keep the provider verbatim (it is a free `string` on the price row, not the
  // 4-value LlmProvider enum). Collapsing an unrecognized provider to a known one
  // would silently rewrite it on edit, or strand an unpriced model forever.
  const [provider, setProvider] = useState<string>(
    initial?.provider ?? prefill?.provider ?? LLM_PROVIDER_OPTIONS[0].value
  )
  const [model, setModel] = useState(initial?.model ?? prefill?.model ?? '')
  const [currency, setCurrency] = useState(initial?.currency ?? DEFAULT_CURRENCY)
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [prices, setPrices] = useState<PriceDraft>(() => initialPriceDraft(initial))
  const [showErrors, setShowErrors] = useState(false)

  // Suggestions come from the allowlist. Prices can be set for a model even if
  // it is currently disabled, so include disabled rows here.
  const { models: allowedModels } = useLlmAllowedModels()
  const modelSuggestions = getModelOptions(allowedModels, provider, { includeDisabled: true })
  // Preserve an unrecognized provider as a selectable option instead of dropping it.
  const providerIsKnown = isKnownProvider(provider)

  const priceErrors = useMemo(() => {
    const errors: Partial<Record<PriceFieldKey, string>> = {}
    for (const field of PRICE_FIELDS) {
      if (parsePrice(prices[field.key]) === null) {
        errors[field.key] = 'Enter a number greater than or equal to 0.'
      }
    }
    return errors
  }, [prices])

  const modelInvalid = model.trim().length === 0
  const currencyInvalid = currency.trim().length === 0
  const hasErrors = modelInvalid || currencyInvalid || Object.keys(priceErrors).length > 0

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    if (hasErrors) {
      setShowErrors(true)
      return
    }
    const input: CreateLlmPriceInput = {
      provider,
      model: model.trim(),
      input_token_price: parsePrice(prices.input_token_price) ?? 0,
      output_token_price: parsePrice(prices.output_token_price) ?? 0,
      cache_read_token_price: parsePrice(prices.cache_read_token_price) ?? 0,
      cache_write_token_price: parsePrice(prices.cache_write_token_price) ?? 0,
      currency: currency.trim(),
      enabled,
    }
    onSubmit(input)
  }

  return (
    <form className="cu-create-content cu-px-form" onSubmit={handleSubmit}>
      <FormSection
        title="Model"
        description="Provider and model name must match the values reported in usage."
      >
        <div className="cu-form-grid cu-form-grid--2">
          <Field htmlFor="llm-price-provider" label="Provider" required>
            <SelectInput
              id="llm-price-provider"
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
            htmlFor="llm-price-model"
            label="Model"
            required
            error={showErrors && modelInvalid ? 'Model is required.' : undefined}
          >
            <TextInput
              id="llm-price-model"
              list="llm-price-model-options"
              monospace
              value={model}
              onChange={event => setModel(event.target.value)}
              placeholder="claude-sonnet-4-6"
              invalid={showErrors && modelInvalid}
              disabled={saving}
              autoFocus
            />
            <datalist id="llm-price-model-options">
              {modelSuggestions.map(name => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="Prices"
        description="All prices are expressed per 1,000,000 tokens and must be ≥ 0."
      >
        <div className="cu-form-grid cu-form-grid--2">
          {PRICE_FIELDS.map(field => (
            <Field
              key={field.key}
              htmlFor={`llm-price-${field.key}`}
              label={field.label}
              description={field.description}
              required
              error={showErrors ? priceErrors[field.key] : undefined}
            >
              <TextInput
                id={`llm-price-${field.key}`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={prices[field.key]}
                onChange={event =>
                  setPrices(prev => ({ ...prev, [field.key]: event.target.value }))
                }
                invalid={showErrors && Boolean(priceErrors[field.key])}
                disabled={saving}
              />
            </Field>
          ))}
        </div>
      </FormSection>

      <FormSection title="Settings">
        <div className="cu-form-grid cu-form-grid--2">
          <Field
            htmlFor="llm-price-currency"
            label="Currency"
            required
            error={showErrors && currencyInvalid ? 'Currency is required.' : undefined}
          >
            <TextInput
              id="llm-price-currency"
              value={currency}
              onChange={event => setCurrency(event.target.value)}
              placeholder={DEFAULT_CURRENCY}
              invalid={showErrors && currencyInvalid}
              disabled={saving}
            />
          </Field>
        </div>
        <CheckboxField
          label="Enabled"
          description="Only one enabled price per provider/model. Disabled rows are ignored when computing cost."
          checked={enabled}
          onChange={event => setEnabled(event.target.checked)}
          disabled={saving}
        />
      </FormSection>

      {budgetsUsingPrice && budgetsUsingPrice.length > 0 ? (
        <div className="cu-banner cu-banner--error" role="alert">
          This price is still used by <strong>{budgetsUsingPrice.length}</strong> cost budget
          {budgetsUsingPrice.length === 1 ? '' : 's'}. Update or remove the model from{' '}
          {budgetsUsingPrice.map((budget, index) => (
            <React.Fragment key={budget.id}>
              {index > 0 ? ', ' : ''}
              <Link
                href={CONTROL_ROUTES.costAndUsage.editTokenBudget(budget.id)}
                className="cu-link"
              >
                {budget.name}
              </Link>
            </React.Fragment>
          ))}{' '}
          before disabling or re-keying it.
        </div>
      ) : error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="cu-create-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? 'Saving…' : mode === 'create' ? 'Add price' : 'Save price'}
        </Button>
      </div>
    </form>
  )
}

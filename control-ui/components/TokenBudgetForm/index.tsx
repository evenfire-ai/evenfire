'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button, CheckboxField, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CreateTokenBudgetInput,
  type LlmModelPrice,
  getAdminTeams,
  getAdminUsers,
  getHosts,
  getLlmPrices,
  getRecipeSecrets,
} from '@lib/api'
import { useLlmAllowedModels } from '@lib/hooks/useLlmAllowedModels'
import { LLM_PROVIDER_OPTIONS, getAllModelOptions } from '@lib/llm'
import { ScopeSelector } from './ScopeSelector'
import { DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from './constants'
import type { ScopeDimensionConfig, ScopeOption, TokenBudgetFormProps } from './types'

// Numeric fields are kept as strings so a partially-typed value never coerces
// to NaN mid-edit; parsed on submit. Returns a finite number or null.
function parseNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

const PROVIDER_OPTIONS: ScopeOption[] = LLM_PROVIDER_OPTIONS.map(o => ({
  value: o.value,
  label: o.label,
}))

export function TokenBudgetForm({
  mode,
  initial,
  saving,
  error,
  unpricedModelsError,
  onSubmit,
  onCancel,
}: TokenBudgetFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [unit, setUnit] = useState<'cost' | 'tokens'>(initial?.unit ?? 'cost')
  const [currency, setCurrency] = useState(initial?.currency ?? DEFAULT_CURRENCY)
  const [limitAmount, setLimitAmount] = useState(initial ? String(initial.limit_amount) : '')
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>(initial?.period ?? 'monthly')
  // Pinned to UTC in this version (see budget timezone limitation); kept in state
  // so an existing budget's stored value round-trips on save.
  const [timezone] = useState(initial?.timezone ?? DEFAULT_TIMEZONE)
  const [minStartAmount, setMinStartAmount] = useState(
    initial ? String(initial.min_start_amount) : '0'
  )
  const [maxTaskAmount, setMaxTaskAmount] = useState(
    initial?.max_task_amount != null ? String(initial.max_task_amount) : ''
  )
  // P0c ships in observation mode: default new budgets to 'warn'.
  const [enforcement, setEnforcement] = useState<'block' | 'warn'>(initial?.enforcement ?? 'warn')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [scope, setScope] = useState<Record<string, string[]>>(initial?.scope ?? {})
  const [showErrors, setShowErrors] = useState(false)

  // Dimension option sources (best-effort; a failed fetch just leaves a
  // dimension with no select options — the budget can still be saved).
  const [teamOptions, setTeamOptions] = useState<ScopeOption[]>([])
  const [userOptions, setUserOptions] = useState<ScopeOption[]>([])
  const [hostOptions, setHostOptions] = useState<ScopeOption[]>([])
  const [secretOptions, setSecretOptions] = useState<ScopeOption[]>([])
  // Active prices, used to derive the live "unpriced model" warning below.
  // `pricesLoaded` guards against flagging every model while the fetch is in
  // flight (empty list would otherwise look like "nothing is priced").
  const [prices, setPrices] = useState<LlmModelPrice[]>([])
  const [pricesLoaded, setPricesLoaded] = useState(false)

  // Free-text model-scope suggestions come from the allowlist (all providers).
  const { models: allowedModels } = useLlmAllowedModels()
  const modelSuggestions = useMemo(
    () => getAllModelOptions(allowedModels, { includeDisabled: true }),
    [allowedModels]
  )

  useEffect(() => {
    let cancelled = false
    async function loadOptions() {
      const [teams, users, hosts, secrets, priceRows] = await Promise.allSettled([
        getAdminTeams(),
        getAdminUsers(),
        getHosts(),
        getRecipeSecrets(),
        getLlmPrices(),
      ])
      if (cancelled) return
      if (priceRows.status === 'fulfilled') {
        setPrices(priceRows.value.rows ?? [])
        setPricesLoaded(true)
      }
      if (teams.status === 'fulfilled') {
        setTeamOptions((teams.value.items ?? []).map(t => ({ value: t.id, label: t.name })))
      }
      if (users.status === 'fulfilled') {
        setUserOptions(
          (users.value.items ?? []).map(u => ({
            value: u.id,
            label: u.displayName || u.name || u.email,
          }))
        )
      }
      if (hosts.status === 'fulfilled') {
        setHostOptions(
          (hosts.value.items ?? [])
            .map(h => h.metadata?.name)
            .filter((n): n is string => Boolean(n))
            .map(n => ({ value: n, label: n }))
        )
      }
      if (secrets.status === 'fulfilled') {
        setSecretOptions((secrets.value.items ?? []).map(s => ({ value: s.name, label: s.name })))
      }
    }
    void loadOptions()
    return () => {
      cancelled = true
    }
  }, [])

  const dimensions: ScopeDimensionConfig[] = useMemo(
    () => [
      { key: 'provider', label: 'Provider', options: PROVIDER_OPTIONS },
      {
        key: 'model',
        label: 'Model',
        options: null,
        suggestions: modelSuggestions,
        placeholder: 'claude-sonnet-4-6',
        description: 'Free-text; press Enter or Add.',
      },
      { key: 'team_id', label: 'Team', options: teamOptions },
      { key: 'user_id', label: 'User', options: userOptions },
      { key: 'host_ref', label: 'Agent', options: hostOptions },
      { key: 'llm_secret_name', label: 'Secret', options: secretOptions },
    ],
    [teamOptions, userOptions, hostOptions, secretOptions, modelSuggestions]
  )

  // Labels for already-selected team/user values so edited budgets show names.
  const valueLabels = useMemo<Record<string, Record<string, string>>>(() => {
    const toMap = (opts: ScopeOption[]) => Object.fromEntries(opts.map(o => [o.value, o.label]))
    return {
      team_id: toMap(teamOptions),
      user_id: toMap(userOptions),
    }
  }, [teamOptions, userOptions])

  const limitValue = parseNumber(limitAmount)
  const minStartValue = parseNumber(minStartAmount)
  const maxTaskValue = maxTaskAmount.trim() === '' ? null : parseNumber(maxTaskAmount)

  const nameInvalid = name.trim().length === 0
  const limitInvalid = limitValue === null || limitValue <= 0
  const minStartInvalid = minStartValue === null || minStartValue < 0
  const maxTaskInvalid = maxTaskAmount.trim() !== '' && (maxTaskValue === null || maxTaskValue <= 0)
  const currencyInvalid = unit === 'cost' && currency.trim().length === 0
  const hasErrors =
    nameInvalid || limitInvalid || minStartInvalid || maxTaskInvalid || currencyInvalid

  // Live unpriced surfacing (§6.2): derived from the CURRENT form scope and the
  // loaded price list, not the saved snapshot — so it appears on create and
  // stays accurate as scope/unit change before saving. Only cost budgets whose
  // scope pins model(s) can under-count spend (or be rejected on save). A model
  // is "unpriced" when no enabled price row matches it (constrained to the
  // scoped providers when the scope also pins a provider).
  const unpricedScopeModels = useMemo(() => {
    if (unit !== 'cost' || !pricesLoaded) return []
    const scopedModels = scope.model ?? []
    if (scopedModels.length === 0) return []
    const scopedProviders = scope.provider ?? []
    const enabledPrices = prices.filter(p => p.enabled)
    return scopedModels.filter(model => {
      const hasActivePrice = enabledPrices.some(
        p =>
          p.model === model &&
          (scopedProviders.length === 0 || scopedProviders.includes(p.provider))
      )
      return !hasActivePrice
    })
  }, [unit, pricesLoaded, prices, scope])

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    if (hasErrors) {
      setShowErrors(true)
      return
    }
    const input: CreateTokenBudgetInput = {
      name: name.trim(),
      enabled,
      scope,
      unit,
      currency: unit === 'cost' ? currency.trim() : null,
      limit_amount: limitValue ?? 0,
      period,
      timezone: timezone.trim() || DEFAULT_TIMEZONE,
      min_start_amount: minStartValue ?? 0,
      max_task_amount: maxTaskValue,
      enforcement,
    }
    onSubmit(input)
  }

  return (
    <form className="cu-create-content cu-tb-form" onSubmit={handleSubmit}>
      <FormSection title="Budget" description="A name and the limit this budget enforces.">
        <div className="cu-form-grid cu-form-grid--2">
          <Field
            htmlFor="budget-name"
            label="Name"
            required
            error={showErrors && nameInvalid ? 'Name is required.' : undefined}
          >
            <TextInput
              id="budget-name"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="Monthly OpenAI cap"
              invalid={showErrors && nameInvalid}
              disabled={saving}
              autoFocus
            />
          </Field>
          <Field htmlFor="budget-unit" label="Unit" required>
            <SelectInput
              id="budget-unit"
              value={unit}
              onChange={event => setUnit(event.target.value as 'cost' | 'tokens')}
              disabled={saving}
            >
              <option value="cost">Cost (currency)</option>
              <option value="tokens">Tokens (raw count)</option>
            </SelectInput>
          </Field>
          <Field
            htmlFor="budget-limit"
            label={unit === 'cost' ? 'Limit amount (cost)' : 'Limit amount (tokens)'}
            required
            error={showErrors && limitInvalid ? 'Enter a number greater than 0.' : undefined}
          >
            <TextInput
              id="budget-limit"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={limitAmount}
              onChange={event => setLimitAmount(event.target.value)}
              invalid={showErrors && limitInvalid}
              disabled={saving}
            />
          </Field>
          {unit === 'cost' ? (
            <Field
              htmlFor="budget-currency"
              label="Currency"
              required
              error={
                showErrors && currencyInvalid ? 'Currency is required for cost budgets.' : undefined
              }
            >
              <TextInput
                id="budget-currency"
                value={currency}
                onChange={event => setCurrency(event.target.value)}
                placeholder={DEFAULT_CURRENCY}
                invalid={showErrors && currencyInvalid}
                disabled={saving}
              />
            </Field>
          ) : null}
        </div>
        {unpricedScopeModels.length > 0 ? (
          <div className="cu-banner cu-banner--warning" role="status">
            <strong>{unpricedScopeModels.length}</strong> scoped model
            {unpricedScopeModels.length === 1 ? '' : 's'} have no active price
            {' ('}
            {unpricedScopeModels.join(', ')}
            {'). '}
            Cost won&apos;t be counted and saving may be rejected until you{' '}
            <Link href={CONTROL_ROUTES.costAndUsage.llmPrices} className="cu-link">
              add prices
            </Link>
            .
          </div>
        ) : null}
      </FormSection>

      <FormSection
        title="Period"
        description="Calendar-aligned window; spend resets at the start of each period."
      >
        <div className="cu-form-grid cu-form-grid--2">
          <Field htmlFor="budget-period" label="Period" required>
            <SelectInput
              id="budget-period"
              value={period}
              onChange={event => setPeriod(event.target.value as 'daily' | 'weekly' | 'monthly')}
              disabled={saving}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </SelectInput>
          </Field>
          <Field
            htmlFor="budget-timezone"
            label="Timezone"
            description="Periods align to UTC in this version. Per-budget timezones arrive with timezone-aware usage rollups."
          >
            <TextInput id="budget-timezone" value={timezone} readOnly disabled />
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="Thresholds"
        description="Guardrails applied per task (enforcement arrives in a later phase)."
      >
        <div className="cu-form-grid cu-form-grid--2">
          <Field
            htmlFor="budget-min-start"
            label="Min remaining to start"
            description="Minimum remaining required to allow a new task. 0 = start while any remains."
            error={
              showErrors && minStartInvalid
                ? 'Enter a number greater than or equal to 0.'
                : undefined
            }
          >
            <TextInput
              id="budget-min-start"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={minStartAmount}
              onChange={event => setMinStartAmount(event.target.value)}
              invalid={showErrors && minStartInvalid}
              disabled={saving}
            />
          </Field>
          <Field
            htmlFor="budget-max-task"
            label="Max per task (optional)"
            description="Hard brake: absolute cap for a single task. Leave blank for no per-task cap."
            error={
              showErrors && maxTaskInvalid
                ? 'Enter a number greater than 0, or leave blank.'
                : undefined
            }
          >
            <TextInput
              id="budget-max-task"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={maxTaskAmount}
              onChange={event => setMaxTaskAmount(event.target.value)}
              invalid={showErrors && maxTaskInvalid}
              disabled={saving}
            />
          </Field>
          <Field htmlFor="budget-enforcement" label="Enforcement">
            <SelectInput
              id="budget-enforcement"
              value={enforcement}
              onChange={event => setEnforcement(event.target.value as 'block' | 'warn')}
              disabled={saving}
            >
              <option value="warn">Warn (observation only)</option>
              <option value="block">Block (deny over limit)</option>
            </SelectInput>
          </Field>
        </div>
        <CheckboxField
          label="Enabled"
          description="Disabled budgets are ignored when computing spend and checks."
          checked={enabled}
          onChange={event => setEnabled(event.target.checked)}
          disabled={saving}
        />
      </FormSection>

      <FormSection
        title="Scope"
        description="Limit this budget to specific dimensions. Leave everything empty for a global budget. Dimensions are ANDed; values within one are ORed."
      >
        <ScopeSelector
          dimensions={dimensions}
          value={scope}
          onChange={setScope}
          disabled={saving}
          valueLabels={valueLabels}
        />
      </FormSection>

      {unpricedModelsError && unpricedModelsError.length > 0 ? (
        <div className="cu-banner cu-banner--error" role="alert">
          Can&apos;t save this cost budget: <strong>{unpricedModelsError.length}</strong> pinned
          model
          {unpricedModelsError.length === 1 ? '' : 's'} have no active price
          {' ('}
          {unpricedModelsError
            .map(m => (m.provider ? `${m.provider}/${m.model}` : m.model))
            .join(', ')}
          {'). '}
          <Link href={CONTROL_ROUTES.costAndUsage.llmPrices} className="cu-link">
            Add prices
          </Link>{' '}
          first, then save.
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
          {saving ? 'Saving…' : mode === 'create' ? 'Create budget' : 'Save budget'}
        </Button>
      </div>
    </form>
  )
}

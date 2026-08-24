'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { LlmPolicyEditor } from '@/components/LlmPolicyEditor'
import { LlmProviderIcon } from '@/components/LlmProviderIcon'
import { SelectionDropdown } from '@/components/SelectionDropdown'
import type { SelectionDropdownOption } from '@/components/SelectionDropdown/types'
import { IconChevronRight } from '@/components/icons'
import { Button, Field, TextAreaInput, TextInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  LLM_PROVIDER_OPTIONS,
  type LlmCredentialField,
  type LlmCredentialGroup,
  type LlmProvider,
  OPENAI_SUBSCRIPTION_PROVIDER,
  OPERATOR_PROVIDER_OPTIONS,
  allowedModelsForProvider,
  constrainModelOptions,
  describeLlmCompleteness,
  getLlmCredentialGroup,
  getModelOptions,
  getProviderLabel,
  getProviderSlotKeys,
  isOpenAiFamily,
  isProviderAllowUnrestricted,
  mintFallbackSlot,
  normalizeProvider,
  providerSupportsFallbackCredentialSlot,
  resolveCodexGrantModel,
  resolveDefaultModel,
  validateLlmSecretData,
} from '@/lib/llm'
import type { LlmCredentialWiring, LlmProviderConfigProps } from './types'

// Where the non-secret per-Host env vars (VERTEX_PROJECT_ID/-LOCATION,
// AWS_REGION, AZURE_OPENAI_ENDPOINT) are configured — the credential block only
// links to it, it never duplicates that editor (spec R4.5.4).
const HOST_ENV_HREF = CONTROL_ROUTES.agents.root

// A synthetic slot definition for a fallback's chosen extra credentialSlot when
// that key is NOT one of the provider's canonical registry slots (e.g.
// `claude-api-key-fb1`). Extra slots are always a single api-key-style value.
function syntheticSlot(provider: LlmProvider, dataKey: string): LlmCredentialField {
  const canonical = getLlmCredentialGroup(provider).slots.find(slot => slot.dataKey === dataKey)
  if (canonical) return canonical
  return {
    dataKey,
    envName: '',
    required: true,
    label: `${getProviderLabel(provider)} API key`,
    placeholder: '',
    multiline: false,
  }
}

// The effective credential slots a fallback entry writes to: its chosen extra
// slot when set, otherwise the provider's canonical registry slots (shared with
// the primary when it is the same provider).
function fallbackEffectiveSlots(
  provider: LlmProvider,
  credentialSlot: string | undefined
): LlmCredentialField[] {
  if (credentialSlot) return [syntheticSlot(provider, credentialSlot)]
  return getLlmCredentialGroup(provider).slots
}

/**
 * The single Host LLM configuration surface (spec Topic 1b, jury design C —
 * "model like A, render like C"). Credentials are a PROJECTION of the provider
 * domain: it renders provider blocks ONLY for `{primary} ∪ {each fallback}`, as
 * a progressive flow, instead of a wall of all 22 provider groups.
 *
 *   1. Primary provider block — provider + model + its credential field(s). The
 *      asymmetric save gate (see `isPrimaryUsable`) blocks create/save until the
 *      primary is usable.
 *   2. Fallback policy — reuses LlmPolicyEditor (starts at ZERO rows so optional
 *      is unmistakable; cooldown + trigger classes; credentialSlot dropdown).
 *   3. Fallback credentials — one block per fallback, keyed to that fallback's
 *      effective slot. A same-provider fallback reuses the primary key until the
 *      operator asks for a separate slot. A missing fallback key WARNS inline
 *      ("won't run until you add its key") but never blocks — optional means
 *      optional.
 *
 * Controlled: the parent owns spec.model, spec.llmPolicy and the write-only
 * credential draft so it can assemble the create/edit payloads.
 */
export function LlmProviderConfig({
  provider,
  model,
  onPrimaryChange,
  policy,
  onPolicyChange,
  allowedModels,
  onAllowedModelsChange,
  catalog,
  catalogLoading = false,
  catalogError,
  modelLabel = 'Model',
  showAllowedModels = true,
  replacePrimaryModelWithAllowedModels = false,
  credentials,
  secretKeys = [],
  fallbackProvidersInitiallyCollapsed = false,
  disabled = false,
  subscriptionCredentialEnabled = false,
  afterPrimaryProvider,
}: LlmProviderConfigProps) {
  const [fallbackProvidersOpen, setFallbackProvidersOpen] = useState(
    !fallbackProvidersInitiallyCollapsed
  )
  const fallbacks = policy?.fallbacks ?? []
  const existingKeySet = useMemo(
    () => new Set(credentials?.existingKeys ?? []),
    [credentials?.existingKeys]
  )
  const draft = credentials?.draft ?? {}

  const present = (dataKey: string): boolean =>
    (draft[dataKey] ?? '').trim().length > 0 || existingKeySet.has(dataKey)

  // Primary model options are constrained to the host's per-provider subset when
  // the operator restricted this provider (Topic 3a); otherwise the full enabled
  // global allowlist. A saved model outside the subset stays selectable below.
  const primaryModelOptions = useMemo(
    () => constrainModelOptions(catalog, allowedModels, provider),
    [catalog, allowedModels, provider]
  )
  const primaryModelOutOfAllowlist = Boolean(model) && !primaryModelOptions.includes(model)
  const pickerOptions = subscriptionCredentialEnabled
    ? OPERATOR_PROVIDER_OPTIONS
    : LLM_PROVIDER_OPTIONS
  const primaryProviderOptions = useMemo(
    () =>
      pickerOptions.map(option => ({
        ...option,
        icon: <LlmProviderIcon provider={option.value} label={option.label} />,
      })),
    [pickerOptions]
  )
  const providerPickerValue = isOpenAiFamily(provider) ? 'openai' : provider
  const primaryModelSelectOptions = useMemo(() => {
    const options: SelectionDropdownOption[] = primaryModelOptions.map(option => ({
      value: option,
      label: option,
      icon: <LlmProviderIcon provider={provider} label={getProviderLabel(provider)} />,
    }))
    if (primaryModelOutOfAllowlist) {
      const saved = catalog.find(entry => entry.provider === provider && entry.model === model)
      options.push({
        value: model,
        label: model,
        icon: <LlmProviderIcon provider={provider} label={getProviderLabel(provider)} />,
        badge: saved?.stale ? 'stale' : saved && !saved.enabled ? 'disabled' : 'out of allowlist',
      })
    }
    return options
  }, [catalog, model, primaryModelOptions, primaryModelOutOfAllowlist, provider])

  // Replace every entry for one provider with the operator's new selection,
  // leaving the other providers' subsets untouched. Selecting none removes the
  // provider's entries → back to "All models" (unrestricted) for it.
  function handleProviderAllowedChange(providerId: string, models: string[]) {
    const others = allowedModels.filter(entry => entry.provider !== providerId)
    const additions = models.map(nextModel => ({ provider: providerId, model: nextModel }))
    onAllowedModelsChange([...others, ...additions])
    if (
      replacePrimaryModelWithAllowedModels &&
      providerId === provider &&
      models.length > 0 &&
      !models.includes(model)
    ) {
      onPrimaryChange({ provider, model: models[0] })
    }
  }

  // The distinct fallback providers whose subset is NOT already curated by the
  // primary block (i.e. a fallback on a different provider). Each gets its own
  // "Allowed models" control so the subset can be set per provider across the
  // whole host domain, without duplicating the primary provider's control.
  const fallbackAllowedProviders = useMemo(() => {
    const seen = new Set<string>([provider])
    const out: LlmProvider[] = []
    for (const entry of fallbacks) {
      if (seen.has(entry.provider)) continue
      seen.add(entry.provider)
      out.push(entry.provider)
    }
    return out
  }, [fallbacks, provider])

  // Providers whose canonical slot is already claimed by an earlier block
  // (primary first, then each default-slot fallback), so a later same-provider
  // fallback knows it must mint a separate slot instead of sharing the key.
  function claimedDefaultBefore(index: number): Set<LlmProvider> {
    const claimed = new Set<LlmProvider>([provider])
    for (let i = 0; i < index; i += 1) {
      const entry = fallbacks[i]
      if (entry && !entry.credentialSlot) claimed.add(entry.provider)
    }
    return claimed
  }

  // Every credential key already spoken for — used when minting a fresh fallback
  // slot so it can never collide with the primary, another fallback, or a stored
  // Secret key.
  const claimedKeys = useMemo(() => {
    const keys = new Set<string>(secretKeys)
    for (const key of getProviderSlotKeys(provider)) keys.add(key)
    for (const entry of fallbacks) {
      for (const slot of fallbackEffectiveSlots(entry.provider, entry.credentialSlot)) {
        keys.add(slot.dataKey)
      }
    }
    for (const key of Object.keys(draft)) {
      if ((draft[key] ?? '').trim().length > 0) keys.add(key)
    }
    return keys
  }, [secretKeys, provider, fallbacks, draft])

  function useSeparateSlot(index: number) {
    const entry = fallbacks[index]
    if (!entry) return
    const nextSlot = mintFallbackSlot(entry.provider, claimedKeys)
    onPolicyChange({
      cooldownSeconds: policy?.cooldownSeconds,
      triggerOn: policy?.triggerOn,
      fallbacks: fallbacks.map((item, i) =>
        i === index ? { ...item, credentialSlot: nextSlot } : item
      ),
    })
  }

  const primaryGroup = getLlmCredentialGroup(provider)

  return (
    <section className="cu-llm-config" aria-label="LLM configuration">
      <div className="cu-llm-config__block cu-llm-config__block--primary">
        <div className="cu-llm-config__block-head">
          <span className="cu-llm-config__block-title">Primary provider</span>
          <span className="cu-llm-config__block-tag">Required</span>
        </div>

        <div className="cu-llm-config__model-row">
          <Field htmlFor="llm-primary-provider" label="Provider">
            <SelectionDropdown
              id="llm-primary-provider"
              className="cu-llm-config__primary-select cu-llm-config__provider-select"
              value={[providerPickerValue]}
              options={primaryProviderOptions}
              placeholder="Select provider…"
              searchPlaceholder="Search providers…"
              selectionLabel="provider"
              multiple={false}
              showSelectedChips={false}
              disabled={disabled}
              onChange={next => {
                const nextProviderValue = next[0]
                if (!nextProviderValue) return
                const nextProvider = normalizeProvider(nextProviderValue)
                const resolved =
                  nextProvider === 'openai' && provider === OPENAI_SUBSCRIPTION_PROVIDER
                    ? OPENAI_SUBSCRIPTION_PROVIDER
                    : nextProvider
                onPrimaryChange({
                  provider: resolved,
                  model: resolveDefaultModel(
                    resolved,
                    constrainModelOptions(catalog, allowedModels, resolved)
                  ),
                })
              }}
            />
          </Field>
          {subscriptionCredentialEnabled && isOpenAiFamily(provider) ? (
            <fieldset
              className="cu-field cu-llm-config__credential-kind"
              data-testid="openai-credential-kind"
            >
              <legend className="cu-field__label">OpenAI credential</legend>
              <div
                className="cu-agent-radio-group"
                role="radiogroup"
                aria-label="OpenAI credential"
              >
                <label className="cu-agent-radio">
                  <input
                    type="radio"
                    name="openai-credential-kind"
                    checked={provider === 'openai'}
                    disabled={disabled}
                    onChange={() =>
                      onPrimaryChange({
                        provider: 'openai',
                        model: resolveDefaultModel(
                          'openai',
                          constrainModelOptions(catalog, allowedModels, 'openai')
                        ),
                      })
                    }
                  />
                  API key
                </label>
                <label className="cu-agent-radio">
                  <input
                    type="radio"
                    name="openai-credential-kind"
                    checked={provider === OPENAI_SUBSCRIPTION_PROVIDER}
                    disabled={disabled}
                    onChange={() =>
                      onPrimaryChange({
                        provider: OPENAI_SUBSCRIPTION_PROVIDER,
                        model: resolveCodexGrantModel(
                          model,
                          constrainModelOptions(
                            catalog,
                            allowedModels,
                            OPENAI_SUBSCRIPTION_PROVIDER
                          )
                        ),
                      })
                    }
                  />
                  ChatGPT subscription
                </label>
              </div>
            </fieldset>
          ) : null}
          {afterPrimaryProvider ? (
            <div className="cu-llm-config__after-provider">{afterPrimaryProvider}</div>
          ) : null}

          {replacePrimaryModelWithAllowedModels && showAllowedModels ? (
            <AllowedModelsField
              provider={provider}
              catalog={catalog}
              allowedModels={allowedModels}
              onChange={handleProviderAllowedChange}
              disabled={disabled}
            />
          ) : (
            <Field htmlFor="llm-primary-model" label={modelLabel}>
              <SelectionDropdown
                id="llm-primary-model"
                className="cu-llm-config__primary-select"
                value={model ? [model] : []}
                options={primaryModelSelectOptions}
                placeholder={
                  primaryModelOptions.length === 0 ? 'No enabled models' : 'Select model…'
                }
                searchPlaceholder="Search models…"
                selectionLabel="model"
                multiple={false}
                showSelectedChips={false}
                disabled={disabled}
                invalid={primaryModelOutOfAllowlist}
                onChange={next => {
                  const nextModel = next[0]
                  if (!nextModel) return
                  onPrimaryChange({ provider, model: nextModel })
                }}
              />
            </Field>
          )}
        </div>

        {catalogError ? (
          <p className="cu-field__error">Couldn&apos;t load the model allowlist: {catalogError}</p>
        ) : !catalogLoading && primaryModelOptions.length === 0 ? (
          <p className="cu-field__error">
            {provider === OPENAI_SUBSCRIPTION_PROVIDER
              ? 'No enabled models for this subscription. Connect and sync the grant first.'
              : 'No enabled models for this provider. Add one under LLM Models first.'}
          </p>
        ) : null}

        {primaryModelOutOfAllowlist && !replacePrimaryModelWithAllowedModels ? (
          <p className="cu-llm-config__warn">
            {model} isn&apos;t in the models offered for {getProviderLabel(provider)} — end users
            won&apos;t be offered it. Pick a model from the list, or add it under Allowed models
            below.
          </p>
        ) : null}

        {showAllowedModels && !replacePrimaryModelWithAllowedModels ? (
          <AllowedModelsField
            provider={provider}
            catalog={catalog}
            allowedModels={allowedModels}
            onChange={handleProviderAllowedChange}
            disabled={disabled}
          />
        ) : null}

        {credentials ? (
          <ProviderCredentialBlock
            variant="primary"
            group={primaryGroup}
            slots={primaryGroup.slots}
            idPrefix="llm-primary"
            wiring={credentials}
            present={present}
            disabled={disabled}
          />
        ) : null}
      </div>

      <div className="cu-llm-config__block">
        <button
          type="button"
          className="cu-llm-config__block-head cu-llm-config__block-toggle"
          onClick={() => setFallbackProvidersOpen(open => !open)}
          aria-expanded={fallbackProvidersOpen}
          aria-controls="llm-fallback-providers"
        >
          <span className="cu-llm-config__block-toggle-title">
            <IconChevronRight
              className={fallbackProvidersOpen ? 'is-expanded' : undefined}
              width={18}
              height={18}
            />
            <span className="cu-llm-config__block-title">Fallback providers</span>
          </span>
          <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">Optional</span>
        </button>
        {fallbackProvidersOpen ? (
          <div id="llm-fallback-providers">
            <LlmPolicyEditor
              value={policy}
              onChange={onPolicyChange}
              catalog={catalog}
              allowedModels={allowedModels}
              secretKeys={secretKeys}
              defaultProvider={provider}
              disabled={disabled}
            />
          </div>
        ) : null}
      </div>

      {showAllowedModels && fallbackAllowedProviders.length > 0 ? (
        <div className="cu-llm-config__block">
          <div className="cu-llm-config__block-head">
            <span className="cu-llm-config__block-title">Allowed models · fallback providers</span>
            <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">
              Optional
            </span>
          </div>
          <p className="cu-field__hint cu-llm-config__allowed-intro">
            Restrict which models each fallback provider offers. Leave a provider on “All models” to
            offer its full allowlist.
          </p>
          {fallbackAllowedProviders.map(fallbackProvider => (
            <AllowedModelsField
              key={fallbackProvider}
              provider={fallbackProvider}
              catalog={catalog}
              allowedModels={allowedModels}
              onChange={handleProviderAllowedChange}
              disabled={disabled}
            />
          ))}
        </div>
      ) : null}

      {credentials && fallbacks.length > 0 ? (
        <div className="cu-llm-config__block">
          <div className="cu-llm-config__block-head">
            <span className="cu-llm-config__block-title">Fallback credentials</span>
          </div>
          <p className="cu-field__hint" style={{ margin: 0 }}>
            A fallback with no usable key is skipped at runtime — it does not block saving.
          </p>
          <div className="cu-llm-config__fallback-creds">
            {fallbacks.map((entry, index) => {
              const label = `Fallback #${index + 1} · ${getProviderLabel(entry.provider)}`
              const sharesPrimaryKey =
                !entry.credentialSlot && claimedDefaultBefore(index).has(entry.provider)
              if (sharesPrimaryKey) {
                // A separate extra slot is a single api-key-style dataKey, so it
                // only makes sense for single, single-line key providers. Bedrock
                // (key pair) and Vertex (JSON) can't be expressed as one extra
                // slot, so those same-provider fallbacks reuse the primary
                // credentials rather than mint a slot that could never authenticate.
                // Shared with the backend gate via providerSupportsFallbackCredentialSlot.
                const canSeparate = providerSupportsFallbackCredentialSlot(entry.provider)
                return (
                  <div className="cu-llm-config__reuse" key={`fb-cred-${index}`}>
                    <span className="cu-muted">
                      {label} reuses the {getProviderLabel(entry.provider)} credentials above.
                    </span>
                    {canSeparate ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => useSeparateSlot(index)}
                      >
                        Use a separate key
                      </Button>
                    ) : null}
                  </div>
                )
              }
              const slots = fallbackEffectiveSlots(entry.provider, entry.credentialSlot)
              const group: LlmCredentialGroup = {
                provider: entry.provider,
                label,
                slots,
                nonSecretEnv: getLlmCredentialGroup(entry.provider).nonSecretEnv,
              }
              return (
                <ProviderCredentialBlock
                  key={`fb-cred-${index}`}
                  variant="fallback"
                  group={group}
                  slots={slots}
                  idPrefix={`llm-fallback-cred-${index}`}
                  wiring={credentials}
                  present={present}
                  disabled={disabled}
                />
              )
            })}
          </div>
        </div>
      ) : null}
    </section>
  )
}

type AllowedModelsFieldProps = {
  provider: LlmProvider
  catalog: LlmProviderConfigProps['catalog']
  allowedModels: LlmProviderConfigProps['allowedModels']
  onChange: (provider: string, models: string[]) => void
  disabled: boolean
}

// One provider's "Allowed models" multi-select (spec Topic 3a). Sourced from the
// GLOBAL operator allowlist for THIS provider (enabled models only), plus any
// already-selected model that has since left the global allowlist so it stays
// removable (badged). An empty selection is the "All models" (unrestricted)
// default — the host offers every enabled model for this provider, matching
// today's behavior. Selecting every enabled model is treated the same as
// unrestricted (the parent omits it from the spec).
function AllowedModelsField({
  provider,
  catalog,
  allowedModels,
  onChange,
  disabled,
}: AllowedModelsFieldProps) {
  const enabledGlobal = useMemo(() => getModelOptions(catalog, provider), [catalog, provider])
  const selected = useMemo(
    () => allowedModelsForProvider(allowedModels, provider),
    [allowedModels, provider]
  )
  const options = useMemo(() => {
    const seen = new Set<string>()
    const values: string[] = []
    for (const value of [...enabledGlobal, ...selected]) {
      if (seen.has(value)) continue
      seen.add(value)
      values.push(value)
    }
    return values.map(value => ({
      value,
      label: value,
      badge: enabledGlobal.includes(value) ? undefined : 'not in allowlist',
    }))
  }, [enabledGlobal, selected])
  const unrestricted = isProviderAllowUnrestricted(selected, enabledGlobal)
  const providerLabel = getProviderLabel(provider)
  const fieldId = `llm-allowed-${provider}`

  return (
    <Field htmlFor={fieldId} label={`Allowed models · ${providerLabel}`}>
      <SelectionDropdown
        id={fieldId}
        options={options}
        value={selected}
        onChange={next => onChange(provider, next)}
        placeholder="All models — offering every enabled model"
        searchPlaceholder="Search models…"
        selectionLabel="models"
        emptyLabel={
          enabledGlobal.length === 0
            ? 'No enabled models for this provider.'
            : 'No models match your search.'
        }
        disabled={disabled}
      />
      {unrestricted ? (
        <span className="cu-field__hint">
          {selected.length === 0
            ? `All models — this host offers every enabled ${providerLabel} model. End users pick one per chat. Leave as-is to keep today's behavior.`
            : `All models — every enabled ${providerLabel} model is selected, so this host stays unrestricted (no subset is saved).`}
        </span>
      ) : (
        <span className="cu-field__hint">
          Restricted — this host offers only the {selected.length} selected {providerLabel} model
          {selected.length === 1 ? '' : 's'}; end users can pick only from these.
        </span>
      )}
    </Field>
  )
}

type ProviderCredentialBlockProps = {
  variant: 'primary' | 'fallback'
  group: LlmCredentialGroup
  slots: LlmCredentialField[]
  idPrefix: string
  wiring: LlmCredentialWiring
  present: (dataKey: string) => boolean
  disabled: boolean
}

// One provider's credential block: the usable/partial/absent chip, its slot
// field(s), the non-secret env note (Azure/Vertex/Bedrock → Host → Environment),
// cross-slot validation (Bedrock-both, Vertex-JSON), and a usable warning. The
// PRIMARY block's warning is a hard requirement (the parent gate blocks); a
// FALLBACK block's warning is advisory (never blocks).
function ProviderCredentialBlock({
  variant,
  group,
  slots,
  idPrefix,
  wiring,
  present,
  disabled,
}: ProviderCredentialBlockProps) {
  const chip = describeLlmCompleteness(group, present)
  const providerLabel = getProviderLabel(group.provider)
  const blockValues = useMemo(() => {
    const values: Record<string, string> = {}
    for (const slot of slots) values[slot.dataKey] = wiring.draft[slot.dataKey] ?? ''
    return values
  }, [slots, wiring.draft])
  const validationError = validateLlmSecretData(blockValues)[0]
  const usable = chip.state === 'present'

  return (
    <section className="cu-llm-cred-group" aria-label={`${group.label} credentials`}>
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

      {slots.map(slot => {
        const inputId = `${idPrefix}-${slot.dataKey}`
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
                value={wiring.draft[slot.dataKey] ?? ''}
                onChange={event => wiring.onChange(slot.dataKey, event.target.value)}
                placeholder={slotPresent ? 'Stored — leave blank to keep' : slot.placeholder}
                autoComplete="off"
                disabled={disabled}
              />
            ) : (
              <TextInput
                id={inputId}
                type="password"
                autoComplete="off"
                value={wiring.draft[slot.dataKey] ?? ''}
                onChange={event => wiring.onChange(slot.dataKey, event.target.value)}
                placeholder={slotPresent ? 'Stored — leave blank to keep' : slot.placeholder}
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

      {validationError ? <p className="cu-field__error">{validationError}</p> : null}

      {!usable && !validationError ? (
        variant === 'primary' ? (
          <p className="cu-field__error">
            Add the {providerLabel} credential so this agent can call its primary model.
          </p>
        ) : (
          <p className="cu-llm-config__warn">
            This fallback won&apos;t run until you add its {providerLabel} key.
          </p>
        )
      ) : null}
    </section>
  )
}

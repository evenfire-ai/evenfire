import { LlmProviderIcon } from '@/components/LlmProviderIcon'
import {
  type HostAllowedModel,
  type LlmPolicy,
  type LlmProvider,
  allowedModelsForProvider,
  getProviderLabel,
} from '@/lib/llm'

export type LlmProviderSummaryProps = {
  provider: LlmProvider
  model: string
  allowedModels: HostAllowedModel[]
  policy?: LlmPolicy
}

function ModelChips({ models, allModelsLabel }: { models: string[]; allModelsLabel: string }) {
  return (
    <div
      className="cu-llm-summary__models"
      aria-label={models.length > 0 ? 'Allowed models' : allModelsLabel}
    >
      {models.length > 0 ? (
        models.map(model => (
          <span key={model} className="cu-llm-summary__model-chip">
            {model}
          </span>
        ))
      ) : (
        <span className="cu-llm-summary__all-models">{allModelsLabel}</span>
      )}
    </div>
  )
}

export function LlmProviderSummary({
  provider,
  model,
  allowedModels,
  policy,
}: LlmProviderSummaryProps) {
  const providerLabel = getProviderLabel(provider)
  const primaryAllowedModels = allowedModelsForProvider(allowedModels, provider)
  const fallbacks = policy?.fallbacks ?? []

  return (
    <div className="cu-llm-summary" role="region" aria-label="LLM configuration summary">
      <section className="cu-llm-config__block cu-llm-config__block--primary">
        <div className="cu-llm-config__block-head">
          <span className="cu-llm-config__block-title">Primary provider</span>
          <span className="cu-llm-config__block-tag">Required</span>
        </div>

        <div className="cu-llm-config__model-row">
          <div className="cu-llm-summary__field">
            <span className="cu-llm-summary__label">Provider</span>
            <div className="cu-llm-summary__value">
              <LlmProviderIcon provider={provider} label={providerLabel} />
              <span>{providerLabel}</span>
            </div>
          </div>

          <div className="cu-llm-summary__field">
            <span className="cu-llm-summary__label">Current model</span>
            <div className="cu-llm-summary__value">
              <LlmProviderIcon provider={provider} label={providerLabel} />
              <span>{model || 'No model configured'}</span>
            </div>
          </div>
        </div>

        <div className="cu-llm-summary__field">
          <span className="cu-llm-summary__label">Allowed models · {providerLabel}</span>
          <ModelChips models={primaryAllowedModels} allModelsLabel="All enabled models" />
          <span className="cu-field__hint">
            {primaryAllowedModels.length > 0
              ? `This agent offers only the ${primaryAllowedModels.length} selected ${providerLabel} model${primaryAllowedModels.length === 1 ? '' : 's'}; end users can pick from these per chat.`
              : `This agent offers every enabled ${providerLabel} model; end users can pick one per chat.`}
          </span>
        </div>
      </section>

      <section className="cu-llm-config__block" aria-labelledby="llm-summary-fallback-title">
        <div className="cu-llm-config__block-head">
          <span id="llm-summary-fallback-title" className="cu-llm-config__block-title">
            Fallback providers
          </span>
          <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">Optional</span>
        </div>

        {fallbacks.length > 0 ? (
          <ol className="cu-llm-summary__fallback-list">
            {fallbacks.map((fallback, index) => {
              const fallbackLabel = getProviderLabel(fallback.provider)
              const fallbackAllowedModels = allowedModelsForProvider(
                allowedModels,
                fallback.provider
              )

              return (
                <li
                  key={`${fallback.provider}-${fallback.model}-${index}`}
                  className="cu-llm-summary__fallback"
                >
                  <div className="cu-llm-summary__fallback-head">
                    <span className="cu-llm-summary__fallback-order">Fallback #{index + 1}</span>
                    {fallback.credentialSlot ? (
                      <span className="cu-llm-summary__credential-slot">
                        Credential slot: {fallback.credentialSlot}
                      </span>
                    ) : null}
                  </div>
                  <div className="cu-llm-summary__fallback-provider">
                    <LlmProviderIcon provider={fallback.provider} label={fallbackLabel} />
                    <strong>{fallbackLabel}</strong>
                    <span className="cu-llm-summary__separator">·</span>
                    <span>{fallback.model || 'No model configured'}</span>
                  </div>
                  {fallbackAllowedModels.length > 0 ? (
                    <div className="cu-llm-summary__fallback-allowed">
                      <span className="cu-llm-summary__label">
                        Allowed models · {fallbackLabel}
                      </span>
                      <ModelChips
                        models={fallbackAllowedModels}
                        allModelsLabel="All enabled models"
                      />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : (
          <div className="cu-llm-summary__empty">No fallback configured.</div>
        )}
      </section>
    </div>
  )
}

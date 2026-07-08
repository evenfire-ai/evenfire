export type LlmProvider = 'openai' | 'claude' | 'zai' | 'bailian'

export const LLM_PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Anthropic' },
  { value: 'zai', label: 'Z.AI' },
  { value: 'bailian', label: 'Bailian' },
]

export const LLM_MODELS_BY_PROVIDER: Record<LlmProvider, string[]> = {
  openai: [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
  ],
  claude: [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-5',
  ],
  zai: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7'],
  bailian: [
    'qwen3-coder-plus',
    'qwen3.5-plus',
    'qwen3-coder-next',
    'qwen3-max-2026-01-23',
    'MiniMax-M2.5',
    'glm-5.1',
    'glm-5',
    'glm-4.7',
    'kimi-k2.5',
  ],
}

// Wizard pre-select / fallback default per provider. Kept separate from
// LLM_MODELS_BY_PROVIDER so the dropdown stays "newest first" while the
// default lands on the cost-effective tier and matches each provider's
// `defaultModel` in mcp-host/src/llm/registryCore.ts (PROVIDERS).
export const LLM_DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  openai: 'gpt-5.4-mini',
  claude: 'claude-sonnet-4-6',
  zai: 'glm-5.1',
  bailian: 'qwen3-coder-plus',
}

export const LLM_SECRET_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'openai-api-key', label: 'OpenAI API key', placeholder: 'sk-...' },
  { key: 'claude-api-key', label: 'Claude API key', placeholder: 'sk-ant-...' },
  { key: 'zai-api-key', label: 'Z.AI API key', placeholder: 'zai-...' },
  { key: 'bailian-api-key', label: 'Bailian API key', placeholder: 'bailian-...' },
]

export function normalizeProvider(value: string | undefined | null): LlmProvider {
  if (value === 'openai' || value === 'claude' || value === 'zai' || value === 'bailian')
    return value
  return 'openai'
}

export function getProviderLabel(provider: string | undefined | null): string {
  const normalized = normalizeProvider(provider)
  const match = LLM_PROVIDER_OPTIONS.find(option => option.value === normalized)
  return match?.label || 'OpenAI'
}

// True when `provider` is one of the recognized LlmProvider values.
export function isKnownProvider(provider: string | undefined | null): boolean {
  return LLM_PROVIDER_OPTIONS.some(option => option.value === provider)
}

// Friendly label for a known provider, otherwise the value verbatim. Unlike
// getProviderLabel (which falls back to "OpenAI"), this never mislabels an
// unrecognized provider — important where free-form providers surface, e.g.
// the LLM-prices table and the unpriced-model chips.
export function getProviderDisplayLabel(provider: string): string {
  return isKnownProvider(provider) ? getProviderLabel(provider) : provider
}

export function getModelOptions(provider: LlmProvider): string[] {
  return LLM_MODELS_BY_PROVIDER[provider]
}

export function getDefaultModel(provider: LlmProvider): string {
  const explicit = LLM_DEFAULT_MODEL_BY_PROVIDER[provider]
  const options = getModelOptions(provider)
  if (explicit && options.includes(explicit)) return explicit
  return options[0] || ''
}

// A grant stores model names but not the provider. Recover the provider from
// the first recognized model so a model picklist can be filtered to the single
// provider bound to the recipe's mcp-host. Defaults to the first provider when
// no model matches (e.g. an empty allowlist).
export function inferProviderFromModels(models: string[]): LlmProvider {
  for (const model of models) {
    const match = (Object.keys(LLM_MODELS_BY_PROVIDER) as LlmProvider[]).find(provider =>
      LLM_MODELS_BY_PROVIDER[provider].includes(model)
    )
    if (match) return match
  }
  return LLM_PROVIDER_OPTIONS[0].value
}

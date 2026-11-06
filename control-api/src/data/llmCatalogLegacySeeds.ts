/**
 * What the retired catalog-seed migrations wrote, kept as data. FROZEN HISTORY,
 * never edit: installations that applied those migrations before they became
 * no-ops hold these rows (unless an operator changed or deleted them).
 * Migration `0135_llm_retire_seeded_catalog` reclassifies the allowlist pairs
 * (via SEEDED_ALLOWED_MODELS_LISTED_BY_CATALOG) and leaves the prices in place;
 * the tests rebuild an upgraded installation from this data.
 *
 * - `LEGACY_SEEDED_ALLOWED_MODELS`: the `(provider, model, vendor)` tuples that
 *   0056, 0057, 0058 and 0100 inserted into `llm_allowed_models`, every other
 *   column left to its DEFAULT (`enabled=true`, `source='manual'`).
 * - `LEGACY_SEEDED_MODEL_PRICES`: the placeholder prices 0044 inserted into
 *   `llm_model_prices` (USD per 1M tokens, every other column left to its
 *   DEFAULT). Values are the NUMERIC literals, as strings, so nothing goes
 *   through a float.
 */

export interface LegacySeededAllowedModel {
  migration:
    | '0056_llm_allowed_models'
    | '0057_llm_allowed_models_vertex_bedrock'
    | '0058_llm_allowed_models_new_providers'
    | '0100_seed_minimax_allowed_model'
  provider: string
  model: string
  vendor: string
}

export const LEGACY_SEEDED_ALLOWED_MODELS: readonly LegacySeededAllowedModel[] = [
  { migration: '0056_llm_allowed_models', provider: 'openai', model: 'gpt-5.5', vendor: 'OpenAI' },
  { migration: '0056_llm_allowed_models', provider: 'openai', model: 'gpt-5.4', vendor: 'OpenAI' },
  {
    migration: '0056_llm_allowed_models',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    vendor: 'OpenAI',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'openai',
    model: 'gpt-5.4-nano',
    vendor: 'OpenAI',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'openai',
    model: 'gpt-5.1-codex',
    vendor: 'OpenAI',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'openai',
    model: 'gpt-5.1-codex-mini',
    vendor: 'OpenAI',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'claude',
    model: 'claude-opus-4-7',
    vendor: 'Anthropic',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    vendor: 'Anthropic',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'claude',
    model: 'claude-haiku-4-5',
    vendor: 'Anthropic',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'claude',
    model: 'claude-opus-4-6',
    vendor: 'Anthropic',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    vendor: 'Anthropic',
  },
  { migration: '0056_llm_allowed_models', provider: 'zai', model: 'glm-5.2', vendor: 'Zhipu' },
  { migration: '0056_llm_allowed_models', provider: 'zai', model: 'glm-5.1', vendor: 'Zhipu' },
  { migration: '0056_llm_allowed_models', provider: 'zai', model: 'glm-5', vendor: 'Zhipu' },
  { migration: '0056_llm_allowed_models', provider: 'zai', model: 'glm-5-turbo', vendor: 'Zhipu' },
  { migration: '0056_llm_allowed_models', provider: 'zai', model: 'glm-4.7', vendor: 'Zhipu' },
  {
    migration: '0056_llm_allowed_models',
    provider: 'bailian',
    model: 'qwen3-coder-plus',
    vendor: 'Alibaba',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'bailian',
    model: 'qwen3.5-plus',
    vendor: 'Alibaba',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'bailian',
    model: 'qwen3-coder-next',
    vendor: 'Alibaba',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'bailian',
    model: 'qwen3-max-2026-01-23',
    vendor: 'Alibaba',
  },
  {
    migration: '0056_llm_allowed_models',
    provider: 'bailian',
    model: 'MiniMax-M2.5',
    vendor: 'MiniMax',
  },
  { migration: '0056_llm_allowed_models', provider: 'bailian', model: 'glm-5.1', vendor: 'Zhipu' },
  { migration: '0056_llm_allowed_models', provider: 'bailian', model: 'glm-5', vendor: 'Zhipu' },
  { migration: '0056_llm_allowed_models', provider: 'bailian', model: 'glm-4.7', vendor: 'Zhipu' },
  {
    migration: '0056_llm_allowed_models',
    provider: 'bailian',
    model: 'kimi-k2.5',
    vendor: 'Moonshot',
  },
  {
    migration: '0057_llm_allowed_models_vertex_bedrock',
    provider: 'vertex',
    model: 'gemini-2.5-pro',
    vendor: 'Google',
  },
  {
    migration: '0057_llm_allowed_models_vertex_bedrock',
    provider: 'vertex',
    model: 'gemini-2.5-flash',
    vendor: 'Google',
  },
  {
    migration: '0057_llm_allowed_models_vertex_bedrock',
    provider: 'bedrock',
    model: 'anthropic.claude-sonnet-4-6-v1:0',
    vendor: 'Anthropic',
  },
  {
    migration: '0057_llm_allowed_models_vertex_bedrock',
    provider: 'bedrock',
    model: 'anthropic.claude-haiku-4-5-v1:0',
    vendor: 'Anthropic',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-latest',
    vendor: 'OpenRouter',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    vendor: 'Google',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    vendor: 'DeepSeek',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    vendor: 'Meta',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'together',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    vendor: 'Meta',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'fireworks',
    model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    vendor: 'Meta',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'mistral',
    model: 'mistral-medium-latest',
    vendor: 'Mistral',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'xai',
    model: 'grok-4.3',
    vendor: 'xAI',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'cerebras',
    model: 'gpt-oss-120b',
    vendor: 'OpenAI',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    vendor: 'DeepSeek',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'perplexity',
    model: 'sonar-pro',
    vendor: 'Perplexity',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'moonshot',
    model: 'kimi-k2.6',
    vendor: 'Moonshot',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'nebius',
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    vendor: 'Alibaba',
  },
  {
    migration: '0058_llm_allowed_models_new_providers',
    provider: 'novita',
    model: 'deepseek/deepseek-v3.2',
    vendor: 'DeepSeek',
  },
  {
    migration: '0100_seed_minimax_allowed_model',
    provider: 'minimax',
    model: 'MiniMax-M2',
    vendor: 'MiniMax',
  },
]

export interface LegacySeededModelPrice {
  provider: string
  model: string
  input_token_price: string
  output_token_price: string
  cache_read_token_price: string
  cache_write_token_price: string
}

export const LEGACY_SEEDED_MODEL_PRICES: readonly LegacySeededModelPrice[] = [
  {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    input_token_price: '0.15',
    output_token_price: '0.60',
    cache_read_token_price: '0.075',
    cache_write_token_price: '0.15',
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    input_token_price: '2.50',
    output_token_price: '10.00',
    cache_read_token_price: '1.25',
    cache_write_token_price: '0',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    input_token_price: '0.15',
    output_token_price: '0.60',
    cache_read_token_price: '0.075',
    cache_write_token_price: '0',
  },
  {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    input_token_price: '3.00',
    output_token_price: '15.00',
    cache_read_token_price: '0.30',
    cache_write_token_price: '3.75',
  },
  {
    provider: 'claude',
    model: 'claude-3-5-sonnet',
    input_token_price: '3.00',
    output_token_price: '15.00',
    cache_read_token_price: '0.30',
    cache_write_token_price: '3.75',
  },
  {
    provider: 'claude',
    model: 'claude-3-5-haiku',
    input_token_price: '0.80',
    output_token_price: '4.00',
    cache_read_token_price: '0.08',
    cache_write_token_price: '1.00',
  },
  {
    provider: 'zai',
    model: 'glm-5.1',
    input_token_price: '0.60',
    output_token_price: '2.20',
    cache_read_token_price: '0.11',
    cache_write_token_price: '0',
  },
  {
    provider: 'bailian',
    model: 'qwen3-coder-plus',
    input_token_price: '1.00',
    output_token_price: '5.00',
    cache_read_token_price: '0.20',
    cache_write_token_price: '0',
  },
]

/**
 * The seeded allowlist pairs (LEGACY_SEEDED_ALLOWED_MODELS) that models.dev
 * lists, matched the way the catalog sync matches them (mapCatalogToProviders)
 * against the live catalog captured on 2026-10-30, frozen as
 * test/fixtures/modelsDevLiveCatalog.2026-10-30.json. A literal, not computed: migration
 * 0135_llm_retire_seeded_catalog must do the same thing in every environment, whatever the catalog says on the day it runs.
 * db.llmRetireSeededCatalogMigration.test.ts recomputes it from that capture.
 */
export const SEEDED_ALLOWED_MODELS_LISTED_BY_CATALOG: readonly (readonly [string, string])[] = [
  ['openai', 'gpt-5.5'],
  ['openai', 'gpt-5.4'],
  ['openai', 'gpt-5.4-mini'],
  ['openai', 'gpt-5.4-nano'],
  ['claude', 'claude-opus-4-7'],
  ['claude', 'claude-sonnet-4-6'],
  ['claude', 'claude-haiku-4-5'],
  ['claude', 'claude-opus-4-6'],
  ['claude', 'claude-sonnet-4-5'],
  ['zai', 'glm-5.2'],
  ['zai', 'glm-5-turbo'],
  ['zai', 'glm-4.7'],
  ['bailian', 'qwen3-coder-plus'],
  ['bailian', 'qwen3.5-plus'],
  ['vertex', 'gemini-2.5-pro'],
  ['vertex', 'gemini-2.5-flash'],
  ['gemini', 'gemini-2.5-flash'],
  ['deepseek', 'deepseek-v4-flash'],
  ['groq', 'llama-3.3-70b-versatile'],
  ['together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  ['mistral', 'mistral-medium-latest'],
  ['xai', 'grok-4.3'],
  ['cerebras', 'gpt-oss-120b'],
  ['deepinfra', 'deepseek-ai/DeepSeek-V3.2'],
  ['perplexity', 'sonar-pro'],
  ['moonshot', 'kimi-k2.6'],
  ['nebius', 'Qwen/Qwen3-235B-A22B-Instruct-2507'],
  ['minimax', 'MiniMax-M2'],
]

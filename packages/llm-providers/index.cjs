'use strict'

/**
 * Shared canonical LLM provider list — the single source of truth for the set
 * of provider ids, their credential slots (mapping the K8s LLM Secret to
 * shell-style env vars), display labels, and non-secret per-Host env.
 *
 * This is a DATA-ONLY leaf. The runtime-only descriptor fields (make/baseURL/
 * defaultModel/tokenizer) stay local to mcp-host's registryCore. Consumers that
 * only need the canonical enum / slots / labels import from here to kill the
 * ~12+ duplicated provider unions across the codebase.
 *
 * Order == mcp-host dev auto-detection priority (first present key wins). The
 * four original providers keep their positions; the own-SDK newcomers (vertex,
 * bedrock) and the OpenAI-compatible additions append at the end so the
 * historical priority is preserved.
 *
 * ADDING A PROVIDER: see docs/llm-providers/adding-a-provider.md. Most providers
 * expose an OpenAI-compatible endpoint and are pure DATA — a slot here + a
 * runtime row (baseURL/defaultModel) in registryCore. Only bespoke wire
 * protocols (claude, vertex, bedrock) or non-vanilla auth (azure: per-resource
 * host + `api-key` header + deployment-name-as-model) need a driver arm.
 */

/** @type {readonly string[]} */
const PROVIDER_IDS = Object.freeze([
  // Original four (OpenAI-compatible openai + own-SDK claude + compat zai/bailian).
  'openai',
  'claude',
  'zai',
  'bailian',
  // Own-SDK newcomers (R4).
  'vertex',
  'bedrock',
  // OpenAI-compatible additions — pure data (baseURL + api-key slot). Order is
  // adoption-priority, but functionally irrelevant (each needs explicit config).
  'openrouter',
  'gemini',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'mistral',
  'xai',
  'cerebras',
  'deepinfra',
  'perplexity',
  'moonshot',
  'nebius',
  'novita',
  // Light-driver (OpenAI-compatible shape, non-vanilla auth/host).
  'azure',
])

/** A single-API-key slot: `<provider>-api-key` → `<PROVIDER>_API_KEY`. */
function apiKeySlot(dataKey, envName) {
  return Object.freeze([Object.freeze({ dataKey, envName, required: true })])
}

/**
 * Credentials each provider loads from the LLM Secret, in priority order (the
 * first is the "primary" slot). Every provider has at least one slot.
 * @type {Record<string, ReadonlyArray<{dataKey: string, envName: string, required: boolean, multiline?: boolean}>>}
 */
const PROVIDER_CREDENTIAL_SLOTS = Object.freeze({
  openai: apiKeySlot('openai-api-key', 'OPENAI_API_KEY'),
  claude: apiKeySlot('claude-api-key', 'CLAUDE_API_KEY'),
  zai: apiKeySlot('zai-api-key', 'ZAI_API_KEY'),
  bailian: apiKeySlot('bailian-api-key', 'BAILIAN_API_KEY'),
  vertex: Object.freeze([
    Object.freeze({
      dataKey: 'vertex-service-account-json',
      envName: 'VERTEX_SERVICE_ACCOUNT_JSON',
      required: true,
      // Multi-line service-account JSON (pasted into a textarea), not a
      // single-line API key. `multiline` is the EXPLICIT source of truth for
      // "this slot is a JSON/multi-line credential" — it replaces the old
      // `-json`/`_JSON` naming heuristic in consumers, and is what makes Vertex
      // ineligible for a per-fallback single-key extra slot.
      multiline: true,
    }),
  ]),
  bedrock: Object.freeze([
    Object.freeze({ dataKey: 'aws-access-key-id', envName: 'AWS_ACCESS_KEY_ID', required: true }),
    Object.freeze({
      dataKey: 'aws-secret-access-key',
      envName: 'AWS_SECRET_ACCESS_KEY',
      required: true,
    }),
  ]),
  // OpenAI-compatible additions — one API key each.
  openrouter: apiKeySlot('openrouter-api-key', 'OPENROUTER_API_KEY'),
  gemini: apiKeySlot('gemini-api-key', 'GEMINI_API_KEY'),
  deepseek: apiKeySlot('deepseek-api-key', 'DEEPSEEK_API_KEY'),
  groq: apiKeySlot('groq-api-key', 'GROQ_API_KEY'),
  together: apiKeySlot('together-api-key', 'TOGETHER_API_KEY'),
  fireworks: apiKeySlot('fireworks-api-key', 'FIREWORKS_API_KEY'),
  mistral: apiKeySlot('mistral-api-key', 'MISTRAL_API_KEY'),
  xai: apiKeySlot('xai-api-key', 'XAI_API_KEY'),
  cerebras: apiKeySlot('cerebras-api-key', 'CEREBRAS_API_KEY'),
  deepinfra: apiKeySlot('deepinfra-api-key', 'DEEPINFRA_API_KEY'),
  perplexity: apiKeySlot('perplexity-api-key', 'PERPLEXITY_API_KEY'),
  moonshot: apiKeySlot('moonshot-api-key', 'MOONSHOT_API_KEY'),
  nebius: apiKeySlot('nebius-api-key', 'NEBIUS_API_KEY'),
  novita: apiKeySlot('novita-api-key', 'NOVITA_API_KEY'),
  // Azure: one API key, sent via the `api-key` header (driver concern, not here).
  azure: apiKeySlot('azure-openai-api-key', 'AZURE_OPENAI_API_KEY'),
})

/**
 * Human-facing label for each provider (creator/runtime brand).
 * @type {Record<string, string>}
 */
const PROVIDER_DISPLAY_LABELS = Object.freeze({
  openai: 'OpenAI',
  claude: 'Anthropic',
  zai: 'Z.AI',
  bailian: 'Bailian',
  vertex: 'Google Vertex AI',
  bedrock: 'Amazon Bedrock',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  mistral: 'Mistral AI',
  xai: 'xAI (Grok)',
  cerebras: 'Cerebras',
  deepinfra: 'DeepInfra',
  perplexity: 'Perplexity',
  moonshot: 'Moonshot (Kimi)',
  nebius: 'Nebius',
  novita: 'Novita AI',
  azure: 'Azure OpenAI',
})

/**
 * Non-secret per-Host env vars a provider needs. These are NOT credential slots
 * (never live in the LLM Secret) — they flow in via the pod's normal env
 * (`host-<ref>-env`, R4.1). Rendered by the UI as a hint, not as a secret field.
 * @type {Record<string, ReadonlyArray<{envName: string, required: boolean}>>}
 */
const PROVIDER_NON_SECRET_ENV = Object.freeze({
  openai: Object.freeze([]),
  claude: Object.freeze([]),
  zai: Object.freeze([]),
  bailian: Object.freeze([]),
  vertex: Object.freeze([
    Object.freeze({ envName: 'VERTEX_PROJECT_ID', required: true }),
    Object.freeze({ envName: 'VERTEX_LOCATION', required: false }),
  ]),
  bedrock: Object.freeze([Object.freeze({ envName: 'AWS_REGION', required: true })]),
  // OpenAI-compatible additions carry no non-secret config (fixed baseURL).
  openrouter: Object.freeze([]),
  gemini: Object.freeze([]),
  deepseek: Object.freeze([]),
  groq: Object.freeze([]),
  together: Object.freeze([]),
  fireworks: Object.freeze([]),
  mistral: Object.freeze([]),
  xai: Object.freeze([]),
  cerebras: Object.freeze([]),
  deepinfra: Object.freeze([]),
  perplexity: Object.freeze([]),
  moonshot: Object.freeze([]),
  nebius: Object.freeze([]),
  novita: Object.freeze([]),
  // Azure has no fixed baseURL: the per-resource endpoint (and optional
  // api-version) are operator-supplied non-secret env. The `model` field is the
  // Azure DEPLOYMENT name, not a catalog id (documented for operators).
  azure: Object.freeze([
    Object.freeze({ envName: 'AZURE_OPENAI_ENDPOINT', required: true }),
    Object.freeze({ envName: 'AZURE_OPENAI_API_VERSION', required: false }),
  ]),
})

// SECURITY: use an own-property check, NOT `in`. `in` walks the prototype chain
// → `'constructor' in {...}` === true, which is exactly the external RPC input
// this guards (workflowService.configure, control-api provider validation).
function isLlmProviderId(s) {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIAL_SLOTS, s)
}

module.exports = {
  PROVIDER_IDS,
  PROVIDER_CREDENTIAL_SLOTS,
  PROVIDER_DISPLAY_LABELS,
  PROVIDER_NON_SECRET_ENV,
  isLlmProviderId,
}

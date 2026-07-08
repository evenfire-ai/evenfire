/**
 * LLM provider registry — DATA-ONLY LEAF.
 *
 * This module holds the provider descriptor DATA, the `LlmProvider` union, and
 * the lightweight guards/lookups (`ALL_PROVIDERS`, `isLlmProvider`,
 * `descriptorFor`). It deliberately imports NOTHING that reaches the provider
 * classes or the tokenizer/prom-client tree.
 *
 * Rationale: `config.ts` (imported extremely early and almost everywhere) only
 * needs the descriptor DATA + guards. Routing those plumbing consumers through
 * this leaf keeps prom-client (pulled in transitively by the provider classes →
 * core/tokenizer) out of config.ts's import graph. The factory layer that
 * actually constructs providers lives in `./registry`.
 *
 * The `LlmProvider` union, the auto-detection order, and the provider factory
 * (in `./registry`) are all derived from `PROVIDERS`. Adding an OpenAI-compatible
 * provider is a single entry here; a divergent provider (e.g. Claude) is one
 * entry here plus its own class wired in `./registry`.
 */

export interface CoreProviderDescriptor {
  /** Canonical id, == getProviderType(). */
  id: string
  /** Lowercase-hyphen key inside the LLM Secret (k8s). */
  dataKey: string
  /** Shell-style env var name. */
  envName: string
  /** Default model when the Host does not specify one. */
  defaultModel: string
  /**
   * Base URL for OpenAI-compatible providers (zai, bailian). Absent for
   * providers that bring their own SDK/client (openai, claude).
   */
  baseURL?: string
  /**
   * Tokenizer hint for providers that do NOT ship createTokenCounter():
   * 'openai' → OpenAITokenCounter; 'fallback' → FallbackTokenCounter(id).
   * 'native' → the provider ships its own counter via createTokenCounter and
   * does not use this hint (Claude).
   */
  tokenizer: 'openai' | 'fallback' | 'native'
}

// Order = dev auto-detection priority (first present key wins).
export const PROVIDERS = {
  openai: {
    id: 'openai',
    dataKey: 'openai-api-key',
    envName: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4-mini',
    tokenizer: 'openai',
  },
  claude: {
    id: 'claude',
    dataKey: 'claude-api-key',
    envName: 'CLAUDE_API_KEY',
    defaultModel: 'claude-sonnet-4-6',
    tokenizer: 'native',
  },
  zai: {
    id: 'zai',
    dataKey: 'zai-api-key',
    envName: 'ZAI_API_KEY',
    defaultModel: 'glm-5.1',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    tokenizer: 'fallback',
  },
  bailian: {
    id: 'bailian',
    dataKey: 'bailian-api-key',
    envName: 'BAILIAN_API_KEY',
    defaultModel: 'qwen3-coder-plus',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    tokenizer: 'fallback',
  },
} as const satisfies Record<string, CoreProviderDescriptor>

export type LlmProvider = keyof typeof PROVIDERS

export const ALL_PROVIDERS = Object.keys(PROVIDERS) as LlmProvider[]

// SECURITY (audit 2026-06-19): use an own-property check, NOT `in`. `in` walks the
// prototype chain → `'constructor' in PROVIDERS` / `'__proto__' in PROVIDERS` === true,
// which is exactly the external RPC input this guards (workflowService.configure).
// With `in`, req.provider='constructor' would pass validation and then blow up in
// descriptorFor/makeProvider.
export const isLlmProvider = (s: string): s is LlmProvider =>
  Object.prototype.hasOwnProperty.call(PROVIDERS, s)

export const descriptorFor = (p: LlmProvider): CoreProviderDescriptor => PROVIDERS[p]

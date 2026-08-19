/**
 * LLM-lane built-in chain (spec §7.2/§7.3).
 *
 * First-party, in-process `pre` rewrite contributors selected + ordered by
 * `Host.spec.guardrails.builtins` (spec §5). Phase 2 (increment 1) ships
 * `prompt-shaping`; `token-trim` (reusing `core/extensions/prePrune.ts`) lands
 * in a later increment. Installed hooks (moderation/PII/`on_error`) are Phase 3.
 */
import type { ToolCompletionRequest } from '../../types'
import { type PromptShapingConfig, applyPromptShaping } from './builtins/promptShaping'
import { type TokenTrimConfig, applyTokenTrim } from './builtins/tokenTrim'

/** One entry of `guardrails.builtins[]` (spec §7.2). */
export interface BuiltinItem {
  type: 'prompt-shaping' | 'token-trim'
  order?: number
  failMode?: 'open' | 'closed'
  timeoutMs?: number
  config?: Record<string, unknown>
}

/** A pure request-shaping function (the composed built-in chain). */
export type RequestShaper = (request: ToolCompletionRequest) => ToolCompletionRequest

const IDENTITY: RequestShaper = r => r

function isBuiltinItem(v: unknown): v is BuiltinItem {
  return !!v && typeof v === 'object' && (v as BuiltinItem).type !== undefined
}

/**
 * Compose the configured built-ins into a single ordered request shaper. Returns
 * an identity shaper when none are configured (no-config compatibility, spec §5).
 * Unknown built-in types are skipped (they are validated at admission in prod).
 */
export function buildLlmBuiltinChain(builtins: unknown[] | undefined): RequestShaper {
  if (!builtins || builtins.length === 0) return IDENTITY

  const items = builtins
    .filter(isBuiltinItem)
    .slice()
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

  const shapers: RequestShaper[] = []
  for (const item of items) {
    if (item.type === 'prompt-shaping') {
      const cfg = (item.config ?? {}) as PromptShapingConfig
      shapers.push(req => applyPromptShaping(req, cfg))
    } else if (item.type === 'token-trim') {
      const cfg = (item.config ?? {}) as TokenTrimConfig
      shapers.push(req => applyTokenTrim(req, cfg))
    }
  }

  if (shapers.length === 0) return IDENTITY
  return request => shapers.reduce((req, shape) => shape(req), request)
}

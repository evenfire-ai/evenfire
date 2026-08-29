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

/**
 * One ordered built-in step, kept individually addressable so the LLM-lane
 * boundary can measure each built-in's effect on the input for the
 * guardrail-input-transparency surface (spec §12.1). `sourceId` is the
 * first-party `builtins[].type`, used as the transparency source id (§4).
 */
export interface BuiltinStep {
  sourceId: 'prompt-shaping' | 'token-trim'
  shape: RequestShaper
}

const IDENTITY: RequestShaper = r => r

function isBuiltinItem(v: unknown): v is BuiltinItem {
  return !!v && typeof v === 'object' && (v as BuiltinItem).type !== undefined
}

/**
 * Resolve the configured built-ins into ordered, individually-addressable steps.
 * Returns `[]` when none are configured (no-config compatibility, spec §5).
 * Unknown built-in types are skipped (validated at admission in prod).
 */
export function buildLlmBuiltinSteps(builtins: unknown[] | undefined): BuiltinStep[] {
  if (!builtins || builtins.length === 0) return []

  const items = builtins
    .filter(isBuiltinItem)
    .slice()
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

  const steps: BuiltinStep[] = []
  for (const item of items) {
    if (item.type === 'prompt-shaping') {
      const cfg = (item.config ?? {}) as PromptShapingConfig
      steps.push({ sourceId: 'prompt-shaping', shape: req => applyPromptShaping(req, cfg) })
    } else if (item.type === 'token-trim') {
      const cfg = (item.config ?? {}) as TokenTrimConfig
      steps.push({ sourceId: 'token-trim', shape: req => applyTokenTrim(req, cfg) })
    }
  }
  return steps
}

/**
 * Compose the configured built-ins into a single ordered request shaper. Returns
 * an identity shaper when none are configured (no-config compatibility, spec §5).
 * Equivalent to applying `buildLlmBuiltinSteps` in order.
 */
export function buildLlmBuiltinChain(builtins: unknown[] | undefined): RequestShaper {
  const steps = buildLlmBuiltinSteps(builtins)
  if (steps.length === 0) return IDENTITY
  return request => steps.reduce((req, step) => step.shape(req), request)
}

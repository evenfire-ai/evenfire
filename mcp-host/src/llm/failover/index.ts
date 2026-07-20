/**
 * Provider-fallback (R5) — public surface.
 *
 * This is the reusable failover motor (spec §3-R5.6). F5 wires it into the
 * agent via `core/adapters/failoverLlmPort.ts`; F6 will reuse the SAME engine +
 * classifier + policy parser for workflow steps and the promptBridge `LlmBridge`.
 *
 * Public API (needed by F6):
 *   - `FailoverEngine` — the ordered-attempt orchestrator + sticky cooldown.
 *   - `FailoverEngineOptions`, `AttemptBuilder`, `ClassifiedLike` — its wiring types.
 *   - `classifyFailoverClass`, `ALL_FAILOVER_CLASSES` — the tuple→class mapping.
 *   - `parseLlmPolicy` — normalize `spec.llmPolicy` off any CR.
 *   - `llmFallbackTotal` — the `clerum_llm_fallback_total` counter.
 *   - the `types` (LlmPolicy, FallbackEntry, FailoverClass, ServedBy, ...).
 */
export * from './types'
export { ALL_FAILOVER_CLASSES, classifyFailoverClass } from './classify'
export { parseLlmPolicy } from './policy'
export { llmFallbackTotal } from './metrics'
export {
  FailoverEngine,
  type Attempt,
  type AttemptBuilder,
  type ClassifiedLike,
  type FailoverEngineOptions,
} from './engine'
export { parseCooldownAndTriggers, type CooldownAndTriggers } from './policy'

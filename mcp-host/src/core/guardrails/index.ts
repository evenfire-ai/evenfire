/**
 * Guardrail engine — public surface (spec §2–§6, §9).
 *
 * Phase 1: lane-neutral core (types, decision algebra, boundary pipeline) and
 * the tool-lane guardrail (rules + predicates) are implemented and wired behind
 * `config.guardrails` in the tool-use loop. Installed hooks + the LLM lane are
 * Phases 2–3.
 */
export * from './types'
export * from './decision'
export * from './capabilities'
export { createGuardrailBoundary, evaluateBoundary, recordDecision } from './boundary'
export type { CoreBoundaryDeps, BoundaryEvaluation } from './boundary'
export type { GuardrailsConfig, GuardrailRule, GuardrailLimits } from './config'
export { buildToolLaneGuardrail } from './tool/toolLaneAdapter'
export type {
  ToolLaneGuardrail,
  ToolGuardrailDecision,
  ToolLaneInput,
  ToolLaneResult,
} from './tool/toolLaneAdapter'
export { resolveToolIdentity, resolveToolIdentityFromRegistry } from './tool/provenance'
export type { ToolIdentity } from './tool/provenance'
export { recordAndCheck } from './tool/doomLoop'
export type { DoomLoopState } from './tool/doomLoop'
export { buildLlmBuiltinChain } from './llm/builtinChain'
export type { BuiltinItem, RequestShaper } from './llm/builtinChain'
export { applyPromptShaping } from './llm/builtins/promptShaping'
export type { PromptShapingConfig } from './llm/builtins/promptShaping'
export { applyTokenTrim } from './llm/builtins/tokenTrim'
export type { TokenTrimConfig } from './llm/builtins/tokenTrim'
export { RemoteLlmHook } from './hooks/remoteLlmHook'
export type { HookDescriptor, HookFetcher, HookHttpResult, LifecyclePoint } from './hooks/types'
export { guardrailDecisionsTotal, guardrailBoundaryDurationMs } from './metrics'

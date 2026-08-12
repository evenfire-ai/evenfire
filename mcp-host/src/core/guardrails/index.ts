/**
 * Guardrail engine — public surface (spec §2–§6, §9).
 *
 * Phase 1: lane-neutral core (types + decision algebra) is implemented; the
 * boundary pipeline and the tool-lane adapter are scaffolded (TODO(phase1)).
 * The live gate is not yet wired into the tool-use loop.
 */
export * from './types'
export * from './decision'
export * from './capabilities'
export { createGuardrailBoundary } from './boundary'
export type { CoreBoundaryDeps } from './boundary'
export type { GuardrailsConfig, GuardrailRule, GuardrailLimits } from './config'
export { buildToolLaneBoundary } from './tool/toolLaneAdapter'
export type { ToolLaneBoundary, ToolLaneInput, ToolLaneResult } from './tool/toolLaneAdapter'
export type { ToolIdentity } from './tool/provenance'
export { guardrailDecisionsTotal, guardrailBoundaryDurationMs } from './metrics'

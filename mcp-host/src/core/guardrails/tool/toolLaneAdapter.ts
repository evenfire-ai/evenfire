/**
 * Tool-lane adapter (spec §6) — specializes the guardrail engine over tool
 * execution.
 *
 * `Input` = resolved-tool arguments; `Identity` = the real tool after
 * dynamic-bridge resolution (spec §6). Unlike the LLM lane (which uses the
 * wrap-around `guard(execute)`), the tool-use loop owns execution + suspension,
 * so this exposes a decision-only `decide()`; the loop acts on the decision
 * (deny → bounded error, ask → suspension, allow/no_decision → existing path).
 */
import { type CoreBoundaryDeps, evaluateBoundary } from '../boundary'
import type { GuardrailsConfig } from '../config'
import type { Decision } from '../types'
import type { ToolIdentity } from './provenance'
import { compileRules, evaluateRules } from './rules'

export type ToolLaneInput = Record<string, unknown>
export type ToolLaneResult = string

export interface ToolGuardrailDecision {
  decision: Decision
  reasonCode: string
  /** Arguments after any honored rewrites (spec §4.1). Phase 1 rules never rewrite. */
  effectiveInput: ToolLaneInput
  source: string
}

/** The tool-lane guardrail the loop consults before executing a tool. */
export interface ToolLaneGuardrail {
  decide(identity: ToolIdentity, input: ToolLaneInput): Promise<ToolGuardrailDecision>
}

/**
 * Build the tool-lane guardrail from the Host guardrails config. Returns
 * `undefined` when no rules are configured — the loop then behaves exactly as
 * today (no-config compatibility, spec §5).
 *
 * Compilation throws on a malformed rule set (spec §3/§5); the caller must
 * reject the config rather than run a partially-valid set.
 *
 * TODO(phase1): add the doom-loop guard (§6.4) as a `pre` contributor once the
 * gate is wired with per-task state.
 */
export function buildToolLaneGuardrail(
  config: GuardrailsConfig | undefined
): ToolLaneGuardrail | undefined {
  const compiled = compileRules(config?.rules, config?.limits?.maxRules)
  if (!compiled.hasRules) return undefined

  const deps: CoreBoundaryDeps<ToolLaneInput, ToolLaneResult, ToolIdentity> = {
    lane: 'tool',
    hasRules: compiled.hasRules,
    contributors: {
      async pre(input, identity) {
        return evaluateRules(compiled, identity, input)
      },
      async post() {
        return [] // Phase 1: no tool-lane post transforms (PostToolUse = Phase 3).
      },
    },
  }

  return {
    async decide(identity, input) {
      const e = await evaluateBoundary(deps, identity, input)
      return {
        decision: e.decision,
        reasonCode: e.reasonCode,
        effectiveInput: e.effectiveInput,
        source: e.source,
      }
    },
  }
}

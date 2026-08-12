/**
 * Tool-lane adapter (spec §6) — specializes the GuardrailBoundary over tool
 * execution.
 *
 * `Input` = resolved-tool arguments; `Result` = the tool result; `Identity` =
 * the real tool after dynamic-bridge resolution (spec §6). This is the entry
 * point the tool-use loop calls before executing a tool.
 *
 * INTEGRATION SEAM (spec §6, map: toolUseLoopToolBatch.ts:207): the live gate is
 * NOT wired into the loop in the Phase 1 scaffold. When wired, `no_decision`
 * falls through to the existing approval path (`beforeTool`), and `ask` returns
 * a suspension shaped like `mcpApprovalGateController.createSuspension`.
 *
 * TODO(phase1): build the boundary from the rules engine + doom-loop, then wire
 * the gate in `executeToolCalls` behind `config.guardrails` (absent = today).
 */
import { createGuardrailBoundary } from '../boundary'
import type { GuardrailsConfig } from '../config'
import type { GuardrailBoundary } from '../types'
import type { ToolIdentity } from './provenance'
import { compileRules, evaluateRules } from './rules'

/** The tool-lane input the boundary aggregates over. */
export type ToolLaneInput = Record<string, unknown>
/** The tool-lane result (kept string-shaped; the loop maps to `ToolResult`). */
export type ToolLaneResult = string

export type ToolLaneBoundary = GuardrailBoundary<ToolLaneInput, ToolLaneResult, ToolIdentity>

/**
 * Build the tool-lane boundary from the Host guardrails config. Returns
 * `undefined` when no rules are configured — the caller then behaves exactly as
 * today (no-config compatibility, spec §5).
 *
 * Compilation throws on a malformed rule set (spec §3/§5); the caller must
 * reject the config rather than run a partially-valid set.
 *
 * TODO(phase1): add the doom-loop guard (§6.4) as a `pre` contributor once the
 * gate is wired with per-task state.
 */
export function buildToolLaneBoundary(
  config: GuardrailsConfig | undefined
): ToolLaneBoundary | undefined {
  const compiled = compileRules(config?.rules, config?.limits?.maxRules)
  if (!compiled.hasRules) return undefined

  return createGuardrailBoundary<ToolLaneInput, ToolLaneResult, ToolIdentity>({
    lane: 'tool',
    hasRules: compiled.hasRules,
    contributors: {
      async pre(input, identity) {
        return evaluateRules(compiled, identity, input)
      },
      async post() {
        // Phase 1: no post transforms on the tool lane (PostToolUse = Phase 3).
        return []
      },
    },
  })
}

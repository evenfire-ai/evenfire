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
import { type FetchLike, createHookFetcher } from '../hooks/hookFetcher'
import { RemoteToolHook, type ToolResultView } from '../hooks/remoteToolHook'
import type { HookDescriptor } from '../hooks/types'
import type { Contributor, Decision } from '../types'
import type { ToolIdentity } from './provenance'
import { compileRules, evaluateRules } from './rules'

export interface ToolLaneGuardrailDeps {
  getAuthToken?: () => string
  fetchImpl?: FetchLike
}

/**
 * Build the tool-lane installed hooks (spec §6.2), ordered by `order`, split by
 * lifecycle point: `pre` (`PreToolUse` gate) and `post` (`PostToolUse` redaction).
 * A hook may subscribe to both.
 */
function buildToolLaneHooks(
  descriptors: HookDescriptor[] | undefined,
  deps: ToolLaneGuardrailDeps
): { pre: RemoteToolHook[]; post: RemoteToolHook[] } {
  const ordered = (descriptors ?? []).slice().sort((a, b) => a.order - b.order)
  const pre: RemoteToolHook[] = []
  const post: RemoteToolHook[] = []
  for (const d of ordered) {
    const hook = new RemoteToolHook(
      d,
      createHookFetcher({
        getAuthToken: deps.getAuthToken ?? (() => ''),
        fetchImpl: deps.fetchImpl,
      })
    )
    if (d.lifecyclePoints.includes('pre_tool_use')) pre.push(hook)
    if (d.lifecyclePoints.includes('post_tool_use')) post.push(hook)
  }
  return { pre, post }
}

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
  /**
   * PostToolUse redaction (spec §6.2 / §10 #3): transform the model-visible tool
   * result through the installed `post_tool_use` hooks, in order. Optional — a
   * guardrail with no post hooks omits it (the loop then leaves the result
   * untouched). Never denies/asks; a fail-closed redactor that's unavailable
   * withholds the content (§8.6).
   */
  transformResult?(
    identity: ToolIdentity,
    input: ToolLaneInput,
    result: ToolResultView
  ): Promise<ToolResultView>
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
  config: GuardrailsConfig | undefined,
  hookDeps: ToolLaneGuardrailDeps = {}
): ToolLaneGuardrail | undefined {
  const compiled = compileRules(config?.rules, config?.limits?.maxRules)
  const hooks = buildToolLaneHooks(config?.hookDescriptors, hookDeps)
  if (!compiled.hasRules && hooks.pre.length === 0 && hooks.post.length === 0) return undefined

  const deps: CoreBoundaryDeps<ToolLaneInput, ToolLaneResult, ToolIdentity> = {
    lane: 'tool',
    hasRules: compiled.hasRules, // unmatched default keys on RULES; a hook returning null is just no opinion.
    contributors: {
      async pre(input, identity) {
        const ruleContribs = evaluateRules(compiled, identity, input)
        const hookContribs = (
          await Promise.all(hooks.pre.map(h => h.preToolUse(identity, input)))
        ).filter((c): c is Contributor<ToolLaneInput, ToolLaneResult> => c !== null)
        return [...ruleContribs, ...hookContribs]
      },
      async post() {
        return [] // PostToolUse redaction is applied via `transformResult`, not the decision boundary.
      },
    },
  }

  const guardrail: ToolLaneGuardrail = {
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

  // Only expose `transformResult` when there are post hooks — a guardrail with none
  // leaves the loop's post-execution path byte-identical to today.
  if (hooks.post.length > 0) {
    guardrail.transformResult = async (identity, input, result) => {
      let current = result
      for (const hook of hooks.post) {
        const redacted = await hook.postToolUse(identity, input, current)
        if (redacted) current = redacted
      }
      return current
    }
  }
  return guardrail
}

/**
 * Canonical agent resolution for workflow recipes.
 *
 * A recipe's mcp-host provider/model comes from spec.agent, or — for a genuine
 * workflow — from the first step that declares a complete agent. This is the
 * single source of truth shared by the reconciler (which needs the AgentSpec
 * to build the mcp-host pod) and the Plugin Workload SDK validator (which only
 * needs to know whether one is resolvable). Keeping both on this helper
 * prevents the two from drifting apart.
 */
import { isRunnableLlmModelId } from '@clerum/llm-providers'
import type { WorkflowRecipeSpec } from '../types'
import type { AgentSpec } from './types'

/**
 * Resolve the complete agent (provider + model) for a recipe, or undefined when
 * neither spec.agent nor any step agent declares both fields. spec.agent is
 * returned verbatim (preserving soulRef/secretRef); a step agent is narrowed to
 * provider + model to match the prior reconciler behavior.
 */
export function resolveMcpHostAgent(spec: WorkflowRecipeSpec): AgentSpec | undefined {
  // An explicitly declared top-level binding is authoritative. Do not silently
  // replace an invalid operator declaration with a step agent: that can boot a
  // different provider/model than the recipe author requested.
  if (spec.agent !== undefined) {
    if (spec.agent.provider && isRunnableLlmModelId(spec.agent.model)) {
      return spec.agent as AgentSpec
    }
    return undefined
  }
  const stepAgent = (spec.steps ?? []).find(
    step => step.agent?.provider && isRunnableLlmModelId(step.agent.model)
  )?.agent
  if (!stepAgent?.provider || !stepAgent.model) return undefined
  return { provider: stepAgent.provider, model: stepAgent.model }
}

/** True when the recipe resolves to a complete agent (provider + model). */
export function hasResolvableAgent(spec: WorkflowRecipeSpec): boolean {
  return resolveMcpHostAgent(spec) !== undefined
}

/**
 * Agent used to build the eager SDK mcp-host pod. promptBridge requires a
 * real resolvable agent; clientNotifications-only recipes deliberately return
 * no agent so the notification runtime does not invent a provider/model.
 */
export function resolveEagerSdkMcpHostAgent(spec: WorkflowRecipeSpec): AgentSpec | undefined {
  const resolved = resolveMcpHostAgent(spec)
  if (resolved) return resolved
  return undefined
}

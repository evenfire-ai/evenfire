/**
 * Canonical agent resolution for workflow recipes.
 *
 * A recipe's mcp-host provider/model comes from spec.agent, or — when absent —
 * from the first step that declares a complete agent. This is the single source
 * of truth shared by the reconciler (which needs the AgentSpec to build the
 * mcp-host pod) and the Plugin Workload SDK validator (which only needs to know
 * whether one is resolvable). Keeping both on this helper prevents the two from
 * drifting apart.
 */
import type { WorkflowRecipeSpec } from '../types'
import type { AgentSpec } from './types'

/**
 * Resolve the complete agent (provider + model) for a recipe, or undefined when
 * neither spec.agent nor any step agent declares both fields. spec.agent is
 * returned verbatim (preserving soulRef/secretRef); a step agent is narrowed to
 * provider + model to match the prior reconciler behavior.
 */
export function resolveMcpHostAgent(spec: WorkflowRecipeSpec): AgentSpec | undefined {
  if (spec.agent) return spec.agent as AgentSpec
  const stepAgent = (spec.steps ?? []).find(step => step.agent?.provider && step.agent.model)?.agent
  if (!stepAgent?.provider || !stepAgent.model) return undefined
  return { provider: stepAgent.provider, model: stepAgent.model }
}

/** True when the recipe resolves to a complete agent (provider + model). */
export function hasResolvableAgent(spec: WorkflowRecipeSpec): boolean {
  return resolveMcpHostAgent(spec) !== undefined
}

/**
 * Sentinel agent for clientNotifications-only eager mcp-host pods.
 *
 * INVARIANT: this value MUST NEVER reach a provider LLM call. It exists only so
 * the always-on SDK server (:8099) can start for clientNotifications recipes
 * that have no resolvable agent and no promptBridge — i.e. no brokered provider
 * keys. `model: 'plugin-workload-sdk-notifications'` is not a real model id; it
 * is a non-routable marker, deliberately distinct from any provider's catalog so
 * an accidental LLM call would fail loudly rather than bill a real model.
 *
 * Safety is enforced by the caller, not by this value:
 *   - `resolveEagerSdkMcpHostAgent` only returns this stub when `clientNotifications`
 *     is set AND `promptBridge` is NOT (promptBridge requires a real resolvable
 *     agent and returns undefined here instead).
 *   - The provisioner gates the mcp-host `/configure` call, so the stub never
 *     drives a chat/completion request.
 * Do not widen the conditions that return this stub without re-checking those gates.
 */
const PLUGIN_WORKLOAD_SDK_NOTIFICATIONS_STUB_AGENT: AgentSpec = {
  provider: 'openai',
  model: 'plugin-workload-sdk-notifications',
}

/**
 * Agent used to build the eager SDK mcp-host pod. promptBridge requires a
 * real resolvable agent; clientNotifications-only recipes use a stub agent so
 * the always-on SDK server can start without brokered provider keys.
 */
export function resolveEagerSdkMcpHostAgent(spec: WorkflowRecipeSpec): AgentSpec | undefined {
  const resolved = resolveMcpHostAgent(spec)
  if (resolved) return resolved
  if (spec.pluginWorkloadSdk?.promptBridge) return undefined
  if (spec.pluginWorkloadSdk?.clientNotifications) {
    return PLUGIN_WORKLOAD_SDK_NOTIFICATIONS_STUB_AGENT
  }
  return undefined
}

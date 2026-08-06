/**
 * Plugin Workload SDK — Prometheus instruments (plan §5.3).
 *
 * Registered on the prom-client global register, so they ride the existing
 * mcp-host GET /metrics endpoint (RPC server :8080). Co-located with the
 * SDK module, same pattern as llm/promptCacheMetrics.ts.
 */
import { Counter, Gauge, Histogram } from 'prom-client'

export const pluginSdkPromptBridgeRequestsTotal = new Counter({
  name: 'clerum_plugin_workload_sdk_prompt_bridge_requests_total',
  help: 'promptBridge requests by recipe, model, and terminal status.',
  labelNames: ['recipe', 'model', 'status'] as const,
})

export const pluginSdkPromptBridgeTokensTotal = new Counter({
  name: 'clerum_plugin_workload_sdk_prompt_bridge_tokens_total',
  help: 'promptBridge token consumption by direction (input|output).',
  labelNames: ['recipe', 'model', 'direction'] as const,
})

export const pluginSdkClientNotificationsTotal = new Counter({
  name: 'clerum_plugin_workload_sdk_client_notifications_total',
  help: 'clientNotifications intents by recipe, event type, and status.',
  labelNames: ['recipe', 'event_type', 'status'] as const,
})

export const pluginSdkCircuitBreakerState = new Gauge({
  name: 'clerum_plugin_workload_sdk_circuit_breaker_state',
  help: 'Circuit breaker state per gateway or authorized target (1 = the labeled state is active).',
  labelNames: ['gateway', 'state'] as const,
})

export const pluginSdkPromptBridgeDurationSeconds = new Histogram({
  name: 'clerum_plugin_workload_sdk_prompt_bridge_duration_seconds',
  help: 'End-to-end promptBridge handling duration (including the LLM call).',
  labelNames: ['recipe', 'model'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
})

/** Mirror a breaker transition into the {gateway, state} gauge pair. */
export function recordCircuitBreakerState(gateway: string, open: boolean): void {
  pluginSdkCircuitBreakerState.set({ gateway, state: 'open' }, open ? 1 : 0)
  pluginSdkCircuitBreakerState.set({ gateway, state: 'closed' }, open ? 0 : 1)
}

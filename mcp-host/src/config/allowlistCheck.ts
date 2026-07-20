/**
 * R3.7 — non-disruptive allowlist signal.
 *
 * If a Host's configured model is not in the operator allowlist for its
 * provider, emit a structured WARN + a metric. mcp-host does NOT reject the
 * model — hard enforcement is control-api/WRC. While the allowlist is
 * unavailable (degraded-explicit) the check is skipped: with no allowlist to
 * compare against, only the Host-configured model is treated as permitted.
 *
 * Extracted from main.ts so the pure decision is unit-testable without loading
 * the runtime module.
 */
import { llmModelNotAllowedTotal } from './allowlistMetrics'
import type { AllowedModelEntry } from './configStore'

/** The slice of ConfigStore this check reads — lets tests pass a stub. */
export interface AllowlistView {
  allowlistAvailable(): boolean
  allowedModels(): ReadonlyMap<string, AllowedModelEntry[]>
}

/**
 * Signal (WARN + metric) when `model` is outside the allowlist for `provider`.
 * Returns true iff a violation was signalled. No-op when the model is allowed,
 * the allowlist is unavailable, or the model config is absent.
 */
export function signalHostModelAllowlist(
  view: AllowlistView,
  model: { provider: string; name: string } | undefined
): boolean {
  if (!model?.provider || !model.name) return false
  if (!view.allowlistAvailable()) return false
  const entries = view.allowedModels().get(model.provider) ?? []
  if (entries.some(e => e.model === model.name)) return false
  llmModelNotAllowedTotal.labels({ provider: model.provider, model: model.name }).inc()
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'llm_model_not_allowed',
      provider: model.provider,
      model: model.name,
      message:
        'Host-configured model is not in the operator allowlist; not enforced by mcp-host (control-api/WRC gate applies to new selections)',
    })
  )
  return true
}

import type { UsageContext } from '../core/types'
import type { LlmUsageEvent } from './usageReporter'

/**
 * Shared usage event for a completed model call.
 * `codex-subscription` returns null because proxy finalize owns that ledger.
 * This builder does not update session counters or cache histograms.
 */
export function buildLlmUsageEvent(input: {
  requestId: string
  staticContext: {
    host_ref: string
    context_ref: string | null
    llm_secret_name: string | null
  }
  providerName: string
  model: string
  usageContext: UsageContext
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
  }
}): LlmUsageEvent | null {
  if (input.providerName === 'codex-subscription') return null
  return {
    request_id: input.requestId,
    ts: new Date().toISOString(),
    run_id: input.usageContext.traceContext?.runId ?? null,
    host_ref: input.staticContext.host_ref,
    context_ref: input.staticContext.context_ref,
    team_id: input.usageContext.team_id ?? null,
    provider: input.providerName,
    model: input.model,
    llm_secret_name: input.staticContext.llm_secret_name,
    source_kind: input.usageContext.source_kind,
    user_id: input.usageContext.user_id ?? null,
    sender: input.usageContext.sender ?? null,
    channel_type: input.usageContext.channel_type ?? null,
    recipe_name: input.usageContext.recipe_name ?? null,
    cron_job_id: input.usageContext.cron_job_id ?? null,
    task_id: input.usageContext.task_id ?? null,
    iteration: input.usageContext.iteration ?? null,
    input_tokens: input.usage.input_tokens,
    output_tokens: input.usage.output_tokens,
    cache_read_tokens: input.usage.cache_read_tokens,
    cache_write_tokens: input.usage.cache_write_tokens,
  }
}

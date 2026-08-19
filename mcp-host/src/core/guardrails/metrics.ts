/**
 * Guardrail engine metrics (spec §9).
 *
 * Fixed-enum labels only — ids/paths/args/free-form reasons/digests are
 * forbidden as labels (spec §9). Follows the idempotent `getOrCreate*` pattern
 * of `usage/governedRunMetrics.ts` so hot-reload/re-import never double-registers.
 */
import { Counter, Histogram, register } from 'prom-client'

function getOrCreateCounter<Label extends string>(options: {
  name: string
  help: string
  labelNames: Label[]
}): Counter<Label> {
  const existing = register.getSingleMetric(options.name)
  if (existing) return existing as Counter<Label>
  return new Counter<Label>({ ...options, registers: [register] })
}

function getOrCreateHistogram<Label extends string>(options: {
  name: string
  help: string
  labelNames: Label[]
  buckets: number[]
}): Histogram<Label> {
  const existing = register.getSingleMetric(options.name)
  if (existing) return existing as Histogram<Label>
  return new Histogram<Label>({ ...options, registers: [register] })
}

/** One count per guarded boundary outcome. Labels are fixed enums only (spec §9). */
export const guardrailDecisionsTotal = getOrCreateCounter({
  name: 'clerum_mcp_host_guardrail_decisions_total',
  help: 'Guardrail boundary outcomes by lane/decision/source/reason.',
  labelNames: [
    'lane',
    'decision',
    'source',
    'execution_mode',
    'phase',
    'outcome',
    'reason_code',
  ] as const as Array<
    'lane' | 'decision' | 'source' | 'execution_mode' | 'phase' | 'outcome' | 'reason_code'
  >,
})

/** Wall-clock of one boundary pass (contributors + aggregate), excluding execute. */
export const guardrailBoundaryDurationMs = getOrCreateHistogram({
  name: 'clerum_mcp_host_guardrail_boundary_duration_ms',
  help: 'Guardrail boundary evaluation latency (ms), excluding tool/model execution.',
  labelNames: ['lane'] as const as Array<'lane'>,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
})

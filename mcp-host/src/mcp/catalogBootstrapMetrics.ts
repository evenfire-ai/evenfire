import { Counter, Gauge, type Registry, register } from 'prom-client'

/** Terminal disposition of one `bootstrapUserCatalog` run. */
type RunOutcome = 'noop' | 'admitted' | 'partial' | 'timed_out' | 'skipped' | 'error'
/** Per-coordinate probe disposition (the §6.3 buckets, plus the answer). */
type ProbeResult =
  | 'present'
  | 'absent'
  | 'unknown'
  | 'cached_absent'
  | 'cached_failed'
  | 'budget'
  | 'paused'
type Partition = 'per-user' | 'shared'
// 'stale' is declared for completeness but stays 0 today: the admission layer
// resolves a superseded/fenced attempt as ok (per-user) or throws (shared), so
// the bootstrap never labels an outcome 'stale'. Kept as a materialized-zero
// series so the label exists if that bookkeeping is ever surfaced.
type AdmissionOutcome = 'ok' | 'failed' | 'stale'

/** Probe dispositions counted for one run; omitted/zero keys are not incremented. */
export type ProbeResultCounts = Partial<Record<ProbeResult, number>>

export interface McpCatalogBootstrapMetricsPort {
  runFinished(outcome: RunOutcome, waitedMs: number): void
  probes(counts: ProbeResultCounts): void
  admission(partition: Partition, outcome: AdmissionOutcome): void
  awaitingGrant(size: number): void
}

function counter<Label extends string>(
  registry: Registry,
  options: { name: string; help: string; labelNames?: Label[] }
): Counter<Label> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Counter<Label>
  return new Counter<Label>({ ...options, registers: [registry] })
}

function gauge<Label extends string>(
  registry: Registry,
  options: { name: string; help: string; labelNames?: Label[] }
): Gauge<Label> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Gauge<Label>
  return new Gauge<Label>({ ...options, registers: [registry] })
}

const RUN_OUTCOMES: RunOutcome[] = ['noop', 'admitted', 'partial', 'timed_out', 'skipped', 'error']
const PROBE_RESULTS: ProbeResult[] = [
  'present',
  'absent',
  'unknown',
  'cached_absent',
  'cached_failed',
  'budget',
  'paused',
]
const PARTITIONS: Partition[] = ['per-user', 'shared']
const ADMISSION_OUTCOMES: AdmissionOutcome[] = ['ok', 'failed', 'stale']

export class McpCatalogBootstrapMetrics implements McpCatalogBootstrapMetricsPort {
  private readonly runs: Counter<'outcome'>
  private readonly probesTotal: Counter<'result'>
  private readonly admissions: Counter<'partition' | 'outcome'>
  private readonly waitMs: Gauge
  private readonly awaiting: Gauge

  constructor(registry: Registry = register) {
    this.runs = counter(registry, {
      name: 'clerum_mcp_catalog_bootstrap_runs_total',
      help: 'Per-turn catalog bootstrap runs by terminal outcome.',
      labelNames: ['outcome'],
    })
    this.probesTotal = counter(registry, {
      name: 'clerum_mcp_catalog_bootstrap_probes_total',
      help: 'Grant-existence probe coordinates by disposition (answer or skip bucket).',
      labelNames: ['result'],
    })
    this.admissions = counter(registry, {
      name: 'clerum_mcp_catalog_bootstrap_admissions_total',
      help: 'Bootstrap-initiated partition admissions by partition kind and outcome.',
      labelNames: ['partition', 'outcome'],
    })
    this.waitMs = gauge(registry, {
      name: 'clerum_mcp_catalog_bootstrap_wait_ms',
      help: 'Time the most recent bootstrap run waited on its admissions before continuing.',
    })
    this.awaiting = gauge(registry, {
      name: 'clerum_mcp_oauth_shared_awaiting_grant',
      help: 'SHARED oauth-context servers currently registered without a confirmed grant.',
    })
    this.initializeSeries()
  }

  /**
   * Materialize every counter series at zero so a scrape distinguishes "none"
   * from "not exported" — the same contract the status-heartbeat metrics keep
   * so an alert on, say, `result="paused"` reads a real zero, not a gap.
   */
  private initializeSeries(): void {
    for (const outcome of RUN_OUTCOMES) this.runs.inc({ outcome }, 0)
    for (const result of PROBE_RESULTS) this.probesTotal.inc({ result }, 0)
    for (const partition of PARTITIONS)
      for (const outcome of ADMISSION_OUTCOMES) this.admissions.inc({ partition, outcome }, 0)
    this.awaiting.set(0)
  }

  runFinished(outcome: RunOutcome, waitedMs: number): void {
    this.runs.inc({ outcome })
    this.waitMs.set(waitedMs)
  }

  probes(counts: ProbeResultCounts): void {
    for (const result of PROBE_RESULTS) {
      const n = counts[result]
      if (n && n > 0) this.probesTotal.inc({ result }, n)
    }
  }

  admission(partition: Partition, outcome: AdmissionOutcome): void {
    this.admissions.inc({ partition, outcome })
  }

  awaitingGrant(size: number): void {
    this.awaiting.set(size)
  }
}

export const catalogBootstrapMetrics = new McpCatalogBootstrapMetrics()

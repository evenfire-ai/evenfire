import { Counter, Gauge, Histogram, register } from 'prom-client'

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

function getOrCreateGauge(options: { name: string; help: string }): Gauge<string> {
  const existing = register.getSingleMetric(options.name)
  if (existing) return existing as Gauge<string>
  return new Gauge<string>({ ...options, registers: [register] })
}

export type GfsDownloadAdmissionOutcome =
  | 'inline_attempt'
  | 'workspace_attempt'
  | 'workspace_unavailable'
  | 'limit_exceeded'

export type GfsDownloadTransferOutcome = 'success' | 'failure'

export type GfsDownloadShellLimitOutcome = 'output_limit_exceeded'

export type GfsDownloadQuotaScope = 'host' | 'caller'

export type GfsDownloadQuotaReason =
  | 'storage_bytes'
  | 'retained_files'
  | 'active_downloads'
  | 'free_space'

export type GfsDownloadExpiryOutcome = 'expired_removed' | 'cleanup_failed' | 'sweep_failed'

const gfsDownloadAdmissionsTotal = getOrCreateCounter({
  name: 'clerum_gfs_download_admissions_total',
  help: 'GFS source admission decisions by fixed outcome.',
  labelNames: ['outcome'] as const as Array<'outcome'>,
})

const gfsDownloadTransfersTotal = getOrCreateCounter({
  name: 'clerum_gfs_download_transfers_total',
  help: 'Governed GFS workspace transfers by fixed outcome.',
  labelNames: ['outcome'] as const as Array<'outcome'>,
})

const gfsDownloadDurationSeconds = getOrCreateHistogram({
  name: 'clerum_gfs_download_duration_seconds',
  help: 'Governed GFS workspace transfer duration.',
  labelNames: [] as const as Array<never>,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
})

const gfsDownloadActive = getOrCreateGauge({
  name: 'clerum_gfs_download_active',
  help: 'Governed GFS workspace transfers currently reported by the tool boundary.',
})

const gfsShellOutputLimitsTotal = getOrCreateCounter({
  name: 'clerum_gfs_shell_output_limits_total',
  help: 'Approved local GFS processing commands stopped by fixed output limits.',
  labelNames: ['outcome'] as const as Array<'outcome'>,
})

const gfsDownloadQuotaTotal = getOrCreateCounter({
  name: 'clerum_gfs_download_quota_total',
  help: 'Governed GFS workspace transfer quota decisions by fixed scope and reason.',
  labelNames: ['scope', 'reason'] as const as Array<'scope' | 'reason'>,
})

const gfsDownloadExpiryTotal = getOrCreateCounter({
  name: 'clerum_gfs_download_expiry_total',
  help: 'Governed GFS workspace-copy expiry and cleanup outcomes.',
  labelNames: ['outcome'] as const as Array<'outcome'>,
})

const gfsLegacyProcessingLeasesDiscardedTotal = getOrCreateCounter({
  name: 'clerum_gfs_legacy_processing_leases_discarded_total',
  help: 'Legacy shell processing leases discarded from the GFS download store ledger at initialize.',
  labelNames: [] as const as Array<never>,
})

const gfsInheritedQuarantinedRecordsTotal = getOrCreateCounter({
  name: 'clerum_gfs_inherited_quarantined_records_total',
  help: 'GFS download store records found quarantined by an earlier boot at initialize; they stay charged to quota until operator recovery.',
  labelNames: [] as const as Array<never>,
})

export function recordGfsLegacyProcessingLeasesDiscarded(count: number): void {
  gfsLegacyProcessingLeasesDiscardedTotal.inc(count)
}

export function recordGfsInheritedQuarantinedRecords(count: number): void {
  gfsInheritedQuarantinedRecordsTotal.inc(count)
}

export function recordGfsDownloadAdmission(outcome: GfsDownloadAdmissionOutcome): void {
  gfsDownloadAdmissionsTotal.labels(outcome).inc()
}

export function recordGfsDownloadTransfer(
  outcome: GfsDownloadTransferOutcome,
  durationSeconds: number
): void {
  gfsDownloadTransfersTotal.labels(outcome).inc()
  gfsDownloadDurationSeconds.observe(durationSeconds)
}

export function enterGfsDownloadTransfer(): void {
  gfsDownloadActive.inc()
}

export function exitGfsDownloadTransfer(): void {
  gfsDownloadActive.dec()
}

export function recordGfsShellOutputLimit(outcome: GfsDownloadShellLimitOutcome): void {
  gfsShellOutputLimitsTotal.labels(outcome).inc()
}

export function recordGfsDownloadQuota(
  scope: GfsDownloadQuotaScope,
  reason: GfsDownloadQuotaReason
): void {
  gfsDownloadQuotaTotal.labels(scope, reason).inc()
}

export function recordGfsDownloadExpiry(outcome: GfsDownloadExpiryOutcome): void {
  gfsDownloadExpiryTotal.labels(outcome).inc()
}

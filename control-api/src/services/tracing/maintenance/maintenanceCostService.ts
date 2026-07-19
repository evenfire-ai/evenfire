import type { DbClient } from '../../../db.js'
import { canonicalSha256 } from './canonical.js'
import type {
  DailyCostComponent,
  DailyCostKey,
  DailyCostVersion,
  InfrastructurePriceSnapshotEvidence,
  NormalizedGcpBillingRow,
  PersistedDailyCostVersion,
} from './contracts.js'
import { Decimal9, sumDecimals } from './decimal.js'
import { reconcileNormalizedGcpBilling } from './gcpBillingReconciliation.js'
import { MaintenanceCostRepository } from './maintenanceCostRepository.js'
import { estimateRequestedCapacityDaily } from './requestedCapacityEstimate.js'

type CapacitySampleRow = {
  utc_day: string
  environment: string
  cluster_name: string
  namespace: string
  workload_kind: string
  workload_ref: string
  interval_start: Date | string
  interval_end: Date | string
  desired_replicas: number
  cpu_request_cores: string
  memory_request_bytes: string
  payload_sha256: string
  event_id: string
  completeness_status: 'complete' | 'partial'
}

export type MaintenanceCostPersistenceConfig = {
  enabled: boolean
  cloudProjectId: string
  clusterLocation: string
  clusterClass: string
  currency: string
  requestedCapacityLookbackDays?: number
  requestedCapacityFinalizationDelayHours?: number
}

export type MaintenanceCostPersistenceResult = {
  priceSnapshotsInserted: number
  requestedCapacityVersions: number
  billedVersions: number
  skippedReason: string | null
}

const EMPTY_RESULT: MaintenanceCostPersistenceResult = {
  priceSnapshotsInserted: 0,
  requestedCapacityVersions: 0,
  billedVersions: 0,
  skippedReason: null,
}

function toIsoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('capacity sample timestamp is invalid')
  return new Date(timestamp).toISOString()
}

export function previousClosedUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000)
    .toISOString()
    .slice(0, 10)
}

export function closedUtcDayRange(
  now: Date,
  lookbackDays: number
): {
  startUtcDay: string
  endUtcDay: string
} {
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 31) {
    throw new Error('closed UTC-day lookback must be between 1 and 31 days')
  }
  const endUtcDay = previousClosedUtcDay(now)
  const end = Date.parse(dayStart(endUtcDay))
  return {
    startUtcDay: new Date(end - (lookbackDays - 1) * 86_400_000).toISOString().slice(0, 10),
    endUtcDay,
  }
}

function dayStart(utcDay: string): string {
  return `${utcDay}T00:00:00.000Z`
}

function dayEnd(utcDay: string): string {
  return new Date(Date.parse(dayStart(utcDay)) + 86_400_000).toISOString()
}

function groupKey(key: DailyCostKey): string {
  return JSON.stringify(key)
}

function cpuCoresToNanoCores(value: string): bigint {
  return Decimal9.parse(value).units
}

function memoryBytes(value: string): bigint {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error('memory_request_bytes cannot be negative')
  return parsed
}

function aggregateComponents(components: readonly DailyCostComponent[]): DailyCostComponent[] {
  const byKey = new Map<string, DailyCostComponent[]>()
  for (const component of components) {
    const values = byKey.get(component.componentKey) ?? []
    values.push(component)
    byKey.set(component.componentKey, values)
  }
  return [...byKey.entries()].map(([componentKey, values]) => {
    const first = values[0]!
    return {
      ...first,
      componentKey,
      unitHours:
        first.unitHours === null
          ? null
          : sumDecimals(values.map(value => Decimal9.parse(value.unitHours ?? '0'))).toString(),
      sourceSha256: canonicalSha256(values.map(value => value.sourceSha256)),
      grossAmount: sumDecimals(values.map(value => Decimal9.parse(value.grossAmount))).toString(),
      creditsAmount: sumDecimals(
        values.map(value => Decimal9.parse(value.creditsAmount))
      ).toString(),
      netAmount: sumDecimals(values.map(value => Decimal9.parse(value.netAmount))).toString(),
    }
  })
}

function aggregateRequestedCapacityVersions(
  key: DailyCostKey,
  intervalVersions: readonly DailyCostVersion[],
  asOfUtc: string,
  completenessStatus: 'complete' | 'partial'
): DailyCostVersion {
  const components = aggregateComponents(intervalVersions.flatMap(version => version.components))
  return {
    key,
    valuationKind: 'estimated',
    selectedBasis: 'requested_capacity',
    publicationState: intervalVersions.every(version => version.publicationState === 'finalized')
      ? 'finalized'
      : 'provisional',
    completenessStatus,
    asOfUtc,
    sourceIntervalStart: intervalVersions
      .map(version => version.sourceIntervalStart)
      .filter((value): value is string => value !== null)
      .sort()[0]!,
    sourceIntervalEnd: intervalVersions
      .map(version => version.sourceIntervalEnd)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1)!,
    billingExportWatermark: null,
    sourceCount: intervalVersions.reduce((sum, version) => sum + version.sourceCount, 0),
    sourceSha256: canonicalSha256(intervalVersions.map(version => version.sourceSha256)),
    grossAmount: sumDecimals(
      components.map(component => Decimal9.parse(component.grossAmount))
    ).toString(),
    creditsAmount: sumDecimals(
      components.map(component => Decimal9.parse(component.creditsAmount))
    ).toString(),
    netAmount: sumDecimals(
      components.map(component => Decimal9.parse(component.netAmount))
    ).toString(),
    components,
  }
}

function hasCompleteDayCoverage(rows: readonly CapacitySampleRow[], utcDay: string): boolean {
  const expectedStart = Date.parse(dayStart(utcDay))
  const expectedEnd = Date.parse(dayEnd(utcDay))
  const intervals = rows
    .map(row => ({
      start: Date.parse(toIsoTimestamp(row.interval_start)),
      end: Date.parse(toIsoTimestamp(row.interval_end)),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  if (intervals.length === 0 || intervals[0]!.start !== expectedStart) return false
  let cursor = expectedStart
  for (const interval of intervals) {
    if (interval.start !== cursor || interval.end <= interval.start) return false
    cursor = interval.end
  }
  return cursor === expectedEnd
}

function publicationStateForRequestedCapacity(input: {
  utcDay: string
  asOfUtc: string
  finalizationDelayHours: number
}): 'provisional' | 'finalized' {
  const deadline = Date.parse(dayEnd(input.utcDay)) + input.finalizationDelayHours * 3_600_000
  return Date.parse(input.asOfUtc) >= deadline ? 'finalized' : 'provisional'
}

function utcDaysInRange(startUtcDay: string, endUtcDay: string): string[] {
  const days: string[] = []
  for (
    let timestamp = Date.parse(dayStart(startUtcDay));
    timestamp <= Date.parse(dayStart(endUtcDay));
    timestamp += 86_400_000
  ) {
    days.push(new Date(timestamp).toISOString().slice(0, 10))
  }
  return days
}

export async function loadCapacitySamplesForDay(
  db: DbClient,
  utcDay: string
): Promise<CapacitySampleRow[]> {
  const result = await db.query(
    `
      SELECT (interval_start AT TIME ZONE 'UTC')::date::text AS utc_day,
             environment, cluster_name, namespace, workload_kind, workload_ref,
             interval_start, interval_end, desired_replicas,
             cpu_request_cores::text, memory_request_bytes::text,
             payload_sha256, event_id::text,
             CASE WHEN payload_metadata->>'status' = 'complete'
                  THEN 'complete' ELSE 'partial' END AS completeness_status
        FROM infrastructure_telemetry_events
       WHERE telemetry_type = 'capacity_sample'
         AND source_service = 'control-api'
         AND source_kind = 'trace_maintenance'
         AND interval_start >= $1::timestamptz
         AND interval_end <= $2::timestamptz
         AND desired_replicas IS NOT NULL
         AND cpu_request_cores IS NOT NULL
         AND memory_request_bytes IS NOT NULL
       ORDER BY environment, cluster_name, namespace, workload_kind, workload_ref,
                interval_start, event_id
    `,
    [dayStart(utcDay), dayEnd(utcDay)]
  )
  return result.rows as CapacitySampleRow[]
}

export async function persistRequestedCapacityDailyCosts(input: {
  db: DbClient
  repository?: MaintenanceCostRepository
  config: MaintenanceCostPersistenceConfig
  utcDay: string
  asOfUtc: string
}): Promise<PersistedDailyCostVersion[]> {
  const repository = input.repository ?? new MaintenanceCostRepository(input.db)
  const samples = await loadCapacitySamplesForDay(input.db, input.utcDay)
  const groups = new Map<string, { key: DailyCostKey; rows: CapacitySampleRow[] }>()
  for (const row of samples) {
    const key: DailyCostKey = {
      utcDay: row.utc_day,
      cloudProvider: 'gcp',
      cloudProjectId: input.config.cloudProjectId,
      clusterLocation: input.config.clusterLocation,
      clusterName: row.cluster_name,
      environment: row.environment,
      namespace: row.namespace,
      workloadKind: row.workload_kind,
      workloadRef: row.workload_ref,
      currency: input.config.currency,
    }
    const existing = groups.get(groupKey(key)) ?? { key, rows: [] }
    existing.rows.push(row)
    groups.set(groupKey(key), existing)
  }

  const persisted: PersistedDailyCostVersion[] = []
  for (const group of groups.values()) {
    const publicationState = publicationStateForRequestedCapacity({
      utcDay: input.utcDay,
      asOfUtc: input.asOfUtc,
      finalizationDelayHours: input.config.requestedCapacityFinalizationDelayHours ?? 24,
    })
    const completenessStatus =
      hasCompleteDayCoverage(group.rows, input.utcDay) &&
      group.rows.every(row => row.completeness_status === 'complete')
        ? 'complete'
        : 'partial'
    const firstInterval = toIsoTimestamp(group.rows[0]!.interval_start)
    const priceSnapshots = await repository.loadApprovedRequestedCapacityPriceSnapshots({
      key: group.key,
      clusterClass: input.config.clusterClass,
      effectiveAt: firstInterval,
    })
    const intervalVersions = group.rows.map(row =>
      estimateRequestedCapacityDaily({
        key: group.key,
        clusterClass: input.config.clusterClass,
        intervalStart: toIsoTimestamp(row.interval_start),
        intervalEnd: toIsoTimestamp(row.interval_end),
        asOfUtc: input.asOfUtc,
        desiredReplicas: row.desired_replicas,
        cpuRequestNanoCores: cpuCoresToNanoCores(row.cpu_request_cores),
        memoryRequestBytes: memoryBytes(row.memory_request_bytes),
        priceSnapshots,
        publicationState,
        completenessStatus: row.completeness_status,
        sourceCount: 1,
        sourceSha256: canonicalSha256({
          eventId: row.event_id,
          payloadSha256: row.payload_sha256,
        }),
      })
    )
    persisted.push(
      await repository.persistDailyCostVersion(
        aggregateRequestedCapacityVersions(
          group.key,
          intervalVersions,
          input.asOfUtc,
          completenessStatus
        )
      )
    )
  }
  return persisted
}

export async function persistNormalizedGcpBillingCosts(input: {
  repository: MaintenanceCostRepository
  rows: readonly NormalizedGcpBillingRow[]
  asOfUtc: string
  finalizationDelayHours: number
}): Promise<PersistedDailyCostVersion[]> {
  const groups = new Map<string, { key: DailyCostKey; rows: NormalizedGcpBillingRow[] }>()
  for (const row of input.rows) {
    const key: DailyCostKey = {
      utcDay: row.usageUtcDay,
      cloudProvider: 'gcp',
      cloudProjectId: row.cloudProjectId,
      clusterLocation: row.clusterLocation,
      clusterName: row.clusterName,
      environment: row.environment,
      namespace: row.namespace,
      workloadKind: row.workloadKind,
      workloadRef: row.workloadRef,
      currency: row.currency,
    }
    const existing = groups.get(groupKey(key)) ?? { key, rows: [] }
    existing.rows.push(row)
    groups.set(groupKey(key), existing)
  }
  const persisted: PersistedDailyCostVersion[] = []
  for (const group of groups.values()) {
    const finalizationDeadline =
      Date.parse(dayEnd(group.key.utcDay)) + input.finalizationDelayHours * 3_600_000
    const publicationState = group.rows.every(
      row => Date.parse(row.exportWatermark) >= finalizationDeadline
    )
      ? 'finalized'
      : 'provisional'
    persisted.push(
      await input.repository.persistDailyCostVersion(
        reconcileNormalizedGcpBilling({
          key: group.key,
          rows: group.rows,
          asOfUtc: input.asOfUtc,
          publicationState,
        })
      )
    )
  }
  return persisted
}

export async function runMaintenanceCostPersistence(input: {
  db: DbClient
  now?: Date
  config: MaintenanceCostPersistenceConfig
  normalizedGcpBillingRows?: readonly NormalizedGcpBillingRow[]
  priceSnapshots?: readonly InfrastructurePriceSnapshotEvidence[]
  gcpBillingFinalizationDelayHours?: number
}): Promise<MaintenanceCostPersistenceResult> {
  if (!input.config.enabled) return { ...EMPTY_RESULT, skippedReason: 'disabled' }
  if (
    !input.config.cloudProjectId ||
    !input.config.clusterLocation ||
    !input.config.clusterClass ||
    !input.config.currency
  ) {
    return { ...EMPTY_RESULT, skippedReason: 'missing_config' }
  }
  const now = input.now ?? new Date()
  const repository = new MaintenanceCostRepository(input.db)
  const priceSnapshotsInserted = await repository.persistPriceSnapshots(input.priceSnapshots ?? [])
  const requestedRange = closedUtcDayRange(now, input.config.requestedCapacityLookbackDays ?? 7)
  const requested: PersistedDailyCostVersion[] = []
  for (const utcDay of utcDaysInRange(requestedRange.startUtcDay, requestedRange.endUtcDay)) {
    requested.push(
      ...(await persistRequestedCapacityDailyCosts({
        db: input.db,
        repository,
        config: input.config,
        utcDay,
        asOfUtc: now.toISOString(),
      }))
    )
  }
  const billed = await persistNormalizedGcpBillingCosts({
    repository,
    rows: input.normalizedGcpBillingRows ?? [],
    asOfUtc: now.toISOString(),
    finalizationDelayHours: input.gcpBillingFinalizationDelayHours ?? 96,
  })
  return {
    priceSnapshotsInserted,
    requestedCapacityVersions: requested.length,
    billedVersions: billed.length,
    skippedReason: null,
  }
}

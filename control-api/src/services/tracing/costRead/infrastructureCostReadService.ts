import type { DbClient } from '../../../db.js'
import type {
  DailyCostComponent,
  DailyCostKey,
  PeriodCostSelection,
  PersistedDailyCostVersion,
} from '../maintenance/contracts.js'
import { Decimal9 } from '../maintenance/decimal.js'
import { selectPeriodCosts } from '../maintenance/periodSelection.js'

export type InfrastructureCostPeriod = 'day' | 'week' | 'month'
export type InfrastructureCostValuation = 'estimated' | 'billed' | 'variance'
export type InfrastructureCostBasis = 'requested_capacity' | 'gcp_request_allocation'

export type InfrastructureCostDimensions = Omit<DailyCostKey, 'utcDay'>

export interface InfrastructureCostReadQuery {
  period: InfrastructureCostPeriod
  periodStartUtc: string
  periodEndUtc: string
  valuation: InfrastructureCostValuation
  basis: InfrastructureCostBasis
  dimensions: InfrastructureCostDimensions
}

export interface InfrastructureCostReadResponse {
  period: InfrastructureCostPeriod
  periodStartUtc: string
  periodEndUtc: string
  dimensions: InfrastructureCostDimensions
  requestedCapacity: InfrastructureCostSelectionView | null
  gcpRequestAllocation: InfrastructureCostSelectionView | null
  variance?: {
    netAmount: string
    billedBasis: 'gcp_request_allocation'
    estimateBasis: 'requested_capacity'
  }
}

export interface InfrastructureCostScope {
  dimensions: InfrastructureCostDimensions
  firstUtcDay: string
  lastUtcDay: string
  availableValuations: readonly ('estimated' | 'billed')[]
  latestAsOfUtc: string
  billingExportWatermark: string | null
  billingLagHours: number | null
}

export interface InfrastructureCostScopeCatalog {
  scopes: readonly InfrastructureCostScope[]
  truncated: boolean
}

export interface InfrastructureCostSelectionView extends PeriodCostSelection {
  valuationKind: 'estimated' | 'billed'
  selectedBasis: 'requested_capacity' | 'gcp_request_allocation'
  asOfUtc: string
  billingExportWatermark: string | null
  billingLagHours: number | null
  billingFreshnessStatus: 'fresh' | 'stale' | 'unavailable' | 'not_applicable'
  components: readonly DailyCostComponent[]
}

type BillingFreshness = {
  status: 'fresh' | 'stale' | 'unavailable'
  lagHours: number | null
}

type DailyCostRow = {
  id: string
  utc_day: unknown
  cloud_provider: 'gcp'
  cloud_project_id: string
  cluster_location: string
  cluster_name: string
  environment: string
  namespace: string
  workload_kind: string
  workload_ref: string
  valuation_kind: 'estimated' | 'billed'
  selected_basis: 'requested_capacity' | 'gcp_request_allocation'
  currency: string
  rollup_version: number
  predecessor_version: number | null
  publication_state: 'provisional' | 'finalized'
  completeness_status: 'complete' | 'partial' | 'unavailable'
  as_of_utc: unknown
  source_interval_start: unknown | null
  source_interval_end: unknown | null
  billing_export_watermark: unknown | null
  source_count: string | number
  source_sha256: string
  gross_amount: string
  credits_amount: string
  net_amount: string
}

type DailyCostComponentRow = {
  daily_cost_id: string
  component_key: string
  resource_class: DailyCostComponent['resourceClass']
  allocation_bucket: DailyCostComponent['allocationBucket']
  unit_hours: string | null
  price_snapshot_id: string | null
  provider_service: string | null
  provider_sku: string | null
  billing_view_version: string | null
  source_row_count: string | number | null
  source_sha256: string
  billing_export_watermark: unknown | null
  gross_amount: string
  credits_amount: string
  net_amount: string
  price_source_ref: string | null
  price_effective_from: unknown | null
  price_unit_price: string | null
}

type InfrastructureCostScopeRow = {
  cloud_provider: 'gcp'
  cloud_project_id: string
  cluster_location: string
  cluster_name: string
  environment: string
  namespace: string
  workload_kind: string
  workload_ref: string
  currency: string
  first_utc_day: unknown
  last_utc_day: unknown
  has_estimated: boolean
  has_billed: boolean
  latest_as_of_utc: unknown
  billing_export_watermark: unknown | null
  billing_lag_hours: string | number | null
}

const MAX_SCOPE_CATALOG_ENTRIES = 200
const SCOPE_CATALOG_LOOKBACK_DAYS = 90

function toUtcDay(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  throw new Error('unexpected infrastructure cost utc_day value')
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === 'string') return new Date(value).toISOString()
  if (value instanceof Date) return value.toISOString()
  throw new Error('unexpected infrastructure cost timestamp value')
}

function toNullableIsoTimestamp(value: unknown | null): string | null {
  return value === null ? null : toIsoTimestamp(value)
}

function sourceCount(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : Number(value)
}

function nullableHours(value: string | number | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error('unexpected infrastructure cost lag value')
  return Math.max(0, Math.round(parsed * 1000) / 1000)
}

function periodDayCount(periodStartUtc: string, periodEndUtc: string): number {
  const start = Date.parse(`${periodStartUtc}T00:00:00.000Z`)
  const end = Date.parse(`${periodEndUtc}T00:00:00.000Z`)
  return Math.round((end - start) / 86_400_000)
}

function maxIso(values: readonly string[]): string {
  return values.reduce((max, value) => (value > max ? value : max))
}

function latestBillingWatermark(versions: readonly PersistedDailyCostVersion[]): string | null {
  const watermarks = versions
    .map(version => version.billingExportWatermark)
    .filter((value): value is string => value !== null)
  return watermarks.length === 0 ? null : maxIso(watermarks)
}

function toDailyVersion(
  row: DailyCostRow,
  components: readonly DailyCostComponent[]
): PersistedDailyCostVersion {
  return {
    id: row.id,
    rollupVersion: row.rollup_version,
    predecessorVersion: row.predecessor_version,
    key: {
      utcDay: toUtcDay(row.utc_day),
      cloudProvider: row.cloud_provider,
      cloudProjectId: row.cloud_project_id,
      clusterLocation: row.cluster_location,
      clusterName: row.cluster_name,
      environment: row.environment,
      namespace: row.namespace,
      workloadKind: row.workload_kind,
      workloadRef: row.workload_ref,
      currency: row.currency,
    },
    valuationKind: row.valuation_kind,
    selectedBasis: row.selected_basis,
    publicationState: row.publication_state,
    completenessStatus: row.completeness_status,
    asOfUtc: toIsoTimestamp(row.as_of_utc),
    sourceIntervalStart: toNullableIsoTimestamp(row.source_interval_start),
    sourceIntervalEnd: toNullableIsoTimestamp(row.source_interval_end),
    billingExportWatermark: toNullableIsoTimestamp(row.billing_export_watermark),
    sourceCount: sourceCount(row.source_count) ?? 0,
    sourceSha256: row.source_sha256,
    grossAmount: row.gross_amount,
    creditsAmount: row.credits_amount,
    netAmount: row.net_amount,
    components,
  }
}

function toComponent(row: DailyCostComponentRow): DailyCostComponent {
  return {
    componentKey: row.component_key,
    resourceClass: row.resource_class,
    allocationBucket: row.allocation_bucket,
    unitHours: row.unit_hours,
    priceSnapshotId: row.price_snapshot_id,
    providerService: row.provider_service,
    providerSku: row.provider_sku,
    billingViewVersion: row.billing_view_version,
    sourceRowCount: sourceCount(row.source_row_count),
    sourceSha256: row.source_sha256,
    billingExportWatermark: toNullableIsoTimestamp(row.billing_export_watermark),
    grossAmount: row.gross_amount,
    creditsAmount: row.credits_amount,
    netAmount: row.net_amount,
    priceSourceRef: row.price_source_ref,
    priceEffectiveFrom: toNullableIsoTimestamp(row.price_effective_from),
    priceUnitPrice: row.price_unit_price,
  }
}

function selectionView(
  query: InfrastructureCostReadQuery,
  versions: readonly PersistedDailyCostVersion[],
  billingFreshness: BillingFreshness
): InfrastructureCostSelectionView | null {
  if (versions.length === 0) return null
  const selected = selectPeriodCosts(
    query.period,
    query.periodStartUtc,
    query.periodEndUtc,
    versions
  )
  const asOfUtc = maxIso(versions.map(version => version.asOfUtc))
  const billingExportWatermark = latestBillingWatermark(versions)
  return {
    ...selected,
    valuationKind: versions[0]!.valuationKind as 'estimated' | 'billed',
    selectedBasis: versions[0]!.selectedBasis as 'requested_capacity' | 'gcp_request_allocation',
    asOfUtc,
    billingExportWatermark,
    billingLagHours: versions[0]!.valuationKind === 'billed' ? billingFreshness.lagHours : null,
    billingFreshnessStatus:
      versions[0]!.valuationKind === 'billed' ? billingFreshness.status : 'not_applicable',
    components: versions.flatMap(version =>
      version.components.map(component => ({
        ...component,
        componentKey: `${version.key.utcDay}:${component.componentKey}`,
      }))
    ),
  }
}

function completeComparable(
  expectedDays: number,
  requestedCapacity: InfrastructureCostSelectionView | null,
  gcpRequestAllocation: InfrastructureCostSelectionView | null
): boolean {
  return (
    requestedCapacity !== null &&
    gcpRequestAllocation !== null &&
    gcpRequestAllocation.billingFreshnessStatus === 'fresh' &&
    requestedCapacity.completenessStatus === 'complete' &&
    gcpRequestAllocation.completenessStatus === 'complete' &&
    requestedCapacity.dailyVersionVector.length === expectedDays &&
    gcpRequestAllocation.dailyVersionVector.length === expectedDays
  )
}

function varianceNetAmount(
  requestedCapacity: InfrastructureCostSelectionView,
  gcpRequestAllocation: InfrastructureCostSelectionView
): string {
  return Decimal9.parse(gcpRequestAllocation.netAmount)
    .subtract(Decimal9.parse(requestedCapacity.netAmount))
    .toString()
}

export class InfrastructureCostReadService {
  constructor(
    private readonly db: DbClient,
    private readonly maximumBillingLagHours = 96
  ) {}

  private async currentBillingFreshness(
    dimensions: InfrastructureCostDimensions
  ): Promise<BillingFreshness> {
    const result = await this.db.query(
      `
        SELECT MAX(billing_export_watermark) AS billing_export_watermark,
               CASE WHEN MAX(billing_export_watermark) IS NULL THEN NULL
                    ELSE GREATEST(
                      0,
                      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(billing_export_watermark))) / 3600
                    )
                END AS billing_lag_hours
          FROM infrastructure_cost_daily
         WHERE cloud_provider = $1
           AND cloud_project_id = $2
           AND cluster_location = $3
           AND cluster_name = $4
           AND environment = $5
           AND namespace = $6
           AND workload_kind = $7
           AND workload_ref = $8
           AND currency = $9
           AND valuation_kind = 'billed'
           AND selected_basis = 'gcp_request_allocation'
           AND utc_day >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $10::integer
      `,
      [
        dimensions.cloudProvider,
        dimensions.cloudProjectId,
        dimensions.clusterLocation,
        dimensions.clusterName,
        dimensions.environment,
        dimensions.namespace,
        dimensions.workloadKind,
        dimensions.workloadRef,
        dimensions.currency,
        SCOPE_CATALOG_LOOKBACK_DAYS,
      ]
    )
    const row = result.rows[0] as
      | { billing_export_watermark: unknown | null; billing_lag_hours: string | number | null }
      | undefined
    const lagHours = nullableHours(row?.billing_lag_hours ?? null)
    if (!row?.billing_export_watermark || lagHours === null) {
      return { status: 'unavailable', lagHours: null }
    }
    return {
      status: lagHours <= this.maximumBillingLagHours ? 'fresh' : 'stale',
      lagHours,
    }
  }

  async listScopes(): Promise<InfrastructureCostScopeCatalog> {
    const result = await this.db.query(
      `
        SELECT cloud_provider, cloud_project_id, cluster_location, cluster_name,
               environment, namespace, workload_kind, workload_ref, currency,
               MIN(utc_day) AS first_utc_day,
               MAX(utc_day) AS last_utc_day,
               BOOL_OR(valuation_kind = 'estimated') AS has_estimated,
               BOOL_OR(valuation_kind = 'billed') AS has_billed,
               MAX(as_of_utc) AS latest_as_of_utc,
               MAX(billing_export_watermark) AS billing_export_watermark,
               CASE WHEN MAX(billing_export_watermark) IS NULL THEN NULL
                    ELSE GREATEST(
                      0,
                      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(billing_export_watermark))) / 3600
                    )
                END AS billing_lag_hours
          FROM infrastructure_cost_daily
         WHERE utc_day >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $1::integer
         GROUP BY cloud_provider, cloud_project_id, cluster_location, cluster_name,
                  environment, namespace, workload_kind, workload_ref, currency
         ORDER BY last_utc_day DESC, latest_as_of_utc DESC,
                  environment, cluster_name, namespace, workload_kind, workload_ref, currency
         LIMIT $2
      `,
      [SCOPE_CATALOG_LOOKBACK_DAYS, MAX_SCOPE_CATALOG_ENTRIES + 1]
    )
    const rows = result.rows as InfrastructureCostScopeRow[]
    return {
      scopes: rows.slice(0, MAX_SCOPE_CATALOG_ENTRIES).map(row => ({
        dimensions: {
          cloudProvider: row.cloud_provider,
          cloudProjectId: row.cloud_project_id,
          clusterLocation: row.cluster_location,
          clusterName: row.cluster_name,
          environment: row.environment,
          namespace: row.namespace,
          workloadKind: row.workload_kind,
          workloadRef: row.workload_ref,
          currency: row.currency,
        },
        firstUtcDay: toUtcDay(row.first_utc_day),
        lastUtcDay: toUtcDay(row.last_utc_day),
        availableValuations: [
          ...(row.has_estimated ? (['estimated'] as const) : []),
          ...(row.has_billed ? (['billed'] as const) : []),
        ],
        latestAsOfUtc: toIsoTimestamp(row.latest_as_of_utc),
        billingExportWatermark: toNullableIsoTimestamp(row.billing_export_watermark),
        billingLagHours: nullableHours(row.billing_lag_hours),
      })),
      truncated: rows.length > MAX_SCOPE_CATALOG_ENTRIES,
    }
  }

  async read(query: InfrastructureCostReadQuery): Promise<InfrastructureCostReadResponse> {
    const dailyResult = await this.db.query(
      `
        WITH ranked AS (
          SELECT d.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY d.utc_day, d.valuation_kind, d.selected_basis
                   ORDER BY d.rollup_version DESC
                 ) AS selected_rank
            FROM infrastructure_cost_daily d
           WHERE d.utc_day >= $1::date
             AND d.utc_day < $2::date
             AND d.cloud_provider = $3
             AND d.cloud_project_id = $4
             AND d.cluster_location = $5
             AND d.cluster_name = $6
             AND d.environment = $7
             AND d.namespace = $8
             AND d.workload_kind = $9
             AND d.workload_ref = $10
             AND d.currency = $11
             AND (
               ($12 = 'variance' AND (
                 (d.valuation_kind = 'estimated' AND d.selected_basis = 'requested_capacity')
                 OR (d.valuation_kind = 'billed' AND d.selected_basis = 'gcp_request_allocation')
               ))
               OR ($12 = d.valuation_kind AND $13 = d.selected_basis)
             )
        )
        SELECT *
          FROM ranked
         WHERE selected_rank = 1
         ORDER BY utc_day ASC, valuation_kind ASC, selected_basis ASC
      `,
      [
        query.periodStartUtc,
        query.periodEndUtc,
        query.dimensions.cloudProvider,
        query.dimensions.cloudProjectId,
        query.dimensions.clusterLocation,
        query.dimensions.clusterName,
        query.dimensions.environment,
        query.dimensions.namespace,
        query.dimensions.workloadKind,
        query.dimensions.workloadRef,
        query.dimensions.currency,
        query.valuation,
        query.basis,
      ]
    )
    const dailyRows = dailyResult.rows as DailyCostRow[]
    const ids = dailyRows.map(row => row.id)
    const billingFreshness = dailyRows.some(row => row.valuation_kind === 'billed')
      ? await this.currentBillingFreshness(query.dimensions)
      : { status: 'unavailable' as const, lagHours: null }
    const componentRows =
      ids.length === 0
        ? []
        : ((
            await this.db.query(
              `
              SELECT c.*,
                     price.source_ref AS price_source_ref,
                     price.effective_from AS price_effective_from,
                     price.unit_price::text AS price_unit_price
                FROM infrastructure_cost_daily_components c
                LEFT JOIN infrastructure_price_snapshots price
                  ON price.id = c.price_snapshot_id
               WHERE c.daily_cost_id = ANY($1::uuid[])
               ORDER BY c.daily_cost_id ASC, c.component_key ASC
            `,
              [ids]
            )
          ).rows as DailyCostComponentRow[])
    const componentsByDailyId = new Map<string, DailyCostComponent[]>()
    for (const row of componentRows) {
      const components = componentsByDailyId.get(row.daily_cost_id) ?? []
      components.push(toComponent(row))
      componentsByDailyId.set(row.daily_cost_id, components)
    }
    const versions = dailyRows.map(row =>
      toDailyVersion(row, componentsByDailyId.get(row.id) ?? [])
    )
    const requestedCapacity = selectionView(
      query,
      versions.filter(version => version.selectedBasis === 'requested_capacity'),
      billingFreshness
    )
    const gcpRequestAllocation = selectionView(
      query,
      versions.filter(version => version.selectedBasis === 'gcp_request_allocation'),
      billingFreshness
    )
    const response: InfrastructureCostReadResponse = {
      period: query.period,
      periodStartUtc: query.periodStartUtc,
      periodEndUtc: query.periodEndUtc,
      dimensions: query.dimensions,
      requestedCapacity,
      gcpRequestAllocation,
    }
    if (
      completeComparable(
        periodDayCount(query.periodStartUtc, query.periodEndUtc),
        requestedCapacity,
        gcpRequestAllocation
      )
    ) {
      response.variance = {
        netAmount: varianceNetAmount(requestedCapacity!, gcpRequestAllocation!),
        billedBasis: 'gcp_request_allocation',
        estimateBasis: 'requested_capacity',
      }
    }
    return response
  }
}

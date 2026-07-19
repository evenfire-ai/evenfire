import type { DbClient } from '../../../db.js'
import type {
  DailyCostComponent,
  DailyCostKey,
  DailyCostVersion,
  InfrastructurePriceSnapshot,
  InfrastructurePriceSnapshotEvidence,
  PersistedDailyCostVersion,
} from './contracts.js'
import { Decimal9, sumDecimals } from './decimal.js'

type DailyCostRow = {
  id: string
  rollup_version: number
  predecessor_version: number | null
  publication_state: string
  source_sha256: string
}

type PriceSnapshotRow = {
  id: string
  cloud_provider: 'gcp'
  cloud_project_id: string
  region: string
  cluster_class: string
  resource_class: 'cpu' | 'memory'
  unit: 'vCPU_hour' | 'GiB_hour'
  unit_price: string
  currency: string
  effective_from: Date | string
  source_ref: string
  source_sha256: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertDailyCostRow(value: unknown): DailyCostRow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.rollup_version !== 'number' ||
    (typeof value.predecessor_version !== 'number' && value.predecessor_version !== null) ||
    typeof value.publication_state !== 'string' ||
    typeof value.source_sha256 !== 'string'
  ) {
    throw new Error('infrastructure_cost_daily returned an unexpected schema')
  }
  return value as DailyCostRow
}

function toIsoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('price snapshot timestamp is invalid')
  return new Date(timestamp).toISOString()
}

function mapPriceSnapshot(row: PriceSnapshotRow): InfrastructurePriceSnapshot {
  return {
    id: row.id,
    cloudProvider: row.cloud_provider,
    cloudProjectId: row.cloud_project_id,
    region: row.region,
    clusterClass: row.cluster_class,
    resourceClass: row.resource_class,
    unit: row.unit,
    unitPrice: row.unit_price,
    currency: row.currency,
    effectiveFrom: toIsoTimestamp(row.effective_from),
    sourceRef: row.source_ref,
    sourceSha256: row.source_sha256,
  }
}

function assertExactConservation(version: DailyCostVersion): void {
  if (version.components.length === 0) {
    throw new Error('infrastructure cost versions require at least one component')
  }
  const componentKeys = new Set<string>()
  for (const component of version.components) {
    if (componentKeys.has(component.componentKey)) {
      throw new Error(`duplicate infrastructure cost component ${component.componentKey}`)
    }
    componentKeys.add(component.componentKey)
    const componentNet = Decimal9.parse(component.grossAmount).add(
      Decimal9.parse(component.creditsAmount)
    )
    if (componentNet.compare(Decimal9.parse(component.netAmount)) !== 0) {
      throw new Error(`component ${component.componentKey} does not conserve net amount`)
    }
  }

  const gross = sumDecimals(
    version.components.map(component => Decimal9.parse(component.grossAmount))
  )
  const credits = sumDecimals(
    version.components.map(component => Decimal9.parse(component.creditsAmount))
  )
  const net = sumDecimals(version.components.map(component => Decimal9.parse(component.netAmount)))
  if (
    gross.compare(Decimal9.parse(version.grossAmount)) !== 0 ||
    credits.compare(Decimal9.parse(version.creditsAmount)) !== 0 ||
    net.compare(Decimal9.parse(version.netAmount)) !== 0
  ) {
    throw new Error('infrastructure cost header and components must conserve exactly')
  }
}

function keyValues(key: DailyCostKey): unknown[] {
  return [
    key.utcDay,
    key.cloudProvider,
    key.cloudProjectId,
    key.clusterLocation,
    key.clusterName,
    key.environment,
    key.namespace,
    key.workloadKind,
    key.workloadRef,
    key.currency,
  ]
}

export class MaintenanceCostRepository {
  constructor(private readonly db: DbClient) {}

  async persistPriceSnapshots(
    snapshots: readonly InfrastructurePriceSnapshotEvidence[]
  ): Promise<number> {
    if (snapshots.length === 0) return 0
    const rows = snapshots.map(snapshot => {
      if (snapshot.cloudProvider !== 'gcp') throw new Error('unsupported price provider')
      if (!['cpu', 'memory'].includes(snapshot.resourceClass)) {
        throw new Error('unsupported price resource class')
      }
      if (
        (snapshot.resourceClass === 'cpu' && snapshot.unit !== 'vCPU_hour') ||
        (snapshot.resourceClass === 'memory' && snapshot.unit !== 'GiB_hour')
      ) {
        throw new Error('price unit does not match its resource class')
      }
      if (Decimal9.parse(snapshot.unitPrice).units < 0n) {
        throw new Error('price snapshot cannot be negative')
      }
      if (!/^[A-Z]{3}$/.test(snapshot.currency)) throw new Error('price currency is invalid')
      if (!/^[0-9a-f]{64}$/.test(snapshot.sourceSha256)) {
        throw new Error('price source hash is invalid')
      }
      return {
        cloud_provider: snapshot.cloudProvider,
        cloud_project_id: snapshot.cloudProjectId,
        region: snapshot.region,
        cluster_class: snapshot.clusterClass,
        resource_class: snapshot.resourceClass,
        unit: snapshot.unit,
        unit_price: snapshot.unitPrice,
        currency: snapshot.currency,
        effective_from: toIsoTimestamp(snapshot.effectiveFrom),
        source_ref: snapshot.sourceRef,
        source_sha256: snapshot.sourceSha256,
      }
    })
    const result = await this.db.query(
      `
        INSERT INTO infrastructure_price_snapshots (
          cloud_provider, cloud_project_id, region, cluster_class, resource_class,
          unit, unit_price, currency, effective_from, source_ref, source_sha256
        )
        SELECT price.cloud_provider, price.cloud_project_id, price.region,
               price.cluster_class, price.resource_class, price.unit,
               price.unit_price::numeric, price.currency,
               price.effective_from::timestamptz, price.source_ref, price.source_sha256
          FROM jsonb_to_recordset($1::jsonb) AS price(
            cloud_provider text, cloud_project_id text, region text,
            cluster_class text, resource_class text, unit text,
            unit_price text, currency text, effective_from text,
            source_ref text, source_sha256 text
          )
        ON CONFLICT (
          cloud_provider, cloud_project_id, region, cluster_class, resource_class,
          unit, currency, effective_from, source_sha256
        ) DO NOTHING
        RETURNING id
      `,
      [JSON.stringify(rows)]
    )
    return result.rowCount ?? 0
  }

  async loadApprovedRequestedCapacityPriceSnapshots(input: {
    key: DailyCostKey
    clusterClass: string
    effectiveAt: string
  }): Promise<InfrastructurePriceSnapshot[]> {
    const result = await this.db.query(
      `
        SELECT id::text, cloud_provider, cloud_project_id, region, cluster_class,
               resource_class, unit, unit_price::text, currency, effective_from,
               source_ref, source_sha256
          FROM infrastructure_price_snapshots
         WHERE cloud_provider = $1
           AND cloud_project_id = $2
           AND region = $3
           AND cluster_class = $4
           AND currency = $5
           AND resource_class IN ('cpu', 'memory')
           AND unit IN ('vCPU_hour', 'GiB_hour')
           AND effective_from <= $6::timestamptz
         ORDER BY resource_class ASC, effective_from DESC, id ASC
      `,
      [
        input.key.cloudProvider,
        input.key.cloudProjectId,
        input.key.clusterLocation,
        input.clusterClass,
        input.key.currency,
        input.effectiveAt,
      ]
    )
    const rows = result.rows as PriceSnapshotRow[]
    const selected = (['cpu', 'memory'] as const).flatMap(resourceClass => {
      const candidates = rows.filter(row => row.resource_class === resourceClass)
      const latest = candidates[0]?.effective_from
      if (!latest) return []
      return candidates.filter(row => toIsoTimestamp(row.effective_from) === toIsoTimestamp(latest))
    })
    if (selected.length !== 2 || new Set(selected.map(row => row.resource_class)).size !== 2) {
      throw new Error('requested-capacity pricing is missing or ambiguous')
    }
    return selected.map(mapPriceSnapshot)
  }

  async persistDailyCostVersion(version: DailyCostVersion): Promise<PersistedDailyCostVersion> {
    assertExactConservation(version)
    const latest = await this.latestVersionForUpdate(version)
    if (latest?.publication_state === 'finalized' && version.publicationState !== 'finalized') {
      throw new Error('infrastructure cost finality cannot regress')
    }
    if (
      latest?.source_sha256 === version.sourceSha256 &&
      latest.publication_state === version.publicationState
    ) {
      return {
        ...version,
        id: latest.id,
        rollupVersion: latest.rollup_version,
        predecessorVersion: latest.predecessor_version,
      }
    }
    const rollupVersion = latest ? latest.rollup_version + 1 : 1
    const predecessorVersion = latest?.rollup_version ?? null
    const inserted = await this.db.query(
      `
        INSERT INTO infrastructure_cost_daily (
          utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name,
          environment, namespace, workload_kind, workload_ref, valuation_kind,
          selected_basis, currency, rollup_version, predecessor_version,
          publication_state, completeness_status, as_of_utc, source_interval_start,
          source_interval_end, billing_export_watermark, source_count, source_sha256,
          gross_amount, credits_amount, net_amount
        )
        VALUES (
          $1::date, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12, $10,
          $13, $14, $15, $16, $17::timestamptz, $18::timestamptz,
          $19::timestamptz, $20::timestamptz, $21, $22, $23, $24, $25
        )
        RETURNING id::text, rollup_version, predecessor_version, publication_state, source_sha256
      `,
      [
        ...keyValues(version.key),
        version.valuationKind,
        version.selectedBasis,
        rollupVersion,
        predecessorVersion,
        version.publicationState,
        version.completenessStatus,
        version.asOfUtc,
        version.sourceIntervalStart,
        version.sourceIntervalEnd,
        version.billingExportWatermark,
        version.sourceCount,
        version.sourceSha256,
        version.grossAmount,
        version.creditsAmount,
        version.netAmount,
      ]
    )
    if (inserted.rowCount !== 1) throw new Error('infrastructure cost header insert failed')
    const header = assertDailyCostRow(inserted.rows[0])
    await this.insertComponents(header.id, version)
    return {
      ...version,
      id: header.id,
      rollupVersion: header.rollup_version,
      predecessorVersion: header.predecessor_version,
    }
  }

  private async latestVersionForUpdate(version: DailyCostVersion): Promise<DailyCostRow | null> {
    const result = await this.db.query(
      `
        SELECT id::text, rollup_version, predecessor_version, publication_state, source_sha256
          FROM infrastructure_cost_daily
         WHERE utc_day = $1::date
           AND cloud_provider = $2
           AND cloud_project_id = $3
           AND cluster_location = $4
           AND cluster_name = $5
           AND environment = $6
           AND namespace = $7
           AND workload_kind = $8
           AND workload_ref = $9
           AND currency = $10
           AND valuation_kind = $11
           AND selected_basis = $12
         ORDER BY rollup_version DESC
         LIMIT 1
         FOR UPDATE
      `,
      [...keyValues(version.key), version.valuationKind, version.selectedBasis]
    )
    if (result.rows.length === 0) return null
    return assertDailyCostRow(result.rows[0])
  }

  private async insertComponents(dailyCostId: string, version: DailyCostVersion): Promise<void> {
    const rows = version.components.map(component => ({
      daily_cost_id: dailyCostId,
      valuation_kind: version.valuationKind,
      selected_basis: version.selectedBasis,
      component_key: component.componentKey,
      resource_class: component.resourceClass,
      allocation_bucket: component.allocationBucket,
      unit_hours: component.unitHours,
      price_snapshot_id: component.priceSnapshotId,
      provider_service: component.providerService,
      provider_sku: component.providerSku,
      billing_view_version: component.billingViewVersion,
      source_row_count: component.sourceRowCount,
      source_sha256: component.sourceSha256,
      billing_export_watermark: component.billingExportWatermark,
      gross_amount: component.grossAmount,
      credits_amount: component.creditsAmount,
      net_amount: component.netAmount,
    }))
    const result = await this.db.query(
      `
        INSERT INTO infrastructure_cost_daily_components (
          daily_cost_id, valuation_kind, selected_basis, component_key, resource_class,
          allocation_bucket, unit_hours, price_snapshot_id, provider_service, provider_sku,
          billing_view_version, source_row_count, source_sha256, billing_export_watermark,
          gross_amount, credits_amount, net_amount
        )
        SELECT component.daily_cost_id, component.valuation_kind, component.selected_basis,
               component.component_key, component.resource_class, component.allocation_bucket,
               component.unit_hours, component.price_snapshot_id, component.provider_service,
               component.provider_sku, component.billing_view_version,
               component.source_row_count, component.source_sha256,
               component.billing_export_watermark, component.gross_amount,
               component.credits_amount, component.net_amount
          FROM jsonb_to_recordset($1::jsonb) AS component(
            daily_cost_id uuid, valuation_kind text, selected_basis text,
            component_key text, resource_class text, allocation_bucket text,
            unit_hours numeric, price_snapshot_id uuid, provider_service text,
            provider_sku text, billing_view_version text, source_row_count bigint,
            source_sha256 text, billing_export_watermark timestamptz,
            gross_amount numeric, credits_amount numeric, net_amount numeric
          )
      `,
      [JSON.stringify(rows)]
    )
    if (result.rowCount !== version.components.length) {
      throw new Error('infrastructure cost component insert count mismatch')
    }
  }
}

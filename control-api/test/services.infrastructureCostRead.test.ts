import { describe, expect, it, vi } from 'vitest'
import { InfrastructureCostReadService } from '../src/services/tracing/costRead/infrastructureCostReadService.js'

const sha = 'a'.repeat(64)
const dimensions = {
  cloudProvider: 'gcp' as const,
  cloudProjectId: 'project-1',
  clusterLocation: 'europe-west1',
  clusterName: 'cluster-1',
  environment: 'test',
  namespace: 'control-plane',
  workloadKind: 'Deployment',
  workloadRef: 'control-api',
  currency: 'USD',
}

function dailyRow(
  id: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const valuationKind = overrides.valuation_kind ?? 'estimated'
  const selectedBasis = overrides.selected_basis ?? 'requested_capacity'
  return {
    id,
    utc_day: '2026-07-10',
    cloud_provider: dimensions.cloudProvider,
    cloud_project_id: dimensions.cloudProjectId,
    cluster_location: dimensions.clusterLocation,
    cluster_name: dimensions.clusterName,
    environment: dimensions.environment,
    namespace: dimensions.namespace,
    workload_kind: dimensions.workloadKind,
    workload_ref: dimensions.workloadRef,
    valuation_kind: valuationKind,
    selected_basis: selectedBasis,
    currency: dimensions.currency,
    rollup_version: 2,
    predecessor_version: 1,
    publication_state: 'finalized',
    completeness_status: 'complete',
    as_of_utc: '2026-07-11T01:00:00.000Z',
    source_interval_start: valuationKind === 'estimated' ? '2026-07-10T00:00:00.000Z' : null,
    source_interval_end: valuationKind === 'estimated' ? '2026-07-11T00:00:00.000Z' : null,
    billing_export_watermark: valuationKind === 'billed' ? '2026-07-11T00:00:00.000Z' : null,
    source_count: 1,
    source_sha256: sha,
    gross_amount: '10.000000000',
    credits_amount: '0.000000000',
    net_amount: '10.000000000',
    ...overrides,
  }
}

function componentRow(
  dailyCostId: string,
  componentKey: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const valuationKind = overrides.valuation_kind ?? 'billed'
  const selectedBasis = overrides.selected_basis ?? 'gcp_request_allocation'
  return {
    daily_cost_id: dailyCostId,
    valuation_kind: valuationKind,
    selected_basis: selectedBasis,
    component_key: componentKey,
    resource_class: 'allocation_bucket',
    allocation_bucket: 'kube:unallocated',
    unit_hours: null,
    price_snapshot_id: null,
    provider_service: 'GKE',
    provider_sku: 'compute',
    billing_view_version: 'v1',
    source_row_count: 1,
    source_sha256: sha,
    billing_export_watermark: '2026-07-11T00:00:00.000Z',
    gross_amount: '2.000000000',
    credits_amount: '0.000000000',
    net_amount: '2.000000000',
    price_source_ref: null,
    price_effective_from: null,
    price_unit_price: null,
    ...overrides,
  }
}

describe('InfrastructureCostReadService', () => {
  it('lists a bounded persisted scope catalog without querying GCP', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          cloud_provider: 'gcp',
          cloud_project_id: 'project-1',
          cluster_location: 'europe-west1',
          cluster_name: 'cluster-1',
          environment: 'test',
          namespace: 'control-plane',
          workload_kind: 'Deployment',
          workload_ref: 'control-api',
          currency: 'USD',
          first_utc_day: '2026-07-01',
          last_utc_day: new Date('2026-07-11T00:00:00.000Z'),
          has_estimated: true,
          has_billed: true,
          latest_as_of_utc: '2026-07-12T01:00:00.000Z',
          billing_export_watermark: new Date('2026-07-12T00:00:00.000Z'),
          billing_lag_hours: '2.1254',
        },
      ],
      rowCount: 1,
    })
    const service = new InfrastructureCostReadService({ query })

    await expect(service.listScopes()).resolves.toEqual({
      scopes: [
        {
          dimensions,
          firstUtcDay: '2026-07-01',
          lastUtcDay: '2026-07-11',
          availableValuations: ['estimated', 'billed'],
          latestAsOfUtc: '2026-07-12T01:00:00.000Z',
          billingExportWatermark: '2026-07-12T00:00:00.000Z',
          billingLagHours: 2.125,
        },
      ],
      truncated: false,
    })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM infrastructure_cost_daily'),
      [90, 201]
    )
    expect(query.mock.calls[0]![0]).toContain(
      "utc_day >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $1::integer"
    )
    expect(query.mock.calls[0]![0]).toContain('LIMIT $2')
    expect(query.mock.calls[0]![0]).not.toContain('BigQuery')
  })

  it('reads selected daily versions set-wise and suppresses variance for stale billing evidence', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          dailyRow('estimate-v2', {
            valuation_kind: 'estimated',
            selected_basis: 'requested_capacity',
            net_amount: '10.000000000',
          }),
          dailyRow('billed-v2', {
            valuation_kind: 'billed',
            selected_basis: 'gcp_request_allocation',
            net_amount: '12.000000000',
          }),
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            billing_export_watermark: '2026-07-11T00:00:00.000Z',
            billing_lag_hours: '120',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          componentRow('estimate-v2', 'cpu', {
            resource_class: 'cpu',
            allocation_bucket: null,
            price_snapshot_id: '11111111-1111-4111-8111-111111111111',
            price_source_ref: 'pricing-export:2026-07-10:cpu',
            price_effective_from: '2026-07-10T00:00:00.000Z',
            price_unit_price: '0.031611000',
            gross_amount: '10.000000000',
            net_amount: '10.000000000',
          }),
          componentRow('billed-v2', 'unallocated', {
            gross_amount: '2.000000000',
            net_amount: '2.000000000',
          }),
        ],
        rowCount: 1,
      })
    const service = new InfrastructureCostReadService({ query })

    const result = await service.read({
      period: 'day',
      periodStartUtc: '2026-07-10',
      periodEndUtc: '2026-07-11',
      valuation: 'variance',
      basis: 'requested_capacity',
      dimensions,
    })

    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0]![0]).toContain('ROW_NUMBER() OVER')
    expect(query.mock.calls[0]![0]).toContain(
      'PARTITION BY d.utc_day, d.valuation_kind, d.selected_basis'
    )
    expect(query.mock.calls[0]![0]).toContain('d.utc_day >= $1::date')
    expect(query.mock.calls[0]![0]).not.toContain(dimensions.workloadRef)
    expect(query.mock.calls[0]![1]).toEqual([
      '2026-07-10',
      '2026-07-11',
      'gcp',
      'project-1',
      'europe-west1',
      'cluster-1',
      'test',
      'control-plane',
      'Deployment',
      'control-api',
      'USD',
      'variance',
      'requested_capacity',
    ])
    expect(query.mock.calls[1]![0]).toContain('MAX(billing_export_watermark)')
    expect(query.mock.calls[2]![0]).toContain('daily_cost_id = ANY($1::uuid[])')
    expect(query.mock.calls[2]![0]).toContain('LEFT JOIN infrastructure_price_snapshots')
    expect(query.mock.calls[2]![1]).toEqual([['estimate-v2', 'billed-v2']])
    expect(result.requestedCapacity).toMatchObject({
      selectedBasis: 'requested_capacity',
      netAmount: '10.000000000',
      completenessStatus: 'complete',
    })
    expect(result.gcpRequestAllocation).toMatchObject({
      selectedBasis: 'gcp_request_allocation',
      netAmount: '12.000000000',
      completenessStatus: 'complete',
      unallocatedAmount: '2.000000000',
      billingExportWatermark: '2026-07-11T00:00:00.000Z',
      billingLagHours: 120,
      billingFreshnessStatus: 'stale',
    })
    expect(result.requestedCapacity?.components).toEqual([
      expect.objectContaining({
        componentKey: '2026-07-10:cpu',
        sourceSha256: sha,
        priceSourceRef: 'pricing-export:2026-07-10:cpu',
        priceEffectiveFrom: '2026-07-10T00:00:00.000Z',
        priceUnitPrice: '0.031611000',
      }),
    ])
    expect(result.gcpRequestAllocation?.components).toEqual([
      expect.objectContaining({ componentKey: '2026-07-10:unallocated', sourceSha256: sha }),
    ])
    expect(result).not.toHaveProperty('variance')
  })

  it('reports billed-minus-requested variance for complete matching daily coverage', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          dailyRow('estimate-v2', {
            valuation_kind: 'estimated',
            selected_basis: 'requested_capacity',
            net_amount: '10.000000000',
          }),
          dailyRow('billed-v2', {
            valuation_kind: 'billed',
            selected_basis: 'gcp_request_allocation',
            net_amount: '12.250000000',
          }),
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            billing_export_watermark: '2026-07-11T00:00:00.000Z',
            billing_lag_hours: '1',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const service = new InfrastructureCostReadService({ query })

    const result = await service.read({
      period: 'day',
      periodStartUtc: '2026-07-10',
      periodEndUtc: '2026-07-11',
      valuation: 'variance',
      basis: 'requested_capacity',
      dimensions,
    })

    expect(result.variance).toEqual({
      netAmount: '2.250000000',
      billedBasis: 'gcp_request_allocation',
      estimateBasis: 'requested_capacity',
    })
    expect(result.gcpRequestAllocation?.billingFreshnessStatus).toBe('fresh')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type {
  DailyCostVersion,
  InfrastructurePriceSnapshot,
  InfrastructurePriceSnapshotEvidence,
  NormalizedGcpBillingRow,
} from '../src/services/tracing/maintenance/contracts.js'
import { adaptNormalizedGcpBillingFixture } from '../src/services/tracing/maintenance/gcpBillingFixtureAdapter.js'
import { MaintenanceCostRepository } from '../src/services/tracing/maintenance/maintenanceCostRepository.js'
import {
  closedUtcDayRange,
  persistNormalizedGcpBillingCosts,
  persistRequestedCapacityDailyCosts,
} from '../src/services/tracing/maintenance/maintenanceCostService.js'

const SHA = 'a'.repeat(64)

function version(overrides: Partial<DailyCostVersion> = {}): DailyCostVersion {
  return {
    key: {
      utcDay: '2026-07-10',
      cloudProvider: 'gcp',
      cloudProjectId: 'project-1',
      clusterLocation: 'europe-west1',
      clusterName: 'cluster-1',
      environment: 'test',
      namespace: 'control-plane',
      workloadKind: 'Deployment',
      workloadRef: 'control-api',
      currency: 'USD',
    },
    valuationKind: 'estimated',
    selectedBasis: 'requested_capacity',
    publicationState: 'provisional',
    completenessStatus: 'complete',
    asOfUtc: '2026-07-11T01:00:00.000Z',
    sourceIntervalStart: '2026-07-10T00:00:00.000Z',
    sourceIntervalEnd: '2026-07-11T00:00:00.000Z',
    billingExportWatermark: null,
    sourceCount: 1,
    sourceSha256: SHA,
    grossAmount: '1.000000000',
    creditsAmount: '0.000000000',
    netAmount: '1.000000000',
    components: [
      {
        componentKey: 'cpu',
        resourceClass: 'cpu',
        allocationBucket: null,
        unitHours: '1.000000000',
        priceSnapshotId: '11111111-1111-4111-8111-111111111111',
        providerService: null,
        providerSku: null,
        billingViewVersion: null,
        sourceRowCount: null,
        sourceSha256: SHA,
        billingExportWatermark: null,
        grossAmount: '1.000000000',
        creditsAmount: '0.000000000',
        netAmount: '1.000000000',
      },
    ],
    ...overrides,
  }
}

function requestedPrices(): InfrastructurePriceSnapshot[] {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      cloudProvider: 'gcp',
      cloudProjectId: 'project-1',
      region: 'europe-west1',
      clusterClass: 'standard',
      resourceClass: 'cpu',
      unit: 'vCPU_hour',
      unitPrice: '1.000000000',
      currency: 'USD',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      sourceRef: 'fixture',
      sourceSha256: SHA,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      cloudProvider: 'gcp',
      cloudProjectId: 'project-1',
      region: 'europe-west1',
      clusterClass: 'standard',
      resourceClass: 'memory',
      unit: 'GiB_hour',
      unitPrice: '1.000000000',
      currency: 'USD',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      sourceRef: 'fixture',
      sourceSha256: SHA,
    },
  ]
}

describe('maintenance cost persistence', () => {
  it('selects a bounded closed-day range for late-data reconciliation', () => {
    expect(closedUtcDayRange(new Date('2026-07-12T18:00:00.000Z'), 7)).toEqual({
      startUtcDay: '2026-07-05',
      endUtcDay: '2026-07-11',
    })
    expect(() => closedUtcDayRange(new Date(), 32)).toThrow('between 1 and 31 days')
  })

  it('persists normalized price snapshots set-wise and idempotently', async () => {
    const prices: InfrastructurePriceSnapshotEvidence[] = [
      {
        cloudProvider: 'gcp',
        cloudProjectId: 'project-1',
        region: 'europe-west1',
        clusterClass: 'standard',
        resourceClass: 'cpu',
        unit: 'vCPU_hour',
        unitPrice: '0.031611000',
        currency: 'USD',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        sourceRef: 'pricing-export:cpu',
        sourceSha256: SHA,
      },
      {
        cloudProvider: 'gcp',
        cloudProjectId: 'project-1',
        region: 'europe-west1',
        clusterClass: 'standard',
        resourceClass: 'memory',
        unit: 'GiB_hour',
        unitPrice: '0.004237000',
        currency: 'USD',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        sourceRef: 'pricing-export:memory',
        sourceSha256: SHA,
      },
    ]
    const query = vi.fn().mockResolvedValue({ rows: [{ id: '1' }, { id: '2' }], rowCount: 2 })
    await expect(
      new MaintenanceCostRepository({ query }).persistPriceSnapshots(prices)
    ).resolves.toBe(2)
    expect(String(query.mock.calls[0]![0])).toContain('jsonb_to_recordset')
    expect(String(query.mock.calls[0]![0])).toContain('ON CONFLICT')
    const persistedRows = JSON.parse(String(query.mock.calls[0]![1][0])) as Array<
      Record<string, unknown>
    >
    expect(persistedRows).toHaveLength(2)
    expect(persistedRows[0]).toMatchObject({
      cloud_provider: 'gcp',
      cloud_project_id: 'project-1',
      resource_class: 'cpu',
      effective_from: '2026-07-01T00:00:00.000Z',
    })
    expect(persistedRows[0]).not.toHaveProperty('cloudProvider')
  })

  it('replays an identical source version without inserting again', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          rollup_version: 3,
          predecessor_version: 2,
          publication_state: 'provisional',
          source_sha256: SHA,
        },
      ],
      rowCount: 1,
    })
    const persisted = await new MaintenanceCostRepository({ query }).persistDailyCostVersion(
      version()
    )
    expect(query).toHaveBeenCalledOnce()
    expect(persisted).toMatchObject({ rollupVersion: 3, predecessorVersion: 2 })
  })

  it('appends a final version when finality advances with the same source hash', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            rollup_version: 3,
            predecessor_version: 2,
            publication_state: 'provisional',
            source_sha256: SHA,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            rollup_version: 4,
            predecessor_version: 3,
            publication_state: 'finalized',
            source_sha256: SHA,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    const persisted = await new MaintenanceCostRepository({ query }).persistDailyCostVersion(
      version({ publicationState: 'finalized' })
    )
    expect(query).toHaveBeenCalledTimes(3)
    expect(persisted).toMatchObject({ rollupVersion: 4, predecessorVersion: 3 })
  })

  it('inserts one header and all components set-wise for a changed source', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            rollup_version: 1,
            predecessor_version: null,
            publication_state: 'provisional',
            source_sha256: SHA,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    await new MaintenanceCostRepository({ query }).persistDailyCostVersion(version())
    expect(query).toHaveBeenCalledTimes(3)
    expect(String(query.mock.calls[1]![0])).toContain('INSERT INTO infrastructure_cost_daily')
    expect(String(query.mock.calls[2]![0])).toContain('infrastructure_cost_daily_components')
    expect(String(query.mock.calls[2]![0])).toContain('jsonb_to_recordset')
    const componentRows = JSON.parse(String(query.mock.calls[2]![1][0])) as Array<
      Record<string, unknown>
    >
    expect(componentRows).toEqual([
      expect.objectContaining({
        daily_cost_id: '33333333-3333-4333-8333-333333333333',
        selected_basis: 'requested_capacity',
        component_key: 'cpu',
      }),
    ])
  })

  it('rejects non-conserving components before touching Postgres', async () => {
    const query = vi.fn()
    await expect(
      new MaintenanceCostRepository({ query }).persistDailyCostVersion(
        version({ netAmount: '2.000000000' })
      )
    ).rejects.toThrow('conserve exactly')
    expect(query).not.toHaveBeenCalled()
  })

  it('keeps fixtures disabled and rejects schema drift when enabled', () => {
    expect(adaptNormalizedGcpBillingFixture({ enabled: false, rows: [{}] })).toEqual([])
    expect(() =>
      adaptNormalizedGcpBillingFixture({
        enabled: true,
        rows: [{ schemaVersion: 'v2' }],
      })
    ).toThrow('schema drift')
  })

  it('rejects invalid normalized GCP enums and decimal evidence', () => {
    const row = {
      schemaVersion: 'gcp-billing-v1',
      usageUtcDay: '2026-07-10',
      cloudProjectId: 'project-1',
      clusterLocation: 'europe-west1',
      clusterName: 'cluster-1',
      environment: 'test',
      namespace: 'control-plane',
      workloadKind: 'Deployment',
      workloadRef: 'control-api',
      providerService: 'GKE',
      providerSku: 'sku-1',
      currency: 'USD',
      costType: 'usage',
      allocationStatus: 'allocated',
      amount: '1.000000000',
      sourceRowCount: 1,
      sourceSha256: SHA,
      billingViewVersion: 'view-v1',
      exportWatermark: '2026-07-11T00:00:00.000Z',
    }
    expect(adaptNormalizedGcpBillingFixture({ enabled: true, rows: [row] })).toHaveLength(1)
    expect(() =>
      adaptNormalizedGcpBillingFixture({
        enabled: true,
        rows: [{ ...row, allocationStatus: 'invented' }],
      })
    ).toThrow('invalid allocationStatus')
    expect(() =>
      adaptNormalizedGcpBillingFixture({
        enabled: true,
        rows: [{ ...row, amount: 'NaN' }],
      })
    ).toThrow('invalid decimal')
  })

  it('keeps requested-capacity cost partial when inventory evidence is partial', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          utc_day: '2026-07-10',
          environment: 'test',
          cluster_name: 'cluster-1',
          namespace: 'control-plane',
          workload_kind: 'Deployment',
          workload_ref: 'control-api',
          interval_start: '2026-07-10T00:00:00.000Z',
          interval_end: '2026-07-10T00:01:00.000Z',
          desired_replicas: 1,
          cpu_request_cores: '1.000000000',
          memory_request_bytes: '1073741824',
          payload_sha256: SHA,
          event_id: '44444444-4444-4444-8444-444444444444',
          completeness_status: 'partial',
        },
      ],
      rowCount: 1,
    })
    const persisted: DailyCostVersion[] = []
    const repository = {
      loadApprovedRequestedCapacityPriceSnapshots: vi.fn().mockResolvedValue(requestedPrices()),
      persistDailyCostVersion: vi.fn(async (value: DailyCostVersion) => {
        persisted.push(value)
        return {
          ...value,
          id: '33333333-3333-4333-8333-333333333333',
          rollupVersion: 1,
          predecessorVersion: null,
        }
      }),
    }
    await persistRequestedCapacityDailyCosts({
      db: { query },
      repository: repository as never,
      config: {
        enabled: true,
        cloudProjectId: 'project-1',
        clusterLocation: 'europe-west1',
        clusterClass: 'standard',
        currency: 'USD',
      },
      utcDay: '2026-07-10',
      asOfUtc: '2026-07-11T00:00:00.000Z',
    })
    expect(persisted[0]?.completenessStatus).toBe('partial')
  })

  it('finalizes requested capacity only after full-day coverage and the lateness delay', async () => {
    const capacityRow = (start: string, end: string, eventId: string) => ({
      utc_day: '2026-07-10',
      environment: 'test',
      cluster_name: 'cluster-1',
      namespace: 'control-plane',
      workload_kind: 'Deployment',
      workload_ref: 'control-api',
      interval_start: start,
      interval_end: end,
      desired_replicas: 1,
      cpu_request_cores: '1.000000000',
      memory_request_bytes: '1073741824',
      payload_sha256: SHA,
      event_id: eventId,
      completeness_status: 'complete',
    })
    const query = vi.fn().mockResolvedValue({
      rows: [
        capacityRow(
          '2026-07-10T00:00:00.000Z',
          '2026-07-10T12:00:00.000Z',
          '44444444-4444-4444-8444-444444444444'
        ),
        capacityRow(
          '2026-07-10T12:00:00.000Z',
          '2026-07-11T00:00:00.000Z',
          '55555555-5555-4555-8555-555555555555'
        ),
      ],
      rowCount: 2,
    })
    const persisted: DailyCostVersion[] = []
    const repository = {
      loadApprovedRequestedCapacityPriceSnapshots: vi.fn().mockResolvedValue(requestedPrices()),
      persistDailyCostVersion: vi.fn(async (value: DailyCostVersion) => {
        persisted.push(value)
        return {
          ...value,
          id: '33333333-3333-4333-8333-333333333333',
          rollupVersion: 1,
          predecessorVersion: null,
        }
      }),
    }
    await persistRequestedCapacityDailyCosts({
      db: { query },
      repository: repository as never,
      config: {
        enabled: true,
        cloudProjectId: 'project-1',
        clusterLocation: 'europe-west1',
        clusterClass: 'standard',
        currency: 'USD',
        requestedCapacityFinalizationDelayHours: 24,
      },
      utcDay: '2026-07-10',
      asOfUtc: '2026-07-12T00:00:00.000Z',
    })

    expect(persisted[0]).toMatchObject({
      publicationState: 'finalized',
      completenessStatus: 'complete',
      sourceIntervalStart: '2026-07-10T00:00:00.000Z',
      sourceIntervalEnd: '2026-07-11T00:00:00.000Z',
    })
  })

  it('keeps billed days provisional until every export watermark clears the lateness budget', async () => {
    const row = (exportWatermark: string): NormalizedGcpBillingRow => ({
      schemaVersion: 'gcp-billing-v1',
      usageUtcDay: '2026-07-10',
      cloudProjectId: 'project-1',
      clusterLocation: 'europe-west1',
      clusterName: 'cluster-1',
      environment: 'test',
      namespace: 'control-plane',
      workloadKind: 'Deployment',
      workloadRef: 'control-api',
      providerService: 'GKE',
      providerSku: 'sku-1',
      currency: 'USD',
      costType: 'usage',
      allocationStatus: 'allocated',
      amount: '1.000000000',
      sourceRowCount: 1,
      sourceSha256: SHA,
      billingViewVersion: 'view-v1',
      exportWatermark,
    })
    const persisted: DailyCostVersion[] = []
    const repository = {
      persistDailyCostVersion: vi.fn(async (value: DailyCostVersion) => {
        persisted.push(value)
        return {
          ...value,
          id: '33333333-3333-4333-8333-333333333333',
          rollupVersion: persisted.length,
          predecessorVersion: persisted.length === 1 ? null : persisted.length - 1,
        }
      }),
    }

    await persistNormalizedGcpBillingCosts({
      repository: repository as never,
      rows: [row('2026-07-14T23:59:59.000Z')],
      asOfUtc: '2026-07-15T00:00:00.000Z',
      finalizationDelayHours: 96,
    })
    await persistNormalizedGcpBillingCosts({
      repository: repository as never,
      rows: [row('2026-07-15T00:00:00.000Z')],
      asOfUtc: '2026-07-15T00:00:00.000Z',
      finalizationDelayHours: 96,
    })

    expect(persisted.map(value => value.publicationState)).toEqual(['provisional', 'finalized'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  type GcpBigQueryBillingConfig,
  gcpBigQueryBillingConfigFromEnv,
  loadNormalizedGcpBillingRows,
} from '../src/services/tracing/maintenance/gcpBigQueryBillingAdapter.js'

const SCHEMA = [
  ['schema_version', 'STRING'],
  ['usage_utc_day', 'DATE'],
  ['cloud_project_id', 'STRING'],
  ['cluster_location', 'STRING'],
  ['cluster_name', 'STRING'],
  ['environment', 'STRING'],
  ['namespace', 'STRING'],
  ['workload_kind', 'STRING'],
  ['workload_ref', 'STRING'],
  ['provider_service', 'STRING'],
  ['provider_sku', 'STRING'],
  ['currency', 'STRING'],
  ['cost_type', 'STRING'],
  ['allocation_status', 'STRING'],
  ['amount', 'NUMERIC'],
  ['source_row_count', 'INTEGER'],
  ['source_sha256', 'STRING'],
  ['billing_view_version', 'STRING'],
  ['export_watermark', 'TIMESTAMP'],
] as const

const VALUES = [
  'gcp-billing-v1',
  '2026-07-10',
  'example-dev-project',
  'europe-west1',
  'example-dev',
  'dev',
  'control-plane',
  'Deployment',
  'control-api',
  'Google Kubernetes Engine',
  'sku-1',
  'USD',
  'usage',
  'allocated',
  '1.250000000',
  '3',
  'a'.repeat(64),
  'normalized-v1',
  '2026-07-11T00:00:00.000Z',
]

function enabledConfig(): Extract<GcpBigQueryBillingConfig, { enabled: true }> {
  return {
    enabled: true,
    queryProjectId: 'finops-project',
    normalizedViewId: 'finops-project.billing.normalized_gke_cost_v1',
    location: 'EU',
    maximumBytesBilled: '1000000000',
    importIntervalMs: 3_600_000,
    maximumLagHours: 96,
    lookbackDays: 7,
    finalizationDelayHours: 96,
    target: {
      cloudProjectId: 'example-dev-project',
      clusterLocation: 'europe-west1',
      clusterName: 'example-dev',
      environment: 'dev',
    },
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    jobComplete: true,
    totalRows: '1',
    schema: { fields: SCHEMA.map(([name, type]) => ({ name, type })) },
    rows: [{ f: VALUES.map(value => ({ v: value })) }],
    ...overrides,
  }
}

describe('normalized GCP BigQuery billing adapter', () => {
  it('is inert without explicit feature activation', async () => {
    const requester = vi.fn()
    expect(
      gcpBigQueryBillingConfigFromEnv({
        env: {},
        target: {
          cloudProjectId: '',
          clusterLocation: '',
          clusterName: '',
          environment: '',
        },
      })
    ).toEqual({ enabled: false })
    await expect(
      loadNormalizedGcpBillingRows({
        config: { enabled: false },
        startUtcDay: 'invalid',
        endUtcDay: 'invalid',
        requester,
      })
    ).resolves.toEqual([])
    expect(requester).not.toHaveBeenCalled()
  })

  it('requires an allowlisted static view and complete target when enabled', () => {
    const target = enabledConfig().target
    expect(() =>
      gcpBigQueryBillingConfigFromEnv({
        env: {
          TRACING_GCP_BILLING_ENABLED: 'true',
          TRACING_GCP_BILLING_QUERY_PROJECT_ID: 'finops-project',
          TRACING_GCP_BILLING_NORMALIZED_VIEW: 'view` WHERE TRUE --',
          TRACING_GCP_BILLING_LOCATION: 'EU',
        },
        target,
      })
    ).toThrow('must be project.dataset.view')
    expect(() =>
      gcpBigQueryBillingConfigFromEnv({
        env: {
          TRACING_GCP_BILLING_ENABLED: 'true',
          TRACING_GCP_BILLING_QUERY_PROJECT_ID: 'finops-project',
          TRACING_GCP_BILLING_NORMALIZED_VIEW: 'finops-project.billing.normalized_gke_cost_v1',
          TRACING_GCP_BILLING_LOCATION: 'EU',
        },
        target: { ...target, clusterName: '' },
      })
    ).toThrow('clusterName is missing')
    expect(() =>
      gcpBigQueryBillingConfigFromEnv({
        env: {
          TRACING_GCP_BILLING_ENABLED: 'true',
          GOOGLE_APPLICATION_CREDENTIALS: '/tmp/static-key.json',
        },
        target,
      })
    ).toThrow('GOOGLE_APPLICATION_CREDENTIALS is forbidden')
  })

  it('builds an enabled configuration with bounded defaults', () => {
    expect(
      gcpBigQueryBillingConfigFromEnv({
        env: {
          TRACING_GCP_BILLING_ENABLED: 'true',
          TRACING_GCP_BILLING_QUERY_PROJECT_ID: 'finops-project',
          TRACING_GCP_BILLING_NORMALIZED_VIEW: 'finops-project.billing.normalized_gke_cost_v1',
          TRACING_GCP_BILLING_LOCATION: 'EU',
        },
        target: enabledConfig().target,
      })
    ).toEqual(enabledConfig())
  })

  it('uses fixed bounded SQL, named parameters, and Workload Identity request semantics', async () => {
    const requester = vi.fn().mockResolvedValue(response())
    const rows = await loadNormalizedGcpBillingRows({
      config: enabledConfig(),
      startUtcDay: '2026-07-04',
      endUtcDay: '2026-07-10',
      requester,
      now: new Date('2026-07-12T00:00:00.000Z'),
    })
    expect(rows).toEqual([
      expect.objectContaining({
        schemaVersion: 'gcp-billing-v1',
        usageUtcDay: '2026-07-10',
        workloadRef: 'control-api',
        amount: '1.250000000',
        sourceRowCount: 3,
        exportWatermark: '2026-07-11T00:00:00.000Z',
      }),
    ])

    const request = requester.mock.calls[0]![0]
    expect(request.url).toBe(
      'https://bigquery.googleapis.com/bigquery/v2/projects/finops-project/queries'
    )
    expect(request.timeoutMs).toBe(25_000)
    expect(request.body).toMatchObject({
      useLegacySql: false,
      parameterMode: 'NAMED',
      maximumBytesBilled: '1000000000',
      maxResults: 10_001,
      location: 'EU',
    })
    expect(request.body.requestId).toHaveLength(36)
    expect(request.body.query).toContain('FROM `finops-project.billing.normalized_gke_cost_v1`')
    expect(request.body.query).toContain('usage_utc_day BETWEEN @start_utc_day AND @end_utc_day')
    expect(request.body.query).toContain('LIMIT 10001')
    expect(request.body.query).not.toContain('example-dev-project')
    expect(request.body.queryParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'cloud_project_id',
          parameterValue: { value: 'example-dev-project' },
        }),
      ])
    )
  })

  it('rejects an impossible UTC day before making a request', async () => {
    const requester = vi.fn()
    await expect(
      loadNormalizedGcpBillingRows({
        config: enabledConfig(),
        startUtcDay: '2026-02-31',
        endUtcDay: '2026-03-01',
        requester,
      })
    ).rejects.toThrow('UTC-day range is invalid')
    expect(requester).not.toHaveBeenCalled()
  })

  it('propagates Workload Identity request failures without returning evidence', async () => {
    const requester = vi.fn().mockRejectedValue(new Error('ADC permission denied'))
    await expect(
      loadNormalizedGcpBillingRows({
        config: enabledConfig(),
        startUtcDay: '2026-07-04',
        endUtcDay: '2026-07-10',
        requester,
      })
    ).rejects.toThrow('ADC permission denied')
    expect(requester).toHaveBeenCalledOnce()
  })

  it.each([
    ['incomplete job', { jobComplete: false }, 'did not complete'],
    ['pagination', { pageToken: 'more' }, 'exceeds 10000 rows'],
    ['schema drift', { schema: { fields: [{ name: 'wrong', type: 'STRING' }] } }, 'schema drift'],
  ])('rejects %s instead of persisting partial evidence', async (_name, override, message) => {
    const requester = vi.fn().mockResolvedValue(response(override))
    await expect(
      loadNormalizedGcpBillingRows({
        config: enabledConfig(),
        startUtcDay: '2026-07-04',
        endUtcDay: '2026-07-10',
        requester,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).rejects.toThrow(message)
  })

  it('rejects a normalized row outside the configured workload target', async () => {
    const wrongTargetValues = [...VALUES]
    wrongTargetValues[4] = 'foreign-cluster'
    const requester = vi
      .fn()
      .mockResolvedValue(
        response({ rows: [{ f: wrongTargetValues.map(value => ({ v: value })) }] })
      )
    await expect(
      loadNormalizedGcpBillingRows({
        config: enabledConfig(),
        startUtcDay: '2026-07-04',
        endUtcDay: '2026-07-10',
        requester,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).rejects.toThrow('outside the configured target')
  })

  it('rejects stale provider evidence using the declared lag budget', async () => {
    const requester = vi.fn().mockResolvedValue(response())
    await expect(
      loadNormalizedGcpBillingRows({
        config: enabledConfig(),
        startUtcDay: '2026-07-04',
        endUtcDay: '2026-07-10',
        requester,
        now: new Date('2026-07-20T00:00:00.000Z'),
      })
    ).rejects.toThrow('watermark is stale')
  })

  it('rejects a query range that exceeds its configured late-data lookback', async () => {
    const requester = vi.fn()
    await expect(
      loadNormalizedGcpBillingRows({
        config: enabledConfig(),
        startUtcDay: '2026-07-03',
        endUtcDay: '2026-07-10',
        requester,
      })
    ).rejects.toThrow('exceeds the configured lookback')
    expect(requester).not.toHaveBeenCalled()
  })
})

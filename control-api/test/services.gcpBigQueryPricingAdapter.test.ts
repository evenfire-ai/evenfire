import { describe, expect, it, vi } from 'vitest'
import {
  type GcpBigQueryPricingConfig,
  gcpBigQueryPricingConfigFromEnv,
  loadNormalizedGcpPricingEvidence,
} from '../src/services/tracing/maintenance/gcpBigQueryPricingAdapter.js'

const SCHEMA = [
  ['schema_version', 'STRING'],
  ['cloud_project_id', 'STRING'],
  ['region', 'STRING'],
  ['cluster_class', 'STRING'],
  ['resource_class', 'STRING'],
  ['unit', 'STRING'],
  ['unit_price', 'NUMERIC'],
  ['currency', 'STRING'],
  ['effective_from', 'TIMESTAMP'],
  ['source_ref', 'STRING'],
  ['source_sha256', 'STRING'],
] as const

const SHA = 'a'.repeat(64)

function config(): Extract<GcpBigQueryPricingConfig, { enabled: true }> {
  return {
    enabled: true,
    queryProjectId: 'finops-project',
    normalizedViewId: 'finops-project.billing.normalized_gke_pricing_v1',
    location: 'EU',
    maximumBytesBilled: '100000000',
    importIntervalMs: 86_400_000,
    maxLagHours: 72,
    target: {
      cloudProjectId: 'example-dev-project',
      region: 'europe-west1',
      clusterClass: 'gke-standard',
      currency: 'USD',
    },
  }
}

function values(resourceClass: 'cpu' | 'memory') {
  return [
    'gcp-pricing-v1',
    'example-dev-project',
    'europe-west1',
    'gke-standard',
    resourceClass,
    resourceClass === 'cpu' ? 'vCPU_hour' : 'GiB_hour',
    resourceClass === 'cpu' ? '0.031611000' : '0.004237000',
    'USD',
    '2026-07-11T00:00:00.000Z',
    `pricing-export:2026-07-11:${resourceClass}`,
    SHA,
  ]
}

function response(rows = [values('cpu'), values('memory')]) {
  return {
    jobComplete: true,
    totalRows: String(rows.length),
    schema: { fields: SCHEMA.map(([name, type]) => ({ name, type })) },
    rows: rows.map(row => ({ f: row.map(value => ({ v: value })) })),
  }
}

describe('normalized GCP BigQuery pricing adapter', () => {
  it('is inert until the pricing lane is explicitly enabled', async () => {
    const requester = vi.fn()
    expect(
      gcpBigQueryPricingConfigFromEnv({
        env: {},
        target: { cloudProjectId: '', region: '', clusterClass: '', currency: '' },
      })
    ).toEqual({ enabled: false })
    await expect(
      loadNormalizedGcpPricingEvidence({ config: { enabled: false }, requester })
    ).resolves.toEqual([])
    expect(requester).not.toHaveBeenCalled()
    expect(() =>
      gcpBigQueryPricingConfigFromEnv({
        env: {
          TRACING_GCP_PRICING_ENABLED: 'true',
          GOOGLE_CLOUD_KEYFILE_JSON: '{not-used}',
        },
        target: config().target,
      })
    ).toThrow('GOOGLE_CLOUD_KEYFILE_JSON is forbidden')

    const enabled = gcpBigQueryPricingConfigFromEnv({
      env: {
        TRACING_GCP_PRICING_ENABLED: 'true',
        TRACING_GCP_PRICING_QUERY_PROJECT_ID: 'finops-project',
        TRACING_GCP_PRICING_NORMALIZED_VIEW: 'finops-project.billing.normalized_gke_pricing_v1',
        TRACING_GCP_PRICING_LOCATION: 'EU',
        TRACING_GCP_PRICING_MAX_LAG_HOURS: '48',
      },
      target: config().target,
    })
    expect(enabled).toMatchObject({ enabled: true, maxLagHours: 48 })
    expect(() =>
      gcpBigQueryPricingConfigFromEnv({
        env: {
          TRACING_GCP_PRICING_ENABLED: 'true',
          TRACING_GCP_PRICING_QUERY_PROJECT_ID: 'finops-project',
          TRACING_GCP_PRICING_NORMALIZED_VIEW: 'finops-project.billing.normalized_gke_pricing_v1',
          TRACING_GCP_PRICING_LOCATION: 'EU',
          TRACING_GCP_PRICING_MAX_LAG_HOURS: '0',
        },
        target: config().target,
      })
    ).toThrow('TRACING_GCP_PRICING_MAX_LAG_HOURS')
  })

  it('loads one account rate for CPU and memory through a bounded static query', async () => {
    const requester = vi.fn().mockResolvedValue(response())
    await expect(
      loadNormalizedGcpPricingEvidence({
        config: config(),
        requester,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).resolves.toEqual([
      expect.objectContaining({
        resourceClass: 'cpu',
        unit: 'vCPU_hour',
        unitPrice: '0.031611000',
      }),
      expect.objectContaining({
        resourceClass: 'memory',
        unit: 'GiB_hour',
        unitPrice: '0.004237000',
      }),
    ])
    const request = requester.mock.calls[0]![0]
    expect(request.url).toBe(
      'https://bigquery.googleapis.com/bigquery/v2/projects/finops-project/queries'
    )
    expect(JSON.stringify(request)).not.toContain('cloudbilling.googleapis.com')
    expect(request.body).toMatchObject({
      maximumBytesBilled: '100000000',
      maxResults: 3,
      parameterMode: 'NAMED',
      useLegacySql: false,
    })
    expect(request.body.query).toContain('FROM `finops-project.billing.normalized_gke_pricing_v1`')
    expect(request.body.query).toContain("resource_class IN ('cpu', 'memory')")
    expect(request.body.query).toContain('effective_from >= @minimum_effective_from')
    expect(request.body.query).toContain("STARTS_WITH(source_ref, 'pricing-export:')")
    expect(request.body.query).toContain(
      "CASE WHEN STARTS_WITH(source_ref, 'pricing-export:') THEN 0 ELSE 1 END"
    )
    expect(request.body.query).not.toContain('example-dev-project')
    expect(request.body.requestId).toHaveLength(36)
    expect(request.body.queryParameters).toContainEqual({
      name: 'minimum_effective_from',
      parameterType: { type: 'TIMESTAMP' },
      parameterValue: { value: '2026-07-09T00:00:00.000Z' },
    })
  })

  it('rejects incomplete or mismatched pricing evidence', async () => {
    const missingMemory = vi.fn().mockResolvedValue(response([values('cpu')]))
    await expect(
      loadNormalizedGcpPricingEvidence({
        config: config(),
        requester: missingMemory,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).rejects.toThrow('requires one CPU and one memory price')

    const wrongRegion = values('memory')
    wrongRegion[2] = 'us-central1'
    const mismatched = vi.fn().mockResolvedValue(response([values('cpu'), wrongRegion]))
    await expect(
      loadNormalizedGcpPricingEvidence({
        config: config(),
        requester: mismatched,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).rejects.toThrow('outside the configured target')

    const unknownSource = values('memory')
    unknownSource[9] = 'manual:memory'
    const invalidSource = vi.fn().mockResolvedValue(response([values('cpu'), unknownSource]))
    await expect(
      loadNormalizedGcpPricingEvidence({
        config: config(),
        requester: invalidSource,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).rejects.toThrow('source ref is invalid')

    const staleCpu = values('cpu')
    staleCpu[8] = '2026-07-01T00:00:00.000Z'
    const stale = vi.fn().mockResolvedValue(response([staleCpu, values('memory')]))
    await expect(
      loadNormalizedGcpPricingEvidence({
        config: config(),
        requester: stale,
        now: new Date('2026-07-12T00:00:00.000Z'),
      })
    ).rejects.toThrow('effective time is invalid')
  })
})

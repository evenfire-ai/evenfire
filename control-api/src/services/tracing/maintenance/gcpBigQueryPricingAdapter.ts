import { canonicalSha256 } from './canonical.js'
import type { InfrastructurePriceSnapshotEvidence } from './contracts.js'
import { Decimal9 } from './decimal.js'
import {
  type BigQueryAuthorizedRequester,
  assertWorkloadIdentityCredentialSource,
  googleAuthorizedBigQueryRequest,
} from './gcpBigQueryRequest.js'
import { parseCompletedBigQueryRows } from './gcpBigQueryResponse.js'

const DEFAULT_MAX_BYTES_BILLED = '100000000'
const DEFAULT_IMPORT_INTERVAL_MS = 86_400_000
const DEFAULT_MAX_LAG_HOURS = 72
const REQUEST_TIMEOUT_MS = 25_000
const JOB_TIMEOUT_MS = 20_000
const MAX_ROWS = 2
const QUERY_ROW_LIMIT = MAX_ROWS + 1
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const VIEW_ID =
  /^([a-z][a-z0-9-]{4,28}[a-z0-9])\.([A-Za-z_][A-Za-z0-9_]{0,1023})\.([A-Za-z_][A-Za-z0-9_]{0,1023})$/
const LOCATION = /^(?:US|EU|[a-z][a-z0-9-]{1,39})$/
const CURRENCY = /^[A-Z]{3}$/
const SHA256 = /^[0-9a-f]{64}$/
const PRICE_SOURCE_REF = /^(?:pricing-export|detailed-usage):[A-Za-z0-9._:@/+,-]{1,480}$/

const EXPECTED_SCHEMA = [
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

const SELECT_COLUMNS = EXPECTED_SCHEMA.map(([name]) => name).join(',\n       ')

export type GcpBigQueryPricingConfig =
  | { enabled: false }
  | {
      enabled: true
      queryProjectId: string
      normalizedViewId: string
      location: string
      maximumBytesBilled: string
      importIntervalMs: number
      maxLagHours: number
      target: {
        cloudProjectId: string
        region: string
        clusterClass: string
        currency: string
      }
    }

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required when GCP pricing import is enabled`)
  return value
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function maximumBytesBilled(value: string | undefined): string {
  const normalized = value?.trim() || DEFAULT_MAX_BYTES_BILLED
  if (!/^\d+$/.test(normalized)) {
    throw new Error('TRACING_GCP_PRICING_MAX_BYTES_BILLED must be a positive integer')
  }
  const parsed = BigInt(normalized)
  if (parsed <= 0n || parsed > 1_000_000_000_000n) {
    throw new Error('TRACING_GCP_PRICING_MAX_BYTES_BILLED is outside the allowed range')
  }
  return normalized
}

function targetValue(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 253) {
    throw new Error(`${name} is missing or exceeds 253 characters`)
  }
  return normalized
}

export function gcpBigQueryPricingConfigFromEnv(input: {
  env?: NodeJS.ProcessEnv
  target: {
    cloudProjectId: string
    region: string
    clusterClass: string
    currency: string
  }
}): GcpBigQueryPricingConfig {
  const env = input.env ?? process.env
  if (env.TRACING_GCP_PRICING_ENABLED !== 'true') return { enabled: false }
  assertWorkloadIdentityCredentialSource(env)
  const queryProjectId = requiredEnv(env, 'TRACING_GCP_PRICING_QUERY_PROJECT_ID')
  const normalizedViewId = requiredEnv(env, 'TRACING_GCP_PRICING_NORMALIZED_VIEW')
  const location = requiredEnv(env, 'TRACING_GCP_PRICING_LOCATION')
  if (!PROJECT_ID.test(queryProjectId)) {
    throw new Error('TRACING_GCP_PRICING_QUERY_PROJECT_ID is invalid')
  }
  if (!VIEW_ID.test(normalizedViewId)) {
    throw new Error('TRACING_GCP_PRICING_NORMALIZED_VIEW must be project.dataset.view')
  }
  if (!LOCATION.test(location)) throw new Error('TRACING_GCP_PRICING_LOCATION is invalid')
  const target = {
    cloudProjectId: targetValue(input.target.cloudProjectId, 'cloudProjectId'),
    region: targetValue(input.target.region, 'region'),
    clusterClass: targetValue(input.target.clusterClass, 'clusterClass'),
    currency: targetValue(input.target.currency, 'currency'),
  }
  if (!CURRENCY.test(target.currency)) throw new Error('pricing target currency is invalid')
  return {
    enabled: true,
    queryProjectId,
    normalizedViewId,
    location,
    maximumBytesBilled: maximumBytesBilled(env.TRACING_GCP_PRICING_MAX_BYTES_BILLED),
    importIntervalMs: positiveInteger(
      env.TRACING_GCP_PRICING_IMPORT_INTERVAL_MS,
      DEFAULT_IMPORT_INTERVAL_MS,
      'TRACING_GCP_PRICING_IMPORT_INTERVAL_MS',
      3_600_000,
      604_800_000
    ),
    maxLagHours: positiveInteger(
      env.TRACING_GCP_PRICING_MAX_LAG_HOURS,
      DEFAULT_MAX_LAG_HOURS,
      'TRACING_GCP_PRICING_MAX_LAG_HOURS',
      1,
      168
    ),
    target,
  }
}

function queryParameter(name: string, value: string, type = 'STRING') {
  return { name, parameterType: { type }, parameterValue: { value } }
}

function queryBody(config: Extract<GcpBigQueryPricingConfig, { enabled: true }>, now: Date) {
  const minimumEffectiveFrom = new Date(
    now.getTime() - config.maxLagHours * 60 * 60 * 1_000
  ).toISOString()
  const query = `SELECT ${SELECT_COLUMNS}
  FROM \`${config.normalizedViewId}\`
 WHERE cloud_project_id = @cloud_project_id
   AND region = @region
   AND cluster_class = @cluster_class
   AND currency = @currency
   AND effective_from >= @minimum_effective_from
   AND resource_class IN ('cpu', 'memory')
   AND (
     STARTS_WITH(source_ref, 'pricing-export:')
     OR STARTS_WITH(source_ref, 'detailed-usage:')
   )
 QUALIFY ROW_NUMBER() OVER (
   PARTITION BY resource_class
   ORDER BY CASE WHEN STARTS_WITH(source_ref, 'pricing-export:') THEN 0 ELSE 1 END,
            effective_from DESC, source_sha256 DESC
 ) = 1
 ORDER BY resource_class
 LIMIT ${QUERY_ROW_LIMIT}`
  return {
    query,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [
      queryParameter('cloud_project_id', config.target.cloudProjectId),
      queryParameter('region', config.target.region),
      queryParameter('cluster_class', config.target.clusterClass),
      queryParameter('currency', config.target.currency),
      queryParameter('minimum_effective_from', minimumEffectiveFrom, 'TIMESTAMP'),
    ],
    location: config.location,
    maximumBytesBilled: config.maximumBytesBilled,
    maxResults: QUERY_ROW_LIMIT,
    timeoutMs: JOB_TIMEOUT_MS,
    jobTimeoutMs: String(JOB_TIMEOUT_MS),
    requestId: canonicalSha256({
      queryProjectId: config.queryProjectId,
      view: config.normalizedViewId,
      target: config.target,
      minimumEffectiveFrom,
    }).slice(0, 36),
    labels: { workload: 'governed_trace_pricing' },
  }
}

function parsePricingEvidence(input: {
  rows: readonly Record<string, unknown>[]
  config: Extract<GcpBigQueryPricingConfig, { enabled: true }>
  now: Date
}): InfrastructurePriceSnapshotEvidence[] {
  const evidence = input.rows.map(row => {
    if (row.schema_version !== 'gcp-pricing-v1') {
      throw new Error('normalized GCP pricing BigQuery schema drift')
    }
    if (
      row.cloud_project_id !== input.config.target.cloudProjectId ||
      row.region !== input.config.target.region ||
      row.cluster_class !== input.config.target.clusterClass ||
      row.currency !== input.config.target.currency
    ) {
      throw new Error('normalized GCP pricing BigQuery row is outside the configured target')
    }
    if (row.resource_class !== 'cpu' && row.resource_class !== 'memory') {
      throw new Error('normalized GCP pricing BigQuery resource class is invalid')
    }
    const resourceClass: InfrastructurePriceSnapshotEvidence['resourceClass'] = row.resource_class
    const expectedUnit: InfrastructurePriceSnapshotEvidence['unit'] =
      resourceClass === 'cpu' ? 'vCPU_hour' : 'GiB_hour'
    if (row.unit !== expectedUnit) {
      throw new Error('normalized GCP pricing BigQuery unit is invalid')
    }
    if (typeof row.unit_price !== 'string') {
      throw new Error('normalized GCP pricing BigQuery unit price is invalid')
    }
    const price = Decimal9.parse(row.unit_price)
    if (price.units < 0n) throw new Error('normalized GCP pricing BigQuery price is negative')
    if (typeof row.effective_from !== 'string') {
      throw new Error('normalized GCP pricing BigQuery effective time is invalid')
    }
    const effectiveFrom = Date.parse(row.effective_from)
    const minimumEffectiveFrom = input.now.getTime() - input.config.maxLagHours * 60 * 60 * 1_000
    if (
      !Number.isFinite(effectiveFrom) ||
      effectiveFrom < minimumEffectiveFrom ||
      effectiveFrom > input.now.getTime() + 300_000
    ) {
      throw new Error('normalized GCP pricing BigQuery effective time is invalid')
    }
    if (typeof row.source_ref !== 'string' || !PRICE_SOURCE_REF.test(row.source_ref)) {
      throw new Error('normalized GCP pricing BigQuery source ref is invalid')
    }
    if (typeof row.source_sha256 !== 'string' || !SHA256.test(row.source_sha256)) {
      throw new Error('normalized GCP pricing BigQuery source hash is invalid')
    }
    return {
      cloudProvider: 'gcp' as const,
      cloudProjectId: input.config.target.cloudProjectId,
      region: input.config.target.region,
      clusterClass: input.config.target.clusterClass,
      resourceClass,
      unit: expectedUnit,
      unitPrice: price.toString(),
      currency: input.config.target.currency,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      sourceRef: row.source_ref,
      sourceSha256: row.source_sha256,
    }
  })
  if (evidence.length !== 2 || new Set(evidence.map(row => row.resourceClass)).size !== 2) {
    throw new Error('normalized GCP pricing BigQuery requires one CPU and one memory price')
  }
  return evidence
}

export async function loadNormalizedGcpPricingEvidence(input: {
  config: GcpBigQueryPricingConfig
  requester?: BigQueryAuthorizedRequester
  now?: Date
}): Promise<InfrastructurePriceSnapshotEvidence[]> {
  if (!input.config.enabled) return []
  const now = input.now ?? new Date()
  const response = await (input.requester ?? googleAuthorizedBigQueryRequest)({
    url: `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(input.config.queryProjectId)}/queries`,
    body: queryBody(input.config, now),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  return parsePricingEvidence({
    rows: parseCompletedBigQueryRows({
      response,
      expectedSchema: EXPECTED_SCHEMA,
      maxRows: MAX_ROWS,
      source: 'normalized GCP pricing BigQuery',
    }),
    config: input.config,
    now,
  })
}

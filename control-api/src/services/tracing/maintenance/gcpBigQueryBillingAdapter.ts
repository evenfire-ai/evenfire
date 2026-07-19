import { canonicalSha256 } from './canonical.js'
import type { NormalizedGcpBillingRow } from './contracts.js'
import {
  type BigQueryAuthorizedRequester,
  assertWorkloadIdentityCredentialSource,
  googleAuthorizedBigQueryRequest,
} from './gcpBigQueryRequest.js'
import { parseCompletedBigQueryRows } from './gcpBigQueryResponse.js'
import { isUtcDay, parseNormalizedGcpBillingRows } from './normalizedGcpBillingRows.js'

const DEFAULT_MAX_BYTES_BILLED = '1000000000'
const DEFAULT_IMPORT_INTERVAL_MS = 3_600_000
const DEFAULT_MAX_LAG_HOURS = 96
const DEFAULT_LOOKBACK_DAYS = 7
const DEFAULT_FINALIZATION_DELAY_HOURS = 96
const MAX_ROWS = 10_000
const QUERY_ROW_LIMIT = MAX_ROWS + 1
const REQUEST_TIMEOUT_MS = 25_000
const JOB_TIMEOUT_MS = 20_000
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const VIEW_ID =
  /^([a-z][a-z0-9-]{4,28}[a-z0-9])\.([A-Za-z_][A-Za-z0-9_]{0,1023})\.([A-Za-z_][A-Za-z0-9_]{0,1023})$/
const LOCATION = /^(?:US|EU|[a-z][a-z0-9-]{1,39})$/

const EXPECTED_SCHEMA = [
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

const SELECT_COLUMNS = EXPECTED_SCHEMA.map(([name]) => name).join(',\n       ')

export type GcpBigQueryBillingConfig =
  | { enabled: false }
  | {
      enabled: true
      queryProjectId: string
      normalizedViewId: string
      location: string
      maximumBytesBilled: string
      importIntervalMs: number
      maximumLagHours: number
      lookbackDays: number
      finalizationDelayHours: number
      target: {
        cloudProjectId: string
        clusterLocation: string
        clusterName: string
        environment: string
      }
    }

export type { BigQueryAuthorizedRequester } from './gcpBigQueryRequest.js'

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required when GCP billing import is enabled`)
  return value
}

function boundedInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 300_000 || parsed > 86_400_000) {
    throw new Error(`${name} must be an integer between 300000 and 86400000`)
  }
  return parsed
}

function boundedHours(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_LAG_HOURS
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 168) {
    throw new Error('TRACING_GCP_BILLING_MAX_LAG_HOURS must be an integer between 1 and 168')
  }
  return parsed
}

function boundedWholeNumber(input: {
  value: string | undefined
  fallback: number
  name: string
  minimum: number
  maximum: number
}): number {
  if (input.value === undefined || input.value.trim() === '') return input.fallback
  const parsed = Number(input.value)
  if (!Number.isSafeInteger(parsed) || parsed < input.minimum || parsed > input.maximum) {
    throw new Error(
      `${input.name} must be an integer between ${input.minimum} and ${input.maximum}`
    )
  }
  return parsed
}

function maximumBytesBilled(value: string | undefined): string {
  const normalized = value?.trim() || DEFAULT_MAX_BYTES_BILLED
  if (!/^\d+$/.test(normalized)) {
    throw new Error('TRACING_GCP_BILLING_MAX_BYTES_BILLED must be a positive integer')
  }
  const parsed = BigInt(normalized)
  if (parsed <= 0n || parsed > 10_000_000_000_000n) {
    throw new Error('TRACING_GCP_BILLING_MAX_BYTES_BILLED is outside the allowed range')
  }
  return normalized
}

function requireTargetValue(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 253) {
    throw new Error(`${name} is missing or exceeds 253 characters`)
  }
  return normalized
}

export function gcpBigQueryBillingConfigFromEnv(input: {
  env?: NodeJS.ProcessEnv
  target: {
    cloudProjectId: string
    clusterLocation: string
    clusterName: string
    environment: string
  }
}): GcpBigQueryBillingConfig {
  const env = input.env ?? process.env
  if (env.TRACING_GCP_BILLING_ENABLED !== 'true') return { enabled: false }
  assertWorkloadIdentityCredentialSource(env)

  const queryProjectId = requiredEnv(env, 'TRACING_GCP_BILLING_QUERY_PROJECT_ID')
  if (!PROJECT_ID.test(queryProjectId)) {
    throw new Error('TRACING_GCP_BILLING_QUERY_PROJECT_ID is invalid')
  }
  const normalizedViewId = requiredEnv(env, 'TRACING_GCP_BILLING_NORMALIZED_VIEW')
  if (!VIEW_ID.test(normalizedViewId)) {
    throw new Error('TRACING_GCP_BILLING_NORMALIZED_VIEW must be project.dataset.view')
  }
  const location = requiredEnv(env, 'TRACING_GCP_BILLING_LOCATION')
  if (!LOCATION.test(location)) {
    throw new Error('TRACING_GCP_BILLING_LOCATION is invalid')
  }
  return {
    enabled: true,
    queryProjectId,
    normalizedViewId,
    location,
    maximumBytesBilled: maximumBytesBilled(env.TRACING_GCP_BILLING_MAX_BYTES_BILLED),
    importIntervalMs: boundedInteger(
      env.TRACING_GCP_BILLING_IMPORT_INTERVAL_MS,
      DEFAULT_IMPORT_INTERVAL_MS,
      'TRACING_GCP_BILLING_IMPORT_INTERVAL_MS'
    ),
    maximumLagHours: boundedHours(env.TRACING_GCP_BILLING_MAX_LAG_HOURS),
    lookbackDays: boundedWholeNumber({
      value: env.TRACING_GCP_BILLING_LOOKBACK_DAYS,
      fallback: DEFAULT_LOOKBACK_DAYS,
      name: 'TRACING_GCP_BILLING_LOOKBACK_DAYS',
      minimum: 1,
      maximum: 31,
    }),
    finalizationDelayHours: boundedWholeNumber({
      value: env.TRACING_GCP_BILLING_FINALIZATION_DELAY_HOURS,
      fallback: DEFAULT_FINALIZATION_DELAY_HOURS,
      name: 'TRACING_GCP_BILLING_FINALIZATION_DELAY_HOURS',
      minimum: 24,
      maximum: 720,
    }),
    target: {
      cloudProjectId: requireTargetValue(input.target.cloudProjectId, 'cloudProjectId'),
      clusterLocation: requireTargetValue(input.target.clusterLocation, 'clusterLocation'),
      clusterName: requireTargetValue(input.target.clusterName, 'clusterName'),
      environment: requireTargetValue(input.target.environment, 'environment'),
    },
  }
}

function queryParameter(name: string, type: 'DATE' | 'STRING', value: string) {
  return { name, parameterType: { type }, parameterValue: { value } }
}

function queryBody(
  config: Extract<GcpBigQueryBillingConfig, { enabled: true }>,
  startUtcDay: string,
  endUtcDay: string
) {
  const query = `SELECT ${SELECT_COLUMNS}
  FROM \`${config.normalizedViewId}\`
 WHERE usage_utc_day BETWEEN @start_utc_day AND @end_utc_day
   AND cloud_project_id = @cloud_project_id
   AND cluster_location = @cluster_location
   AND cluster_name = @cluster_name
   AND environment = @environment
 ORDER BY namespace, workload_kind, workload_ref, provider_service, provider_sku,
          allocation_status, cost_type, source_sha256
 LIMIT ${QUERY_ROW_LIMIT}`
  return {
    query,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [
      queryParameter('start_utc_day', 'DATE', startUtcDay),
      queryParameter('end_utc_day', 'DATE', endUtcDay),
      queryParameter('cloud_project_id', 'STRING', config.target.cloudProjectId),
      queryParameter('cluster_location', 'STRING', config.target.clusterLocation),
      queryParameter('cluster_name', 'STRING', config.target.clusterName),
      queryParameter('environment', 'STRING', config.target.environment),
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
      startUtcDay,
      endUtcDay,
    }).slice(0, 36),
    labels: { workload: 'governed_trace_billing' },
  }
}

export async function loadNormalizedGcpBillingRows(input: {
  config: GcpBigQueryBillingConfig
  startUtcDay: string
  endUtcDay: string
  requester?: BigQueryAuthorizedRequester
  now?: Date
}): Promise<NormalizedGcpBillingRow[]> {
  if (!input.config.enabled) return []
  if (!isUtcDay(input.startUtcDay) || !isUtcDay(input.endUtcDay)) {
    throw new Error('GCP billing UTC-day range is invalid')
  }
  const start = Date.parse(`${input.startUtcDay}T00:00:00.000Z`)
  const end = Date.parse(`${input.endUtcDay}T00:00:00.000Z`)
  const rangeDays = Math.floor((end - start) / 86_400_000) + 1
  if (end < start || rangeDays > input.config.lookbackDays) {
    throw new Error('GCP billing UTC-day range exceeds the configured lookback')
  }
  const response = await (input.requester ?? googleAuthorizedBigQueryRequest)({
    url: `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(input.config.queryProjectId)}/queries`,
    body: queryBody(input.config, input.startUtcDay, input.endUtcDay),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  const values = parseCompletedBigQueryRows({
    response,
    expectedSchema: EXPECTED_SCHEMA,
    maxRows: MAX_ROWS,
    source: 'normalized GCP billing BigQuery',
  })
  const rows = parseNormalizedGcpBillingRows({
    rows: values.map(row => ({
      schemaVersion: row.schema_version,
      usageUtcDay: row.usage_utc_day,
      cloudProjectId: row.cloud_project_id,
      clusterLocation: row.cluster_location,
      clusterName: row.cluster_name,
      environment: row.environment,
      namespace: row.namespace,
      workloadKind: row.workload_kind,
      workloadRef: row.workload_ref,
      providerService: row.provider_service,
      providerSku: row.provider_sku,
      currency: row.currency,
      costType: row.cost_type,
      allocationStatus: row.allocation_status,
      amount: row.amount,
      sourceRowCount: Number(row.source_row_count),
      sourceSha256: row.source_sha256,
      billingViewVersion: row.billing_view_version,
      exportWatermark: row.export_watermark,
    })),
    source: 'normalized GCP billing BigQuery',
  })
  for (const row of rows) {
    if (
      row.usageUtcDay < input.startUtcDay ||
      row.usageUtcDay > input.endUtcDay ||
      row.cloudProjectId !== input.config.target.cloudProjectId ||
      row.clusterLocation !== input.config.target.clusterLocation ||
      row.clusterName !== input.config.target.clusterName ||
      row.environment !== input.config.target.environment
    ) {
      throw new Error('normalized GCP billing BigQuery row is outside the configured target')
    }
    const now = input.now ?? new Date()
    const watermark = Date.parse(row.exportWatermark)
    if (watermark > now.getTime() + 300_000) {
      throw new Error('normalized GCP billing BigQuery watermark is in the future')
    }
    if (now.getTime() - watermark > input.config.maximumLagHours * 3_600_000) {
      throw new Error('normalized GCP billing BigQuery watermark is stale')
    }
  }
  return rows
}

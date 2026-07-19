import { createHash, randomUUID } from 'node:crypto'
import type { DbClient } from '../../db.js'
import { stableStringify } from '../../utils/stableStringify.js'
import type {
  GovernedAppendResult,
  GovernedEventFamily,
  TracingServiceDependencies,
} from './contracts.js'

const FAMILY_CONFIG: Record<
  GovernedEventFamily,
  { table: string; sourceIdentityColumn: PendingGovernedEvent['sourceIdentityColumn'] }
> = {
  agent_run: { table: 'agent_run_events', sourceIdentityColumn: 'source_event_id' },
  administrative: { table: 'administrative_events', sourceIdentityColumn: 'source_event_id' },
  infrastructure_telemetry: {
    table: 'infrastructure_telemetry_events',
    sourceIdentityColumn: 'source_occurrence_id',
  },
}

const MAX_APPEND_BATCH_SIZE = 100

const COLUMN_SQL_TYPES: Readonly<Record<string, string>> = {
  event_id: 'uuid',
  schema_version: 'smallint',
  occurred_at: 'timestamptz',
  ingested_at: 'timestamptz',
  run_id: 'uuid',
  operation_id: 'uuid',
  related_run_id: 'uuid',
  related_operation_id: 'uuid',
  approval_request_id: 'uuid',
  token_exchange_id: 'uuid',
  operator_user_id: 'uuid',
  target_user_id: 'uuid',
  effective_scopes: 'text[]',
  payload_metadata: 'jsonb',
  duration_ms: 'bigint',
  metadata_generation: 'bigint',
  interval_start: 'timestamptz',
  interval_end: 'timestamptz',
  desired_replicas: 'integer',
  observed_replicas: 'integer',
  ready_replicas: 'integer',
  cpu_request_cores: 'numeric',
  cpu_limit_cores: 'numeric',
  memory_request_bytes: 'bigint',
  memory_limit_bytes: 'bigint',
  cpu_usage_core_seconds: 'numeric',
  memory_usage_byte_seconds: 'numeric',
  stream_run_id: 'uuid',
  stream_operation_id: 'uuid',
}

type FamilyColumn = {
  name: string
  value: unknown
}

export interface PendingGovernedEvent<Family extends GovernedEventFamily = GovernedEventFamily> {
  family: Family
  eventId: string
  schemaVersion: number
  sourceService: string
  sourceKind: string
  sourceEventId: string
  sourceIdentityColumn: 'source_event_id' | 'source_occurrence_id'
  occurredAt: string
  ingestedAt: string
  payloadSha256: string
  familyColumns: readonly FamilyColumn[]
  stream: {
    environment: string
    tenantId: string | null
    teamId: string | null
    runId: string | null
    operationId: string | null
    workloadRef: string | null
  }
}

export type PendingGovernedEventBatch<Family extends GovernedEventFamily> = readonly [
  PendingGovernedEvent<Family>,
  ...PendingGovernedEvent<Family>[],
]

export class TracingIdempotencyConflictError extends Error {
  readonly code = 'tracing_idempotency_conflict'
  readonly status = 409
  readonly statusCode = 409

  constructor(
    readonly family: GovernedEventFamily,
    readonly sourceKind: string,
    readonly sourceEventId: string
  ) {
    super(`conflicting payload for ${family}:${sourceKind}:${sourceEventId}`)
    this.name = 'TracingIdempotencyConflictError'
  }
}

export class UnsafeTracingInputError extends Error {
  readonly code = 'unsafe_tracing_input'
  readonly status = 400
  readonly statusCode = 400

  constructor(readonly field: string) {
    super(`tracing input contains a server-owned or monetary field: ${field}`)
    this.name = 'UnsafeTracingInputError'
  }
}

export class TracingPersistenceInvariantError extends Error {
  readonly code = 'tracing_persistence_invariant'

  constructor(message: string) {
    super(message)
    this.name = 'TracingPersistenceInvariantError'
  }
}

export function canonicalPayloadSha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function normalizeIsoTimestamp(value: string, field: string): string {
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`${field} must be an ISO timestamp`)
  }
  return timestamp.toISOString()
}

export function resolveServiceDependencies(
  dependencies: TracingServiceDependencies
): Required<TracingServiceDependencies> {
  return {
    transaction: dependencies.transaction,
    now: dependencies.now ?? (() => new Date()),
    newEventId: dependencies.newEventId ?? randomUUID,
  }
}

const SERVER_OWNED_INPUT_KEYS = new Set([
  'source_service',
  'service_sub',
  'operator_sub',
  'operator_user_id',
  'identity_issuer',
  'actor_human_sub',
  'agent_sub',
  'delegated_actor_sub',
  'actor_medium',
  'resource_aud',
  'effective_scopes',
  'decision',
  'decision_source_kind',
  'decision_source_ref',
  'decision_actor_sub',
  'approval_request_id',
  'token_exchange_id',
  'tenant_id',
  'team_id',
  'user_id',
  'target_identity_issuer',
  'target_human_sub',
  'target_user_id',
  'run_id',
  'operation_id',
  'environment',
  'cluster_name',
  'namespace',
  'workload_ref',
])

const MONETARY_INPUT_KEYS = new Set([
  'price',
  'cost',
  'currency',
  'money',
  'monetary_value',
  'amount',
  'usd',
  'eur',
  'gbp',
])

const SAFE_METADATA_KEYS = new Set([
  'reason_code',
  'error_class',
  'phase',
  'state',
  'status',
  'transition',
  'resource_class',
  'unit',
  'provider_ref',
  'summary',
  'detail_ref',
  'target_label',
  'target_principal_kind',
  'target_principal_ref',
  'tool_name',
  'tool_kind',
  'tool_source_ref',
  'model',
  'attempt',
  'count',
  'config_hash',
])

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

export function assertNoClientAuthority(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoClientAuthority(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = snakeCase(key)
    if (SERVER_OWNED_INPUT_KEYS.has(normalized) || MONETARY_INPUT_KEYS.has(normalized)) {
      throw new UnsafeTracingInputError(`${path}.${key}`)
    }
    assertNoClientAuthority(nested, `${path}.${key}`)
  }
}

export function assertSafeEventPayload(value: unknown): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsafeTracingInputError('input.payload')
  }
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (
      !SAFE_METADATA_KEYS.has(key) ||
      !['string', 'number'].includes(typeof fieldValue) ||
      (typeof fieldValue === 'number' && !Number.isFinite(fieldValue))
    ) {
      throw new UnsafeTracingInputError(`input.payload.${key}`)
    }
    if (
      key === 'tool_kind' &&
      !['internal_tool', 'mcp_server_tool', 'workflow'].includes(String(fieldValue))
    ) {
      throw new UnsafeTracingInputError('input.payload.tool_kind')
    }
    if (
      key === 'tool_source_ref' &&
      (typeof fieldValue !== 'string' || fieldValue.length === 0 || fieldValue.length > 128)
    ) {
      throw new UnsafeTracingInputError('input.payload.tool_source_ref')
    }
    if (
      key === 'target_label' &&
      (typeof fieldValue !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(fieldValue))
    ) {
      throw new UnsafeTracingInputError('input.payload.target_label')
    }
    if (
      key === 'target_principal_kind' &&
      !['operator', 'host', 'context', 'service'].includes(String(fieldValue))
    ) {
      throw new UnsafeTracingInputError('input.payload.target_principal_kind')
    }
    if (
      key === 'target_principal_ref' &&
      (typeof fieldValue !== 'string' ||
        fieldValue.length === 0 ||
        fieldValue.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(fieldValue))
    ) {
      throw new UnsafeTracingInputError('input.payload.target_principal_ref')
    }
  }
  const payload = value as Record<string, unknown>
  const targetPrincipalKind = payload.target_principal_kind
  const targetPrincipalRef = payload.target_principal_ref
  if ((targetPrincipalKind === undefined) !== (targetPrincipalRef === undefined)) {
    throw new UnsafeTracingInputError('input.payload.target_principal')
  }
  if (typeof targetPrincipalKind === 'string' && typeof targetPrincipalRef === 'string') {
    const hasCanonicalPrefix =
      (targetPrincipalKind === 'operator' && targetPrincipalRef === 'operator:') ||
      (targetPrincipalKind !== 'operator' &&
        targetPrincipalRef.startsWith(`${targetPrincipalKind}:`))
    if (!hasCanonicalPrefix) {
      throw new UnsafeTracingInputError('input.payload.target_principal_ref')
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16_384) {
    throw new UnsafeTracingInputError('input.payload')
  }
}

function assertIdentifier(value: string, name: string): void {
  if (!value.trim() || value.includes('\u0000')) {
    throw new Error(`${name} must be a non-empty string without NUL bytes`)
  }
}

function mapResult(
  kind: GovernedAppendResult['kind'],
  family: GovernedEventFamily,
  row: Record<string, unknown>
): GovernedAppendResult {
  return {
    kind,
    accepted: kind === 'accepted' ? 1 : 0,
    replayed: kind === 'replayed' ? 1 : 0,
    family,
    eventId: String(row.event_id),
    streamSequence: String(row.stream_sequence),
    payloadSha256: String(row.payload_sha256),
    ingestedAt: new Date(row.ingested_at as string).toISOString(),
  }
}

function validateColumns(columns: readonly FamilyColumn[]): void {
  const seen = new Set<string>()
  for (const column of columns) {
    if (!/^[a-z][a-z0-9_]*$/.test(column.name) || seen.has(column.name)) {
      throw new Error(`invalid or duplicate tracing family column: ${column.name}`)
    }
    seen.add(column.name)
  }
}

type PreparedBatchEvent<Family extends GovernedEventFamily> = {
  batchIndex: number
  event: PendingGovernedEvent<Family>
  identity: string
  familyColumns: ReadonlyMap<string, unknown>
}

type PreparedBatch<Family extends GovernedEventFamily> = {
  family: Family
  table: string
  sourceIdentityColumn: PendingGovernedEvent['sourceIdentityColumn']
  familyColumnNames: readonly string[]
  canonicalEvents: readonly PreparedBatchEvent<Family>[]
  canonicalIndexByInput: readonly number[]
  lockIdentities: readonly string[]
}

function eventIdentity(event: PendingGovernedEvent): string {
  const columns = new Map(event.familyColumns.map(column => [column.name, column.value]))
  if (event.family === 'agent_run') {
    return stableStringify([
      event.family,
      event.sourceService,
      event.sourceKind,
      event.sourceEventId,
      columns.get('event_type'),
      columns.get('run_id'),
    ])
  }
  if (event.family === 'administrative') {
    return stableStringify([
      event.family,
      event.sourceService,
      event.sourceKind,
      event.sourceEventId,
      columns.get('event_kind'),
      columns.get('operation_id'),
      columns.get('target_ref'),
    ])
  }
  return stableStringify([
    event.family,
    event.sourceService,
    event.sourceKind,
    event.sourceEventId,
    columns.get('telemetry_type'),
    columns.get('workload_ref'),
    columns.get('metadata_generation'),
    columns.get('interval_start'),
    columns.get('interval_end'),
  ])
}

function idempotencyKey(event: PendingGovernedEvent): string {
  return createHash('sha256').update(eventIdentity(event)).digest('hex')
}

function prepareBatch<Family extends GovernedEventFamily>(
  events: PendingGovernedEventBatch<Family>
): PreparedBatch<Family> {
  if (events.length > MAX_APPEND_BATCH_SIZE) {
    throw new Error(`governed append batch exceeds ${MAX_APPEND_BATCH_SIZE} events`)
  }

  const family = events[0].family
  const config = FAMILY_CONFIG[family]
  const canonicalEvents: PreparedBatchEvent<Family>[] = []
  const canonicalByIdentity = new Map<string, PreparedBatchEvent<Family>>()
  const canonicalIndexByInput: number[] = []
  let familyColumnNames: readonly string[] | undefined

  events.forEach((event, batchIndex) => {
    if (event.family !== family) {
      throw new Error('governed append batch must contain exactly one event family')
    }
    if (event.sourceIdentityColumn !== config.sourceIdentityColumn) {
      throw new Error(
        `${event.family} events must use ${config.sourceIdentityColumn} as their source identity`
      )
    }
    assertIdentifier(event.eventId, 'eventId')
    assertIdentifier(event.sourceService, 'sourceService')
    assertIdentifier(event.sourceKind, 'sourceKind')
    assertIdentifier(event.sourceEventId, 'sourceEventId')
    validateColumns(event.familyColumns)

    const columns = new Map(event.familyColumns.map(column => [column.name, column.value]))
    const columnNames = [...columns.keys()].sort()
    if (!familyColumnNames) {
      familyColumnNames = columnNames
    } else if (stableStringify(columnNames) !== stableStringify(familyColumnNames)) {
      throw new Error('governed append batch events must have the same family columns')
    }

    const identity = eventIdentity(event)
    const canonical = canonicalByIdentity.get(identity)
    if (canonical) {
      if (canonical.event.payloadSha256 !== event.payloadSha256) {
        throw new TracingIdempotencyConflictError(
          event.family,
          event.sourceKind,
          event.sourceEventId
        )
      }
      canonicalIndexByInput.push(canonical.batchIndex)
      return
    }

    const prepared = { batchIndex, event, identity, familyColumns: columns }
    canonicalByIdentity.set(identity, prepared)
    canonicalEvents.push(prepared)
    canonicalIndexByInput.push(batchIndex)
  })

  const eventIds = new Set(canonicalEvents.map(item => item.event.eventId))
  if (eventIds.size !== canonicalEvents.length) {
    throw new Error('governed append batch eventId values must be unique')
  }

  return {
    family,
    table: config.table,
    sourceIdentityColumn: config.sourceIdentityColumn,
    familyColumnNames: familyColumnNames ?? [],
    canonicalEvents,
    canonicalIndexByInput,
    lockIdentities: [...canonicalByIdentity.keys()].sort(),
  }
}

function resultBatchIndex(row: Record<string, unknown>): number {
  const value = Number(row.batch_index)
  if (!Number.isInteger(value) || value < 0) {
    throw new TracingPersistenceInvariantError(
      'governed append query returned an invalid batch index'
    )
  }
  return value
}

function collectRowsByBatchIndex(
  rows: readonly unknown[],
  expectedIndexes: ReadonlySet<number>,
  message: string
): Map<number, Record<string, unknown>> {
  const byBatchIndex = new Map<number, Record<string, unknown>>()
  for (const value of rows) {
    const row = value as Record<string, unknown>
    const batchIndex = resultBatchIndex(row)
    if (!expectedIndexes.has(batchIndex) || byBatchIndex.has(batchIndex)) {
      throw new TracingPersistenceInvariantError(message)
    }
    byBatchIndex.set(batchIndex, row)
  }
  return byBatchIndex
}

function insertMissingBatchSql<Family extends GovernedEventFamily>(
  batch: PreparedBatch<Family>,
  missing: readonly PreparedBatchEvent<Family>[]
): { sql: string; values: unknown[] } {
  const familyColumns = batch.familyColumnNames
  const familyInsertColumns = [
    'event_id',
    'schema_version',
    'source_service',
    'source_kind',
    batch.sourceIdentityColumn,
    'idempotency_key',
    'occurred_at',
    'ingested_at',
    'payload_sha256',
    ...familyColumns,
  ]
  const batchColumns = [
    'batch_index',
    ...familyInsertColumns,
    'stream_environment',
    'stream_tenant_id',
    'stream_team_id',
    'stream_run_id',
    'stream_operation_id',
    'stream_workload_ref',
  ]
  const values: unknown[] = []
  const valueRows = missing.map(item => {
    const event = item.event
    const row = [
      item.batchIndex,
      event.eventId,
      event.schemaVersion,
      event.sourceService,
      event.sourceKind,
      event.sourceEventId,
      idempotencyKey(event),
      event.occurredAt,
      event.ingestedAt,
      event.payloadSha256,
      ...familyColumns.map(name => item.familyColumns.get(name)),
      event.stream.environment,
      event.stream.tenantId,
      event.stream.teamId,
      event.stream.runId,
      event.stream.operationId,
      event.stream.workloadRef,
    ]
    const placeholders = row.map((value, columnIndex) => {
      values.push(value)
      const sqlType = COLUMN_SQL_TYPES[batchColumns[columnIndex]]
      return `$${values.length}${sqlType ? `::${sqlType}` : ''}`
    })
    return `(${placeholders.join(', ')})`
  })
  values.push(batch.family)
  const familyPlaceholder = `$${values.length}`

  return {
    sql: `WITH batch_values (${batchColumns.join(', ')}) AS (
       VALUES ${valueRows.join(', ')}
     ), inserted_family AS (
       INSERT INTO ${batch.table} (${familyInsertColumns.join(', ')})
       SELECT ${familyInsertColumns.join(', ')}
         FROM batch_values
        ORDER BY batch_index
       RETURNING event_id, schema_version, occurred_at, ingested_at, payload_sha256
     ), inserted_stream AS (
       INSERT INTO governed_event_stream
         (event_family, event_id, schema_version, occurred_at, ingested_at,
          environment, tenant_id, team_id, run_id, operation_id, workload_ref, payload_sha256)
       SELECT ${familyPlaceholder}, f.event_id, f.schema_version, f.occurred_at, f.ingested_at,
              b.stream_environment, b.stream_tenant_id, b.stream_team_id, b.stream_run_id,
              b.stream_operation_id, b.stream_workload_ref, f.payload_sha256
         FROM inserted_family f
         JOIN batch_values b USING (event_id)
        ORDER BY b.batch_index
       RETURNING stream_sequence, event_id
     )
     SELECT b.batch_index, f.event_id, f.payload_sha256, f.ingested_at, s.stream_sequence
       FROM batch_values b
       JOIN inserted_family f USING (event_id)
       JOIN inserted_stream s USING (event_id)
      ORDER BY b.batch_index`,
    values,
  }
}

/**
 * Appends one non-empty, same-family batch inside the caller's transaction.
 * Duplicate identities with the same digest are written once; the first input
 * is accepted and later inputs replay it. Conflicting duplicates abort before
 * any database round trip.
 */
export async function appendGovernedEventBatchInTransaction<Family extends GovernedEventFamily>(
  db: DbClient,
  events: PendingGovernedEventBatch<Family>
): Promise<GovernedAppendResult[]> {
  const batch = prepareBatch(events)

  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(lock_identity, 0))
       FROM unnest($1::text[]) WITH ORDINALITY AS ordered_locks(lock_identity, lock_order)
      ORDER BY lock_order`,
    [batch.lockIdentities]
  )

  const requested = batch.canonicalEvents.map(item => ({
    batch_index: item.batchIndex,
    source_service: item.event.sourceService,
    source_kind: item.event.sourceKind,
    source_event_id: item.event.sourceEventId,
    idempotency_key: idempotencyKey(item.event),
  }))
  const existing = await db.query(
    `WITH requested AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS input(
           batch_index integer,
           source_service text,
           source_kind text,
           source_event_id text,
           idempotency_key text
         )
     )
     SELECT r.batch_index, f.event_id, f.payload_sha256, f.ingested_at, s.stream_sequence
       FROM requested r
       JOIN ${batch.table} f
         ON f.source_service = r.source_service
        AND f.source_kind = r.source_kind
        AND f.idempotency_key = r.idempotency_key
       LEFT JOIN governed_event_stream s
         ON s.event_family = $1 AND s.event_id = f.event_id
      ORDER BY r.batch_index`,
    [batch.family, JSON.stringify(requested)]
  )

  const expectedIndexes = new Set(batch.canonicalEvents.map(item => item.batchIndex))
  const existingByIndex = collectRowsByBatchIndex(
    existing.rows,
    expectedIndexes,
    'governed append lookup returned duplicate or unrequested rows'
  )
  for (const item of batch.canonicalEvents) {
    const row = existingByIndex.get(item.batchIndex)
    if (!row) continue
    if (row.stream_sequence === null || row.stream_sequence === undefined) {
      throw new TracingPersistenceInvariantError(
        `existing ${batch.family} event has no governed_event_stream pointer`
      )
    }
    if (String(row.payload_sha256) !== item.event.payloadSha256) {
      throw new TracingIdempotencyConflictError(
        batch.family,
        item.event.sourceKind,
        item.event.sourceEventId
      )
    }
  }

  const missing = batch.canonicalEvents.filter(item => !existingByIndex.has(item.batchIndex))
  const inserted = missing.length
    ? await db.query(
        ...(() => {
          const statement = insertMissingBatchSql(batch, missing)
          return [statement.sql, statement.values] as const
        })()
      )
    : await db.query(
        `SELECT NULL::integer AS batch_index, NULL::text AS event_id,
                NULL::text AS payload_sha256, NULL::timestamptz AS ingested_at,
                NULL::bigint AS stream_sequence
          WHERE FALSE`
      )
  const missingIndexes = new Set(missing.map(item => item.batchIndex))
  const insertedByIndex = collectRowsByBatchIndex(
    inserted.rows,
    missingIndexes,
    `atomic ${batch.family} append returned duplicate or unrequested rows`
  )
  if (insertedByIndex.size !== missing.length) {
    throw new TracingPersistenceInvariantError(
      `atomic ${batch.family} append did not return every family row and stream pointer`
    )
  }

  const canonicalResults = new Map<number, GovernedAppendResult>()
  for (const item of batch.canonicalEvents) {
    const existingRow = existingByIndex.get(item.batchIndex)
    const row = existingRow ?? insertedByIndex.get(item.batchIndex)
    if (!row || row.stream_sequence === null || row.stream_sequence === undefined) {
      throw new TracingPersistenceInvariantError(
        `atomic ${batch.family} append did not return a family row and stream pointer`
      )
    }
    canonicalResults.set(
      item.batchIndex,
      mapResult(existingRow ? 'replayed' : 'accepted', batch.family, row)
    )
  }

  return batch.canonicalIndexByInput.map((canonicalIndex, inputIndex) => {
    const result = canonicalResults.get(canonicalIndex)
    if (!result) {
      throw new TracingPersistenceInvariantError('governed append result ordering is incomplete')
    }
    if (canonicalIndex === inputIndex) return result
    return { ...result, kind: 'replayed', accepted: 0, replayed: 1 }
  })
}

/**
 * Requires a real transaction. The advisory transaction lock serializes one
 * family/source-service/source-kind/source-event identity without mutating
 * append-only rows. It must match the family-level database uniqueness exactly.
 */
export async function appendGovernedEventInTransaction(
  db: DbClient,
  event: PendingGovernedEvent
): Promise<GovernedAppendResult> {
  const [result] = await appendGovernedEventBatchInTransaction(db, [event])
  return result
}

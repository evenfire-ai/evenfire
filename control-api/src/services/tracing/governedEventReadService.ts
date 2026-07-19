import { governedTraceReadDurationSeconds } from '../../observability/metrics.js'
import { canonicalPayloadSha256 } from './append.js'
import { GOVERNED_EVENT_FAMILIES } from './contracts.js'
import type {
  GovernedEventFamily,
  GovernedEventReadPageV1,
  GovernedEventReadQueryV1,
  GovernedEventReadRepositoryV1,
  GovernedEventReadRowV1,
  GovernedReadScope,
} from './contracts.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

type GovernedReadMetricFamily = GovernedEventFamily | 'mixed'

const FAMILY_PAYLOAD_FIELDS: Record<GovernedEventFamily, ReadonlySet<string>> = {
  agent_run: new Set([
    'phase',
    'state',
    'status',
    'summary',
    'detail_ref',
    'tool_name',
    'model',
    'attempt',
    'count',
    'config_hash',
  ]),
  administrative: new Set([
    'reason_code',
    'status',
    'resource_class',
    'summary',
    'detail_ref',
    'target_label',
    'target_principal_kind',
    'target_principal_ref',
    'count',
    'config_hash',
  ]),
  infrastructure_telemetry: new Set([
    'trigger_kind',
    'reason_code',
    'error_class',
    'environment',
    'cluster_name',
    'namespace',
    'workload_kind',
    'workload_ref',
    'kubernetes_kind',
    'kubernetes_name',
    'interval_start',
    'interval_end',
    'desired_replicas',
    'observed_replicas',
    'ready_replicas',
    'cpu_request_cores',
    'cpu_limit_cores',
    'memory_request_bytes',
    'memory_limit_bytes',
    'cpu_usage_core_seconds',
    'memory_usage_byte_seconds',
    'state',
    'status',
    'transition',
    'resource_class',
    'unit',
    'provider_ref',
    'summary',
    'count',
    'config_hash',
  ]),
}

type CursorV1 = {
  v: 1
  after: string
  highWatermark: string
  queryHash: string
}

export class GovernedReadScopeMismatchError extends Error {
  readonly code = 'governed_read_scope_mismatch'

  constructor(message: string) {
    super(message)
    this.name = 'GovernedReadScopeMismatchError'
  }
}

export class GovernedReadInvalidQueryError extends Error {
  readonly code = 'governed_read_invalid_query'
  readonly status = 400
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'GovernedReadInvalidQueryError'
  }
}

function isSequence(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function decodeCursor(value: string): CursorV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new GovernedReadInvalidQueryError('invalid governed event cursor')
  }
  if (!parsed || typeof parsed !== 'object')
    throw new GovernedReadInvalidQueryError('invalid governed event cursor')
  const cursor = parsed as Record<string, unknown>
  if (
    cursor.v !== 1 ||
    !isSequence(cursor.after) ||
    !isSequence(cursor.highWatermark) ||
    typeof cursor.queryHash !== 'string'
  ) {
    throw new GovernedReadInvalidQueryError('invalid governed event cursor')
  }
  return cursor as CursorV1
}

function encodeCursor(cursor: CursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function nonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`)
}

function validateScope(scope: GovernedReadScope): void {
  switch (scope.kind) {
    case 'stream':
      return
    case 'workflow_run':
      nonEmpty(scope.runId, 'runId')
      nonEmpty(scope.recipeNamespace, 'recipeNamespace')
      nonEmpty(scope.recipeName, 'recipeName')
      return
    case 'host_run':
      nonEmpty(scope.runId, 'runId')
      nonEmpty(scope.hostRef, 'hostRef')
      return
    case 'workload':
      nonEmpty(scope.workloadRef, 'workloadRef')
      return
    default:
      throw new Error('runId cannot be queried without workflow_run or host_run scope')
  }
}

function validateTimeWindow(
  from: string | undefined,
  to: string | undefined
): [string | null, string | null] {
  if (!from && !to) return [null, null]
  if (!from || !to) throw new Error('occurredFrom and occurredTo must be provided together')
  const fromDate = new Date(from)
  const toDate = new Date(to)
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) {
    throw new Error('governed event time bounds must be ISO timestamps')
  }
  if (fromDate >= toDate || toDate.getTime() - fromDate.getTime() > MAX_WINDOW_MS) {
    throw new Error('governed event time window must be positive and at most 31 days')
  }
  return [fromDate.toISOString(), toDate.toISOString()]
}

function releasePayload(row: GovernedEventReadRowV1): GovernedEventReadRowV1 {
  const allowed = FAMILY_PAYLOAD_FIELDS[row.eventFamily]
  const payload = Object.fromEntries(
    Object.entries(row.payload).filter(([field]) => allowed.has(field))
  )
  return { ...row, payload }
}

function assertRelationshipScope(scope: GovernedReadScope, rows: GovernedEventReadRowV1[]): void {
  if (scope.kind === 'workflow_run') {
    const mismatch = rows.some(
      row => row.recipeNamespace !== scope.recipeNamespace || row.recipeName !== scope.recipeName
    )
    if (mismatch) {
      throw new GovernedReadScopeMismatchError('workflow run does not match the requested recipe')
    }
  }
  if (scope.kind === 'host_run' && rows.some(row => row.hostRef !== scope.hostRef)) {
    throw new GovernedReadScopeMismatchError('run does not match the requested host')
  }
}

function metricFamily(families: GovernedEventFamily[]): GovernedReadMetricFamily {
  return families.length === 1 ? families[0] : 'mixed'
}

export class GovernedEventReadService {
  constructor(private readonly repository: GovernedEventReadRepositoryV1) {}

  async read(query: GovernedEventReadQueryV1): Promise<GovernedEventReadPageV1> {
    validateScope(query.scope)
    const limit = query.limit ?? DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`governed event read limit must be between 1 and ${MAX_LIMIT}`)
    }
    const families = [...new Set(query.families ?? GOVERNED_EVENT_FAMILIES)]
    if (families.length < 1 || families.some(family => !GOVERNED_EVENT_FAMILIES.includes(family))) {
      throw new Error('governed event read contains an unknown or empty family filter')
    }
    const startedAt = process.hrtime.bigint()
    const family = metricFamily(families)
    try {
      const [occurredFrom, occurredTo] = validateTimeWindow(query.occurredFrom, query.occurredTo)
      const order = query.order ?? 'oldest'
      const queryHash = canonicalPayloadSha256({
        scope: query.scope,
        families: [...families].sort(),
        order,
        occurredFrom,
        occurredTo,
        filters: query.filters ?? {},
      })
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (cursor && cursor.queryHash !== queryHash) {
        throw new GovernedReadInvalidQueryError(
          'governed event cursor does not belong to this query'
        )
      }

      const highWatermark = cursor?.highWatermark ?? (await this.repository.captureHighWatermark())
      const afterSequence =
        cursor?.after ?? (order === 'latest' ? (BigInt(highWatermark) + 1n).toString() : '0')
      const rows = await this.repository.readAfter({
        scope: query.scope,
        families,
        order,
        afterSequence,
        highWatermark,
        limit,
        occurredFrom,
        occurredTo,
        filters: query.filters ?? {},
      })
      assertRelationshipScope(query.scope, rows)
      const events = rows.map(releasePayload)
      const last = rows.at(-1)

      return {
        events,
        capturedHighWatermark: highWatermark,
        nextCursor:
          last && rows.length === limit
            ? encodeCursor({
                v: 1,
                after: last.streamSequence,
                highWatermark,
                queryHash,
              })
            : null,
      }
    } finally {
      governedTraceReadDurationSeconds.observe(
        { family },
        Number(process.hrtime.bigint() - startedAt) / 1e9
      )
    }
  }
}

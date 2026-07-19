import type { DbClient } from '../db.js'
import { pool } from '../db.js'

export type UsageSourceKind = 'channel' | 'desktop' | 'workflow' | 'cron' | 'unknown'

export type LlmUsageEvent = {
  request_id: string
  ts: string
  run_id: string | null
  host_ref: string
  context_ref: string | null
  team_id: string | null
  provider: string
  model: string
  llm_secret_name: string | null
  source_kind: UsageSourceKind
  user_id: string | null
  sender: string | null
  channel_type: string | null
  recipe_name: string | null
  cron_job_id: string | null
  task_id: string | null
  iteration: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cache_tokens_reported: boolean
}

export type UsageIngestResult = {
  accepted: number
  duplicates: number
  rejected: number
}

export type UsageIngestTransactionResult = {
  result: UsageIngestResult
  acceptedEvents: LlmUsageEvent[]
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCE_KINDS: Set<string> = new Set(['channel', 'desktop', 'workflow', 'cron', 'unknown'])
const CONTROL_PLANE_ADMIN_USAGE_TEAM_ID = 'control-plane-admin-ui'
const CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX = 'admin-ui/'

function isUsageTeamId(value: string): boolean {
  return UUID_REGEX.test(value) || value === CONTROL_PLANE_ADMIN_USAGE_TEAM_ID
}

function isUsageUserId(value: string): boolean {
  if (UUID_REGEX.test(value)) return true
  if (!value.startsWith(CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX)) return false
  return UUID_REGEX.test(value.slice(CONTROL_PLANE_ADMIN_USAGE_USER_PREFIX.length))
}

function workflowRunIdFromTaskId(taskId: string | null): string | null {
  const runId = taskId?.split(':', 1)[0]?.trim() ?? ''
  return UUID_REGEX.test(runId) ? runId : null
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function intOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (!Number.isInteger(value)) return null
  return value
}

export function validateUsageEvent(raw: unknown): LlmUsageEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const request_id = typeof r.request_id === 'string' ? r.request_id.trim() : ''
  if (!UUID_REGEX.test(request_id)) return null

  const tsRaw = typeof r.ts === 'string' ? r.ts.trim() : ''
  if (!tsRaw) return null
  const tsParsed = new Date(tsRaw)
  if (Number.isNaN(tsParsed.getTime())) return null

  const host_ref = typeof r.host_ref === 'string' ? r.host_ref.trim() : ''
  if (!host_ref) return null

  const provider = typeof r.provider === 'string' ? r.provider.trim() : ''
  if (!provider) return null

  const model = typeof r.model === 'string' ? r.model.trim() : ''
  if (!model) return null

  const source_kind_raw = typeof r.source_kind === 'string' ? r.source_kind.trim() : ''
  if (!SOURCE_KINDS.has(source_kind_raw)) return null

  const team_id = trimOrNull(r.team_id)
  if (team_id && !isUsageTeamId(team_id)) return null
  const user_id = trimOrNull(r.user_id)
  if (user_id && !isUsageUserId(user_id)) return null

  const input_tokens = intOrNull(r.input_tokens)
  const output_tokens = intOrNull(r.output_tokens)
  if (input_tokens === null || output_tokens === null) return null
  if (input_tokens < 0 || output_tokens < 0) return null

  // Cache token counts are optional in the body (older producers omit them) but
  // when present must be non-negative integers. Preserve whether the producer
  // reported either field before normalizing absent counts to zero.
  const cache_tokens_reported =
    r.cache_read_tokens !== undefined || r.cache_write_tokens !== undefined
  const cache_read_raw = r.cache_read_tokens === undefined ? 0 : intOrNull(r.cache_read_tokens)
  const cache_write_raw = r.cache_write_tokens === undefined ? 0 : intOrNull(r.cache_write_tokens)
  if (cache_read_raw === null || cache_write_raw === null) return null
  if (cache_read_raw < 0 || cache_write_raw < 0) return null

  const recipe_name = trimOrNull(r.recipe_name)
  const llm_secret_name = trimOrNull(r.llm_secret_name)
  const task_id = trimOrNull(r.task_id)
  const run_id = trimOrNull(r.run_id)
  if (run_id && !UUID_REGEX.test(run_id)) return null
  if (source_kind_raw === 'workflow') {
    const taskRunId = workflowRunIdFromTaskId(task_id)
    if (!recipe_name || !llm_secret_name || !run_id || !taskRunId) return null
    if (taskRunId.toLowerCase() !== run_id.toLowerCase()) return null
  }

  return {
    request_id,
    ts: tsParsed.toISOString(),
    run_id: run_id?.toLowerCase() ?? null,
    host_ref,
    context_ref: trimOrNull(r.context_ref),
    team_id,
    provider,
    model,
    llm_secret_name,
    source_kind: source_kind_raw as UsageSourceKind,
    user_id,
    sender: trimOrNull(r.sender),
    channel_type: trimOrNull(r.channel_type),
    recipe_name,
    cron_job_id: trimOrNull(r.cron_job_id),
    task_id,
    iteration: intOrNull(r.iteration),
    input_tokens,
    output_tokens,
    cache_read_tokens: cache_read_raw,
    cache_write_tokens: cache_write_raw,
    cache_tokens_reported,
  }
}

const COLUMNS_PER_EVENT = 22

function buildInsertSql(rowCount: number): string {
  const placeholders: string[] = []
  for (let i = 0; i < rowCount; i++) {
    const o = i * COLUMNS_PER_EVENT
    const slots: string[] = []
    for (let c = 1; c <= COLUMNS_PER_EVENT; c++) slots.push(`$${o + c}`)
    placeholders.push(`(${slots.join(',')})`)
  }
  return `
    INSERT INTO usage_events (
      request_id, ts, run_id, host_ref, context_ref, team_id, provider, model, llm_secret_name,
      source_kind, user_id, sender, channel_type, recipe_name, cron_job_id,
      task_id, iteration, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cache_tokens_reported
    )
    VALUES ${placeholders.join(',')}
    ON CONFLICT (request_id) DO NOTHING
    RETURNING request_id
  `
}

function buildInsertParams(events: LlmUsageEvent[]): unknown[] {
  const params: unknown[] = []
  for (const e of events) {
    params.push(
      e.request_id,
      e.ts,
      e.run_id,
      e.host_ref,
      e.context_ref,
      e.team_id,
      e.provider,
      e.model,
      e.llm_secret_name,
      e.source_kind,
      e.user_id,
      e.sender,
      e.channel_type,
      e.recipe_name,
      e.cron_job_id,
      e.task_id,
      e.iteration,
      e.input_tokens,
      e.output_tokens,
      e.cache_read_tokens,
      e.cache_write_tokens,
      e.cache_tokens_reported
    )
  }
  return params
}

export async function ingestUsageEvents(
  rawEvents: unknown[],
  db: DbClient = pool
): Promise<UsageIngestResult> {
  return (await ingestUsageEventsInTransaction(rawEvents, db)).result
}

export async function ingestUsageEventsInTransaction(
  rawEvents: unknown[],
  db: DbClient
): Promise<UsageIngestTransactionResult> {
  const total = rawEvents.length
  const validated: LlmUsageEvent[] = []
  for (const raw of rawEvents) {
    const ev = validateUsageEvent(raw)
    if (ev) validated.push(ev)
  }
  const rejected = total - validated.length
  if (validated.length === 0) {
    return {
      result: { accepted: 0, duplicates: 0, rejected },
      acceptedEvents: [],
    }
  }

  const sql = buildInsertSql(validated.length)
  const params = buildInsertParams(validated)
  const result = await db.query(sql, params)
  const acceptedRequestIds = new Set(
    (result.rows as Array<{ request_id?: unknown }>)
      .filter((row): row is { request_id: string } => typeof row.request_id === 'string')
      .map(row => row.request_id.toLowerCase())
  )
  const acceptedByRequestId = new Map<string, LlmUsageEvent>()
  for (const event of validated) {
    const requestId = event.request_id.toLowerCase()
    if (acceptedRequestIds.has(requestId) && !acceptedByRequestId.has(requestId)) {
      acceptedByRequestId.set(requestId, event)
    }
  }
  const acceptedEvents = Array.from(acceptedByRequestId.values())
  const accepted = acceptedEvents.length
  const duplicates = validated.length - accepted
  return {
    result: { accepted, duplicates, rejected },
    acceptedEvents,
  }
}

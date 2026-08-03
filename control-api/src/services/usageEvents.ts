import type { DbClient } from '../db.js'
import { pool } from '../db.js'

export type UsageSourceKind =
  | 'channel'
  | 'desktop'
  | 'workflow'
  | 'cron'
  | 'unknown'
  | 'plugin_workload_sdk'

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
  prompt_bridge_metadata: {
    invocation_id?: string
    target_ref: string
    credential_slot: string
    fallback_used: boolean
    attempt_count: number
    attempt_generation?: number
    provider_attempt_id?: string
    provider_attempt_index?: number
  } | null
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

type PromptBridgeAttemptBinding = {
  invocation_id: string
  recipe_name: string
  contract_version: number
  attempt_generation: number
  method: string
  target_refs: unknown
}

type ProviderAttemptBinding = {
  id: string
  invocation_id: string
  attempt_generation: number
  attempt_index: number
  target_ref: string
  provider: string
  model: string
  credential_slot: string
  status: string
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCE_KINDS: Set<string> = new Set([
  'channel',
  'desktop',
  'workflow',
  'cron',
  'unknown',
  'plugin_workload_sdk',
])
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

function promptBridgeMetadata(value: unknown): LlmUsageEvent['prompt_bridge_metadata'] {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const targetRef = typeof record.target_ref === 'string' ? record.target_ref.trim() : ''
  const invocationId = typeof record.invocation_id === 'string' ? record.invocation_id.trim() : ''
  const credentialSlot =
    typeof record.credential_slot === 'string' ? record.credential_slot.trim() : ''
  const fallbackUsed = record.fallback_used
  const attemptCount = intOrNull(record.attempt_count)
  const attemptGeneration =
    record.attempt_generation === undefined ? null : intOrNull(record.attempt_generation)
  const providerAttemptId =
    record.provider_attempt_id === undefined
      ? null
      : typeof record.provider_attempt_id === 'string' &&
          UUID_REGEX.test(record.provider_attempt_id)
        ? record.provider_attempt_id
        : null
  const providerAttemptIndex =
    record.provider_attempt_index === undefined ? null : intOrNull(record.provider_attempt_index)
  const hasProviderAttemptId = record.provider_attempt_id !== undefined
  const hasProviderAttemptIndex = record.provider_attempt_index !== undefined
  if (
    !targetRef ||
    targetRef.length > 256 ||
    !credentialSlot ||
    credentialSlot.length > 256 ||
    typeof fallbackUsed !== 'boolean' ||
    attemptCount === null ||
    attemptCount < 1 ||
    attemptCount > 4 ||
    (attemptGeneration !== null && attemptGeneration < 1) ||
    hasProviderAttemptId !== hasProviderAttemptIndex ||
    (hasProviderAttemptId && providerAttemptId === null) ||
    (hasProviderAttemptIndex && (providerAttemptIndex === null || providerAttemptIndex < 1))
  ) {
    return null
  }
  return {
    ...(invocationId ? { invocation_id: invocationId } : {}),
    target_ref: targetRef,
    credential_slot: credentialSlot,
    fallback_used: fallbackUsed,
    attempt_count: attemptCount,
    ...(attemptGeneration !== null ? { attempt_generation: attemptGeneration } : {}),
    ...(providerAttemptId !== null ? { provider_attempt_id: providerAttemptId } : {}),
    ...(providerAttemptIndex !== null ? { provider_attempt_index: providerAttemptIndex } : {}),
  }
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

  const prompt_bridge_metadata = promptBridgeMetadata(r.prompt_bridge_metadata)
  if (
    r.prompt_bridge_metadata !== undefined &&
    r.prompt_bridge_metadata !== null &&
    !prompt_bridge_metadata
  ) {
    return null
  }

  const recipe_name = trimOrNull(r.recipe_name)
  const llm_secret_name = trimOrNull(r.llm_secret_name)
  const task_id = trimOrNull(r.task_id)
  const run_id = trimOrNull(r.run_id)
  if (run_id && !UUID_REGEX.test(run_id)) return null
  const isSdkOnly =
    source_kind_raw === 'plugin_workload_sdk' &&
    r.channel_type === 'plugin_workload_sdk' &&
    recipe_name !== null &&
    run_id === null &&
    task_id === null &&
    llm_secret_name !== null &&
    prompt_bridge_metadata?.invocation_id !== undefined
  const isLegacySdkOnly =
    source_kind_raw === 'unknown' &&
    r.channel_type === 'plugin_workload_sdk' &&
    recipe_name !== null &&
    run_id === null &&
    task_id === null &&
    llm_secret_name !== null &&
    prompt_bridge_metadata?.invocation_id !== undefined
  const isWorkflowSdk = source_kind_raw === 'workflow' && r.channel_type === 'plugin_workload_sdk'
  if (source_kind_raw === 'workflow') {
    const taskRunId = workflowRunIdFromTaskId(task_id)
    if (!recipe_name || !llm_secret_name || !run_id || !taskRunId) return null
    if (taskRunId.toLowerCase() !== run_id.toLowerCase()) return null
  }
  // Workflow promptBridge calls use the same channel marker as SDK-only calls,
  // but retain their canonical workflow run/task/secret binding above. Reject
  // only an unrecognised shape; otherwise the usage emitted by a step-bearing
  // host would be dropped before it can be metered.
  if (
    r.channel_type === 'plugin_workload_sdk' &&
    !isSdkOnly &&
    !isLegacySdkOnly &&
    !isWorkflowSdk
  ) {
    return null
  }
  if (
    (isSdkOnly || isWorkflowSdk) &&
    !UUID_REGEX.test(prompt_bridge_metadata?.invocation_id ?? '')
  ) {
    return null
  }
  // Contract v2 physical-attempt fields are checked against the persisted
  // receipt during ingestion. A v1 host may omit generation/attempt fields;
  // retaining the event here lets the binding layer classify it explicitly as
  // the narrow legacy lane instead of confusing it with malformed JSON.

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
    prompt_bridge_metadata,
  }
}

const COLUMNS_PER_EVENT = 23

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
      cache_tokens_reported, prompt_bridge_metadata
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
      e.cache_tokens_reported,
      e.prompt_bridge_metadata
    )
  }
  return params
}

/**
 * Bind SDK-only usage to an immutable attempt receipt rather than the mutable
 * parent invocation status. A delayed reporter remains valid for the attempt
 * that actually executed, while a stale generation or forged target is
 * rejected before it can enter the usage ledger.
 */
async function filterEventsByAttemptReceipt(
  events: LlmUsageEvent[],
  db: DbClient
): Promise<{ accepted: LlmUsageEvent[]; rejected: number }> {
  // Both runtime lanes use the same immutable attempt receipt.  SDK-only
  // hosts emit source_kind=plugin_workload_sdk; step-bearing hosts retain
  // source_kind=workflow for run attribution but mark the channel as the
  // Plugin Workload SDK.  Treating the latter as ordinary workflow usage
  // would leave the target/generation binding unaudited.
  const isPromptBridgeSdkEvent = (event: LlmUsageEvent): boolean =>
    event.channel_type === 'plugin_workload_sdk' &&
    (event.source_kind === 'unknown' ||
      event.source_kind === 'plugin_workload_sdk' ||
      event.source_kind === 'workflow')
  const sdkEvents = events.filter(isPromptBridgeSdkEvent)
  if (sdkEvents.length === 0) return { accepted: events, rejected: 0 }
  const invocationIds = [
    ...new Set(
      sdkEvents
        .map(event => event.prompt_bridge_metadata?.invocation_id)
        .filter((value): value is string => typeof value === 'string')
    ),
  ]
  if (invocationIds.length === 0) {
    return {
      accepted: events.filter(event => !isPromptBridgeSdkEvent(event)),
      rejected: sdkEvents.length,
    }
  }
  const result = await db.query(
    `SELECT attempts.invocation_id::text, attempts.attempt_generation, attempts.method,
            attempts.target_refs, attempts.recipe_name, invocations.contract_version
       FROM plugin_workload_sdk_invocation_attempts attempts
       JOIN plugin_workload_sdk_invocations invocations
         ON invocations.id = attempts.invocation_id
      WHERE attempts.invocation_id = ANY($1::uuid[])`,
    [invocationIds]
  )
  const receipts = new Map<string, PromptBridgeAttemptBinding>()
  for (const row of result.rows as PromptBridgeAttemptBinding[]) {
    receipts.set(`${row.invocation_id}:${row.attempt_generation}`, row)
  }
  const providerAttemptIds = sdkEvents
    .map(event => event.prompt_bridge_metadata?.provider_attempt_id)
    .filter((value): value is string => typeof value === 'string')
  const providerAttempts = providerAttemptIds.length
    ? await db.query(
        `SELECT id::text, invocation_id::text, attempt_generation, attempt_index,
                target_ref, provider, model, credential_slot, status
           FROM plugin_workload_sdk_provider_attempts
          WHERE id = ANY($1::uuid[])`,
        [[...new Set(providerAttemptIds)]]
      )
    : { rows: [] }
  const providerAttemptById = new Map<string, ProviderAttemptBinding>()
  for (const row of providerAttempts.rows as ProviderAttemptBinding[]) {
    providerAttemptById.set(row.id, row)
  }
  const accepted: LlmUsageEvent[] = []
  let rejected = 0
  for (const event of events) {
    if (!isPromptBridgeSdkEvent(event)) {
      accepted.push(event)
      continue
    }
    const metadata = event.prompt_bridge_metadata
    const invocationId = metadata?.invocation_id
    const generation = metadata?.attempt_generation
    const providerAttemptId = metadata?.provider_attempt_id
    const providerAttemptIndex = metadata?.provider_attempt_index
    const receipt =
      typeof invocationId === 'string' && Number.isInteger(generation)
        ? receipts.get(`${invocationId}:${generation}`)
        : undefined
    const targetRefs = receipt && Array.isArray(receipt.target_refs) ? receipt.target_refs : []
    const targetRef = metadata?.target_ref
    const legacyInvocation =
      typeof invocationId === 'string'
        ? await db.query(
            `SELECT contract_version, method, status, authorization_decision, detail,
                    recipe_namespace, recipe_name
               FROM plugin_workload_sdk_invocations
              WHERE id = $1`,
            [invocationId]
          )
        : { rows: [] }
    const legacy = legacyInvocation.rows[0] as
      | {
          contract_version?: unknown
          method?: unknown
          status?: unknown
          authorization_decision?: unknown
          detail?: unknown
          recipe_namespace?: unknown
          recipe_name?: unknown
        }
      | undefined
    const hasPhysicalAttempt =
      typeof providerAttemptId === 'string' && Number.isInteger(providerAttemptIndex)
    const legacyCompatible =
      !hasPhysicalAttempt &&
      legacy?.contract_version === 1 &&
      legacy.method === 'promptBridge' &&
      ['in_progress', 'complete'].includes(String(legacy.status)) &&
      legacy.authorization_decision === 'authorized' &&
      legacy.recipe_name === event.recipe_name &&
      legacy.detail === event.model
    const physicalCompatible =
      hasPhysicalAttempt &&
      receipt?.method === 'promptBridge' &&
      receipt.recipe_name === event.recipe_name &&
      typeof targetRef === 'string' &&
      targetRefs.some(ref => ref === targetRef) &&
      providerAttemptById.get(providerAttemptId!)?.invocation_id === invocationId &&
      providerAttemptById.get(providerAttemptId!)?.attempt_generation === generation &&
      providerAttemptById.get(providerAttemptId!)?.attempt_index === providerAttemptIndex &&
      providerAttemptById.get(providerAttemptId!)?.target_ref === targetRef &&
      providerAttemptById.get(providerAttemptId!)?.provider === event.provider &&
      providerAttemptById.get(providerAttemptId!)?.model === event.model &&
      providerAttemptById.get(providerAttemptId!)?.credential_slot === metadata?.credential_slot &&
      providerAttemptById.get(providerAttemptId!)?.status === 'complete'
    if (physicalCompatible || legacyCompatible) {
      accepted.push(event)
    } else {
      rejected += 1
    }
  }
  return { accepted, rejected }
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
  let validated: LlmUsageEvent[] = []
  for (const raw of rawEvents) {
    const ev = validateUsageEvent(raw)
    if (ev) validated.push(ev)
  }
  let rejected = total - validated.length
  if (validated.length === 0) {
    return {
      result: { accepted: 0, duplicates: 0, rejected },
      acceptedEvents: [],
    }
  }

  const receiptFilter = await filterEventsByAttemptReceipt(validated, db)
  validated = receiptFilter.accepted
  rejected += receiptFilter.rejected
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

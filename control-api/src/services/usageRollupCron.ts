/**
 * Rollup crons for LLM-usage events. Three independent setInterval timers
 * aggregate raw events upward:
 *
 *   usage_events  ──(every 60s, sweep last 48h)──▶  usage_5min
 *   usage_5min    ──(every 5m,  sweep last 48h)──▶  usage_hourly
 *   usage_hourly  ──(every 1h,  sweep last 2d)─────▶  usage_daily
 *
 * Each rollup is `INSERT ... ON CONFLICT DO UPDATE` so re-running the same
 * window is idempotent: GROUP BY produces the same dimension row, and
 * EXCLUDED.* overwrites the prior aggregate.
 *
 * The 5-min rollup is the only tier that resolves `team_id`. New events carry
 * the effective team snapshot in `usage_events.team_id`; context-bound channel
 * usage can still resolve through `context_ref -> team_contexts`. Workflow
 * usage must carry the canonical run_id prefix in `task_id`, but rollup does
 * not infer ownership from mutable actor/team membership.
 * Once resolved at that tier, hourly/daily rollups carry the `team_id` forward
 * as a plain dimension column.
 * "Team at the time of the call" is the event snapshot. Historical rows with
 * missing snapshots are migration/cleanup concerns, not compatibility fallbacks.
 */
import { type DbClient, pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'

const log = rootLogger.child({ service: 'usage_rollup' })

// team_contexts is an M:N table, so context resolution collapses to one
// canonical team before joining usage rows.
//
// team_contexts: a context
// shared across teams would naively fan out the LEFT JOIN and double-count
// every event. The DISTINCT ON subquery collapses to one canonical team
// per context — earliest-bound wins, with team_id breaking ties — so each
// raw event contributes exactly one row to usage_5min. Multi-team contexts
// surface only under their canonical team in the breakdowns; consequence
// documented in the read endpoint's group-by behaviour.
const ROLLUP_5MIN_SQL = `
  WITH purged_recent AS (
    DELETE FROM usage_5min
    WHERE bucket >= NOW() - INTERVAL '48 hours'
    RETURNING 1
  )
  INSERT INTO usage_5min (
    bucket, host_ref, context_ref, team_id, llm_secret_name, user_id, sender,
    channel_type, recipe_name, cron_job_id, provider, model, source_kind,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    total_tokens, request_count
  )
  SELECT
    date_trunc('minute', e.ts) - (extract(minute from e.ts)::int % 5) * interval '1 minute' AS bucket,
    e.host_ref,
    e.context_ref,
    COALESCE(e.team_id, tc.team_id::text) AS team_id,
    e.llm_secret_name,
    e.user_id,
    e.sender,
    e.channel_type,
    e.recipe_name,
    e.cron_job_id,
    e.provider,
    e.model,
    e.source_kind,
    SUM(e.input_tokens)::bigint        AS input_tokens,
    SUM(e.output_tokens)::bigint       AS output_tokens,
    SUM(e.cache_read_tokens)::bigint   AS cache_read_tokens,
    SUM(e.cache_write_tokens)::bigint  AS cache_write_tokens,
    (SUM(e.input_tokens) + SUM(e.output_tokens))::bigint AS total_tokens,
    COUNT(*)::bigint AS request_count
  FROM usage_events e
  LEFT JOIN (
    SELECT DISTINCT ON (context_id) context_id, team_id
    FROM team_contexts
    ORDER BY context_id, created_at ASC, team_id ASC
  ) tc ON tc.context_id = e.context_ref
  WHERE e.ts >= NOW() - INTERVAL '48 hours'
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ON CONFLICT (bucket, host_ref, context_ref_key, team_id_key,
               provider, model, llm_secret_key, source_kind,
               user_id_key, sender_key, channel_type_key,
               recipe_name_key, cron_job_id_key)
  DO UPDATE SET
    input_tokens       = EXCLUDED.input_tokens,
    output_tokens      = EXCLUDED.output_tokens,
    cache_read_tokens  = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    total_tokens       = EXCLUDED.total_tokens,
    request_count      = EXCLUDED.request_count
`

const ROLLUP_HOURLY_SQL = `
  WITH purged_recent AS (
    DELETE FROM usage_hourly
    WHERE bucket >= NOW() - INTERVAL '48 hours'
    RETURNING 1
  )
  INSERT INTO usage_hourly (
    bucket, host_ref, context_ref, team_id, llm_secret_name, user_id, sender,
    channel_type, recipe_name, cron_job_id, provider, model, source_kind,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    total_tokens, request_count
  )
  SELECT
    date_trunc('hour', f.bucket) AS bucket,
    f.host_ref, f.context_ref, f.team_id, f.llm_secret_name, f.user_id, f.sender,
    f.channel_type, f.recipe_name, f.cron_job_id, f.provider, f.model, f.source_kind,
    SUM(f.input_tokens)::bigint        AS input_tokens,
    SUM(f.output_tokens)::bigint       AS output_tokens,
    SUM(f.cache_read_tokens)::bigint   AS cache_read_tokens,
    SUM(f.cache_write_tokens)::bigint  AS cache_write_tokens,
    SUM(f.total_tokens)::bigint        AS total_tokens,
    SUM(f.request_count)::bigint       AS request_count
  FROM usage_5min f
  WHERE f.bucket >= NOW() - INTERVAL '48 hours'
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ON CONFLICT (bucket, host_ref, context_ref_key, team_id_key,
               provider, model, llm_secret_key, source_kind,
               user_id_key, sender_key, channel_type_key,
               recipe_name_key, cron_job_id_key)
  DO UPDATE SET
    input_tokens       = EXCLUDED.input_tokens,
    output_tokens      = EXCLUDED.output_tokens,
    cache_read_tokens  = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    total_tokens       = EXCLUDED.total_tokens,
    request_count      = EXCLUDED.request_count
`

const ROLLUP_DAILY_SQL = `
  WITH purged_recent AS (
    DELETE FROM usage_daily
    WHERE bucket >= NOW() - INTERVAL '2 days'
    RETURNING 1
  )
  INSERT INTO usage_daily (
    bucket, host_ref, context_ref, team_id, llm_secret_name, user_id, sender,
    channel_type, recipe_name, cron_job_id, provider, model, source_kind,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    total_tokens, request_count
  )
  SELECT
    date_trunc('day', f.bucket) AS bucket,
    f.host_ref, f.context_ref, f.team_id, f.llm_secret_name, f.user_id, f.sender,
    f.channel_type, f.recipe_name, f.cron_job_id, f.provider, f.model, f.source_kind,
    SUM(f.input_tokens)::bigint        AS input_tokens,
    SUM(f.output_tokens)::bigint       AS output_tokens,
    SUM(f.cache_read_tokens)::bigint   AS cache_read_tokens,
    SUM(f.cache_write_tokens)::bigint  AS cache_write_tokens,
    SUM(f.total_tokens)::bigint        AS total_tokens,
    SUM(f.request_count)::bigint       AS request_count
  FROM usage_hourly f
  WHERE f.bucket >= NOW() - INTERVAL '2 days'
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ON CONFLICT (bucket, host_ref, context_ref_key, team_id_key,
               provider, model, llm_secret_key, source_kind,
               user_id_key, sender_key, channel_type_key,
               recipe_name_key, cron_job_id_key)
  DO UPDATE SET
    input_tokens       = EXCLUDED.input_tokens,
    output_tokens      = EXCLUDED.output_tokens,
    cache_read_tokens  = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    total_tokens       = EXCLUDED.total_tokens,
    request_count      = EXCLUDED.request_count
`

export type RollupResult = { rowCount: number }

export async function rollupUsageEventsTo5Min(db: DbClient = pool): Promise<RollupResult> {
  const res = await db.query(ROLLUP_5MIN_SQL)
  return { rowCount: res.rowCount ?? 0 }
}

export async function rollupUsage5MinToHourly(db: DbClient = pool): Promise<RollupResult> {
  const res = await db.query(ROLLUP_HOURLY_SQL)
  return { rowCount: res.rowCount ?? 0 }
}

export async function rollupUsageHourlyToDaily(db: DbClient = pool): Promise<RollupResult> {
  const res = await db.query(ROLLUP_DAILY_SQL)
  return { rowCount: res.rowCount ?? 0 }
}

export type StartUsageRollupOptions = {
  fiveMinIntervalMs: number
  hourlyIntervalMs: number
  dailyIntervalMs: number
}

let fiveMinHandle: ReturnType<typeof setInterval> | null = null
let hourlyHandle: ReturnType<typeof setInterval> | null = null
let dailyHandle: ReturnType<typeof setInterval> | null = null

async function safeRollup(
  name: string,
  fn: () => Promise<RollupResult>,
  successEvent: string
): Promise<void> {
  try {
    const result = await fn()
    if (result.rowCount > 0) {
      log.debug(
        { event: successEvent, rowCount: result.rowCount },
        `${name} rolled ${result.rowCount} rows`
      )
    }
  } catch (err) {
    log.error(
      {
        event: `${successEvent}_error`,
        err: err instanceof Error ? err.message : String(err),
      },
      `${name} rollup failed`
    )
  }
}

export function startUsageRollupCron(opts: StartUsageRollupOptions): void {
  if (fiveMinHandle || hourlyHandle || dailyHandle) return

  fiveMinHandle = setInterval(() => {
    void safeRollup('usage_events→5min', rollupUsageEventsTo5Min, 'usage_rollup_5min')
  }, opts.fiveMinIntervalMs)
  fiveMinHandle.unref()

  hourlyHandle = setInterval(() => {
    void safeRollup('5min→hourly', rollupUsage5MinToHourly, 'usage_rollup_hourly')
  }, opts.hourlyIntervalMs)
  hourlyHandle.unref()

  dailyHandle = setInterval(() => {
    void safeRollup('hourly→daily', rollupUsageHourlyToDaily, 'usage_rollup_daily')
  }, opts.dailyIntervalMs)
  dailyHandle.unref()

  log.info(
    {
      event: 'usage_rollup_started',
      fiveMinIntervalMs: opts.fiveMinIntervalMs,
      hourlyIntervalMs: opts.hourlyIntervalMs,
      dailyIntervalMs: opts.dailyIntervalMs,
    },
    'usage rollup crons started'
  )
}

export function stopUsageRollupCron(): void {
  if (fiveMinHandle) {
    clearInterval(fiveMinHandle)
    fiveMinHandle = null
  }
  if (hourlyHandle) {
    clearInterval(hourlyHandle)
    hourlyHandle = null
  }
  if (dailyHandle) {
    clearInterval(dailyHandle)
    dailyHandle = null
  }
}

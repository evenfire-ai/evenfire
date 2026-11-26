/**
 * cron_jobs row mapping for the database worker.
 *
 * Times are unix seconds. The mapper round-trips columns. validateCronRecord
 * reports whether a row may be armed and rebuilds ProviderIdentity without
 * providerEventId. Neither path disables a row. There is no provider_event_id
 * column.
 */
import type { Database, Statement } from 'better-sqlite3'
import { parseNextRun } from '../agent/cronExpression'
import type { CronJob } from '../agent/types'

export type CronJobRecord = {
  id: string
  name: string
  schedule: string
  task: string
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  createdAt: number
  createdBy: string | null
  origin: null | {
    channelType: 'telegram' | 'email' | 'slack' | 'teams' | 'rpc'
    channelId: string
    sender: string
    threadId: string | null
  }
  provider: null | {
    medium: 'telegram' | 'slack' | 'teams'
    providerUserId: string
    providerWorkspaceId: string | null
    providerChannelId: string
    providerChannelType: string | null
    providerTarget: null | {
      hostRef: string
      communicationChannelNamespace: string
      communicationChannelName: string
      providerBotId: string | null
      providerBotUsername: string | null
    }
  }
}

export type CronClaimArgs = {
  id: string
  slotSeconds: number
  nowSeconds: number
  followingSeconds: number
}

const COLUMN_LIST = `
  id, name, schedule, task, enabled,
  next_run_at, last_run_at, created_at, created_by,
  origin_channel_type, origin_channel_id, origin_sender, origin_thread_id,
  provider_medium, provider_user_id, provider_workspace_id, provider_channel_id,
  provider_channel_type, provider_target_host_ref, provider_target_namespace,
  provider_target_name, provider_bot_id, provider_bot_username
`

/** SQL the worker runs. Claim is one compare-and-swap UPDATE. */
export const CRON_JOB_SQL = {
  load: `SELECT ${COLUMN_LIST} FROM cron_jobs`,
  read: `SELECT ${COLUMN_LIST} FROM cron_jobs WHERE id = :id`,
  insert: `
    INSERT INTO cron_jobs (${COLUMN_LIST})
    VALUES (
      :id, :name, :schedule, :task, :enabled,
      :next_run_at, :last_run_at, :created_at, :created_by,
      :origin_channel_type, :origin_channel_id, :origin_sender, :origin_thread_id,
      :provider_medium, :provider_user_id, :provider_workspace_id, :provider_channel_id,
      :provider_channel_type, :provider_target_host_ref, :provider_target_namespace,
      :provider_target_name, :provider_bot_id, :provider_bot_username
    )
  `,
  delete: `DELETE FROM cron_jobs WHERE id = :id`,
  claim: `
    UPDATE cron_jobs
       SET last_run_at = :now_seconds,
           next_run_at = :following_seconds
     WHERE id = :id
       AND enabled = 1 AND next_run_at = :slot
  `,
  setSchedule: `
    UPDATE cron_jobs
       SET enabled = :enabled,
           next_run_at = :next_run_at
     WHERE id = :id
  `,
  setLastRun: `
    UPDATE cron_jobs
       SET last_run_at = :last_run_at
     WHERE id = :id
  `,
} as const

interface CronJobRow {
  id: string
  name: string
  schedule: string
  task: string
  enabled: number
  next_run_at: number | null
  last_run_at: number | null
  created_at: number
  created_by: string | null
  origin_channel_type: string | null
  origin_channel_id: string | null
  origin_sender: string | null
  origin_thread_id: string | null
  provider_medium: string | null
  provider_user_id: string | null
  provider_workspace_id: string | null
  provider_channel_id: string | null
  provider_channel_type: string | null
  provider_target_host_ref: string | null
  provider_target_namespace: string | null
  provider_target_name: string | null
  provider_bot_id: string | null
  provider_bot_username: string | null
}

type OriginChannelType = NonNullable<CronJobRecord['origin']>['channelType']
type ProviderMedium = NonNullable<CronJobRecord['provider']>['medium']

interface CronStatements {
  load: Statement
  read: Statement
  insert: Statement
  delete: Statement
  claim: Statement
  setSchedule: Statement
  setLastRun: Statement
}

const prepared = new WeakMap<Database, CronStatements>()

function statements(db: Database): CronStatements {
  const cached = prepared.get(db)
  if (cached) return cached
  const next: CronStatements = {
    load: db.prepare(CRON_JOB_SQL.load),
    read: db.prepare(CRON_JOB_SQL.read),
    insert: db.prepare(CRON_JOB_SQL.insert),
    delete: db.prepare(CRON_JOB_SQL.delete),
    claim: db.prepare(CRON_JOB_SQL.claim),
    setSchedule: db.prepare(CRON_JOB_SQL.setSchedule),
    setLastRun: db.prepare(CRON_JOB_SQL.setLastRun),
  }
  prepared.set(db, next)
  return next
}

function allNull(values: Array<string | null>): boolean {
  return values.every(value => value === null)
}

function rowToRecord(row: CronJobRow): CronJobRecord {
  const originBlank = allNull([
    row.origin_channel_type,
    row.origin_channel_id,
    row.origin_sender,
    row.origin_thread_id,
  ])
  const targetBlank = allNull([
    row.provider_target_host_ref,
    row.provider_target_namespace,
    row.provider_target_name,
    row.provider_bot_id,
    row.provider_bot_username,
  ])
  const providerBlank =
    targetBlank &&
    allNull([
      row.provider_medium,
      row.provider_user_id,
      row.provider_workspace_id,
      row.provider_channel_id,
      row.provider_channel_type,
    ])
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    task: row.task,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    origin: originBlank
      ? null
      : {
          channelType: row.origin_channel_type as OriginChannelType,
          channelId: row.origin_channel_id as string,
          sender: row.origin_sender as string,
          threadId: row.origin_thread_id,
        },
    provider: providerBlank
      ? null
      : {
          medium: row.provider_medium as ProviderMedium,
          providerUserId: row.provider_user_id as string,
          providerWorkspaceId: row.provider_workspace_id,
          providerChannelId: row.provider_channel_id as string,
          providerChannelType: row.provider_channel_type,
          providerTarget: targetBlank
            ? null
            : {
                hostRef: row.provider_target_host_ref as string,
                communicationChannelNamespace: row.provider_target_namespace as string,
                communicationChannelName: row.provider_target_name as string,
                providerBotId: row.provider_bot_id,
                providerBotUsername: row.provider_bot_username,
              },
        },
  }
}

function recordToRow(row: CronJobRecord): CronJobRow {
  const origin = row.origin
  const provider = row.provider
  const target = provider?.providerTarget ?? null
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    task: row.task,
    enabled: row.enabled ? 1 : 0,
    next_run_at: row.nextRunAt,
    last_run_at: row.lastRunAt,
    created_at: row.createdAt,
    created_by: row.createdBy,
    origin_channel_type: origin?.channelType ?? null,
    origin_channel_id: origin?.channelId ?? null,
    origin_sender: origin?.sender ?? null,
    origin_thread_id: origin?.threadId ?? null,
    provider_medium: provider?.medium ?? null,
    provider_user_id: provider?.providerUserId ?? null,
    provider_workspace_id: provider?.providerWorkspaceId ?? null,
    provider_channel_id: provider?.providerChannelId ?? null,
    provider_channel_type: provider?.providerChannelType ?? null,
    provider_target_host_ref: target?.hostRef ?? null,
    provider_target_namespace: target?.communicationChannelNamespace ?? null,
    provider_target_name: target?.communicationChannelName ?? null,
    provider_bot_id: target?.providerBotId ?? null,
    provider_bot_username: target?.providerBotUsername ?? null,
  }
}

export function loadCronJobs(db: Database): CronJobRecord[] {
  const rows = statements(db).load.all() as CronJobRow[]
  return rows.map(rowToRecord)
}

export function readCronJob(db: Database, id: string): CronJobRecord | null {
  const row = statements(db).read.get({ id }) as CronJobRow | undefined
  return row ? rowToRecord(row) : null
}

export function insertCronJob(db: Database, row: CronJobRecord): void {
  statements(db).insert.run(recordToRow(row))
}

export function deleteCronJob(db: Database, id: string): void {
  statements(db).delete.run({ id })
}

/** One UPDATE. `changes` is SQLite's row count for that statement. */
export function claimCronJob(db: Database, args: CronClaimArgs): { changes: number } {
  const result = statements(db).claim.run({
    id: args.id,
    now_seconds: args.nowSeconds,
    following_seconds: args.followingSeconds,
    slot: args.slotSeconds,
  })
  return { changes: result.changes }
}

export function setCronSchedule(
  db: Database,
  id: string,
  enabled: boolean,
  nextRunAt: number | null
): void {
  statements(db).setSchedule.run({
    id,
    enabled: enabled ? 1 : 0,
    next_run_at: nextRunAt,
  })
}

export function setCronLastRun(db: Database, id: string, lastRunAt: number): void {
  statements(db).setLastRun.run({ id, last_run_at: lastRunAt })
}

const TELEGRAM_CHANNEL_TYPES = new Set(['private', 'group', 'supergroup'])

function filled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function originChannelType(
  value: string | null
): NonNullable<CronJob['origin']>['channelType'] | null {
  if (
    value === 'telegram' ||
    value === 'email' ||
    value === 'slack' ||
    value === 'teams' ||
    value === 'rpc'
  ) {
    return value
  }
  return null
}

function providerMedium(value: string | null): 'telegram' | 'slack' | 'teams' | null {
  if (value === 'telegram' || value === 'slack' || value === 'teams') return value
  return null
}

function readOrigin(origin: CronJobRecord['origin']): CronJob['origin'] | undefined {
  if (!origin) return undefined
  const channelType = originChannelType(origin.channelType)
  if (!channelType || !filled(origin.channelId) || !filled(origin.sender)) return undefined
  if (!filled(origin.threadId)) {
    return { channelType, channelId: origin.channelId, sender: origin.sender }
  }
  return {
    channelType,
    channelId: origin.channelId,
    sender: origin.sender,
    threadId: origin.threadId,
  }
}

function readTarget(
  target: NonNullable<CronJobRecord['provider']>['providerTarget']
): NonNullable<NonNullable<CronJob['providerIdentity']>['providerTarget']> | 'absent' | 'invalid' {
  if (target === null) return 'absent'
  if (
    !filled(target.hostRef) ||
    !filled(target.communicationChannelNamespace) ||
    !filled(target.communicationChannelName)
  ) {
    return 'invalid'
  }
  if (
    (target.providerBotId !== null && !filled(target.providerBotId)) ||
    (target.providerBotUsername !== null && !filled(target.providerBotUsername))
  ) {
    return 'invalid'
  }
  return {
    hostRef: target.hostRef,
    communicationChannelNamespace: target.communicationChannelNamespace,
    communicationChannelName: target.communicationChannelName,
    providerBotId: target.providerBotId,
    providerBotUsername: target.providerBotUsername,
  }
}

function readProviderIdentity(
  row: CronJobRecord,
  origin: NonNullable<CronJob['origin']>
): CronJob['providerIdentity'] | undefined {
  const provider = row.provider
  if (!provider) return undefined
  const medium = providerMedium(provider.medium)
  if (!medium || medium !== origin.channelType) return undefined
  if (!filled(provider.providerUserId) || provider.providerUserId !== origin.sender) {
    return undefined
  }
  if (!filled(provider.providerChannelId)) return undefined
  if (provider.providerWorkspaceId !== null && !filled(provider.providerWorkspaceId)) {
    return undefined
  }
  if (provider.providerChannelType !== null && !filled(provider.providerChannelType)) {
    return undefined
  }
  if (medium === 'telegram') {
    if (!TELEGRAM_CHANNEL_TYPES.has(provider.providerChannelType ?? '')) return undefined
  } else if (!filled(provider.providerWorkspaceId)) {
    return undefined
  }

  const target = readTarget(provider.providerTarget)
  if (target === 'invalid') return undefined
  if (target === 'absent' && medium !== 'teams') return undefined

  return {
    medium,
    providerUserId: provider.providerUserId,
    providerWorkspaceId: provider.providerWorkspaceId,
    providerChannelId: provider.providerChannelId,
    providerChannelType: provider.providerChannelType,
    ...(target === 'absent' ? {} : { providerTarget: target }),
  }
}

function cronJobFromRecord(
  row: CronJobRecord,
  origin: CronJob['origin'] | undefined,
  providerIdentity: CronJob['providerIdentity'] | undefined
): CronJob {
  const job: CronJob = {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    task: row.task,
    enabled: row.enabled,
    createdAt: new Date(row.createdAt * 1000),
  }
  if (row.lastRunAt != null) job.lastRun = new Date(row.lastRunAt * 1000)
  if (row.nextRunAt != null) job.nextRun = new Date(row.nextRunAt * 1000)
  if (row.createdBy != null) job.createdBy = row.createdBy
  if (origin) job.origin = origin
  if (providerIdentity) job.providerIdentity = providerIdentity
  return job
}

export function validateCronRecord(row: CronJobRecord): { job: CronJob; valid: boolean } {
  const origin = readOrigin(row.origin)
  const originOk = row.origin === null || origin !== undefined
  const providerIdentity = origin && row.provider ? readProviderIdentity(row, origin) : undefined
  const providerOk = row.provider === null || providerIdentity !== undefined
  const scheduleOk = parseNextRun(row.schedule) !== null
  return {
    job: cronJobFromRecord(row, origin, providerIdentity),
    valid: originOk && providerOk && scheduleOk,
  }
}

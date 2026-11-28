import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { type CronDurableStore, createCronDurableStore } from '../../agent/cronStore'
import { CRON_JOB_SQL, type CronJobRecord } from '../cronJobs'
import { runMigrations } from '../migrate'
import { applyPragmas } from '../pragmas'
import { createDispatcher, dispatch } from '../worker/dispatcher'
import type { WorkerOp } from '../worker/protocol'

const SLOT = 1_764_050_000
const NOW = SLOT + 30
const FOLLOWING = SLOT + 3600

function teamsRow(): CronJobRecord {
  return {
    id: 'teams-1',
    name: 'standup',
    schedule: '0 8 * * *',
    task: 'check the channel',
    enabled: true,
    nextRunAt: SLOT,
    lastRunAt: null,
    createdAt: SLOT - 86_400,
    createdBy: 'task-9',
    origin: {
      channelType: 'teams',
      channelId: '19:conversation',
      sender: 'user-1',
      threadId: 'reply-1',
    },
    provider: {
      medium: 'teams',
      providerUserId: 'user-1',
      providerWorkspaceId: 'workspace-1',
      providerChannelId: '19:channel',
      providerChannelType: null,
      providerTarget: {
        hostRef: 'host-1',
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'general',
        providerBotId: null,
        providerBotUsername: null,
      },
    },
  }
}

function halfSetRow(): CronJobRecord {
  return {
    id: 'half-set',
    name: 'half',
    schedule: '*/5 * * * *',
    task: 'ping',
    enabled: true,
    nextRunAt: SLOT,
    lastRunAt: null,
    createdAt: SLOT - 60,
    createdBy: null,
    origin: {
      channelType: 'slack',
      channelId: 'C-origin',
      sender: 'U-sender',
      threadId: null,
    },
    provider: {
      medium: 'slack',
      providerUserId: 'U-sender',
      providerWorkspaceId: null,
      providerChannelId: 'C-provider',
      providerChannelType: null,
      providerTarget: null,
    },
  }
}

describe('cron job worker ops', () => {
  let db: Database.Database
  let store: CronDurableStore
  let timeouts: Array<number | null>

  beforeEach(() => {
    db = new Database(':memory:')
    applyPragmas(db)
    runMigrations(db)
    const deps = createDispatcher(db)
    timeouts = []
    store = createCronDurableStore({
      send<T>(op: WorkerOp, timeoutMs: null): Promise<T> {
        timeouts.push(timeoutMs)
        return dispatch(op, deps) as Promise<T>
      },
    })
  })

  afterEach(() => {
    db.close()
  })

  it('round-trips a Teams row and claims the stored slot once', async () => {
    const row = teamsRow()
    await store.insert(row)

    const loaded = await store.load()
    expect(loaded).toEqual([row])
    expect(loaded[0]?.origin?.channelId).toBe('19:conversation')
    expect(loaded[0]?.provider?.providerChannelId).toBe('19:channel')
    expect(
      db
        .prepare(`SELECT origin_channel_id, provider_channel_id FROM cron_jobs WHERE id = ?`)
        .get(row.id)
    ).toEqual({
      origin_channel_id: '19:conversation',
      provider_channel_id: '19:channel',
    })

    const claimed = await store.claim({
      id: row.id,
      slotSeconds: SLOT,
      nowSeconds: NOW,
      followingSeconds: FOLLOWING,
    })
    expect(claimed).toEqual({ changes: 1 })
    expect(FOLLOWING).toBeGreaterThan(SLOT)

    const afterClaim = await store.read(row.id)
    expect(afterClaim?.nextRunAt).toBe(FOLLOWING)
    expect(afterClaim?.lastRunAt).toBe(NOW)
    expect(afterClaim?.enabled).toBe(true)

    const lost = await store.claim({
      id: row.id,
      slotSeconds: SLOT,
      nowSeconds: NOW + 1,
      followingSeconds: FOLLOWING + 3600,
    })
    expect(lost).toEqual({ changes: 0 })
    expect(await store.read(row.id)).toEqual(afterClaim)

    db.prepare(`UPDATE cron_jobs SET enabled = 0 WHERE id = ?`).run(row.id)
    const disabled = await store.claim({
      id: row.id,
      slotSeconds: FOLLOWING,
      nowSeconds: NOW + 2,
      followingSeconds: FOLLOWING + 7200,
    })
    expect(disabled).toEqual({ changes: 0 })
    const still = await store.read(row.id)
    expect(still?.enabled).toBe(false)
    expect(still?.nextRunAt).toBe(FOLLOWING)
    expect(still?.lastRunAt).toBe(NOW)
    expect(timeouts.length).toBeGreaterThan(0)
    expect(timeouts.every(timeoutMs => timeoutMs === null)).toBe(true)
  })

  it('round-trips a half-set provider row without disabling it', async () => {
    const row = halfSetRow()
    await store.insert(row)
    expect(await store.read(row.id)).toEqual(row)
    expect((await store.load()).find(job => job.id === row.id)?.enabled).toBe(true)
    expect((await store.load()).find(job => job.id === row.id)?.provider).not.toBeNull()

    db.prepare(`UPDATE cron_jobs SET provider_channel_id = NULL WHERE id = ?`).run(row.id)
    const loaded = await store.read(row.id)
    expect(loaded?.enabled).toBe(true)
    expect(loaded?.provider).toEqual({
      medium: 'slack',
      providerUserId: 'U-sender',
      providerWorkspaceId: null,
      providerChannelId: null,
      providerChannelType: null,
      providerTarget: null,
    })
    expect(
      db
        .prepare(
          `SELECT enabled, provider_medium, provider_user_id, provider_channel_id,
                  provider_workspace_id, provider_target_host_ref
             FROM cron_jobs WHERE id = ?`
        )
        .get(row.id)
    ).toEqual({
      enabled: 1,
      provider_medium: 'slack',
      provider_user_id: 'U-sender',
      provider_channel_id: null,
      provider_workspace_id: null,
      provider_target_host_ref: null,
    })
  })

  it('updates the schedule and last run, then deletes the row', async () => {
    const row = teamsRow()
    await store.insert(row)
    await store.setSchedule(row.id, false, null)
    expect(await store.read(row.id)).toMatchObject({ enabled: false, nextRunAt: null })
    await store.setLastRun(row.id, NOW)
    expect((await store.read(row.id))?.lastRunAt).toBe(NOW)
    expect((await store.read(row.id))?.nextRunAt).toBeNull()
    await store.delete(row.id)
    expect(await store.read(row.id)).toBeNull()
    expect(await store.load()).toEqual([])
    expect(timeouts.every(timeoutMs => timeoutMs === null)).toBe(true)
  })

  it('does not reference provider_event_id in cron SQL', () => {
    const sql = Object.values(CRON_JOB_SQL).join('\n')
    expect(sql).not.toContain('provider_event_id')
    expect(CRON_JOB_SQL.claim).toContain('AND enabled = 1 AND next_run_at = :slot')
    expect(CRON_JOB_SQL.claim.match(/\bUPDATE\b/g)).toEqual(['UPDATE'])
    expect(CRON_JOB_SQL.insert).toContain('origin_channel_id')
    expect(CRON_JOB_SQL.insert).toContain('provider_channel_id')
  })
})

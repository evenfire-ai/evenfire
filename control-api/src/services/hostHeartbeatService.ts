import { pool } from '../db.js'

/**
 * Stateless heartbeat persistence (host_heartbeats, migration 0051).
 *
 * mcp-host pods POST D8 activity snapshots to control-api's /mcp-host facade
 * (`POST /api/v1/mcp-host/hosts/heartbeat`, identity bound to the runtime
 * token's `hostRefs[0]` claim). One row per host — the latest beat wins: the
 * lifecycle idle decision derives from the payload's `lastActivityTs`, not
 * from row history. HCC polls the rows via
 * `GET /api/v1/auth/mcp-host/heartbeats?since=<epoch_ms>` (InternalControl,
 * iss=hcc) and feeds them into its StatelessLifecycleTracker.
 */

export type HostHeartbeatConditions = {
  activeTask: boolean
  awaitingApproval: boolean
  pendingResults: boolean
  /** Cron×stateless (additive): absent on rows persisted before the field
   *  existed — HCC's parser treats absent as false. */
  activeCronSchedules?: boolean
}

export type HostHeartbeatState = 'active' | 'draining' | 'drained'

export type HostHeartbeatUpsert = {
  hostRef: string
  podUid: string
  activeWork: boolean
  conditions: HostHeartbeatConditions
  /** Epoch ms of the last inbound runtime message / turn activity. */
  lastActivityTs: number
  state: HostHeartbeatState
}

export type HostHeartbeatRecord = HostHeartbeatUpsert & {
  /** Epoch ms when control-api ingested the beat (drives the poll cursor). */
  receivedAtMs: number
}

export async function upsertHostHeartbeat(heartbeat: HostHeartbeatUpsert): Promise<void> {
  const result = await pool.query(
    `INSERT INTO host_heartbeats
       (host_ref, pod_uid, active_work, conditions, last_activity_ts, state, received_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
     ON CONFLICT (host_ref) DO UPDATE SET
       pod_uid = EXCLUDED.pod_uid,
       active_work = EXCLUDED.active_work,
       conditions = EXCLUDED.conditions,
       last_activity_ts = EXCLUDED.last_activity_ts,
       state = EXCLUDED.state,
       received_at = NOW()`,
    [
      heartbeat.hostRef,
      heartbeat.podUid,
      heartbeat.activeWork,
      JSON.stringify(heartbeat.conditions),
      heartbeat.lastActivityTs,
      heartbeat.state,
    ]
  )
  // Fail loud: a heartbeat that cannot be recorded must not pretend it was —
  // HCC's poller would otherwise never see the activity snapshot.
  if (result.rowCount !== 1) {
    throw new Error(
      `host_heartbeats upsert affected ${result.rowCount} rows for host ${heartbeat.hostRef}`
    )
  }
}

export async function listHostHeartbeatsSince(
  sinceEpochMs: number
): Promise<HostHeartbeatRecord[]> {
  if (!Number.isSafeInteger(sinceEpochMs) || sinceEpochMs < 0) {
    throw new Error('listHostHeartbeatsSince: sinceEpochMs must be a non-negative safe integer')
  }
  const result = await pool.query(
    `SELECT host_ref, pod_uid, active_work, conditions, last_activity_ts, state,
            (EXTRACT(EPOCH FROM received_at) * 1000)::bigint AS received_at_ms
       FROM host_heartbeats
      WHERE received_at > to_timestamp($1::double precision / 1000.0)
      ORDER BY received_at ASC`,
    [sinceEpochMs]
  )
  return result.rows.map(row => {
    const r = row as {
      host_ref: string
      pod_uid: string
      active_work: boolean
      conditions: HostHeartbeatConditions
      last_activity_ts: number | string
      state: HostHeartbeatState
      received_at_ms: number | string
    }
    return {
      hostRef: r.host_ref,
      podUid: r.pod_uid,
      activeWork: r.active_work === true,
      conditions: r.conditions,
      lastActivityTs: Number(r.last_activity_ts),
      state: r.state,
      receivedAtMs: Number(r.received_at_ms),
    }
  })
}

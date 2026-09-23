import type { PoolClient } from 'pg'
import { config } from '../config.js'
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { entityChangeDispatchBatchesTotal } from '../observability/metrics.js'

const logger = rootLogger.child({ module: 'entity-change-feed' })
const CURSOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ZERO_CURSOR = '00000000-0000-0000-0000-000000000000'

export type EntityChangeScope = 'gfs' | 'authorization'

export type EntityChangeCheckpoint = {
  resyncRequired: boolean
  cursor: string
  scopes: EntityChangeScope[]
}

type CheckpointRow = {
  needs_resync: boolean
  current_cursor: string | null
  invalidated_scopes: string[] | null
}

export function isEntityChangeCursor(value: string): boolean {
  return CURSOR_RE.test(value)
}

export async function readEntityChangeCheckpoint(
  cursor: string | null
): Promise<EntityChangeCheckpoint> {
  const result = await pool.query('SELECT * FROM entity_change_read_checkpoint($1::uuid, $2)', [
    cursor,
    config.entityChangeMaxRecoveryEvents,
  ])
  const row = result.rows[0] as CheckpointRow | undefined
  if (!row || typeof row.needs_resync !== 'boolean') {
    throw new Error('Entity change checkpoint query returned an invalid result')
  }
  const scopes = Array.isArray(row.invalidated_scopes)
    ? row.invalidated_scopes.filter(
        (scope): scope is EntityChangeScope => scope === 'gfs' || scope === 'authorization'
      )
    : []
  return {
    resyncRequired: row.needs_resync,
    cursor: isEntityChangeCursor(String(row.current_cursor || ''))
      ? String(row.current_cursor)
      : ZERO_CURSOR,
    scopes,
  }
}

export async function dispatchEntityChangeOutbox(): Promise<number> {
  const result = await pool.query('SELECT * FROM entity_change_dispatch_batch($1, $2)', [
    config.entityChangeDispatchBatchSize,
    config.entityChangeRetentionSeconds,
  ])
  return result.rows.length
}

let dispatcherTimer: NodeJS.Timeout | null = null
let wakeupListener: PoolClient | null = null
let listenerRetryTimer: NodeJS.Timeout | null = null
let dispatcherRunning = false

async function runDispatcherTick(): Promise<void> {
  if (dispatcherRunning) return
  dispatcherRunning = true
  try {
    const count = await dispatchEntityChangeOutbox()
    entityChangeDispatchBatchesTotal.inc({ result: count > 0 ? 'dispatched' : 'empty' })
    if (count > 0) {
      logger.info(
        { event: 'entity_change_batch_dispatched', feedRows: count },
        'entity changes dispatched'
      )
    }
  } catch (err) {
    entityChangeDispatchBatchesTotal.inc({ result: 'error' })
    logger.warn({ event: 'entity_change_dispatch_failed', err }, 'entity change dispatch failed')
  } finally {
    dispatcherRunning = false
  }
}

async function connectWakeupListener(): Promise<void> {
  if (wakeupListener || !dispatcherTimer) return
  try {
    const client = await pool.connect()
    if (!dispatcherTimer) {
      client.release()
      return
    }
    await client.query('LISTEN entity_change_outbox')
    wakeupListener = client
    client.on('notification', () => void runDispatcherTick())
    const disconnected = (err?: Error) => {
      if (wakeupListener !== client) return
      wakeupListener = null
      client.removeAllListeners('notification')
      client.release(true)
      if (err) {
        logger.warn(
          { event: 'entity_change_dispatch_listener_lost', err },
          'dispatcher wake-up degraded'
        )
      }
      if (dispatcherTimer && !listenerRetryTimer) {
        listenerRetryTimer = setTimeout(() => {
          listenerRetryTimer = null
          void connectWakeupListener()
        }, 5000)
      }
    }
    client.on('error', disconnected)
    client.on('end', () => disconnected())
  } catch (err) {
    logger.warn(
      { event: 'entity_change_dispatch_listener_unavailable', err },
      'dispatcher wake-up unavailable'
    )
    if (dispatcherTimer && !listenerRetryTimer) {
      listenerRetryTimer = setTimeout(() => {
        listenerRetryTimer = null
        void connectWakeupListener()
      }, 5000)
    }
  }
}

/** Start a per-instance dispatcher; the database advisory lock elects one active owner. */
export function startEntityChangeDispatcher(): void {
  if (dispatcherTimer) return
  dispatcherTimer = setInterval(() => {
    void runDispatcherTick()
    if (!wakeupListener) void connectWakeupListener()
  }, config.entityChangeDispatchIntervalMs)
  void connectWakeupListener()
  void runDispatcherTick()
}

export function stopEntityChangeDispatcher(): void {
  if (dispatcherTimer) clearInterval(dispatcherTimer)
  if (listenerRetryTimer) clearTimeout(listenerRetryTimer)
  dispatcherTimer = null
  listenerRetryTimer = null
  const listener = wakeupListener
  wakeupListener = null
  if (listener) {
    listener.removeAllListeners('notification')
    listener.release()
  }
}

const feedWakeSubscribers = new Set<() => void>()
let feedWakeListener: PoolClient | null = null
let feedWakeConnect: Promise<void> | null = null
let feedWakeRetryTimer: NodeJS.Timeout | null = null

function scheduleFeedWakeReconnect(): void {
  if (feedWakeSubscribers.size === 0 || feedWakeRetryTimer) return
  feedWakeRetryTimer = setTimeout(() => {
    feedWakeRetryTimer = null
    void connectFeedWakeListener()
  }, 5000)
}

async function connectFeedWakeListener(): Promise<void> {
  if (feedWakeListener || feedWakeConnect || feedWakeSubscribers.size === 0) return
  const connecting = (async () => {
    let client: PoolClient | null = null
    try {
      client = await pool.connect()
      if (feedWakeSubscribers.size === 0) {
        client.release()
        return
      }
      await client.query('LISTEN entity_change_feed')
      if (feedWakeSubscribers.size === 0) {
        client.release()
        return
      }
      feedWakeListener = client
      const connectedClient = client
      connectedClient.on('notification', () => {
        for (const subscriber of Array.from(feedWakeSubscribers)) {
          try {
            subscriber()
          } catch {
            // One stream's wake callback must not interrupt delivery to others.
          }
        }
      })
      const disconnected = (err?: Error) => {
        if (feedWakeListener !== connectedClient) return
        feedWakeListener = null
        connectedClient.removeAllListeners('notification')
        connectedClient.removeAllListeners('error')
        connectedClient.removeAllListeners('end')
        connectedClient.release(true)
        if (err) {
          logger.warn(
            { event: 'entity_change_feed_listener_lost', err },
            'entity change wake-up degraded to polling'
          )
        }
        scheduleFeedWakeReconnect()
      }
      connectedClient.on('error', disconnected)
      connectedClient.on('end', () => disconnected())
    } catch (err) {
      if (client) client.release(true)
      logger.warn(
        { event: 'entity_change_feed_listener_unavailable', err },
        'entity change wake-up unavailable; polling remains active'
      )
      scheduleFeedWakeReconnect()
    }
  })()
  feedWakeConnect = connecting
  try {
    await connecting
  } finally {
    if (feedWakeConnect === connecting) feedWakeConnect = null
  }
}

/** Share one process-local LISTEN connection; durable polling remains authoritative. */
export function subscribeEntityChangeFeedWake(onWake: () => void): () => void {
  feedWakeSubscribers.add(onWake)
  void connectFeedWakeListener()
  return () => {
    feedWakeSubscribers.delete(onWake)
    if (feedWakeSubscribers.size > 0) return
    if (feedWakeRetryTimer) clearTimeout(feedWakeRetryTimer)
    feedWakeRetryTimer = null
    const listener = feedWakeListener
    feedWakeListener = null
    if (listener) {
      listener.removeAllListeners('notification')
      listener.removeAllListeners('error')
      listener.removeAllListeners('end')
      listener.release()
    }
  }
}

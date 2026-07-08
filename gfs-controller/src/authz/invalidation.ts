/**
 * Postgres LISTEN/NOTIFY fan-out that invalidates gfsc decision caches the
 * instant a grant or share is written (spec community.md Governance controls
 * "Immediate revocation": "a short-TTL decision cache is invalidated immediately
 * on any grant/share write — revocation is immediate, not TTL-bound").
 *
 * gfsc readers each hold a dedicated LISTEN connection. A grant/share write
 * emits NOTIFY on the shared channel; every reader flushes its cache, so the
 * next op re-checks the store and sees the new state.
 *
 * Fail-closed: if a reader's LISTEN connection errors or closes it can no longer
 * hear revocations, so it puts its cache into BYPASS — serving nothing until a
 * healthy re-LISTEN. A reader that cannot hear invalidations must never serve a
 * cached allow. (Acceptance: "fan-out failure never extends access".)
 */

import type { DecisionCache } from './cache.js'

export const GFS_INVALIDATE_CHANNEL = 'gfs_perm_invalidate'

/** Postgres channel identifiers are not parameterizable; only safe identifiers. */
const SAFE_CHANNEL = /^[a-z_][a-z0-9_]*$/

export interface PgNotification {
  channel: string
  payload?: string
}

/** The subset of a dedicated pg Client used for LISTEN. */
export interface ListenClient {
  connect(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<unknown>
  on(event: 'notification', listener: (msg: PgNotification) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
}

export interface InvalidationListenerOptions {
  client: ListenClient
  cache: Pick<DecisionCache, 'flushAll' | 'setBypassed'>
  channel?: string
  /** Invoked after the cache enters fail-closed bypass (e.g. to schedule reconnect). */
  onDegraded?: () => void
}

function assertSafeChannel(channel: string): void {
  if (!SAFE_CHANNEL.test(channel)) {
    throw new Error(`invalid LISTEN/NOTIFY channel: ${JSON.stringify(channel)}`)
  }
}

export class InvalidationListener {
  private readonly channel: string

  constructor(private readonly opts: InvalidationListenerOptions) {
    this.channel = opts.channel ?? GFS_INVALIDATE_CHANNEL
    assertSafeChannel(this.channel)
  }

  /**
   * Connect the dedicated client, LISTEN, and wire handlers. On a NOTIFY for our
   * channel the cache is flushed (immediate revocation); on any connection error
   * or close the cache enters fail-closed bypass.
   */
  async start(): Promise<void> {
    const { client, cache } = this.opts
    client.on('notification', (msg) => {
      if (msg.channel === this.channel) cache.flushAll()
    })
    client.on('error', () => this.degrade())
    client.on('end', () => this.degrade())
    await client.connect()
    await client.query(`LISTEN ${this.channel}`)
    // A fresh LISTEN may have missed notifications during connect — flush once
    // and (re)enable caching now that the fan-out is healthy.
    cache.flushAll()
    cache.setBypassed(false)
  }

  private degrade(): void {
    this.opts.cache.setBypassed(true)
    this.opts.onDegraded?.()
  }
}

/**
 * Emit an invalidation NOTIFY. Called by the writer (control-api) — or a DB
 * trigger on gfs_grants/gfs_shares — after a grant/share mutation commits, so
 * every reader flushes immediately.
 */
export async function emitInvalidation(
  client: Pick<ListenClient, 'query'>,
  channel: string = GFS_INVALIDATE_CHANNEL,
  payload?: string
): Promise<void> {
  assertSafeChannel(channel)
  if (payload === undefined) {
    await client.query(`NOTIFY ${channel}`)
  } else {
    await client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
  }
}

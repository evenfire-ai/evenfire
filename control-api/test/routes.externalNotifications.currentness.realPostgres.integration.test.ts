import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Pool } from 'pg'
import request from 'supertest'
import { type DbClient, initDb } from '../src/db.js'
import { createExternalNotificationsRouter } from '../src/routes/external/notifications.routes.js'
import {
  createUserSession,
  revokeAllUserSessions,
} from '../src/services/auth/userSessionService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const producerDatabase = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  transaction: undefined as (<T>(work: (db: DbClient) => Promise<T>) => Promise<T>) | undefined,
  listEvents: vi.fn(),
  listActive: vi.fn(),
  openListener: vi.fn(),
}))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
    },
    withTransaction: <T>(work: (db: DbClient) => Promise<T>) => producerDatabase.transaction!(work),
  }
})
vi.mock('../src/middleware/externalClientIdentity.js', () => ({
  createExternalClientRateLimiters: () => [
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  ],
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/middleware/mcpHostHttpMetrics.js', () => ({
  mcpHostHttpMetrics:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../src/observability/metrics.js', () => {
  const metric = { inc: vi.fn(), dec: vi.fn(), observe: vi.fn() }
  return {
    notificationStreamConnectionsActive: metric,
    notificationStreamDisconnectsTotal: metric,
    notificationStreamEventsFilteredTotal: metric,
    notificationStreamEventsSentTotal: metric,
    notificationStreamSnapshotSize: metric,
  }
})
vi.mock('../src/services/access/accessCatalogShadow.js', () => ({
  scheduleAccessCatalogShadow: vi.fn(),
}))
vi.mock('../src/services/notificationStreamService.js', () => ({
  listActiveApprovalNotificationsForUser: producerDatabase.listActive,
  listNotificationStreamEventsForUser: producerDatabase.listEvents,
  newestNotificationCursor: () => null,
  openNotificationQueueListener: producerDatabase.openListener,
  parseNotificationCursor: (value: string) => ({ createdAt: value, id: 'cursor-id' }),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describeRealPostgres('mounted notification stream currentness on real PostgreSQL', () => {
  const database = `control_api_notification_currentness_${randomBytes(6).toString('hex')}`
  const databaseUrl = new URL(adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres')
  databaseUrl.pathname = `/${database}`
  let adminPool: Pool
  let databasePool: Pool

  async function transaction<T>(work: (db: DbClient) => Promise<T>): Promise<T> {
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client as unknown as DbClient)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString: databaseUrl.toString() })
    producerDatabase.pool = databasePool
    producerDatabase.transaction = transaction
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    } finally {
      await adminPool?.end()
    }
  })

  it('drops a real V2 notification batch after revoke-all during the awaited read', async () => {
    const userId = randomUUID()
    const email = `notification-currentness-${userId}@example.test`
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      email,
      'Notification currentness',
    ])
    await transaction(db => revokeAllUserSessions(userId, 'generation-advance', db))
    const session = await transaction(db =>
      createUserSession({ userId, email, authenticationMethods: ['pwd'] }, { db })
    )
    const generation = await databasePool.query<{ lifecycle_version: number | string }>(
      `SELECT lifecycle_version FROM users WHERE id = $1`,
      [userId]
    )
    expect(Number(generation.rows[0]?.lifecycle_version)).toBeGreaterThan(1)

    const events = deferred<unknown[]>()
    producerDatabase.listActive.mockResolvedValue([])
    producerDatabase.listEvents.mockReset().mockReturnValue(events.promise)
    producerDatabase.openListener.mockResolvedValue(
      Object.assign(new EventEmitter(), { release: vi.fn() })
    )

    const app = express()
    app.use(createExternalNotificationsRouter())
    const responsePromise = request(app)
      .get('/external/notifications/stream')
      .set('x-user-session-token', session.token)
    let responseResult: { status: number; text: string } | undefined
    void responsePromise.then(response => {
      responseResult = { status: response.status, text: response.text }
    })
    await vi.waitFor(() =>
      expect(producerDatabase.listEvents, JSON.stringify(responseResult)).toHaveBeenCalledOnce()
    )

    await transaction(db => revokeAllUserSessions(userId, 'revoke-all-during-notification', db))
    events.resolve([
      {
        eventType: 'approval.updated',
        id: 'private-event-id',
        cursor: 'private-cursor',
        approvalRequestId: 'private-approval-id',
        status: 'approved',
      },
    ])
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(response.text).toContain('notification.snapshot')
    expect(response.text).toContain('stream.closing')
    expect(response.text).toContain('session_expired')
    expect(response.text).not.toContain('private-event-id')
    expect(response.text).not.toContain('private-cursor')
    expect(response.text).not.toContain('private-approval-id')
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import request from 'supertest'
import { bindVerifiedProviderTraceAttribution } from '../src/routes/mcp-host/user-approval-requests.routes.js'
import { DirectRunAttributionBindingService } from '../src/services/tracing/directRunAttributionBindingService.js'
import { createDrive, createUser, createUserHomeDatabase } from './helpers/userHomeRealPostgres.js'
import './realPostgres.requirement.js'

/**
 * EvenDrive "Recent files" on a real PostgreSQL 16.
 *
 * Everything the feature claims about retention, ordering, authority, roles and
 * attribution is database behaviour, so it is pinned here: the two recording
 * functions, the per-user trim, the cascade, the role grants, the readable-only
 * filter and the list route. Desktop opens go through the mounted external
 * router with a stubbed gfsc fetch (the only external boundary); Desktop writes
 * call the user function under `SET ROLE gfs_controller`, exactly as gfsc does;
 * agent reads run in autocommit under `gfs_controller_reader` and agent writes
 * inside a `gfs_controller` transaction.
 */

const HOST = 'chatllm'
const NAMESPACE = 'mcp-host'
const HOST_SUBJECT = `host:1st:${NAMESPACE}/${HOST}`

const linkState = vi.hoisted(() => ({ link: null as null | Record<string, unknown> }))
const holder = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  const testPool = () => ({
    query: (...args: Parameters<Pool['query']>) => holder.pool!.query(...args),
  })
  return {
    ...actual,
    pool: testPool(),
    // The external GFS limiters fail closed on an uncountable request, so the
    // bucket pool must be the migrated database too.
    rateLimitPool: testPool(),
    withTransaction: ((work, txPool, options) =>
      actual.withTransaction(
        work,
        txPool ?? holder.pool,
        options
      )) as typeof actual.withTransaction,
  }
})

// The linked-admin flag and the operator-link lookup have their own suites; the
// only thing under test here is that the proxy keys the record by
// `desktopUserId` and never by `tokenSubject`.
vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...actual,
    config: { ...actual.config, desktopGfsOperatorLinkingEnabled: true },
  }
})
vi.mock('../src/services/gfsDesktopOperatorLinkService.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/gfsDesktopOperatorLinkService.js')>()
  return {
    ...actual,
    gfsDesktopOperatorLinkService: {
      resolveActiveLink: async (desktopUserId: string) =>
        linkState.link && linkState.link.desktopUserId === desktopUserId ? linkState.link : null,
      isDesktopUserActive: async () => true,
    },
  }
})

// The session-token verifier has its own suites; here it is the boundary that
// names the Desktop user, so it is replaced by the same contract: no session →
// 401, otherwise `externalAuth` carries the user.
vi.mock('../src/middleware/externalSessionAuth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/middleware/externalSessionAuth.js')>()
  return {
    ...actual,
    requireValidExternalSessionToken: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      const userId = req.header('x-user')
      if (!userId) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      const teamId = req.header('x-team')
      Object.assign(req, { externalAuth: { userId, ...(teamId ? { teamId } : {}) } })
      next()
    },
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

interface Fixture {
  drive: string
  root: string
  owner: string
  alice: string
  bob: string
  carol: string
  folder: string
  f1: string
  f2: string
  f3: string
  aliceOwn: string
  bobOwn: string
  shareId: string
}

describeRealPostgres('EvenDrive recent files on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>
  let app: express.Express
  let fx: Fixture
  let publicRole: string

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    database = await createUserHomeDatabase(adminUrl!, adminPool)
    holder.pool = database.pool
    publicRole = `recent_public_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE ROLE ${publicRole} NOLOGIN`)

    const { createExternalGfsRouter } = await import('../src/routes/external/gfs.js')
    const { correlationIdMiddleware } = await import('../src/middleware/correlationId.js')
    app = express()
    app.use(express.json())
    app.use(correlationIdMiddleware)
    // external-rest-api forwards the caller's session token on every relayed
    // request; the pre-resolution limiter needs it as its session bucket key.
    app.use((req, _res, next) => {
      const userId = req.header('x-user')
      if (userId && !req.headers['x-user-session-token']) {
        req.headers['x-user-session-token'] = `session-${userId}`
      }
      next()
    })
    app.use(createExternalGfsRouter())
  }, 180_000)

  afterAll(async () => {
    try {
      holder.pool = undefined
      if (database) {
        await database.closeConnections()
        await adminPool.query(`DROP DATABASE "${database.database}"`)
      }
      if (publicRole) await adminPool.query(`DROP ROLE IF EXISTS ${publicRole}`)
    } finally {
      await adminPool?.end()
    }
  }, 180_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    linkState.link = null
    // The only external boundary: gfsc. Every proxy/resolve/children call gets a
    // 200 body, so nothing here depends on a cluster.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('abc', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          })
      )
    )
    fx = await seedFixture()
  })

  it('RP1: records an open for the Desktop user who opened the file, and only for that user', async () => {
    await openAs('x-user', fx.alice, fx.f1)
    await openAs('x-user', fx.bob, fx.f2)

    expect(await recentIds(fx.alice)).toEqual([fx.f1])
    expect(await recentIds(fx.bob)).toEqual([fx.f2])
    // Liveness: both lists are non-empty, so neither half can pass vacuously.
    expect(await recentIds(fx.alice)).not.toHaveLength(0)
    expect(await recentIds(fx.bob)).not.toHaveLength(0)
  })

  it("RP2: another user's open never makes a file recent for me", async () => {
    await openAs('x-user', fx.alice, fx.aliceOwn)
    await openAs('x-user', fx.bob, fx.f1)

    const aliceIds = await recentIds(fx.alice)
    expect(aliceIds).not.toContain(fx.f1)
    expect(aliceIds).toEqual([fx.aliceOwn])
    expect(await recentIds(fx.bob)).toEqual([fx.f1])
  })

  it('RP3: a Desktop write is recorded for its author only, and another reader still sees the file', async () => {
    await openAs('x-user', fx.bob, fx.bobOwn)
    await recordUserActivityAsGfsc(fx.alice, [fx.f3])

    expect((await recentIds(fx.alice))[0]).toBe(fx.f3)
    expect(await recentIds(fx.bob)).not.toContain(fx.f3)
    // Witness: bob can read f3, so the absence is recency, not authority.
    expect(await holdsRead(fx.bob, fx.f3)).toBe(true)
    expect(await recentIds(fx.bob)).toEqual([fx.bobOwn])
  })

  it('RP4: revoking the share hides the row without deleting it', async () => {
    await openAs('x-user', fx.alice, fx.f1)
    expect(await recentIds(fx.alice)).toContain(fx.f1)

    await database.pool.query('DELETE FROM gfs_shares WHERE id = $1::uuid', [fx.shareId])

    expect(await recentIds(fx.alice)).not.toContain(fx.f1)
    // Witness: the recorded row is still there; only the list filter hid it.
    const stored = await database.pool.query(
      'SELECT 1 FROM gfs_user_file_activity WHERE user_id = $1::uuid AND resource_id = $2::uuid',
      [fx.alice, fx.f1]
    )
    expect(stored.rowCount).toBe(1)
  })

  it('RP5: a tombstoned file leaves every list while live rows stay', async () => {
    await openAs('x-user', fx.alice, fx.f1)
    await openAs('x-user', fx.alice, fx.f2)

    await database.pool.query(
      'UPDATE gfs_resources SET deleted_at = now() WHERE resource_id = $1::uuid',
      [fx.f2]
    )

    expect(await recentIds(fx.alice)).toEqual([fx.f1])
    expect(await recentIds(fx.alice)).not.toContain(fx.f2)

    // An operator bypasses the per-resource authority filter, so only the list
    // query's own liveness predicate can keep the tombstone out of their list.
    const { listRecentFiles } = await import('../src/gfs/recentFiles.js')
    const operatorRows = await listRecentFiles(
      database.pool,
      { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' },
      fx.alice,
      fx.drive
    )
    expect(operatorRows.map(row => row.resourceId)).not.toContain(fx.f2)
    expect(operatorRows.map(row => row.resourceId)).toEqual([fx.f1])
  })

  it('RP6: only an explicit open records; listings, resolve, home, affordances and plain proxy reads do not', async () => {
    await request(app)
      .get('/external/gfs/recent')
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
      .expect(200)
    await request(app)
      .get(`/external/gfs/resources/${fx.folder}/children`)
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
      .expect(200)
    await request(app)
      .get('/external/gfs/resolve')
      .set('x-user', fx.alice)
      .query({ drive: fx.drive, uri: `gfs://${fx.drive}/nope` })
      .expect(200)
    await request(app).get('/external/gfs/home').set('x-user', fx.alice).expect(200)
    await request(app)
      .get(`/external/gfs/resources/${fx.f1}/affordances`)
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
      .expect(200)
    const plainRead = await request(app)
      .get(`/external/gfs/proxy/${fx.f1}`)
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
    // Witness: the plain proxy read really returned the body, and recorded nothing.
    expect(plainRead.status).toBe(200)
    expect(plainRead.body).toEqual(Buffer.from('abc'))

    expect(await recentIds(fx.alice)).toEqual([])

    // Witness: the same proxy with `intent=open` records exactly one row.
    await openAs('x-user', fx.alice, fx.f1)
    expect(await recentIds(fx.alice)).toEqual([fx.f1])
  })

  it('RP7: the newest activity is first and a re-open moves the file to the top', async () => {
    await openAs('x-user', fx.alice, fx.f1)
    await openAs('x-user', fx.alice, fx.f2)
    await openAs('x-user', fx.alice, fx.f3)
    expect(await recentIds(fx.alice)).toEqual([fx.f3, fx.f2, fx.f1])

    await openAs('x-user', fx.alice, fx.f1)
    expect(await recentIds(fx.alice)).toEqual([fx.f1, fx.f3, fx.f2])
  })

  it('RP8: the list returns every readable row in one response, newest first, with no server page size', async () => {
    const ids = await seedActivityFiles(fx, 25)
    for (const id of ids) await recordUserActivityAsGfsc(fx.alice, [id])

    const response = await request(app)
      .get('/external/gfs/recent')
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
      .expect(200)

    const items = response.body.data.items as Array<{ resourceId: string }>
    expect(items).toHaveLength(25)
    expect(items.map(item => item.resourceId)).toEqual([...ids].reverse())
  })

  it('RP9: a user keeps 100 rows, the oldest are evicted, and other users are untouched', async () => {
    await openAs('x-user', fx.bob, fx.bobOwn)
    const ids = await seedActivityFiles(fx, 105)
    for (const id of ids) await recordUserActivityAsGfsc(fx.alice, [id])

    const kept = await database.pool.query<{ resource_id: string }>(
      'SELECT resource_id::text FROM gfs_user_file_activity WHERE user_id = $1::uuid',
      [fx.alice]
    )
    expect(kept.rowCount).toBe(100)
    const keptIds = new Set(kept.rows.map(row => String(row.resource_id)))
    for (const evicted of ids.slice(0, 5)) expect(keptIds.has(evicted)).toBe(false)
    for (const survivor of ids.slice(5)) expect(keptIds.has(survivor)).toBe(true)

    const listed = await request(app)
      .get('/external/gfs/recent')
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
      .expect(200)
    expect(listed.body.data.items).toHaveLength(100)

    // Witness: bob's single row survived a trim that only ever touches alice.
    expect(await recentIds(fx.bob)).toEqual([fx.bobOwn])
  })

  it('RP10: deleting the user deletes the activity and leaves other users alone', async () => {
    await openAs('x-user', fx.alice, fx.f1)
    await openAs('x-user', fx.bob, fx.bobOwn)

    await database.pool.query('DELETE FROM users WHERE id = $1::uuid', [fx.alice])

    const remaining = await database.pool.query(
      'SELECT 1 FROM gfs_user_file_activity WHERE user_id = $1::uuid',
      [fx.alice]
    )
    expect(remaining.rowCount).toBe(0)
    expect(await recentIds(fx.bob)).toEqual([fx.bobOwn])
  })

  it('RP11: each role can do only its job', async () => {
    // control_api_runtime: reads the list and records a user open; it cannot
    // record agent activity, and it has no DML on the table.
    await runAs('control_api_runtime', async client => {
      await client.query('SELECT * FROM gfs_user_file_activity LIMIT 1')
      await client.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
        fx.alice,
        [fx.f1],
      ])
    })
    expect(await recentIds(fx.alice)).toEqual([fx.f1])
    for (const [sql, values] of [
      [
        'INSERT INTO gfs_user_file_activity (user_id, resource_id, last_activity_at) VALUES ($1::uuid, $2::uuid, now())',
        [fx.alice, fx.f2],
      ],
      ['UPDATE gfs_user_file_activity SET last_activity_at = now()', []],
      ['DELETE FROM gfs_user_file_activity', []],
    ] as Array<[string, unknown[]]>) {
      await expect(deniedAs('control_api_runtime', sql, values)).rejects.toMatchObject({
        code: '42501',
      })
    }
    await expect(
      deniedAs(
        'control_api_runtime',
        'SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])',
        [HOST_SUBJECT, randomUUID(), [fx.f1]]
      )
    ).rejects.toMatchObject({ code: '42501' })

    // gfs_controller: records both kinds inside its transactions and cannot read
    // the table.
    const run = await bindDirectRun(fx.alice)
    await runAs('gfs_controller', async client => {
      await client.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
        fx.alice,
        [fx.f2],
      ])
      await client.query('SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])', [
        HOST_SUBJECT,
        run,
        [fx.f3],
      ])
    })
    expect(await recentIds(fx.alice)).toEqual([fx.f3, fx.f2, fx.f1])
    await expect(
      deniedAs('gfs_controller', 'SELECT * FROM gfs_user_file_activity')
    ).rejects.toMatchObject({ code: '42501' })

    // gfs_controller_reader: agent activity only — no user function, no table.
    const readerRun = await bindDirectRun(fx.alice)
    await runAs('gfs_controller_reader', async client => {
      await client.query('SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])', [
        HOST_SUBJECT,
        readerRun,
        [fx.f1],
      ])
    })
    expect((await recentIds(fx.alice))[0]).toBe(fx.f1)
    for (const [sql, values] of [
      ['SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [fx.alice, [fx.f2]]],
      ['SELECT * FROM gfs_user_file_activity', []],
      ['SELECT * FROM governed_run_attribution_bindings', []],
    ] as Array<[string, unknown[]]>) {
      await expect(deniedAs('gfs_controller_reader', sql, values)).rejects.toMatchObject({
        code: '42501',
      })
    }

    // PUBLIC: a role holding nothing but PUBLIC's defaults cannot execute either
    // function.
    for (const [sql, values] of [
      ['SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [fx.alice, [fx.f2]]],
      [
        'SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])',
        [HOST_SUBJECT, randomUUID(), [fx.f1]],
      ],
    ] as Array<[string, unknown[]]>) {
      await expect(deniedAs(publicRole, sql, values)).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('RP12: a linked admin records for the brokered Desktop user, not the Control admin', async () => {
    const controlAdmin = randomUUID()
    await database.pool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1::uuid, $2, 'test-hash', 'admin', 'active')`,
      [controlAdmin, `recent-${controlAdmin}`]
    )
    linkState.link = {
      desktopUserId: fx.carol,
      controlAdminId: controlAdmin,
      source: 'initial_setup',
      lineageId: randomUUID(),
      generation: 1,
      desktopUserGeneration: 1,
      controlAdminGeneration: 1,
      createdAt: new Date(),
    }

    await openAs('x-user', fx.carol, fx.aliceOwn)

    const carolIds = await recentIds(fx.carol)
    expect(carolIds).toEqual([fx.aliceOwn])
    // Witness: the Desktop actor's id is the key, so neither the Control admin
    // id nor another user's list carries the row.
    expect(await recentIds(fx.alice)).not.toContain(fx.aliceOwn)
    const keyed = await database.pool.query<{ user_id: string }>(
      'SELECT user_id::text FROM gfs_user_file_activity'
    )
    expect(keyed.rows.map(row => String(row.user_id))).not.toContain(controlAdmin)
  })

  it('RP13: a recorded directory is never listed while a recorded file of the same user is', async () => {
    await recordUserActivityAsGfsc(fx.alice, [fx.folder, fx.aliceOwn])

    expect(await recentIds(fx.alice)).toEqual([fx.aliceOwn])
    expect(await recentIds(fx.alice)).not.toContain(fx.folder)
  })

  it('RP14: activity in another drive never appears in the home-drive list', async () => {
    const otherDrive = `recent-other-${randomUUID()}`
    const otherRoot = await createDrive(database.pool, otherDrive)
    const otherFile = await createFile(otherDrive, otherRoot, 'other.txt')
    await database.pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1, $2::uuid, 'user', $3, ARRAY['read'], true)`,
      [otherDrive, otherFile, fx.alice]
    )
    await openAs('x-user', fx.alice, fx.aliceOwn)
    await recordUserActivityAsGfsc(fx.alice, [otherFile])

    expect(await recentIds(fx.alice)).toEqual([fx.aliceOwn])
    const other = await request(app)
      .get('/external/gfs/recent')
      .set('x-user', fx.alice)
      .query({ drive: otherDrive })
      .expect(200)
    expect(other.body.data.items.map((item: { resourceId: string }) => item.resourceId)).toEqual([
      otherFile,
    ])
  })

  it('RP15: the readable filter agrees with holds(read) for every candidate', async () => {
    const { readableResourceIds, heldPermissions } = await import('../src/routes/gfs/grants.js')
    const caller = {
      isOperator: false,
      subjects: new Set([`user:${fx.alice}`]),
      actorKey: `user:${fx.alice}`,
    }
    // A grant that does NOT inherit never covers a child: the candidate below is
    // reachable only through it, so it must be unreadable. Both the batched
    // filter and the per-resource engine are asserted on it directly, because a
    // shared `holds()` bug would keep their parity intact.
    const restrictedFolder = await createFolderRow(fx.drive, fx.root, 'no-inherit')
    const restricted = await createFile(fx.drive, restrictedFolder, 'restricted.txt')
    await database.pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1, $2::uuid, 'user', $3, ARRAY['read'], false)`,
      [fx.drive, restrictedFolder, fx.alice]
    )

    const candidates = [fx.f1, fx.folder, fx.f2, fx.f3, fx.bobOwn, restricted]
    const readable = await readableResourceIds(database.pool, caller, fx.drive, candidates)
    for (const id of candidates) {
      const held = await heldPermissions(database.pool, caller, fx.drive, id)
      expect(readable.has(id)).toBe(held.includes('read'))
    }
    // Witness: the filter is not uniformly true or false.
    expect(readable.has(fx.f1)).toBe(true)
    expect(readable.has(fx.bobOwn)).toBe(false)
    expect(readable.has(restricted)).toBe(false)
    expect(await heldPermissions(database.pool, caller, fx.drive, restricted)).not.toContain('read')
  })

  it('RP16: the route answers the whole list, rejects a bad intent and needs a session', async () => {
    await openAs('x-user', fx.alice, fx.f1)

    const listed = await request(app)
      .get('/external/gfs/recent')
      .set('x-user', fx.alice)
      .query({ drive: fx.drive })
      .expect(200)
    expect(listed.body).toEqual({
      ok: true,
      data: {
        items: [
          {
            resourceId: fx.f1,
            gfsUri: `gfs://${fx.drive}/${fx.f1.replace(/-/g, '')}`,
            drive: fx.drive,
            name: 'f1.txt',
            version: 0,
            bytes: 3,
            lastActivityAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          },
        ],
      },
    })

    await request(app).get('/external/gfs/recent').expect(401)

    for (const query of ['intent=other', 'intent=open&intent=open']) {
      const rejected = await request(app)
        .get(`/external/gfs/proxy/${fx.f2}?${query}`)
        .set('x-user', fx.alice)
        .query({ drive: fx.drive })
      expect(rejected.status).toBe(400)
      expect(rejected.body).toEqual({ error: 'intent_invalid' })
    }
    expect(await recentIds(fx.alice)).toEqual([fx.f1])
  })

  it('RP17: an agent read on the reader role is recorded for the run user in autocommit', async () => {
    await openAs('x-user', fx.bob, fx.bobOwn)
    const run = await bindDirectRun(fx.alice)

    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.f2])).toBe('recorded')

    expect((await recentIds(fx.alice))[0]).toBe(fx.f2)
    expect(await recentIds(fx.bob)).not.toContain(fx.f2)
    // Witness: bob can read f2 and his own list is non-empty, so the absence is
    // attribution rather than authority or an empty list.
    expect(await holdsRead(fx.bob, fx.f2)).toBe(true)
    expect(await recentIds(fx.bob)).toEqual([fx.bobOwn])
  })

  it('RP18: a different Host name is refused and records nothing; the bound name records', async () => {
    const run = await bindDirectRun(fx.alice)

    expect(await recordAgentAsReader(`host:1st:${NAMESPACE}/other`, run, [fx.f2])).toBe(
      'host_mismatch'
    )
    expect(await recentIds(fx.alice)).toEqual([])

    // The name is compared BEFORE the origin, so a foreign Host presenting a run
    // id that is not even a Desktop chat still gets `host_mismatch` rather than
    // the softer `excluded_origin` status.
    const channelRun = randomUUID()
    await bindVerifiedProviderTraceAttribution({
      binding: { runId: channelRun, sessionId: 'channel-session', origin: 'channel_event' },
      callerHostRef: HOST,
      providerHostRef: HOST,
      identityIssuer: 'https://issuer.example.test',
      accountUserId: fx.alice,
      service: bindingService(),
    })
    expect(await recordAgentAsReader(`host:1st:${NAMESPACE}/other`, channelRun, [fx.f2])).toBe(
      'host_mismatch'
    )

    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.f2])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f2])
  })

  it('RP19: an unknown run id records nothing, and a bound run still records', async () => {
    expect(await recordAgentAsReader(HOST_SUBJECT, randomUUID(), [fx.f2])).toBe('no_binding')
    expect(await recentIds(fx.alice)).toEqual([])

    const run = await bindDirectRun(fx.alice)
    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.f2])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f2])
  })

  it('RP20: a non first-party Host subject raises, and a valid subject still records', async () => {
    const run = await bindDirectRun(fx.alice)
    for (const subject of [fx.alice, 'host:3rd:ns/x', 'host:1st:bad', 'host:1st:UPPER/x']) {
      await expect(recordAgentAsReader(subject, run, [fx.f2])).rejects.toMatchObject({
        code: '22023',
      })
    }
    // NULL is a defect too: the function is the boundary for every role with
    // EXECUTE, so a missing subject raises instead of returning a status.
    await expect(
      database.pool.query('SELECT gfs_record_agent_file_activity(NULL, $1::uuid, $2::uuid[])', [
        run,
        [fx.f2],
      ])
    ).rejects.toMatchObject({ code: '22023' })
    expect(await recentIds(fx.alice)).toEqual([])
    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.f2])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f2])
  })

  it('RP21: an agent write records with its transaction, so a rollback leaves no row', async () => {
    const run = await bindDirectRun(fx.alice)
    const client = new Client({ connectionString: await databaseUrl() })
    await client.connect()
    try {
      await client.query('SET ROLE gfs_controller')
      await client.query('BEGIN')
      const recorded = await client.query(
        'SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])',
        [HOST_SUBJECT, run, [fx.f3]]
      )
      expect(recorded.rows[0]).toEqual({ gfs_record_agent_file_activity: 'recorded' })
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query('SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])', [
        HOST_SUBJECT,
        run,
        [fx.f3],
      ])
      await client.query('COMMIT')
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      await client.end()
    }

    expect(await recentIds(fx.alice)).toEqual([fx.f3])
  })

  it('RP22: each run records for its own user', async () => {
    await openAs('x-user', fx.alice, fx.aliceOwn)
    const runForBob = await bindDirectRun(fx.bob)

    expect(await recordAgentAsReader(HOST_SUBJECT, runForBob, [fx.f3])).toBe('recorded')

    expect(await recentIds(fx.bob)).toEqual([fx.f3])
    expect(await recentIds(fx.alice)).not.toContain(fx.f3)
    expect(await recentIds(fx.alice)).toEqual([fx.aliceOwn])
  })

  it('RP23: an agent read of a file its user cannot read is recorded but hidden', async () => {
    const run = await bindDirectRun(fx.alice)

    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.bobOwn])).toBe('recorded')

    expect(await recentIds(fx.alice)).not.toContain(fx.bobOwn)
    // Witness: the row exists, so the list filter is what hides it.
    const stored = await database.pool.query(
      'SELECT 1 FROM gfs_user_file_activity WHERE user_id = $1::uuid AND resource_id = $2::uuid',
      [fx.alice, fx.bobOwn]
    )
    expect(stored.rowCount).toBe(1)

    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.f1])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f1])
  })

  it('RP24 (D14): the same Host name in another namespace is refused, the bound namespace records', async () => {
    const run = await bindDirectRun(fx.alice)

    expect(await recordAgentAsReader(`host:1st:sandbox-recipes/${HOST}`, run, [fx.f2])).toBe(
      'host_mismatch'
    )
    expect(await recentIds(fx.alice)).toEqual([])

    expect(await recordAgentAsReader(HOST_SUBJECT, run, [fx.f2])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f2])
  })

  it('RP25 (D14, D23): a binding written without a namespace records nothing, a namespaced run does', async () => {
    const legacyRun = await bindAsRuntimeWithoutNamespace(fx.alice)

    expect(await recordAgentAsReader(HOST_SUBJECT, legacyRun, [fx.f2])).toBe(
      'binding_without_namespace'
    )
    expect(await recentIds(fx.alice)).toEqual([])

    const namespaced = await bindDirectRun(fx.alice)
    expect(await recordAgentAsReader(HOST_SUBJECT, namespaced, [fx.f2])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f2])
  })

  it('RP26 (D19): a channel run is never recorded, a direct-chat run of the same user is', async () => {
    const channelRun = randomUUID()
    await bindVerifiedProviderTraceAttribution({
      binding: { runId: channelRun, sessionId: 'channel-session', origin: 'channel_event' },
      callerHostRef: HOST,
      providerHostRef: HOST,
      identityIssuer: 'https://issuer.example.test',
      accountUserId: fx.alice,
      service: bindingService(),
    })

    expect(await recordAgentAsReader(HOST_SUBJECT, channelRun, [fx.f2])).toBe('excluded_origin')
    expect(await recentIds(fx.alice)).toEqual([])

    const directRun = await bindDirectRun(fx.alice)
    expect(await recordAgentAsReader(HOST_SUBJECT, directRun, [fx.f2])).toBe('recorded')
    expect(await recentIds(fx.alice)).toEqual([fx.f2])
  })

  it('RP27 (D14 writer): the direct-chat writer stores the verified namespace, the channel writer stores NULL', async () => {
    const directRun = await bindDirectRun(fx.alice)
    const channelRun = randomUUID()
    await bindVerifiedProviderTraceAttribution({
      binding: { runId: channelRun, sessionId: 'channel-session', origin: 'channel_event' },
      callerHostRef: HOST,
      providerHostRef: HOST,
      identityIssuer: 'https://issuer.example.test',
      accountUserId: fx.alice,
      service: bindingService(),
    })

    const rows = await database.pool.query<{ run_id: string; host_namespace: string | null }>(
      `SELECT run_id::text, host_namespace FROM governed_run_attribution_bindings
        WHERE run_id = ANY($1::uuid[])`,
      [[directRun, channelRun]]
    )
    expect(rows.rowCount).toBe(2)
    const byRun = new Map(rows.rows.map(row => [String(row.run_id), row.host_namespace]))
    expect(byRun.get(directRun)).toBe(NAMESPACE)
    expect(byRun.get(channelRun)).toBeNull()
  })

  it('RP28 (D14 rollout): a row written without a namespace re-binds as existing and keeps its NULL', async () => {
    const runId = await bindAsRuntimeWithoutNamespace(fx.alice)

    await expect(
      bindingService().bind({
        runId,
        hostRef: HOST,
        hostNamespace: NAMESPACE,
        sessionId: `recent-${runId}`,
        origin: 'direct_chat',
        identityIssuer: 'https://issuer.example.test',
        actorHumanSub: fx.alice,
        userId: fx.alice,
        teamId: null,
      })
    ).resolves.toMatchObject({ runId: runId.toLowerCase(), status: 'existing' })

    const row = await database.pool.query<{ host_namespace: string | null }>(
      'SELECT host_namespace FROM governed_run_attribution_bindings WHERE run_id = $1::uuid',
      [runId]
    )
    expect(row.rows[0]!.host_namespace).toBeNull()
  })

  it('RP29 (arrays): a duplicated id writes one row, an empty or NULL-bearing array raises', async () => {
    await database.pool.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
      fx.alice,
      [fx.f1, fx.f1],
    ])
    expect(await recentIds(fx.alice)).toEqual([fx.f1])

    await expect(
      database.pool.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
        fx.alice,
        [],
      ])
    ).rejects.toMatchObject({ code: '22023' })
    await expect(
      database.pool.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
        fx.alice,
        [fx.f2, null],
      ])
    ).rejects.toMatchObject({ code: '22023' })
    expect(await recentIds(fx.alice)).toEqual([fx.f1])
  })

  it('RP30 (D16): one agent call with three copied file ids records three rows with one timestamp', async () => {
    await openAs('x-user', fx.bob, fx.bobOwn)
    const run = await bindDirectRun(fx.alice)
    const copies = [
      await createFile(fx.drive, fx.folder, 'copy-a.txt'),
      await createFile(fx.drive, fx.folder, 'copy-b.txt'),
      await createFile(fx.drive, fx.folder, 'copy-c.txt'),
    ]

    const client = new Client({ connectionString: await databaseUrl() })
    await client.connect()
    try {
      await client.query('SET ROLE gfs_controller')
      await client.query('BEGIN')
      const result = await client.query(
        'SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])',
        [HOST_SUBJECT, run, copies]
      )
      expect(result.rows[0]).toEqual({ gfs_record_agent_file_activity: 'recorded' })
      await client.query('COMMIT')
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      await client.end()
    }

    const rows = await database.pool.query<{ resource_id: string; last_activity_at: Date }>(
      `SELECT resource_id::text, last_activity_at FROM gfs_user_file_activity
        WHERE user_id = $1::uuid`,
      [fx.alice]
    )
    expect(rows.rowCount).toBe(3)
    expect(new Set(rows.rows.map(row => row.last_activity_at.getTime())).size).toBe(1)
    expect(rows.rows.map(row => String(row.resource_id)).sort()).toEqual([...copies].sort())
    // Witness: bob's own list is non-empty and untouched.
    expect(await recentIds(fx.bob)).toEqual([fx.bobOwn])
  })

  // ── helpers ──────────────────────────────────────────────────────────────

  async function databaseUrl(): Promise<string> {
    const url = new URL(adminUrl!)
    url.pathname = `/${database.database}`
    return url.toString()
  }

  function bindingService(): DirectRunAttributionBindingService {
    return new DirectRunAttributionBindingService(async work => {
      const client = await database.pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({
          query: async (text: string, values?: unknown[]) =>
            (await client.query(text, values)) as unknown as { rows: Record<string, unknown>[] },
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
  }

  async function recentIds(userId: string): Promise<string[]> {
    const response = await request(app)
      .get('/external/gfs/recent')
      .set('x-user', userId)
      .query({ drive: fx.drive })
    if (response.status !== 200) {
      throw new Error(
        `recent list for ${userId}: ${response.status} ${JSON.stringify(response.body)}`
      )
    }
    return (response.body.data.items as Array<{ resourceId: string }>).map(item => item.resourceId)
  }

  async function openAs(header: string, userId: string, resourceId: string): Promise<void> {
    await request(app)
      .get(`/external/gfs/proxy/${resourceId}`)
      .set(header, userId)
      .query({ drive: fx.drive, intent: 'open' })
      .expect(200)
  }

  async function recordUserActivityAsGfsc(userId: string, resourceIds: string[]): Promise<void> {
    await runAs('gfs_controller', async client => {
      await client.query('SELECT gfs_record_user_file_activity($1::uuid, $2::uuid[])', [
        userId,
        resourceIds,
      ])
    })
  }

  /** The user function under a role, in one autocommit statement. */
  async function runAs(role: string, work: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: await databaseUrl() })
    await client.connect()
    try {
      await client.query(`SET ROLE ${role}`)
      await work(client)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      await client.end()
    }
  }

  async function deniedAs(role: string, sql: string, values: unknown[] = []): Promise<unknown> {
    const client = new Client({ connectionString: await databaseUrl() })
    await client.connect()
    try {
      await client.query(`SET ROLE ${role}`)
      return await client.query(sql, values)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      await client.end()
    }
  }

  async function recordAgentAsReader(
    subject: string,
    runId: string,
    resourceIds: string[]
  ): Promise<string> {
    const client = new Client({ connectionString: await databaseUrl() })
    await client.connect()
    try {
      await client.query('SET ROLE gfs_controller_reader')
      const result = await client.query(
        'SELECT gfs_record_agent_file_activity($1, $2::uuid, $3::uuid[])',
        [subject, runId, resourceIds]
      )
      return String((result.rows[0] as Record<string, unknown>).gfs_record_agent_file_activity)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      await client.end()
    }
  }

  async function bindDirectRun(userId: string): Promise<string> {
    const runId = randomUUID()
    await bindingService().bind({
      runId,
      hostRef: HOST,
      hostNamespace: NAMESPACE,
      sessionId: `recent-${runId}`,
      origin: 'direct_chat',
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: userId,
      userId,
      teamId: null,
    })
    return runId
  }

  /**
   * A row written the way a control-api pod that predates 0132 writes it: through
   * the same service and digest formula, with no namespace. `control_api_runtime`
   * holds exactly the INSERT the old writer used, so the role is part of the
   * proof that the new column is optional for re-binds.
   */
  async function bindAsRuntimeWithoutNamespace(userId: string): Promise<string> {
    const runId = randomUUID()
    const client = await database.pool.connect()
    try {
      await client.query('SET ROLE control_api_runtime')
      await client.query('BEGIN')
      const service = new DirectRunAttributionBindingService(async work => {
        const result = await work({
          query: async (text: string, values?: unknown[]) =>
            (await client.query(text, values)) as unknown as { rows: Record<string, unknown>[] },
        })
        return result
      })
      await service.bind({
        runId,
        hostRef: HOST,
        hostNamespace: null,
        sessionId: `recent-${runId}`,
        origin: 'direct_chat',
        identityIssuer: 'https://issuer.example.test',
        actorHumanSub: userId,
        userId,
        teamId: null,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      client.release()
    }
    return runId
  }

  async function holdsRead(userId: string, resourceId: string): Promise<boolean> {
    const { heldPermissions } = await import('../src/routes/gfs/grants.js')
    const held = await heldPermissions(
      database.pool,
      { isOperator: false, subjects: new Set([`user:${userId}`]), actorKey: `user:${userId}` },
      fx.drive,
      resourceId
    )
    return held.includes('read')
  }

  async function seedActivityFiles(fixture: Fixture, count: number): Promise<string[]> {
    const ids: string[] = []
    for (let index = 0; index < count; index += 1) {
      ids.push(await createFile(fixture.drive, fixture.folder, `activity-${index}.txt`))
    }
    return ids
  }
})

async function createFile(drive: string, parentId: string, name: string): Promise<string> {
  const result = await holder.pool!.query<{ resource_id: string }>(
    `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, bytes)
     VALUES ($1, $2::uuid, $3, 'file', $4, 3) RETURNING resource_id::text`,
    [drive, parentId, name, `/${name}`]
  )
  return result.rows[0]!.resource_id
}

async function createFolderRow(drive: string, parentId: string, name: string): Promise<string> {
  const result = await holder.pool!.query<{ resource_id: string }>(
    `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
     VALUES ($1, $2::uuid, $3, 'directory', $4) RETURNING resource_id::text`,
    [drive, parentId, name, `/${name}`]
  )
  return result.rows[0]!.resource_id
}

async function seedFixture(): Promise<Fixture> {
  const pool = holder.pool!
  const drive = `recent-${randomUUID()}`
  const root = await createDrive(pool, drive)
  const owner = await createUser(pool, 'Owner')
  const alice = await createUser(pool, 'Alice')
  const bob = await createUser(pool, 'Bob')
  const carol = await createUser(pool, 'Carol')
  const folder = await createFolderRow(drive, root, 'shared')
  const f1 = await createFile(drive, folder, 'f1.txt')
  const f2 = await createFile(drive, folder, 'f2.txt')
  const f3 = await createFile(drive, folder, 'f3.txt')
  const aliceOwn = await createFile(drive, root, 'alice-own.txt')
  const bobOwn = await createFile(drive, root, 'bob-own.txt')

  // A share with inheritance over the folder is what makes f1..f3 readable (and
  // what RP4 later revokes); the two "own" files are direct grants.
  const share = await pool.query<{ id: string }>(
    `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions,
                             include_descendants, created_by)
     VALUES ($1, $2::uuid, 'user', $3, ARRAY['read'], true, $4::uuid) RETURNING id::text`,
    [drive, folder, alice, owner]
  )
  await pool.query(
    `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
     VALUES ($1, $2::uuid, 'user', $3, ARRAY['read'], true)`,
    [drive, folder, bob]
  )
  for (const [resource, user] of [
    [aliceOwn, alice],
    [bobOwn, bob],
    [aliceOwn, carol],
  ] as Array<[string, string]>) {
    await pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1, $2::uuid, 'user', $3, ARRAY['read'], true)`,
      [drive, resource, user]
    )
  }

  return {
    drive,
    root,
    owner,
    alice,
    bob,
    carol,
    folder,
    f1,
    f2,
    f3,
    aliceOwn,
    bobOwn,
    shareId: share.rows[0]!.id,
  }
}

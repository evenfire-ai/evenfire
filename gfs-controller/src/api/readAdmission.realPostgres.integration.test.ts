import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Pool } from 'pg'
import { DecisionCache } from '../authz/cache'
import { type AuditSink, DbAuditSink, PermissionClient } from '../authz/permissionClient'
import { resolveAuthzContext } from '../authz/subjectResolver'
import { PgResourceStore } from '../db/resourceStore'
import { RateLimiter } from '../quota/rateLimit'
import { BlobStore } from '../storage/blobStore'
import { admitGfsContentRead } from './readAdmission'
import { GfsServingHandler } from './serve'

class AdmissionResponse extends Writable {
  statusCode = 0
  headers: Record<string, string> = {}
  private chunks: Buffer[] = []

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status
    if (headers) Object.assign(this.headers, headers)
    return this
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describeRealPostgres('GFS content-read snapshot admission on real PostgreSQL', () => {
  const database = `gfsc_read_admission_${randomBytes(6).toString('hex')}`
  const userId = randomUUID()
  const adminId = randomUUID()
  const linkLineageId = randomUUID()
  const teamId = randomUUID()
  const resourceId = randomUUID()
  const rid = resourceId.replaceAll('-', '')
  let adminPool: Pool
  let db: Pool
  let readPool: Pool
  let blobDirectory: string

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    db = new Pool({ connectionString: databaseUrl(adminUrl as string, database) })
    // Keep the admission/audit pool at one connection. The admission snapshot
    // must release its checked-out client before writing the audit record.
    readPool = new Pool({ connectionString: databaseUrl(adminUrl as string, database), max: 1 })
    blobDirectory = mkdtempSync(join(tmpdir(), 'gfsc-read-admission-'))
    await db.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        lifecycle_state TEXT NOT NULL,
        lifecycle_version BIGINT NOT NULL
      );
      CREATE TABLE control_admin_users (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL,
        session_version BIGINT NOT NULL
      );
      CREATE TABLE gfs_desktop_operator_links (
        user_id UUID NOT NULL,
        control_admin_id UUID NOT NULL,
        lineage_id UUID NOT NULL,
        generation BIGINT NOT NULL,
        state TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE team_members (
        team_id UUID NOT NULL,
        user_id UUID NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE gfs_resources (
        resource_id UUID PRIMARY KEY,
        drive TEXT NOT NULL,
        parent_resource_id UUID,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path_cache TEXT,
        version BIGINT NOT NULL,
        bytes BIGINT NOT NULL,
        blob_key TEXT,
        content_sha256 TEXT,
        deleted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE gfs_grants (
        drive TEXT NOT NULL,
        resource_id UUID NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        permissions TEXT[] NOT NULL,
        inherit BOOLEAN NOT NULL
      );
      CREATE TABLE gfs_shares (
        drive TEXT NOT NULL,
        resource_id UUID NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        permissions TEXT[] NOT NULL,
        include_descendants BOOLEAN NOT NULL
      );
      CREATE TABLE gfs_audit (
        id BIGSERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        actor_on_behalf_of TEXT,
        op TEXT NOT NULL,
        gfs_uri TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_id TEXT,
        row_hash TEXT NOT NULL,
        record_type TEXT NOT NULL,
        matched_subject TEXT,
        authorization_source TEXT,
        cached_authorization_source TEXT,
        mutation_outcome TEXT,
        desktop_user_id UUID,
        authority_source TEXT
      );
      INSERT INTO users (id, lifecycle_state, lifecycle_version)
        VALUES ('${userId}', 'active', 1);
      INSERT INTO gfs_resources
        (resource_id, drive, name, kind, path_cache, version, bytes, blob_key)
        VALUES ('${resourceId}', 'main', 'snapshot.txt', 'file', '/snapshot.txt', 17, 13, 'blob-generation-17');
      INSERT INTO gfs_grants
        (drive, resource_id, subject_type, subject_id, permissions, inherit)
        VALUES ('main', '${resourceId}', 'user', '${userId}', ARRAY['read'], false);
    `)
  }, 60_000)

  afterAll(async () => {
    await readPool?.end()
    await db?.end()
    if (blobDirectory) rmSync(blobDirectory, { recursive: true, force: true })
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    await adminPool.end()
  })

  function claims() {
    return {
      sub: userId,
      drive: 'main',
      scopes: ['gfs.read'],
      pathBindings: [],
      principalType: 'user' as const,
      authGeneration: 1,
      iat: 1,
      exp: 4_102_444_800,
    }
  }

  function linkedAdminClaims() {
    return {
      ...claims(),
      sub: adminId,
      principalType: 'control-admin' as const,
      authGeneration: 4,
      brokeredAuthority: {
        desktopUserId: userId,
        controlAdminId: adminId,
        authoritySource: 'linked-admin' as const,
        linkLineageId,
        linkGeneration: 9,
        desktopUserGeneration: 1,
      },
    }
  }

  function admission(
    pool: Pool,
    pauseAfterSubject?: () => Promise<void>,
    blobRead = vi.fn(async (_resourceId: string, blobKey?: string | null) => {
      expect(blobKey).toBe('blob-generation-17')
      const { Readable } = await import('node:stream')
      return Readable.from(Buffer.from('snapshot body'))
    }),
    permissions = new PermissionClient(pool, new DbAuditSink(pool)),
    blobs: {
      read: (resourceId: string, blobKey?: string | null) => Promise<import('node:stream').Readable>
    } = {
      read: blobRead,
    },
    tokenClaims: ReturnType<typeof claims> | ReturnType<typeof linkedAdminClaims> = claims()
  ) {
    return {
      blobRead,
      run: () =>
        admitGfsContentRead(
          {
            pool,
            permissions,
            resolveContext: async (client, tokenClaims, requestId) => {
              const ctx = await resolveAuthzContext(client, tokenClaims, requestId)
              if (pauseAfterSubject) await pauseAfterSubject()
              return ctx
            },
            blobs,
          },
          tokenClaims,
          'snapshot-read-test',
          rid
        ),
    }
  }

  it('rejects a grant revoked before admission despite a cached allow', async () => {
    const cache = new DecisionCache({ ttlMs: 60_000 })
    cache.set(
      {
        subjectsKey: `user:${userId}`,
        resourceId: rid,
        op: 'read',
      },
      {
        allowed: true,
        via: 'grant',
        matchedSubject: `user:${userId}`,
        authorizationSource: 'direct_grant',
      }
    )
    const blobRead = async () => {
      throw new Error('blob read must not start after revoked admission')
    }
    await db.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resourceId])
    const permissions = new PermissionClient(readPool, new DbAuditSink(readPool), cache)

    await expect(
      admitGfsContentRead(
        {
          pool: readPool,
          permissions,
          resolveContext: resolveAuthzContext,
          blobs: { read: blobRead },
        },
        claims(),
        'revoked-before-admission',
        rid
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(cache.get({ subjectsKey: `user:${userId}`, resourceId: rid, op: 'read' })?.allowed).toBe(
      true
    )
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'user', $2, ARRAY['read'], false)`,
      [resourceId, userId]
    )
  })

  it('finishes an admitted version when membership revocation commits afterward', async () => {
    await db.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resourceId])
    await db.query(
      `INSERT INTO team_members (team_id, user_id, status) VALUES ($1, $2, 'active')`,
      [teamId, userId]
    )
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'team', $2, ARRAY['read'], false)`,
      [resourceId, teamId]
    )
    const snapshotOpened = deferred<void>()
    const continueAdmission = deferred<void>()
    const first = admission(readPool, async () => {
      snapshotOpened.resolve()
      await continueAdmission.promise
    })

    const pending = first.run()
    await snapshotOpened.promise
    await db.query('DELETE FROM team_members WHERE user_id = $1', [userId])
    continueAdmission.resolve()
    const admitted = await pending
    expect(admitted.resource.version).toBe(17)
    expect(admitted.resource.gfsUri).toBe(`gfs://main/${rid}`)
    expect(await admitted.stream.toArray().then(bytes => Buffer.concat(bytes).toString())).toBe(
      'snapshot body'
    )
    expect(first.blobRead).toHaveBeenCalledOnce()

    const second = admission(readPool)
    await expect(second.run()).rejects.toMatchObject({ code: 'forbidden' })
    expect(second.blobRead).not.toHaveBeenCalled()
  })

  it('re-resolves a stale route subject when membership is revoked before the snapshot', async () => {
    await db.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resourceId])
    await db.query(
      `INSERT INTO team_members (team_id, user_id, status) VALUES ($1, $2, 'active')`,
      [teamId, userId]
    )
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'team', $2, ARRAY['read'], false)`,
      [resourceId, teamId]
    )
    const routeContext = await resolveAuthzContext(db, claims(), 'before-revoke-route')
    expect(routeContext.subjects).toContain(`team:${teamId}`)

    await db.query('DELETE FROM team_members WHERE user_id = $1', [userId])
    const attempt = admission(readPool)
    await expect(attempt.run()).rejects.toMatchObject({ code: 'forbidden' })
    expect(attempt.blobRead).not.toHaveBeenCalled()
    expect(routeContext.subjects).toContain(`team:${teamId}`)

    await db.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resourceId])
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'user', $2, ARRAY['read'], false)`,
      [resourceId, userId]
    )
  })

  it('denies a stale early team context when revocation precedes the admission snapshot', async () => {
    await db.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resourceId])
    await db.query(
      "INSERT INTO team_members (team_id, user_id, status) VALUES ($1, $2, 'active')",
      [teamId, userId]
    )
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'team', $2, ARRAY['read'], false)`,
      [resourceId, teamId]
    )
    // Capture the real pre-route context before revocation, as the route may
    // have done for accounting. It must not become the admission decision.
    const earlyContext = await resolveAuthzContext(db, claims(), 'stale-early-context')
    expect(earlyContext.subjects).toContain(`team:${teamId}`)
    await db.query('DELETE FROM team_members WHERE user_id = $1', [userId])

    const permissions = new PermissionClient(readPool, new DbAuditSink(readPool))
    const blobRead = vi.fn(async () => {
      const { Readable } = await import('node:stream')
      return Readable.from(Buffer.from('must not stream'))
    })
    const resolve = vi.fn(async (client, tokenClaims, requestId) => {
      // The exact production mutation under test is passing the general pool
      // instead of the RR transaction client. That would reuse the route's
      // stale context; the corrected producer resolves from the supplied
      // transaction client after the committed membership revocation.
      if (client === readPool) return earlyContext
      return resolveAuthzContext(client, tokenClaims, requestId)
    })
    const attempt = admitGfsContentRead(
      {
        pool: readPool,
        permissions,
        resolveContext: resolve,
        blobs: { read: blobRead },
      },
      claims(),
      'stale-early-context-admission',
      rid
    )
    const outcome = await attempt.then(
      () => 'admitted',
      error => error.code
    )
    expect(blobRead).not.toHaveBeenCalled()
    expect(outcome).toBe('forbidden')
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve.mock.calls[0][0]).not.toBe(readPool)

    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'user', $2, ARRAY['read'], false)`,
      [resourceId, userId]
    )
  })

  it("denies content after the user's lifecycle is retired before the snapshot", async () => {
    await db.query(
      "UPDATE users SET lifecycle_state = 'retired', lifecycle_version = 2 WHERE id = $1",
      [userId]
    )
    const attempt = admission(readPool)
    await expect(attempt.run()).rejects.toMatchObject({ code: 'forbidden' })
    expect(attempt.blobRead).not.toHaveBeenCalled()
    await db.query(
      "UPDATE users SET lifecycle_state = 'active', lifecycle_version = 1 WHERE id = $1",
      [userId]
    )
  })

  it('routes stale content identity through fresh admission and its denial audit', async () => {
    await db.query(
      "UPDATE users SET lifecycle_state = 'retired', lifecycle_version = 2 WHERE id = $1",
      [userId]
    )
    const permissions = new PermissionClient(readPool, new DbAuditSink(readPool))
    const earlyResolve = vi.fn(
      async (tokenClaims: Parameters<typeof resolveAuthzContext>[1], requestId?: string) =>
        resolveAuthzContext(readPool, tokenClaims, requestId)
    )
    const admit = vi.fn(
      (tokenClaims: ReturnType<typeof claims>, requestId: string | undefined, targetId: string) =>
        admitGfsContentRead(
          {
            pool: readPool,
            permissions,
            resolveContext: resolveAuthzContext,
            blobs: {
              read: vi.fn(async () => {
                throw new Error('denied read must not open a blob')
              }),
            },
          },
          tokenClaims,
          requestId,
          targetId
        )
    )
    const limiter = new RateLimiter({ limit: 100, windowMs: 60_000 })
    const handler = new GfsServingHandler({
      verifyToken: () => claims(),
      resolveContext: earlyResolve,
      authorize: (ctx, targetId, op) => permissions.authorize(ctx, targetId, op),
      admitContentRead: admit,
      store: new PgResourceStore(readPool),
      blobs: { read: async () => Readable.from(Buffer.alloc(0)) },
      rateLimit: { reads: limiter, writes: limiter },
    })
    const req = {
      url: `/v1/resources/${rid}/content`,
      method: 'GET',
      headers: { authorization: 'Bearer verified' },
    } as unknown as IncomingMessage
    const res = new AdmissionResponse()

    await handler.tryHandle(req, res as unknown as ServerResponse)

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(earlyResolve).not.toHaveBeenCalled()
    expect(admit).toHaveBeenCalledOnce()
    expect(admit).toHaveBeenCalledWith(claims(), undefined, rid)
    const audit = await db.query(
      `SELECT outcome, record_type FROM gfs_audit
        WHERE gfs_uri = $1 ORDER BY id DESC LIMIT 1`,
      [`gfs://main/${rid}`]
    )
    expect(audit.rows[0]).toMatchObject({ outcome: 'error', record_type: 'authorization_decision' })
    await db.query(
      "UPDATE users SET lifecycle_state = 'active', lifecycle_version = 1 WHERE id = $1",
      [userId]
    )
  })

  it('denies a control-admin token whose session generation changed before admission', async () => {
    await db.query(
      "INSERT INTO control_admin_users (id, status, session_version) VALUES ($1, 'active', 5)",
      [adminId]
    )
    const attempt = admission(readPool, undefined, undefined, undefined, undefined, {
      ...claims(),
      sub: adminId,
      principalType: 'control-admin',
      authGeneration: 4,
    })

    await expect(attempt.run()).rejects.toMatchObject({ code: 'forbidden' })
    expect(attempt.blobRead).not.toHaveBeenCalled()
    await db.query('DELETE FROM control_admin_users WHERE id = $1', [adminId])
  })

  it('uses the brokered link generation from the admission snapshot', async () => {
    await db.query(
      "INSERT INTO control_admin_users (id, status, session_version) VALUES ($1, 'active', 4)",
      [adminId]
    )
    await db.query(
      `INSERT INTO gfs_desktop_operator_links
         (user_id, control_admin_id, lineage_id, generation, state, source)
       VALUES ($1, $2, $3, 10, 'active', 'initial_setup')`,
      [userId, adminId, linkLineageId]
    )
    const stale = admission(
      readPool,
      undefined,
      undefined,
      undefined,
      undefined,
      linkedAdminClaims()
    )
    await expect(stale.run()).rejects.toMatchObject({ code: 'forbidden' })
    expect(stale.blobRead).not.toHaveBeenCalled()
    const denialAudit = await db.query(
      `SELECT actor_on_behalf_of, desktop_user_id, authority_source
         FROM gfs_audit ORDER BY id DESC LIMIT 1`
    )
    expect(denialAudit.rows[0]).toMatchObject({
      actor_on_behalf_of: adminId,
      desktop_user_id: userId,
      authority_source: 'linked-admin',
    })

    await db.query(
      'UPDATE gfs_desktop_operator_links SET generation = 9 WHERE control_admin_id = $1',
      [adminId]
    )
    const snapshotOpened = deferred<void>()
    const continueAdmission = deferred<void>()
    const admittedBeforeRevoke = admission(
      readPool,
      async () => {
        snapshotOpened.resolve()
        await continueAdmission.promise
      },
      undefined,
      undefined,
      undefined,
      linkedAdminClaims()
    )
    const pending = admittedBeforeRevoke.run()
    await snapshotOpened.promise
    await db.query(
      "UPDATE gfs_desktop_operator_links SET state = 'revoked', generation = 10 WHERE control_admin_id = $1",
      [adminId]
    )
    continueAdmission.resolve()
    const result = await pending
    expect(result.resource.version).toBe(17)
    expect(admittedBeforeRevoke.blobRead).toHaveBeenCalledOnce()

    const afterRevoke = admission(
      readPool,
      undefined,
      undefined,
      undefined,
      undefined,
      linkedAdminClaims()
    )
    await expect(afterRevoke.run()).rejects.toMatchObject({ code: 'forbidden' })
    expect(afterRevoke.blobRead).not.toHaveBeenCalled()
    await db.query('DELETE FROM gfs_desktop_operator_links WHERE control_admin_id = $1', [adminId])
    await db.query('DELETE FROM control_admin_users WHERE id = $1', [adminId])
  })

  it('does not write an admitted snapshot allow into the shared cache', async () => {
    const cache = new DecisionCache({ ttlMs: 60_000 })
    const permissions = new PermissionClient(readPool, new DbAuditSink(readPool), cache)
    const routeContext = await resolveAuthzContext(db, claims(), 'cache-writeback-route')
    const snapshotOpened = deferred<void>()
    const continueAdmission = deferred<void>()
    const first = admission(
      readPool,
      async () => {
        snapshotOpened.resolve()
        await continueAdmission.promise
      },
      undefined,
      permissions
    )

    const pending = first.run()
    await snapshotOpened.promise
    await db.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resourceId])
    continueAdmission.resolve()
    const admitted = await pending
    expect(admitted.resource.version).toBe(17)
    expect(
      cache.get({ subjectsKey: `user:${userId}`, resourceId: rid, op: 'read' })
    ).toBeUndefined()
    expect(await admitted.stream.toArray().then(bytes => Buffer.concat(bytes).toString())).toBe(
      'snapshot body'
    )

    const next = await permissions.authorize(routeContext, rid, 'read')
    expect(next.allowed).toBe(false)
    await db.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'user', $2, ARRAY['read'], false)`,
      [resourceId, userId]
    )
  })

  it('binds the opened immutable body to the row version captured by the same snapshot', async () => {
    const writer = new BlobStore(blobDirectory, 'writer')
    const reader = new BlobStore(blobDirectory, 'reader')
    const oldBytes = Buffer.from('version-17-body')
    const newBytes = Buffer.from('version-18-body')
    const oldBlob = await writer.writeImmutable(rid, randomUUID(), oldBytes)
    await db.query(
      "UPDATE gfs_resources SET name = 'version-17.txt', version = 17, bytes = $2, blob_key = $3 WHERE resource_id = $1",
      [resourceId, oldBytes.byteLength, oldBlob.blobKey]
    )
    const snapshotOpened = deferred<void>()
    const continueAdmission = deferred<void>()
    const first = admission(
      readPool,
      async () => {
        snapshotOpened.resolve()
        await continueAdmission.promise
      },
      undefined,
      new PermissionClient(readPool, new DbAuditSink(readPool)),
      reader
    )

    const pending = first.run()
    await snapshotOpened.promise
    const newBlob = await writer.writeImmutable(rid, randomUUID(), newBytes)
    await db.query(
      "UPDATE gfs_resources SET name = 'version-18.txt', version = 18, bytes = $2, blob_key = $3 WHERE resource_id = $1",
      [resourceId, newBytes.byteLength, newBlob.blobKey]
    )
    continueAdmission.resolve()

    const admitted = await pending
    expect(admitted.resource).toMatchObject({
      name: 'version-17.txt',
      version: 17,
      bytes: oldBytes.byteLength,
      gfsUri: `gfs://main/${rid}`,
    })
    expect(Buffer.concat(await admitted.stream.toArray())).toEqual(oldBytes)
  })

  it('closes the real opened blob stream when snapshot COMMIT fails', async () => {
    const writer = new BlobStore(blobDirectory, 'writer')
    const reader = new BlobStore(blobDirectory, 'reader')
    const bytes = Buffer.from('opened before failed commit')
    const blob = await writer.writeImmutable(rid, randomUUID(), bytes)
    await db.query(
      'UPDATE gfs_resources SET version = 19, bytes = $2, blob_key = $3 WHERE resource_id = $1',
      [resourceId, bytes.byteLength, blob.blobKey]
    )

    const failCommitPool = {
      connect: async () => {
        const client = await readPool.connect()
        return {
          query: (sql: string, values?: unknown[]) => {
            if (sql === 'COMMIT')
              return Promise.reject(new Error('injected snapshot COMMIT failure'))
            return client.query(sql, values)
          },
          release: (error?: Error) => client.release(error),
        }
      },
    }
    let openedStream: import('node:stream').Readable | undefined
    let resolveClosed!: () => void
    const closed = new Promise<void>(resolvePromise => {
      resolveClosed = resolvePromise
    })
    const blobs = {
      read: async (id: string, blobKey?: string | null) => {
        const stream = await reader.read(id, blobKey)
        openedStream = stream
        stream.once('close', resolveClosed)
        return stream
      },
    }
    const permissions = new PermissionClient(readPool, new DbAuditSink(readPool))

    await expect(
      admitGfsContentRead(
        {
          pool: failCommitPool as unknown as Pool,
          permissions,
          resolveContext: resolveAuthzContext,
          blobs,
        },
        claims(),
        'commit-failure-read',
        rid
      )
    ).rejects.toThrow('injected snapshot COMMIT failure')
    expect(openedStream).toBeDefined()
    expect(openedStream?.destroyed).toBe(true)
    await closed
  })

  it('does not return or consume an admitted stream when its audit write fails', async () => {
    const { Readable } = await import('node:stream')
    const stream = Readable.from(Buffer.from('must not reach the response'))
    const audit: AuditSink = {
      record: vi.fn(async () => {
        throw new Error('audit unavailable')
      }),
    }
    const permissions = new PermissionClient(readPool, audit)
    const attempt = admission(
      readPool,
      undefined,
      vi.fn(async () => stream),
      permissions
    )

    await expect(attempt.run()).rejects.toMatchObject({ code: 'not_mounted' })
    expect(stream.destroyed).toBe(true)
  })
})

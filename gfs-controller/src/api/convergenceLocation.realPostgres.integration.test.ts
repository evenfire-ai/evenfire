import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { DbAuditSink, PermissionClient } from '../authz/permissionClient'
import { resolveAuthzContext } from '../authz/subjectResolver'
import { resolveConvergenceLocation } from './convergenceLocation'

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

describeRealPostgres('GFS Files convergence location on real PostgreSQL', () => {
  const database = `gfsc_convergence_${randomBytes(6).toString('hex')}`
  const userId = randomUUID()
  let adminPool: Pool
  let db: Pool
  let readPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    db = new Pool({ connectionString: databaseUrl(adminUrl as string, database) })
    readPool = new Pool({ connectionString: databaseUrl(adminUrl as string, database), max: 1 })
    await db.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        lifecycle_state TEXT NOT NULL,
        lifecycle_version BIGINT NOT NULL
      );
      CREATE TABLE team_members (team_id UUID NOT NULL, user_id UUID NOT NULL, status TEXT NOT NULL);
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
    `)
  }, 60_000)

  afterAll(async () => {
    await readPool?.end()
    await db?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    await adminPool.end()
  })

  const claims = () => ({
    sub: userId,
    drive: 'main',
    scopes: ['gfs.read'] as ['gfs.read'],
    pathBindings: [],
    principalType: 'user' as const,
    authGeneration: 1,
    iat: 1,
    exp: 4_102_444_800,
  })

  async function makeDirectory(name: string, parentId: string | null, path: string) {
    const id = randomUUID()
    await db.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key)
       VALUES ($1, 'main', $2, $3, 'directory', $4, 1, 0, NULL)`,
      [id, parentId, name, path]
    )
    return id
  }

  async function makeFile(name: string, parentId: string, path: string) {
    const id = randomUUID()
    await db.query(
      `INSERT INTO gfs_resources
         (resource_id, drive, parent_resource_id, name, kind, path_cache, version, bytes, blob_key)
       VALUES ($1, 'main', $2, $3, 'file', $4, 1, 0, 'unused')`,
      [id, parentId, name, path]
    )
    return id
  }

  async function grantRead(resourceId: string, inherit = false) {
    await db.query(
      `INSERT INTO gfs_grants
         (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ('main', $1, 'user', $2, ARRAY['read'], $3)`,
      [resourceId, userId, inherit]
    )
  }

  function resolver(pauseAfterSubject?: () => Promise<void>) {
    const permissions = new PermissionClient(readPool, new DbAuditSink(readPool))
    return (resourceId: string) =>
      resolveConvergenceLocation(
        {
          pool: readPool,
          permissions,
          resolveContext: async (client, tokenClaims, requestId) => {
            const ctx = await resolveAuthzContext(client, tokenClaims, requestId)
            if (pauseAfterSubject) await pauseAfterSubject()
            return ctx
          },
        },
        claims(),
        'convergence-real-pg',
        resourceId
      )
  }

  it('returns the current readable target after a Move and only authorized breadcrumb entries', async () => {
    const oldRoot = await makeDirectory('old-private-name', null, '/old-private-name')
    const newRoot = await makeDirectory('current-root', null, '/current-root')
    const fileId = await makeFile('before-move.txt', oldRoot, '/old-private-name/before-move.txt')
    await db.query(
      "UPDATE gfs_resources SET parent_resource_id = $2, name = 'after-move.txt', path_cache = '/current-root/after-move.txt' WHERE resource_id = $1",
      [fileId, newRoot]
    )
    await grantRead(newRoot)
    await grantRead(fileId)

    const result = await resolver()(fileId)
    expect(result).toEqual({
      available: true,
      location: {
        resourceId: fileId,
        rid: fileId.replaceAll('-', ''),
        gfsUri: `gfs://main/${fileId.replaceAll('-', '')}`,
        name: 'after-move.txt',
        kind: 'file',
        version: 1,
      },
      breadcrumbs: [
        {
          resourceId: newRoot,
          rid: newRoot.replaceAll('-', ''),
          gfsUri: `gfs://main/${newRoot.replaceAll('-', '')}`,
          name: 'current-root',
          kind: 'directory',
          version: 1,
        },
        {
          resourceId: fileId,
          rid: fileId.replaceAll('-', ''),
          gfsUri: `gfs://main/${fileId.replaceAll('-', '')}`,
          name: 'after-move.txt',
          kind: 'file',
          version: 1,
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('old-private-name')
    expect(JSON.stringify(result)).not.toContain('pathCache')
    expect(JSON.stringify(result)).not.toContain('parentResourceId')
  })

  it('walks tombstoned descendants and parents to the nearest readable ancestor', async () => {
    const root = await makeDirectory('authorized-root', null, '/authorized-root')
    const hiddenParent = await makeDirectory(
      'hidden-deleted-parent',
      root,
      '/authorized-root/hidden-deleted-parent'
    )
    const deletedTarget = await makeFile(
      'hidden-deleted-child.txt',
      hiddenParent,
      '/authorized-root/hidden-deleted-parent/hidden-deleted-child.txt'
    )
    await db.query(
      'UPDATE gfs_resources SET deleted_at = now() WHERE resource_id = ANY($1::uuid[])',
      [[hiddenParent, deletedTarget]]
    )
    await grantRead(root)

    const result = await resolver()(deletedTarget)
    expect(result).toMatchObject({
      available: true,
      location: { resourceId: root, name: 'authorized-root', kind: 'directory' },
      breadcrumbs: [{ resourceId: root, name: 'authorized-root' }],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('hidden-deleted-parent')
    expect(serialized).not.toContain('hidden-deleted-child.txt')
  })

  it('returns the same generic unavailable result for a target with no readable ancestry', async () => {
    const root = await makeDirectory('secret-root', null, '/secret-root')
    const fileId = await makeFile('secret-file.txt', root, '/secret-root/secret-file.txt')
    const result = await resolver()(fileId)
    expect(result).toEqual({ available: false })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('returns the exact live authorized saved URI after an unrelated mutation in the snapshot window', async () => {
    const root = await makeDirectory('saved-root', null, '/saved-root')
    const savedFile = await makeFile('saved-document.txt', root, '/saved-root/saved-document.txt')
    const unrelatedRoot = await makeDirectory('unrelated-root', null, '/unrelated-root')
    const unrelatedFile = await makeFile(
      'unrelated-before.txt',
      unrelatedRoot,
      '/unrelated-root/unrelated-before.txt'
    )
    await grantRead(root)
    await grantRead(savedFile)

    const subjectResolved = deferred<void>()
    const continueResolve = deferred<void>()
    const pending = resolver(async () => {
      subjectResolved.resolve()
      await continueResolve.promise
    })(savedFile)

    await subjectResolved.promise
    await db.query(
      "UPDATE gfs_resources SET name = 'unrelated-after.txt', path_cache = '/unrelated-root/unrelated-after.txt' WHERE resource_id = $1",
      [unrelatedFile]
    )
    continueResolve.resolve()

    const result = await pending
    expect(result).toMatchObject({
      available: true,
      location: {
        resourceId: savedFile,
        rid: savedFile.replaceAll('-', ''),
        gfsUri: `gfs://main/${savedFile.replaceAll('-', '')}`,
        name: 'saved-document.txt',
        kind: 'file',
      },
      breadcrumbs: [
        { resourceId: root, name: 'saved-root' },
        { resourceId: savedFile, name: 'saved-document.txt' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('unrelated-before.txt')
    expect(JSON.stringify(result)).not.toContain('unrelated-after.txt')
  })

  it('returns generic unavailable for a hard-purged target without guessing ancestry', async () => {
    const missingTarget = randomUUID()
    const result = await resolver()(missingTarget)

    expect(result).toEqual({ available: false })
    expect(JSON.stringify(result)).not.toContain(missingTarget)
    expect(JSON.stringify(result)).not.toContain('location')
    expect(JSON.stringify(result)).not.toContain('breadcrumbs')
  })

  it('does not compose old target and new ancestry observations across a concurrent Move', async () => {
    const oldRoot = await makeDirectory('snapshot-root', null, '/snapshot-root')
    const newRoot = await makeDirectory('replacement-root', null, '/replacement-root')
    const fileId = await makeFile('snapshot-name.txt', oldRoot, '/snapshot-root/snapshot-name.txt')
    await grantRead(oldRoot)
    await grantRead(fileId)
    const subjectResolved = deferred<void>()
    const continueResolve = deferred<void>()
    const pending = resolver(async () => {
      subjectResolved.resolve()
      await continueResolve.promise
    })(fileId)

    await subjectResolved.promise
    await db.query(
      "UPDATE gfs_resources SET parent_resource_id = $2, name = 'replacement-name.txt', path_cache = '/replacement-root/replacement-name.txt' WHERE resource_id = $1",
      [fileId, newRoot]
    )
    continueResolve.resolve()

    const result = await pending
    expect(result).toMatchObject({
      available: true,
      location: { resourceId: fileId, name: 'snapshot-name.txt' },
      breadcrumbs: [
        { resourceId: oldRoot, name: 'snapshot-root' },
        { resourceId: fileId, name: 'snapshot-name.txt' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('replacement-root')
    expect(JSON.stringify(result)).not.toContain('replacement-name.txt')
  })
})

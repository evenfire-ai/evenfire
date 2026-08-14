import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { GfsSubjectResolutionDeniedError, resolveAuthzContext } from './subjectResolver'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

describeRealPostgres('gfsc subject lifecycle resolution on real PostgreSQL', () => {
  const database = `gfsc_subject_lifecycle_${randomBytes(6).toString('hex')}`
  const userId = randomUUID()
  const adminId = randomUUID()
  const lineageId = randomUUID()
  let adminPool: Pool
  let db: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    db = new Pool({ connectionString: databaseUrl(adminUrl as string, database) })
    await db.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        lifecycle_state TEXT NOT NULL,
        lifecycle_version BIGINT NOT NULL
      );
      CREATE TABLE control_admin_users (
        id UUID PRIMARY KEY,
        status TEXT NOT NULL,
        session_version INTEGER NOT NULL
      );
      CREATE TABLE gfs_desktop_operator_links (
        id UUID PRIMARY KEY,
        lineage_id UUID NOT NULL,
        generation INTEGER NOT NULL,
        user_id UUID NOT NULL,
        control_admin_id UUID NOT NULL,
        state TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE team_members (
        team_id UUID NOT NULL,
        user_id UUID NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO users (id, lifecycle_state, lifecycle_version)
      VALUES ('${userId}', 'active', 1);
      INSERT INTO control_admin_users (id, status, session_version)
      VALUES ('${adminId}', 'active', 1);
      INSERT INTO gfs_desktop_operator_links
        (id, lineage_id, generation, user_id, control_admin_id, state, source)
      VALUES ('${randomUUID()}', '${lineageId}', 1, '${userId}', '${adminId}', 'active', 'initial_setup');
    `)
  }, 60_000)

  afterAll(async () => {
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

  const userClaims = () => ({
    sub: userId,
    drive: 'main',
    principalType: 'user' as const,
    authGeneration: 1,
  })

  const linkedClaims = () => ({
    sub: adminId,
    drive: 'main',
    principalType: 'control-admin' as const,
    authGeneration: 1,
    brokeredAuthority: {
      desktopUserId: userId,
      controlAdminId: adminId,
      authoritySource: 'linked-admin' as const,
      linkLineageId: lineageId,
      linkGeneration: 1,
      desktopUserGeneration: 1,
    },
  })

  it('allows the current user generation, then denies the same bearer after retirement', async () => {
    await expect(
      resolveAuthzContext(db, { ...userClaims(), scopes: [], pathBindings: [] })
    ).resolves.toMatchObject({
      primarySubject: userId,
      isOperator: false,
    })
    await db.query(
      `UPDATE users SET lifecycle_state = 'retired', lifecycle_version = 2 WHERE id = $1`,
      [userId]
    )
    await expect(
      resolveAuthzContext(db, { ...userClaims(), scopes: [], pathBindings: [] })
    ).rejects.toBeInstanceOf(GfsSubjectResolutionDeniedError)
  })

  it('denies a linked-admin bearer after the active link generation is revoked', async () => {
    await db.query(
      `UPDATE users SET lifecycle_state = 'active', lifecycle_version = 1 WHERE id = $1`,
      [userId]
    )
    await db.query(`UPDATE gfs_desktop_operator_links SET state = 'revoked' WHERE user_id = $1`, [
      userId,
    ])
    await expect(resolveAuthzContext(db, linkedClaims())).rejects.toBeInstanceOf(
      GfsSubjectResolutionDeniedError
    )
  })

  it('denies a linked-admin bearer when the link generation is stale', async () => {
    await db.query(
      `UPDATE users SET lifecycle_state = 'active', lifecycle_version = 1 WHERE id = $1;
       UPDATE control_admin_users SET status = 'active', session_version = 1 WHERE id = $2;
       UPDATE gfs_desktop_operator_links
       SET state = 'active', generation = 2
       WHERE user_id = $1 AND control_admin_id = $2`,
      [userId, adminId]
    )
    await expect(resolveAuthzContext(db, linkedClaims())).rejects.toBeInstanceOf(
      GfsSubjectResolutionDeniedError
    )
  })

  it('denies a linked-admin bearer when the control-admin session generation is stale', async () => {
    await db.query(
      `UPDATE users SET lifecycle_state = 'active', lifecycle_version = 1 WHERE id = $1;
       UPDATE control_admin_users SET status = 'active', session_version = 1 WHERE id = $2;
       UPDATE gfs_desktop_operator_links
       SET state = 'active', generation = 1
       WHERE user_id = $1 AND control_admin_id = $2`,
      [userId, adminId]
    )
    await expect(resolveAuthzContext(db, linkedClaims())).resolves.toMatchObject({
      primarySubject: adminId,
      isOperator: true,
    })

    await db.query(`UPDATE control_admin_users SET session_version = 2 WHERE id = $1`, [adminId])
    await expect(resolveAuthzContext(db, linkedClaims())).rejects.toBeInstanceOf(
      GfsSubjectResolutionDeniedError
    )
  })
})

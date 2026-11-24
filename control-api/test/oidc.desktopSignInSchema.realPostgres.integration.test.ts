import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CONTROL_API_MIGRATIONS, initDb } from '../src/db.js'
import { insertOidcProtocolAttempt } from '../src/oidc/protocolAttemptStore.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const ENCRYPTION_KEY = 'cd'.repeat(32)
const KIND_COLUMNS = 'oidc_attempt_sign_in_contexts_kind_columns'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function challenge(): string {
  return randomBytes(32).toString('base64url')
}

function codeHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex')
}

function invitedEmail(): string {
  return `invitee-${randomUUID()}@fixture.test`
}

describeRealPostgres('OIDC Desktop sign-in schema on real PostgreSQL', () => {
  const database = `oidc_desktop_sign_in_${randomBytes(6).toString('hex')}`
  let adminPool: Pool | undefined
  let pool: Pool | undefined
  let runtimePool: Pool | undefined

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => pool!.connect() })

    runtimePool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    runtimePool.on('connect', client => {
      void client.query('SET ROLE control_api_runtime')
    })
    const role = await runtimePool.query<{ current_user: string }>('SELECT current_user')
    expect(role.rows).toEqual([{ current_user: 'control_api_runtime' }])
    await expect(
      runtimePool.query('UPDATE oidc_desktop_sign_in_codes SET team_id = NULL')
    ).rejects.toMatchObject({ code: '42501' })
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(runtimePool)
      await endPoolAndWaitForClients(pool)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  async function seedAttempt(): Promise<string> {
    const created = await insertOidcProtocolAttempt(pool!, ENCRYPTION_KEY, {
      registrationId: 'company-login',
      configurationGeneration: 'v1:generation-one',
      issuer: 'https://issuer.example.test',
      clientId: 'fixture-client',
      redirectUri: 'https://api.example.test/oidc/callback',
      responseMode: 'query',
      state: `state-${randomBytes(32).toString('base64url')}`,
      browserBinding: randomBytes(32).toString('base64url'),
      pkceVerifier: `verifier-${randomBytes(32).toString('base64url')}`,
      nonce: `nonce-${randomBytes(16).toString('base64url')}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    return created.id
  }

  async function seedUser(): Promise<string> {
    const id = randomUUID()
    await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@fixture.test`])
    return id
  }

  type ContextRow = {
    kind: string
    challenge: string | null
    invitationId: string | null
    email: string | null
  }

  function insertContext(db: Pool, attemptId: string, row: ContextRow) {
    return db.query(
      `INSERT INTO oidc_attempt_sign_in_contexts
         (attempt_id, context_kind, desktop_code_challenge, invitation_id, invited_email)
       VALUES ($1, $2, $3, $4, $5)`,
      [attemptId, row.kind, row.challenge, row.invitationId, row.email]
    )
  }

  function insertCode(db: Pool, hash: string, userId: string) {
    return db.query(
      `INSERT INTO oidc_desktop_sign_in_codes
         (code_hash, user_id, team_id, code_challenge, registration_id,
          configuration_generation, expires_at)
       VALUES ($1, $2, NULL, $3, 'company-login', 'v1:generation-one',
               now() + INTERVAL '90 seconds')`,
      [hash, userId, challenge()]
    )
  }

  it('creates both tables with the planned columns after initDb', async () => {
    expect(CONTROL_API_MIGRATIONS.map(m => m.version)).toContain('0160_oidc_desktop_sign_in')
    const receipt = await pool!.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0160_oidc_desktop_sign_in'`
    )
    expect(receipt.rows).toEqual([{ version: '0160_oidc_desktop_sign_in' }])

    const columns = await pool!.query<{
      table_name: string
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('oidc_attempt_sign_in_contexts', 'oidc_desktop_sign_in_codes')
        ORDER BY table_name, column_name`
    )
    expect(
      columns.rows.map(r => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}`)
    ).toEqual([
      'oidc_attempt_sign_in_contexts.attempt_id:uuid:NO',
      'oidc_attempt_sign_in_contexts.context_kind:text:NO',
      'oidc_attempt_sign_in_contexts.created_at:timestamp with time zone:NO',
      'oidc_attempt_sign_in_contexts.desktop_code_challenge:text:YES',
      'oidc_attempt_sign_in_contexts.invitation_id:uuid:YES',
      'oidc_attempt_sign_in_contexts.invited_email:text:YES',
      'oidc_desktop_sign_in_codes.code_challenge:text:NO',
      'oidc_desktop_sign_in_codes.code_hash:text:NO',
      'oidc_desktop_sign_in_codes.configuration_generation:text:NO',
      'oidc_desktop_sign_in_codes.created_at:timestamp with time zone:NO',
      'oidc_desktop_sign_in_codes.expires_at:timestamp with time zone:NO',
      'oidc_desktop_sign_in_codes.registration_id:text:NO',
      'oidc_desktop_sign_in_codes.team_id:uuid:YES',
      'oidc_desktop_sign_in_codes.user_id:uuid:NO',
    ])

    // invitation_id has the type of invitations.id, and only the attempt and
    // user columns carry a foreign key.
    const invitationId = await pool!.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'id'`
    )
    expect(invitationId.rows).toEqual([{ data_type: 'uuid' }])
    const foreignKeys = await pool!.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('oidc_attempt_sign_in_contexts'::regclass,
                           'oidc_desktop_sign_in_codes'::regclass)
        ORDER BY conrelid::regclass::text`
    )
    expect(foreignKeys.rows.map(r => r.definition)).toEqual([
      'FOREIGN KEY (attempt_id) REFERENCES oidc_protocol_attempts(id) ON DELETE CASCADE',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ])
    const index = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'oidc_desktop_sign_in_codes_expiry_idx'`
    )
    expect(index.rows).toEqual([
      {
        indexdef:
          'CREATE INDEX oidc_desktop_sign_in_codes_expiry_idx ON public.oidc_desktop_sign_in_codes USING btree (expires_at)',
      },
    ])
  })

  it('refuses a context whose kind and columns disagree', async () => {
    const invitationId = randomUUID()
    const email = invitedEmail()
    const mismatches: ContextRow[] = [
      // desktop_sign_in without its challenge
      { kind: 'desktop_sign_in', challenge: null, invitationId: null, email: null },
      // desktop_sign_in carrying invitation columns
      { kind: 'desktop_sign_in', challenge: challenge(), invitationId, email },
      // invitation carrying a challenge
      { kind: 'invitation', challenge: challenge(), invitationId, email },
      // invitation without its invitation columns
      { kind: 'invitation', challenge: null, invitationId: null, email: null },
    ]
    for (const row of mismatches) {
      const attemptId = await seedAttempt()
      await expect(insertContext(pool!, attemptId, row)).rejects.toMatchObject({
        code: '23514',
        constraint: KIND_COLUMNS,
      })
    }
    // Half of an invitation pair, or one invitation column on a Desktop row,
    // is also a mismatch.
    const halfSet: ContextRow[] = [
      { kind: 'invitation', challenge: null, invitationId, email: null },
      { kind: 'invitation', challenge: null, invitationId: null, email },
      { kind: 'desktop_sign_in', challenge: challenge(), invitationId: null, email },
    ]
    for (const row of halfSet) {
      const attemptId = await seedAttempt()
      await expect(insertContext(pool!, attemptId, row)).rejects.toMatchObject({
        code: '23514',
        constraint: KIND_COLUMNS,
      })
    }

    // Both kinds are accepted when their columns agree.
    const desktopAttempt = await seedAttempt()
    const invitationAttempt = await seedAttempt()
    await insertContext(pool!, desktopAttempt, {
      kind: 'desktop_sign_in',
      challenge: challenge(),
      invitationId: null,
      email: null,
    })
    await insertContext(pool!, invitationAttempt, {
      kind: 'invitation',
      challenge: null,
      invitationId,
      email,
    })
    const stored = await pool!.query<{ context_kind: string }>(
      `SELECT context_kind FROM oidc_attempt_sign_in_contexts
        WHERE attempt_id = ANY($1::uuid[]) ORDER BY context_kind`,
      [[desktopAttempt, invitationAttempt]]
    )
    expect(stored.rows).toEqual([
      { context_kind: 'desktop_sign_in' },
      { context_kind: 'invitation' },
    ])
  })

  it('refuses a malformed challenge, an uppercase invited email and a malformed code hash', async () => {
    // Each row agrees on kind and columns, so only the column's own check fails.
    const attemptId = await seedAttempt()
    await expect(
      insertContext(pool!, attemptId, {
        kind: 'desktop_sign_in',
        challenge: `${challenge()}=`,
        invitationId: null,
        email: null,
      })
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'oidc_attempt_sign_in_contexts_desktop_code_challenge_check',
    })
    await expect(
      insertContext(pool!, attemptId, {
        kind: 'invitation',
        challenge: null,
        invitationId: randomUUID(),
        email: invitedEmail().toUpperCase(),
      })
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'oidc_attempt_sign_in_contexts_invited_email_check',
    })

    const userId = await seedUser()
    await expect(insertCode(pool!, codeHash().toUpperCase(), userId)).rejects.toMatchObject({
      code: '23514',
      constraint: 'oidc_desktop_sign_in_codes_code_hash_check',
    })
    await expect(
      pool!.query(
        `INSERT INTO oidc_desktop_sign_in_codes
           (code_hash, user_id, code_challenge, registration_id, configuration_generation,
            expires_at)
         VALUES ($1, $2, $3, 'company-login', 'v1:generation-one', now())`,
        [codeHash(), userId, challenge().slice(1)]
      )
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'oidc_desktop_sign_in_codes_code_challenge_check',
    })

    // Well-formed values are accepted.
    await insertContext(pool!, attemptId, {
      kind: 'desktop_sign_in',
      challenge: challenge(),
      invitationId: null,
      email: null,
    })
    await insertCode(pool!, codeHash(), userId)
  })

  it('removes a context when its attempt is deleted', async () => {
    const attemptId = await seedAttempt()
    await insertContext(pool!, attemptId, {
      kind: 'desktop_sign_in',
      challenge: challenge(),
      invitationId: null,
      email: null,
    })
    const before = await pool!.query(
      `SELECT 1 FROM oidc_attempt_sign_in_contexts WHERE attempt_id = $1`,
      [attemptId]
    )
    expect(before.rowCount).toBe(1)

    // The expired-attempt purge runs as the runtime role, which has no DELETE
    // on contexts; the cascade still removes the context.
    const deleted = await runtimePool!.query(`DELETE FROM oidc_protocol_attempts WHERE id = $1`, [
      attemptId,
    ])
    expect(deleted.rowCount).toBe(1)
    const after = await pool!.query(
      `SELECT 1 FROM oidc_attempt_sign_in_contexts WHERE attempt_id = $1`,
      [attemptId]
    )
    expect(after.rowCount).toBe(0)
  })

  it('lets the runtime role insert and read contexts, and insert, read and delete codes, and nothing else', async () => {
    const attemptId = await seedAttempt()
    const userId = await seedUser()
    const hash = codeHash()

    await insertContext(runtimePool!, attemptId, {
      kind: 'desktop_sign_in',
      challenge: challenge(),
      invitationId: null,
      email: null,
    })
    const context = await runtimePool!.query(
      `SELECT context_kind FROM oidc_attempt_sign_in_contexts WHERE attempt_id = $1`,
      [attemptId]
    )
    expect(context.rows).toEqual([{ context_kind: 'desktop_sign_in' }])

    await insertCode(runtimePool!, hash, userId)
    const code = await runtimePool!.query(
      `SELECT user_id FROM oidc_desktop_sign_in_codes WHERE code_hash = $1`,
      [hash]
    )
    expect(code.rows).toEqual([{ user_id: userId }])

    await expect(
      runtimePool!.query(
        `UPDATE oidc_attempt_sign_in_contexts SET invited_email = NULL WHERE attempt_id = $1`,
        [attemptId]
      )
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool!.query(`DELETE FROM oidc_attempt_sign_in_contexts WHERE attempt_id = $1`, [
        attemptId,
      ])
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool!.query(
        `UPDATE oidc_desktop_sign_in_codes SET expires_at = now() WHERE code_hash = $1`,
        [hash]
      )
    ).rejects.toMatchObject({ code: '42501' })

    const redeemed = await runtimePool!.query(
      `DELETE FROM oidc_desktop_sign_in_codes WHERE code_hash = $1 RETURNING user_id`,
      [hash]
    )
    expect(redeemed.rows).toEqual([{ user_id: userId }])

    // The full privilege matrix, as the deploy verifier reads it.
    const privileges = await pool!.query<{ relation: string; privilege: string; held: boolean }>(
      `SELECT relation, privilege,
              has_table_privilege('control_api_runtime', relation, privilege) AS held
         FROM unnest(ARRAY['oidc_attempt_sign_in_contexts', 'oidc_desktop_sign_in_codes']) AS relation
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                'REFERENCES', 'TRIGGER']) AS privilege
        ORDER BY relation, privilege`
    )
    expect(
      privileges.rows.filter(row => row.held).map(row => `${row.relation}:${row.privilege}`)
    ).toEqual([
      'oidc_attempt_sign_in_contexts:INSERT',
      'oidc_attempt_sign_in_contexts:SELECT',
      'oidc_desktop_sign_in_codes:DELETE',
      'oidc_desktop_sign_in_codes:INSERT',
      'oidc_desktop_sign_in_codes:SELECT',
    ])
    const others = await pool!.query<{ role: string; held: boolean }>(
      `SELECT role,
              has_table_privilege(role, 'oidc_attempt_sign_in_contexts', 'SELECT')
                OR has_table_privilege(role, 'oidc_desktop_sign_in_codes', 'SELECT') AS held
         FROM unnest(ARRAY['trace_maintenance_runtime', 'workflow_recipes_runtime']) AS role
        ORDER BY role`
    )
    expect(others.rows).toEqual([
      { role: 'trace_maintenance_runtime', held: false },
      { role: 'workflow_recipes_runtime', held: false },
    ])
  })
})

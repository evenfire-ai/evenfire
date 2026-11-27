import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { insertDesktopSignInContext } from '../src/oidc/attemptSignInContextStore.js'
import {
  type OidcProtocolAttemptBinding,
  claimOidcProtocolAttempt,
  insertOidcProtocolAttempt,
} from '../src/oidc/protocolAttemptStore.js'
import { OIDC_R5_PUBLIC_IP, createOidcR5ProtocolFixture } from './helpers/oidcR5ProtocolFixture.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

const oidcNetwork = vi.hoisted(() => ({
  routes: new Map<string, (input: unknown) => Promise<unknown>>(),
  lookup: vi.fn(),
  transport: vi.fn(),
}))

vi.mock('node:dns/promises', () => ({
  lookup: (hostname: string) => oidcNetwork.lookup(hostname),
}))

vi.mock('../src/http/pinnedFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: PinnedFetchOptions = {}) =>
      actual.pinnedFetch(url, field, {
        ...options,
        transport: input => oidcNetwork.transport(input),
      }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const ENCRYPTION_KEY = 'ab'.repeat(32)
const CONTEXTS_TABLE = 'oidc_attempt_sign_in_contexts'
const CLAIM_STATEMENT_MARKER = 'WITH candidate AS'
const BINDING: OidcProtocolAttemptBinding = {
  registrationId: 'company-login',
  configurationGeneration: 'v1:generation-one',
  issuer: 'https://issuer.example.test',
  clientId: 'fixture-client',
  redirectUri: 'https://api.example.test/oidc/callback',
  responseMode: 'query',
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function codeChallenge(): string {
  return randomBytes(32).toString('base64url')
}

function registerOidcFixture(fixture: ReturnType<typeof createOidcR5ProtocolFixture>): void {
  for (const endpoint of [
    fixture.issuer,
    fixture.authorizationEndpoint,
    fixture.tokenEndpoint,
    fixture.jwksUri,
  ]) {
    oidcNetwork.routes.set(new URL(endpoint).hostname, input => fixture.transport(input as never))
  }
}

describeRealPostgres('OIDC attempt sign-in context on real PostgreSQL', () => {
  const database = `oidc_attempt_context_${randomBytes(6).toString('hex')}`
  let adminPool: Pool | undefined
  let pool: Pool | undefined
  let runtimePool: Pool | undefined

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => pool!.connect() })

    // The role is a startup parameter, so it is set before the first query on
    // each connection. The store and the engine run as the runtime role.
    runtimePool = new Pool({
      connectionString: databaseUrl(adminUrl, database),
      options: '-c role=control_api_runtime',
    })
    const role = await runtimePool.query<{ current_user: string }>('SELECT current_user')
    expect(role.rows).toEqual([{ current_user: 'control_api_runtime' }])
    await expect(
      runtimePool.query('UPDATE oidc_desktop_sign_in_codes SET team_id = NULL')
    ).rejects.toMatchObject({ code: '42501' })

    oidcNetwork.lookup.mockResolvedValue([{ address: OIDC_R5_PUBLIC_IP, family: 4 }])
    oidcNetwork.transport.mockImplementation((input: { url: string }) => {
      const route = oidcNetwork.routes.get(new URL(input.url).hostname)
      if (!route) throw new Error('Unexpected real-Postgres OIDC fixture request')
      return route(input)
    })
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

  async function seedAttempt(): Promise<{ id: string; state: string; browserBinding: string }> {
    const state = `state-${randomBytes(32).toString('base64url')}`
    const browserBinding = randomBytes(32).toString('base64url')
    const created = await insertOidcProtocolAttempt(runtimePool!, ENCRYPTION_KEY, {
      ...BINDING,
      state,
      browserBinding,
      pkceVerifier: `verifier-${randomBytes(32).toString('base64url')}`,
      nonce: `nonce-${randomBytes(16).toString('base64url')}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    return { id: created.id, state, browserBinding }
  }

  async function storedCreatedAt(table: string, idColumn: string, id: string): Promise<Date> {
    const result = await pool!.query<{ created_at: Date }>(
      `SELECT created_at FROM ${table} WHERE ${idColumn} = $1`,
      [id]
    )
    expect(result.rows).toHaveLength(1)
    return result.rows[0]!.created_at
  }

  it('returns the Desktop context with the claimed attempt', async () => {
    const attempt = await seedAttempt()
    const challenge = codeChallenge()
    await insertDesktopSignInContext(runtimePool!, attempt.id, challenge)
    const stored = await pool!.query(
      `SELECT context_kind, desktop_code_challenge, invitation_id, invited_email
         FROM oidc_attempt_sign_in_contexts WHERE attempt_id = $1`,
      [attempt.id]
    )
    expect(stored.rows).toEqual([
      {
        context_kind: 'desktop_sign_in',
        desktop_code_challenge: challenge,
        invitation_id: null,
        invited_email: null,
      },
    ])
    // Both rows are written within milliseconds; move the attempt's timestamp
    // so the two created_at values can be told apart.
    await pool!.query(
      `UPDATE oidc_protocol_attempts SET created_at = created_at - INTERVAL '1 minute'
        WHERE id = $1`,
      [attempt.id]
    )

    const claimed = await claimOidcProtocolAttempt(
      runtimePool!,
      ENCRYPTION_KEY,
      attempt.state,
      attempt.browserBinding,
      BINDING
    )

    expect(claimed).toMatchObject({ id: attempt.id, ...BINDING })
    expect(claimed?.signInContext).toEqual({ kind: 'desktop_sign_in', codeChallenge: challenge })
    expect(Object.isFrozen(claimed?.signInContext)).toBe(true)
    // The attempt's own timestamp, never the context's.
    const attemptCreatedAt = await storedCreatedAt('oidc_protocol_attempts', 'id', attempt.id)
    const contextCreatedAt = await storedCreatedAt(CONTEXTS_TABLE, 'attempt_id', attempt.id)
    expect(attemptCreatedAt.getTime()).toBeLessThan(contextCreatedAt.getTime())
    expect(claimed?.createdAt).toEqual(attemptCreatedAt)

    // The verified proof carries the context of the attempt that begin created.
    const fixture = createOidcR5ProtocolFixture({
      hostPrefix: 'attempt-context-desktop',
      db: runtimePool!,
    })
    registerOidcFixture(fixture)
    const begun = await fixture.begin()
    const proofChallenge = codeChallenge()
    await insertDesktopSignInContext(runtimePool!, begun.attemptId, proofChallenge)

    const proof = await fixture.complete(begun.state)

    expect(proof.attemptId).toBe(begun.attemptId)
    expect(proof.signInContext).toEqual({
      kind: 'desktop_sign_in',
      codeChallenge: proofChallenge,
    })
    oidcNetwork.routes.clear()
  })

  it('returns an invitation context with the claimed attempt', async () => {
    const attempt = await seedAttempt()
    const invitationId = randomUUID()
    const invitedEmail = `invitee-${randomUUID()}@fixture.test`
    // No runtime code writes an invitation context yet, so the test writes the row as admin.
    await pool!.query(
      `INSERT INTO oidc_attempt_sign_in_contexts
         (attempt_id, context_kind, invitation_id, invited_email)
       VALUES ($1, 'invitation', $2, $3)`,
      [attempt.id, invitationId, invitedEmail]
    )

    const claimed = await claimOidcProtocolAttempt(
      runtimePool!,
      ENCRYPTION_KEY,
      attempt.state,
      attempt.browserBinding,
      BINDING
    )

    expect(claimed?.id).toBe(attempt.id)
    expect(claimed?.signInContext).toEqual({ kind: 'invitation', invitationId, invitedEmail })
  })

  it('returns a null context and the real createdAt for a plain attempt', async () => {
    const attempt = await seedAttempt()

    const claimed = await claimOidcProtocolAttempt(
      runtimePool!,
      ENCRYPTION_KEY,
      attempt.state,
      attempt.browserBinding,
      BINDING
    )

    expect(claimed?.id).toBe(attempt.id)
    expect(claimed?.signInContext).toBeNull()
    expect(claimed?.createdAt).toEqual(
      await storedCreatedAt('oidc_protocol_attempts', 'id', attempt.id)
    )
  })

  it('never reads the contexts table outside the claim statement', async () => {
    const statements: string[] = []
    const recordingDb = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push(sql)
        return runtimePool!.query(sql, values)
      },
    }
    const fixture = createOidcR5ProtocolFixture({
      hostPrefix: 'attempt-context-plain',
      db: recordingDb,
    })
    registerOidcFixture(fixture)
    const begun = await fixture.begin()
    statements.length = 0

    const proof = await fixture.complete(begun.state)

    const contextReads = statements.filter(sql => sql.includes(CONTEXTS_TABLE))
    // The claim statement ran and is the only statement naming the contexts table.
    expect(contextReads).toHaveLength(1)
    expect(contextReads[0]).toContain(CLAIM_STATEMENT_MARKER)
    expect(statements.filter(sql => sql.includes(CLAIM_STATEMENT_MARKER))).toHaveLength(1)
    expect(statements.length).toBeGreaterThan(1)
    expect(proof.attemptId).toBe(begun.attemptId)
    expect(proof.signInContext).toBeNull()
    const stored = await pool!.query<{ status: string }>(
      'SELECT status FROM oidc_protocol_attempts WHERE state_hash = $1',
      [createHash('sha256').update(begun.state, 'utf8').digest('hex')]
    )
    expect(stored.rows).toEqual([{ status: 'completed' }])
    oidcNetwork.routes.clear()
  })
})

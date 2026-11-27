import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import {
  type DbClient,
  type DbTransactionClient,
  initDb,
  pool,
  withTransaction,
} from '../src/db.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import type { OidcProviderConfiguration } from '../src/oidc/configuration.js'
import type { VerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import {
  OidcInvitationWithdrawnError,
  type OidcRefusal,
} from '../src/services/auth/oidcAccountResolution.js'
import {
  type OidcMemberSignInResult,
  signInOidcMember,
} from '../src/services/auth/oidcMemberSignIn.js'
import {
  type InvitationPurpose,
  insertInvitationForTeams,
} from '../src/services/directory/invitationStore.js'
import { acceptInvitationForEmailInTransaction } from '../src/services/directory/membership.js'
import type { InviteRole } from '../src/services/directory/types.js'
import {
  type FakeIdTokenClaims,
  OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP,
  type OidcMemberSignInFakeProvider,
  createOidcMemberSignInFakeProvider,
  oidcMemberSignInFakeTransport,
} from './helpers/oidcMemberSignInFakeProvider.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

/**
 * OIDC sign-in from an invitation link (design §9): the attempt carries an
 * `invitation` sign-in context, and account resolution compares the
 * provider's email with the invited email before it writes any account,
 * link or membership. With account creation off, the invitation creates the
 * one account it was sent to (the creation exception). Every statement the app runs goes through a pool whose
 * connections start as `control_api_runtime`, so the grants are part of what
 * is proved. Fixtures and reads use the owner pool.
 */

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const network = vi.hoisted(() => ({ lookup: vi.fn(), transport: vi.fn() }))

vi.mock('node:dns/promises', () => ({ lookup: () => network.lookup() }))

vi.mock('../src/http/pinnedFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: PinnedFetchOptions = {}) =>
      actual.pinnedFetch(url, field, { ...options, transport: input => network.transport(input) }),
  }
})

// Member sign-in's default transaction runner and the directory services use
// the module-level pool; point it at this suite's runtime pool.
vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  const proxy = {
    query: (...args: unknown[]) => (holder.pool.query as Function)(...args),
    connect: () => holder.pool.connect(),
  }
  return {
    ...real,
    pool: proxy,
    rateLimitPool: proxy,
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

beforeEach(() => {
  network.lookup
    .mockReset()
    .mockResolvedValue([{ address: OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP, family: 4 }])
  network.transport.mockReset().mockImplementation(input => oidcMemberSignInFakeTransport(input))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const ENTRA_TENANT_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const ENTRA_ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`

const WATCHED_TABLES = [
  'users',
  'profiles',
  'user_oidc_links',
  'team_members',
  'invitations',
  'external_user_sessions',
]

const sessionPolicy: EffectiveUserAccessPolicy = Object.freeze({
  policyVersion: '1',
  policyRevision: 'oidc-invitation-sign-in-fixture',
  acceptV1: true,
  issueV1: true,
  acceptV2: true,
  issueV2: true,
  renewV2: true,
  switchCompatibility: false,
  actionContextV2: false,
  rpcDelegationV2: false,
  minimumClientVersion: null,
  enforceMinimumClient: false,
})

type TransactionRunner = <T>(work: (db: DbTransactionClient) => Promise<T>) => Promise<T>

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function uniqueLabel(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    value => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

function valueOf<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}

function signedIn(result: OidcMemberSignInResult) {
  if (result.status === 'refused') {
    throw new Error(`expected signed_in, got refused: ${result.reason}`)
  }
  if (result.status !== 'signed_in') throw new Error(`expected signed_in, got ${result.status}`)
  return result
}

describeRealPostgres('OIDC sign-in from an invitation link on real PostgreSQL', () => {
  const database = `oidc_invitation_sign_in_${randomBytes(6).toString('hex')}`
  const actorId = randomUUID()
  let adminPool: Pool
  /** The database owner: schema, fixtures and every read a test makes. */
  let testPool: Pool
  /** `control_api_runtime`: every statement the app runs. */
  let runtimePool: Pool
  let defaultFake: OidcMemberSignInFakeProvider
  let creatingFake: OidcMemberSignInFakeProvider

  // The mocked db.js transaction: it runs on holder.pool, the runtime pool.
  const committed: TransactionRunner = work => withTransaction(work)

  function entraFake(
    registrationId: string,
    env: Record<string, string | undefined> = {}
  ): OidcMemberSignInFakeProvider {
    return createOidcMemberSignInFakeProvider({
      issuer: ENTRA_ISSUER,
      memberSignInEnv: {
        CONTROL_API_OIDC_REGISTRATION_ID: registrationId,
        CONTROL_API_OIDC_TENANT_ID: ENTRA_TENANT_ID,
        ...env,
      },
    })
  }

  function policyOf(fake: OidcMemberSignInFakeProvider) {
    const policy = fake.provider.memberSignIn
    if (!policy) throw new Error('fake provider has member sign-in switched off')
    return policy
  }

  function signIn(
    fake: OidcMemberSignInFakeProvider,
    proof: VerifiedOidcIdentityProof,
    options: { transaction?: TransactionRunner } = {}
  ): Promise<OidcMemberSignInResult> {
    return signInOidcMember(
      {
        proof,
        provider: fake.provider,
        policy: policyOf(fake),
        completion: { kind: 'session', contract: 'v2', sessionPolicy },
      },
      { transaction: options.transaction ?? committed }
    )
  }

  /** A real proof from the fake provider, as an invitation attempt's claim would carry it. */
  async function invitationProof(
    fake: OidcMemberSignInFakeProvider,
    claims: FakeIdTokenClaims,
    invitation: { invitationId: string; invitedEmail: string }
  ): Promise<VerifiedOidcIdentityProof> {
    const proof = await fake.signIn(claims)
    return { ...proof, signInContext: { kind: 'invitation', ...invitation } }
  }

  async function seedConnection(provider: OidcProviderConfiguration): Promise<void> {
    await testPool.query(
      `INSERT INTO oidc_connections (id, issuer, client_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [provider.registrationId, provider.issuer, provider.clientId]
    )
  }

  async function seedUser(email: string): Promise<string> {
    const id = randomUUID()
    await testPool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Seeded Member')`, [
      id,
      email,
    ])
    return id
  }

  async function seedLink(
    provider: OidcProviderConfiguration,
    subject: string,
    userId: string
  ): Promise<void> {
    await seedConnection(provider)
    await testPool.query(
      `INSERT INTO user_oidc_links (connection_id, issuer, subject, user_id)
       VALUES ($1, $2, $3, $4::uuid)`,
      [provider.registrationId, provider.issuer, subject, userId]
    )
  }

  async function seedTeam(label: string): Promise<string> {
    const id = randomUUID()
    await testPool.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [id, uniqueLabel(label)])
    return id
  }

  /** A pending invitation written by the directory's own invitation insert. */
  async function seedInvitation(input: {
    email: string
    /** The primary team, as a `member`. */
    teamId: string
    /** Further teams, after the primary one. */
    moreTeams?: ReadonlyArray<{ teamId: string; role: InviteRole }>
    purpose?: InvitationPurpose
  }): Promise<{ id: string; token: string }> {
    const created = await insertInvitationForTeams(testPool, {
      inviteeName: 'Invited Member',
      email: input.email,
      teamAssignments: [{ teamId: input.teamId, role: 'member' }, ...(input.moreTeams ?? [])],
      purpose: input.purpose ?? 'member_invitation',
      status: 'pending',
    })
    return { id: created.invitation.id, token: created.invitation.token }
  }

  async function retireUser(userId: string): Promise<void> {
    const operation = await testPool.query<{ id: string }>(
      `INSERT INTO desktop_user_retirement_operations(
         actor_type, actor_control_admin_id, target_user_id,
         idempotency_key_hash, request_fingerprint, reason, request_id
       )
       VALUES ('control_admin', $1::uuid, $2::uuid, repeat('a', 64), repeat('b', 64),
               'oidc invitation sign-in fixture', 'oidc-invitation-sign-in-fixture')
       RETURNING id::text AS id`,
      [actorId, userId]
    )
    const operationId = operation.rows[0]!.id
    await testPool.query(
      `UPDATE users
          SET lifecycle_state = 'retired',
              retired_at = NOW(),
              retirement_reason = 'oidc invitation sign-in fixture',
              retired_by_type = 'control_admin',
              retired_by_control_admin_id = $3::uuid,
              retirement_request_id = 'oidc-invitation-sign-in-fixture',
              retirement_operation_id = $2::uuid,
              lifecycle_version = lifecycle_version + 1,
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [userId, operationId, actorId]
    )
    await testPool.query(
      `UPDATE desktop_user_retirement_operations
          SET status = 'completed', outcome = 'retired', lifecycle_version = 2,
              lifecycle_operation_id = id, completed_at = NOW()
        WHERE id = $1::uuid`,
      [operationId]
    )
  }

  async function invitationState(id: string) {
    const result = await testPool.query<{ status: string; accepted_user_id: string | null }>(
      `SELECT status, accepted_user_id::text AS accepted_user_id FROM invitations WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  async function membershipsOf(userId: string) {
    const result = await testPool.query<{ team_id: string; role: string }>(
      `SELECT team_id::text AS team_id, role FROM team_members
        WHERE user_id = $1::uuid AND status = 'active' ORDER BY team_id`,
      [userId]
    )
    return result.rows
  }

  async function linkCount(subject: string): Promise<number> {
    const result = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_oidc_links WHERE subject = $1`,
      [subject]
    )
    return result.rows[0]!.n
  }

  async function profileCount(userId: string): Promise<number> {
    const result = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM profiles WHERE user_id = $1::uuid`,
      [userId]
    )
    return result.rows[0]!.n
  }

  async function connectionCount(registrationId: string): Promise<number> {
    const result = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oidc_connections WHERE id = $1`,
      [registrationId]
    )
    return result.rows[0]!.n
  }

  async function userCount(email: string): Promise<number> {
    const result = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)`,
      [email]
    )
    return result.rows[0]!.n
  }

  /** Row count and content digest of every table a refusal must leave untouched. */
  async function watchedTables(): Promise<Record<string, string>> {
    const snapshot: Record<string, string> = {}
    for (const table of WATCHED_TABLES) {
      const result = await testPool.query<{ n: number; digest: string }>(
        `SELECT count(*)::int AS n,
                md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
           FROM ${table} t`
      )
      snapshot[table] = `${result.rows[0]!.n}:${result.rows[0]!.digest}`
    }
    return snapshot
  }

  /**
   * Resolves true once another backend in this database waits on a row or key
   * lock, or false once `signingIn` settles without having waited: a sign-in
   * that never reached the lock then fails on its outcome.
   */
  async function waitForLockWaiter(signingIn: Promise<unknown>): Promise<boolean> {
    let settled = false
    const markSettled = () => {
      settled = true
    }
    void signingIn.then(markSettled, markSettled)
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const waiting = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [database]
      )
      if (waiting.rows[0]!.n > 0) return true
      if (settled) return false
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('no transaction ever waited on a lock')
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    holder.pool = testPool
    await initDb({ connect: () => testPool.connect() })

    // The role is a startup parameter, so it is set before the first query on
    // each connection. Every statement the app runs from here uses this pool.
    runtimePool = new Pool({
      connectionString: databaseUrl(adminUrl, database),
      options: '-c role=control_api_runtime',
    })
    holder.pool = runtimePool
    // Through the only two ways the app reaches the database: the mocked db.js
    // transaction and pool. Both read holder.pool, so a suite that stopped
    // pointing it at the runtime pool would run every sign-in as the owner.
    const transactionRole = await withTransaction(db => db.query('SELECT current_user'))
    expect(transactionRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
    const poolRole = await pool.query<{ current_user: string }>('SELECT current_user')
    expect(poolRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
    const committedRole = await committed(db => db.query('SELECT current_user'))
    expect(committedRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
    await expect(
      withTransaction(db => db.query('UPDATE oidc_desktop_sign_in_codes SET team_id = NULL'))
    ).rejects.toMatchObject({ code: '42501' })

    await testPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'fixture-password-hash', 'admin', 'active')`,
      [actorId, `oidc-invitation-sign-in-actor-${actorId}`]
    )
    defaultFake = createOidcMemberSignInFakeProvider()
    creatingFake = createOidcMemberSignInFakeProvider({
      memberSignInEnv: {
        CONTROL_API_OIDC_REGISTRATION_ID: 'fake-invitation-creation',
        // Creation on for everyone the issuer signs in: these sign-ins carry no required claim.
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'any_issuer_account',
      },
    })
    expect(policyOf(defaultFake).accountCreation).toBe('disabled')
    expect(policyOf(creatingFake).accountCreation).toBe('enabled')
    await seedConnection(defaultFake.provider)
    await seedConnection(creatingFake.provider)
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(runtimePool)
      await endPoolAndWaitForClients(testPool)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  it('refuses a different provider email before any write, even with account creation enabled', async () => {
    const alice = `${uniqueLabel('alice')}@fixture.test`
    const bob = `${uniqueLabel('bob')}@fixture.test`
    const subject = uniqueLabel('creation-mismatch-subject')
    const teamId = await seedTeam('creation-mismatch-team')
    const invitation = await seedInvitation({ email: alice, teamId })
    const proof = await invitationProof(
      creatingFake,
      { sub: subject, email: bob, email_verified: true },
      { invitationId: invitation.id, invitedEmail: alice }
    )
    const before = await watchedTables()

    expect(await signIn(creatingFake, proof)).toEqual({
      status: 'refused',
      reason: 'invitation_email_mismatch',
    })
    expect(await userCount(bob)).toBe(0)
    expect(await userCount(alice)).toBe(0)
    expect(await linkCount(subject)).toBe(0)
    expect(await invitationState(invitation.id)).toEqual({
      status: 'pending',
      accepted_user_id: null,
    })
    expect(await watchedTables()).toEqual(before)
  })

  it('refuses an unlinked account whose email differs and writes no link', async () => {
    const alice = `${uniqueLabel('alice')}@fixture.test`
    const bob = `${uniqueLabel('bob')}@fixture.test`
    const subject = uniqueLabel('unlinked-mismatch-subject')
    const bobId = await seedUser(bob)
    const teamId = await seedTeam('unlinked-mismatch-team')
    const invitation = await seedInvitation({ email: alice, teamId })
    const proof = await invitationProof(
      defaultFake,
      { sub: subject, email: bob, email_verified: true },
      { invitationId: invitation.id, invitedEmail: alice }
    )
    const before = await watchedTables()

    expect(await signIn(defaultFake, proof)).toEqual({
      status: 'refused',
      reason: 'invitation_email_mismatch',
    })
    expect(await linkCount(subject)).toBe(0)
    expect(await membershipsOf(bobId)).toEqual([])
    expect(await invitationState(invitation.id)).toEqual({
      status: 'pending',
      accepted_user_id: null,
    })
    expect(await watchedTables()).toEqual(before)
  })

  it.each(['stored equals invited, claim differs', 'claim equals invited, stored differs'])(
    'compares a linked account by its stored email: %s',
    async row => {
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const bob = `${uniqueLabel('bob')}@fixture.test`
      const storedEqualsInvited = row === 'stored equals invited, claim differs'
      const [stored, claim] = storedEqualsInvited ? [alice, bob] : [bob, alice]
      const subject = uniqueLabel('linked-compare-subject')
      const userId = await seedUser(stored)
      await seedLink(defaultFake.provider, subject, userId)
      const teamId = await seedTeam('linked-compare-team')
      const invitation = await seedInvitation({ email: alice, teamId })
      const proof = await invitationProof(
        defaultFake,
        { sub: subject, email: claim, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )

      if (storedEqualsInvited) {
        // Alice's account signs in, whatever address the provider now reports.
        expect(signedIn(await signIn(defaultFake, proof))).toMatchObject({
          status: 'signed_in',
          userId,
          created: { account: false, link: false },
          invitationsApplied: 1,
        })
        expect(await invitationState(invitation.id)).toEqual({
          status: 'accepted',
          accepted_user_id: userId,
        })
        expect(await membershipsOf(userId)).toEqual([{ team_id: teamId, role: 'member' }])
        return
      }

      // Bob's account is refused although the provider now reports alice's address.
      const before = await watchedTables()
      expect(await signIn(defaultFake, proof)).toEqual({
        status: 'refused',
        reason: 'invitation_email_mismatch',
      })
      expect(await membershipsOf(userId)).toEqual([])
      expect(await invitationState(invitation.id)).toEqual({
        status: 'pending',
        accepted_user_id: null,
      })
      expect(await watchedTables()).toEqual(before)
    }
  )

  it('ignores case on every side of the comparison', async () => {
    const storedEmail = 'Alice.Member@Fixture.Test'
    const invitationRowEmail = 'ALICE.member@fixture.test'
    const claimEmail = 'ALICE.MEMBER@FIXTURE.TEST'
    // The context carries the invited address lower-cased, as its schema requires.
    const invitedEmail = 'alice.member@fixture.test'
    const subject = uniqueLabel('case-subject')
    const userId = await seedUser(storedEmail)
    const teamId = await seedTeam('case-team')
    const invitation = await seedInvitation({ email: invitationRowEmail, teamId })
    // The directory insert lower-cases the address; put the row's own case back.
    await testPool.query(`UPDATE invitations SET email = $2 WHERE id = $1`, [
      invitation.id,
      invitationRowEmail,
    ])
    const claims = { sub: subject, email: claimEmail, email_verified: true }
    const context = { invitationId: invitation.id, invitedEmail }

    // An unlinked existing account: found by the claim, then linked.
    const unlinked = await signIn(defaultFake, await invitationProof(defaultFake, claims, context))
    expect(signedIn(unlinked)).toMatchObject({
      status: 'signed_in',
      userId,
      created: { account: false, link: true },
      invitationsApplied: 1,
    })
    expect(await membershipsOf(userId)).toEqual([{ team_id: teamId, role: 'member' }])

    // The same account, now linked: compared by its stored address.
    const linked = await signIn(defaultFake, await invitationProof(defaultFake, claims, context))
    expect(signedIn(linked)).toMatchObject({
      status: 'signed_in',
      userId,
      created: { account: false, link: false },
      invitationsApplied: 0,
    })
    expect(await linkCount(subject)).toBe(1)
  })

  it('keeps the earlier refusals ahead of the comparison', async () => {
    const alice = `${uniqueLabel('alice')}@fixture.test`
    const teamId = await seedTeam('earlier-refusal-team')
    const invitation = await seedInvitation({ email: alice, teamId })
    const context = { invitationId: invitation.id, invitedEmail: alice }

    // account_disabled: bob's linked, retired account.
    const retiredSubject = uniqueLabel('earlier-retired-subject')
    const retiredEmail = `${uniqueLabel('bob-retired')}@fixture.test`
    const retiredUserId = await seedUser(retiredEmail)
    await seedLink(defaultFake.provider, retiredSubject, retiredUserId)
    await retireUser(retiredUserId)
    // email_unverified: bob's existing account, which the provider did not verify.
    const unverifiedEmail = `${uniqueLabel('bob-unverified')}@fixture.test`
    await seedUser(unverifiedEmail)

    // provider_configuration: an Entra token for bob with neither email_verified
    // nor xms_edov, so the app registration does not send the domain claim.
    const entra = entraFake('fake-invitation-entra-earlier-refusal')

    const cases: ReadonlyArray<{
      fake: OidcMemberSignInFakeProvider
      claims: FakeIdTokenClaims
      expected: OidcRefusal
    }> = [
      {
        fake: defaultFake,
        claims: { sub: retiredSubject, email: retiredEmail, email_verified: true },
        expected: { status: 'refused', reason: 'account_disabled' },
      },
      {
        fake: defaultFake,
        claims: { sub: uniqueLabel('earlier-no-email-subject'), email_verified: true },
        expected: { status: 'refused', reason: 'email_claim_missing' },
      },
      {
        fake: defaultFake,
        claims: {
          sub: uniqueLabel('earlier-unverified-subject'),
          email: unverifiedEmail,
          email_verified: false,
        },
        expected: { status: 'refused', reason: 'email_unverified' },
      },
      {
        fake: entra,
        claims: {
          sub: uniqueLabel('earlier-entra-subject'),
          tid: ENTRA_TENANT_ID,
          email: `${uniqueLabel('bob-entra')}@fixture.test`,
        },
        expected: {
          status: 'refused',
          reason: 'provider_configuration',
          cause: 'email_domain_claim_missing',
        },
      },
    ]
    for (const { fake, claims, expected } of cases) {
      const proof = await invitationProof(fake, claims, context)
      const before = await watchedTables()
      expect(await signIn(fake, proof), expected.reason).toEqual(expected)
      expect(await watchedTables(), expected.reason).toEqual(before)
    }
    expect(await invitationState(invitation.id)).toEqual({
      status: 'pending',
      accepted_user_id: null,
    })
  })

  describe('the creation exception', () => {
    /** Teams sorted as membershipsOf returns them. */
    function byTeam(rows: Array<{ team_id: string; role: string }>) {
      return [...rows].sort((a, b) => (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0))
    }

    it('creates the invited account when account creation is off', async () => {
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const subject = uniqueLabel('exception-subject')
      const teamId = await seedTeam('exception-team')
      const invitation = await seedInvitation({ email: alice, teamId })
      const proof = await invitationProof(
        defaultFake,
        { sub: subject, email: alice, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )
      expect(policyOf(defaultFake).accountCreation).toBe('disabled')

      const outcome = await signIn(defaultFake, proof)
      expect(outcome.status).toBe('signed_in')
      const result = signedIn(outcome)
      expect(result.created).toStrictEqual({ account: true, link: true, byInvitation: true })
      expect(result.invitationsApplied).toBe(1)
      expect(await userCount(alice)).toBe(1)
      expect(await profileCount(result.userId)).toBe(1)
      expect(await linkCount(subject)).toBe(1)
      expect(await invitationState(invitation.id)).toEqual({
        status: 'accepted',
        accepted_user_id: result.userId,
      })
      expect(await membershipsOf(result.userId)).toEqual([{ team_id: teamId, role: 'member' }])
    })

    it('gives the created account only the invitation teams, even with a new-member team configured', async () => {
      const newMemberTeamId = await seedTeam('exception-new-member-team')
      const fake = createOidcMemberSignInFakeProvider({
        memberSignInEnv: {
          CONTROL_API_OIDC_REGISTRATION_ID: 'fake-invitation-exception-new-member-team',
          CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: newMemberTeamId,
        },
      })
      expect(policyOf(fake)).toMatchObject({ accountCreation: 'disabled', newMemberTeamId })
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const firstTeamId = await seedTeam('exception-first-team')
      const secondTeamId = await seedTeam('exception-second-team')
      const invitation = await seedInvitation({
        email: alice,
        teamId: firstTeamId,
        moreTeams: [{ teamId: secondTeamId, role: 'inviter' }],
      })
      const proof = await invitationProof(
        fake,
        { sub: uniqueLabel('exception-teams-subject'), email: alice, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )

      const outcome = await signIn(fake, proof)
      expect(outcome.status).toBe('signed_in')
      const result = signedIn(outcome)
      expect(result.created).toStrictEqual({ account: true, link: true, byInvitation: true })
      // Decision 14: an inviter of these teams grants no other team.
      expect(await membershipsOf(result.userId)).toEqual(
        byTeam([
          { team_id: firstTeamId, role: 'member' },
          { team_id: secondTeamId, role: 'inviter' },
        ])
      )
    })

    it('does not consult the new-member team, even one that does not exist', async () => {
      const fake = createOidcMemberSignInFakeProvider({
        memberSignInEnv: {
          CONTROL_API_OIDC_REGISTRATION_ID: 'fake-invitation-exception-missing-team',
          CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: randomUUID(),
        },
      })
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const teamId = await seedTeam('exception-missing-team-invited')
      const invitation = await seedInvitation({ email: alice, teamId })
      const proof = await invitationProof(
        fake,
        { sub: uniqueLabel('exception-missing-team-subject'), email: alice, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )

      // Normal creation refuses this configuration (unknown_new_member_team).
      const outcome = await signIn(fake, proof)
      expect(outcome.status).toBe('signed_in')
      const result = signedIn(outcome)
      expect(result.created).toStrictEqual({ account: true, link: true, byInvitation: true })
      expect(await membershipsOf(result.userId)).toEqual([{ team_id: teamId, role: 'member' }])
    })

    it.each(['enabled', 'entra'] as const)(
      'creates by the normal policy when creation is %s',
      async mode => {
        const newMemberTeamId = await seedTeam(`normal-${mode}-new-member-team`)
        const registrationId = `fake-invitation-normal-${mode}`
        const fake =
          mode === 'entra'
            ? entraFake(registrationId, { CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: newMemberTeamId })
            : createOidcMemberSignInFakeProvider({
                memberSignInEnv: {
                  CONTROL_API_OIDC_REGISTRATION_ID: registrationId,
                  // Loads as the `enabled` policy, with no required claim to carry.
                  CONTROL_API_OIDC_ACCOUNT_CREATION: 'any_issuer_account',
                  CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: newMemberTeamId,
                },
              })
        expect(policyOf(fake).accountCreation).toBe(mode)
        const alice = `${uniqueLabel('alice')}@fixture.test`
        const subject = uniqueLabel(`normal-${mode}-subject`)
        const teamId = await seedTeam(`normal-${mode}-invited-team`)
        const invitation = await seedInvitation({ email: alice, teamId })
        const claims =
          mode === 'entra'
            ? { sub: subject, tid: ENTRA_TENANT_ID, email: alice, xms_edov: true }
            : { sub: subject, email: alice, email_verified: true }
        const proof = await invitationProof(fake, claims, {
          invitationId: invitation.id,
          invitedEmail: alice,
        })

        const result = signedIn(await signIn(fake, proof))
        // No byInvitation key at all: toEqual would also accept an undefined one.
        expect(result.created).toStrictEqual({ account: true, link: true })
        expect(await invitationState(invitation.id)).toEqual({
          status: 'accepted',
          accepted_user_id: result.userId,
        })
        expect(await membershipsOf(result.userId)).toEqual(
          byTeam([
            { team_id: teamId, role: 'member' },
            { team_id: newMemberTeamId, role: 'member' },
          ])
        )
      }
    )

    it.each(['revoked', 'expired', 'accepted', 'admin_desktop_access'] as const)(
      'refuses no_account when the invitation is %s at the unlocked read',
      async row => {
        // A connection record no other test writes: a refusal that commits keeps
        // it, while a refusal from the locked re-check rolls it back.
        const registrationId = `fake-invitation-unlocked-${row.replaceAll('_', '-')}`
        const fake = createOidcMemberSignInFakeProvider({
          memberSignInEnv: { CONTROL_API_OIDC_REGISTRATION_ID: registrationId },
        })
        const alice = `${uniqueLabel('alice')}@fixture.test`
        const subject = uniqueLabel(`unlocked-${row}-subject`)
        const teamId = await seedTeam(`unlocked-${row}-team`)
        const invitation = await seedInvitation({
          email: alice,
          teamId,
          ...(row === 'admin_desktop_access' ? { purpose: 'admin_desktop_access' as const } : {}),
        })
        if (row === 'revoked') {
          await testPool.query(`UPDATE invitations SET status = 'revoked' WHERE id = $1`, [
            invitation.id,
          ])
        }
        if (row === 'expired') {
          await testPool.query(
            `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
            [invitation.id]
          )
        }
        if (row === 'accepted') {
          // Accepted with no account at the address, so nothing resolves by email.
          await testPool.query(
            `UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1`,
            [invitation.id]
          )
        }
        const proof = await invitationProof(
          fake,
          { sub: subject, email: alice, email_verified: true },
          { invitationId: invitation.id, invitedEmail: alice }
        )
        const before = await watchedTables()

        expect(await signIn(fake, proof)).toEqual({ status: 'refused', reason: 'no_account' })
        expect(await userCount(alice)).toBe(0)
        expect(await linkCount(subject)).toBe(0)
        expect(await watchedTables()).toEqual(before)
        expect(await connectionCount(registrationId)).toBe(1)
      }
    )

    it('refuses no_account when the context names an invitation sent to another address', async () => {
      // A connection record no other test writes: the refusal commits it.
      const registrationId = 'fake-invitation-other-address'
      const fake = createOidcMemberSignInFakeProvider({
        memberSignInEnv: { CONTROL_API_OIDC_REGISTRATION_ID: registrationId },
      })
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const carol = `${uniqueLabel('carol')}@fixture.test`
      const subject = uniqueLabel('other-address-subject')
      const teamId = await seedTeam('other-address-team')
      const carolInvitation = await seedInvitation({ email: carol, teamId })
      // Alice's proof, and a context whose address is hers but whose
      // invitation is carol's: the comparison passes, so only the
      // invitation's own address can refuse the creation.
      const proof = await invitationProof(
        fake,
        { sub: subject, email: alice, email_verified: true },
        { invitationId: carolInvitation.id, invitedEmail: alice }
      )
      const before = await watchedTables()

      expect(await signIn(fake, proof)).toEqual({ status: 'refused', reason: 'no_account' })
      expect(await userCount(alice)).toBe(0)
      expect(await userCount(carol)).toBe(0)
      expect(await linkCount(subject)).toBe(0)
      expect(await invitationState(carolInvitation.id)).toEqual({
        status: 'pending',
        accepted_user_id: null,
      })
      expect(await watchedTables()).toEqual(before)
      // The sign-in ran to resolution and committed its refusal.
      expect(await connectionCount(registrationId)).toBe(1)
    })

    it('refuses no_account and writes nothing when a revoke commits while the sign-in waits on the invitation', async () => {
      // Never seeded, so the connection record exists only if the sign-in commits.
      const registrationId = 'fake-invitation-revoke-race'
      const fake = createOidcMemberSignInFakeProvider({
        memberSignInEnv: { CONTROL_API_OIDC_REGISTRATION_ID: registrationId },
      })
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const subject = uniqueLabel('revoke-race-subject')
      const teamId = await seedTeam('revoke-race-team')
      const invitation = await seedInvitation({ email: alice, teamId })
      const proof = await invitationProof(
        fake,
        { sub: subject, email: alice, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )

      const revoke = await testPool.connect()
      let signingIn: Promise<PromiseSettledResult<OidcMemberSignInResult>> | undefined
      let waited = false
      try {
        await revoke.query('BEGIN')
        // The statement revokePendingInvitation runs, left uncommitted.
        const revoked = await revoke.query(
          `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending'`,
          [invitation.id]
        )
        expect(revoked.rowCount).toBe(1)
        signingIn = settle(signIn(fake, proof))
        waited = await waitForLockWaiter(signingIn)
        await revoke.query('COMMIT')
      } catch (error) {
        await revoke.query('ROLLBACK')
        throw error
      } finally {
        revoke.release()
        if (signingIn) await signingIn
      }

      expect(valueOf(await signingIn!)).toEqual({ status: 'refused', reason: 'no_account' })
      expect(await userCount(alice)).toBe(0)
      expect(await linkCount(subject)).toBe(0)
      // The rollback undoes the connection record too.
      expect(await connectionCount(registrationId)).toBe(0)
      expect(await invitationState(invitation.id)).toEqual({
        status: 'revoked',
        accepted_user_id: null,
      })
      expect(waited, 'the sign-in waited on the invitation lock').toBe(true)
    })

    it('signs in to the account a concurrent password acceptance created', async () => {
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const subject = uniqueLabel('lost-insert-subject')
      const teamId = await seedTeam('lost-insert-team')
      const invitation = await seedInvitation({ email: alice, teamId })
      const proof = await invitationProof(
        defaultFake,
        { sub: subject, email: alice, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )

      const acceptance = await testPool.connect()
      let signingIn: Promise<PromiseSettledResult<OidcMemberSignInResult>> | undefined
      let acceptedUserId = ''
      let waited = false
      try {
        await acceptance.query('BEGIN')
        // The invitation link's own password acceptance, left uncommitted: it has
        // created alice's user and accepted the invitation.
        const byPassword = await acceptInvitationForEmailInTransaction(
          acceptance as unknown as DbClient,
          alice,
          invitation.token
        )
        if (!('data' in byPassword) || !byPassword.data) {
          throw new Error('the password acceptance was refused')
        }
        acceptedUserId = byPassword.data.userId
        signingIn = settle(signIn(defaultFake, proof))
        waited = await waitForLockWaiter(signingIn)
        await acceptance.query('COMMIT')
      } catch (error) {
        await acceptance.query('ROLLBACK')
        throw error
      } finally {
        acceptance.release()
        if (signingIn) await signingIn
      }

      const result = valueOf(await signingIn!)
      expect(result).toMatchObject({
        status: 'signed_in',
        userId: acceptedUserId,
        created: { account: false, link: true },
        invitationsApplied: 0,
      })
      expect(result).not.toHaveProperty('created.byInvitation')
      expect(await userCount(alice)).toBe(1)
      expect(await linkCount(subject)).toBe(1)
      expect(await invitationState(invitation.id)).toEqual({
        status: 'accepted',
        accepted_user_id: acceptedUserId,
      })
      expect(await membershipsOf(acceptedUserId)).toEqual([{ team_id: teamId, role: 'member' }])
      expect(waited, 'the sign-in waited on the users insert').toBe(true)
    })

    it('signs in to the account a password acceptance created after the email lookup found none', async () => {
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const subject = uniqueLabel('lookup-race-subject')
      const teamId = await seedTeam('lookup-race-team')
      const invitation = await seedInvitation({ email: alice, teamId })
      const proof = await invitationProof(
        defaultFake,
        { sub: subject, email: alice, email_verified: true },
        { invitationId: invitation.id, invitedEmail: alice }
      )

      let acceptedUserId = ''
      /** The invitation link's own password acceptance, committed in full. */
      async function acceptByPassword(): Promise<void> {
        const acceptance = await testPool.connect()
        try {
          await acceptance.query('BEGIN')
          // The sign-in holds no lock this needs, so a wait here is a defect, not the pause.
          await acceptance.query(`SET LOCAL lock_timeout = '5s'`)
          const byPassword = await acceptInvitationForEmailInTransaction(
            acceptance as unknown as DbClient,
            alice,
            invitation.token
          )
          if (!('data' in byPassword) || !byPassword.data) {
            throw new Error('the password acceptance was refused')
          }
          acceptedUserId = byPassword.data.userId
          await acceptance.query('COMMIT')
        } catch (error) {
          await acceptance.query('ROLLBACK')
          throw error
        } finally {
          acceptance.release()
        }
      }

      // The email lookup, and not the reselect after the insert: only the lookup has LIMIT 2.
      const emailLookup = /FROM users\s+WHERE lower\(email\) = lower\(\$1\)[\s\S]*LIMIT 2/
      const pauses: Array<{ lookupRows: number }> = []
      // Once the lookup has returned, the acceptance commits before the sign-in's next statement.
      const pausingAfterLookup: TransactionRunner = work =>
        committed(db => {
          const query: DbClient['query'] = async (text, values) => {
            const result = await db.query(text, values)
            if (pauses.length === 0 && emailLookup.test(text)) {
              pauses.push({ lookupRows: result.rowCount ?? 0 })
              await acceptByPassword()
            }
            return result
          }
          return work(
            new Proxy(db, {
              get: (target, key) => (key === 'query' ? query : Reflect.get(target, key)),
            })
          )
        })

      const outcome = await signIn(defaultFake, proof, { transaction: pausingAfterLookup })
      // The pause ran once, on a lookup that found no account yet.
      expect(pauses).toEqual([{ lookupRows: 0 }])
      expect(acceptedUserId).not.toBe('')
      expect(outcome).toMatchObject({
        status: 'signed_in',
        userId: acceptedUserId,
        created: { account: false, link: true },
        invitationsApplied: 0,
      })
      expect(outcome).not.toHaveProperty('created.byInvitation')
      expect(await userCount(alice)).toBe(1)
      expect(await linkCount(subject)).toBe(1)
      expect(await invitationState(invitation.id)).toEqual({
        status: 'accepted',
        accepted_user_id: acceptedUserId,
      })
      expect(await membershipsOf(acceptedUserId)).toEqual([{ team_id: teamId, role: 'member' }])
    })

    it('requires eligibility before the exception', async () => {
      const fake = createOidcMemberSignInFakeProvider({
        memberSignInEnv: {
          CONTROL_API_OIDC_REGISTRATION_ID: 'fake-invitation-required-claim',
          CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE: 'evenfire-member',
        },
      })
      expect(policyOf(fake)).toMatchObject({
        accountCreation: 'disabled',
        requiredClaim: { name: 'roles', value: 'evenfire-member' },
      })
      const alice = `${uniqueLabel('alice')}@fixture.test`
      const subject = uniqueLabel('eligibility-subject')
      const teamId = await seedTeam('eligibility-team')
      const invitation = await seedInvitation({ email: alice, teamId })
      const context = { invitationId: invitation.id, invitedEmail: alice }

      // No roles claim: the invitation does not stand in for eligibility.
      const before = await watchedTables()
      const ineligible = await invitationProof(
        fake,
        { sub: subject, email: alice, email_verified: true },
        context
      )
      expect(await signIn(fake, ineligible)).toEqual({ status: 'refused', reason: 'not_eligible' })
      expect(await userCount(alice)).toBe(0)
      expect(await watchedTables()).toEqual(before)

      // Control: with the required role, the exception creates the account.
      const eligible = await invitationProof(
        fake,
        { sub: subject, email: alice, email_verified: true, roles: ['evenfire-member'] },
        context
      )
      const outcome = await signIn(fake, eligible)
      expect(outcome.status).toBe('signed_in')
      const result = signedIn(outcome)
      expect(result.created).toStrictEqual({ account: true, link: true, byInvitation: true })
      expect(await userCount(alice)).toBe(1)
    })

    it('maps a withdrawn invitation to no_account on the first run and on the 23505 rerun, without a retry of its own', async () => {
      const proof = await defaultFake.signIn({
        sub: uniqueLabel('withdrawn-subject'),
        email: `${uniqueLabel('withdrawn')}@fixture.test`,
        email_verified: true,
      })

      let firstRunCalls = 0
      const withdrawnAtOnce: TransactionRunner = async () => {
        firstRunCalls += 1
        throw new OidcInvitationWithdrawnError()
      }
      await expect(signIn(defaultFake, proof, { transaction: withdrawnAtOnce })).resolves.toEqual({
        status: 'refused',
        reason: 'no_account',
      })
      expect(firstRunCalls).toBe(1)

      let rerunCalls = 0
      const withdrawnOnRerun: TransactionRunner = async () => {
        rerunCalls += 1
        if (rerunCalls === 1) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          })
        }
        throw new OidcInvitationWithdrawnError()
      }
      await expect(signIn(defaultFake, proof, { transaction: withdrawnOnRerun })).resolves.toEqual({
        status: 'refused',
        reason: 'no_account',
      })
      expect(rerunCalls).toBe(2)
    })
  })
})

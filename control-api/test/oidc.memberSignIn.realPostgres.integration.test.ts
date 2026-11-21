import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbClient, type DbTransactionClient, initDb, withTransaction } from '../src/db.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import type { OidcProviderConfiguration } from '../src/oidc/configuration.js'
import type { VerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
import type { ExternalSessionContract } from '../src/services/auth/externalSessionIssuance.js'
import {
  type OidcMemberSignInResult,
  signInOidcMember,
} from '../src/services/auth/oidcMemberSignIn.js'
import {
  type InvitationPurpose,
  insertInvitationForTeams,
} from '../src/services/directory/invitationStore.js'
import {
  acceptInvitationForEmailInTransaction,
  deleteManagedUserForUser,
  softDeleteMember,
} from '../src/services/directory/membership.js'
import type { InviteRole } from '../src/services/directory/types.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import {
  OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP,
  type OidcMemberSignInFakeProvider,
  createOidcMemberSignInFakeProvider,
  oidcMemberSignInFakeTransport,
} from './helpers/oidcMemberSignInFakeProvider.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

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

// Session authentication reads through the module-level pool; point it at this suite's database.
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

/** Retirement reads the OIDC configuration from process.env: exactly these settings. */
function stubOidcEnvironment(env: Record<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONTROL_API_OIDC_') && !(name in env)) vi.stubEnv(name, undefined)
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

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
  policyRevision: 'oidc-member-sign-in-fixture',
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

/** Attaches the outcome handler at once, so a sign-in that fails while the test waits elsewhere is not an unhandled rejection. */
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
  if (result.status !== 'signed_in') {
    throw new Error(`expected signed_in, got refused: ${result.reason}`)
  }
  return result
}

describeRealPostgres('OIDC member sign-in on real PostgreSQL', () => {
  const database = `oidc_member_sign_in_${randomBytes(6).toString('hex')}`
  const actorId = randomUUID()
  let adminPool: Pool
  let testPool: Pool
  let defaultFake: OidcMemberSignInFakeProvider

  const committed: TransactionRunner = work => withTransaction(work, testPool)

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
    options: { contract?: ExternalSessionContract; transaction?: TransactionRunner } = {}
  ): Promise<OidcMemberSignInResult> {
    return signInOidcMember(
      {
        proof,
        provider: fake.provider,
        policy: policyOf(fake),
        contract: options.contract ?? 'v2',
        sessionPolicy,
      },
      { transaction: options.transaction ?? committed }
    )
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

  async function seedMembership(teamId: string, userId: string, role: InviteRole): Promise<void> {
    await testPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [teamId, userId, role]
    )
  }

  /** A pending invitation written by the directory's own invitation insert. */
  async function seedInvitation(input: {
    email: string
    teamId: string
    role?: InviteRole
    purpose?: InvitationPurpose
    status?: 'draft' | 'pending'
  }): Promise<{ id: string; token: string }> {
    const created = await insertInvitationForTeams(testPool, {
      inviteeName: 'Invited Member',
      email: input.email,
      teamAssignments: [{ teamId: input.teamId, role: input.role ?? 'member' }],
      purpose: input.purpose ?? 'member_invitation',
      status: input.status ?? 'pending',
    })
    return { id: created.invitation.id, token: created.invitation.token }
  }

  /**
   * Seeds two pending invitations for one address and makes the one with the
   * lower or the higher id the more recently created, so creation order and
   * id order can be made to disagree.
   */
  async function seedTwoInvitations(
    email: string,
    specs: readonly [{ teamId: string; role: InviteRole }, { teamId: string; role: InviteRole }],
    newest: 'lower id' | 'higher id'
  ) {
    const created = []
    for (const spec of specs)
      created.push({ ...spec, ...(await seedInvitation({ email, ...spec })) })
    const [lower, higher] = created.sort((a, b) => (a.id < b.id ? -1 : 1))
    const [older, newer] = newest === 'lower id' ? [higher!, lower!] : [lower!, higher!]
    await testPool.query(
      `UPDATE invitations SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [older.id]
    )
    await testPool.query(
      `UPDATE invitations SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [newer.id]
    )
    return { older, newer }
  }

  async function retireUser(userId: string): Promise<void> {
    const operation = await testPool.query<{ id: string }>(
      `INSERT INTO desktop_user_retirement_operations(
         actor_type, actor_control_admin_id, target_user_id,
         idempotency_key_hash, request_fingerprint, reason, request_id
       )
       VALUES ('control_admin', $1::uuid, $2::uuid, repeat('a', 64), repeat('b', 64),
               'oidc member sign-in fixture', 'oidc-member-sign-in-fixture')
       RETURNING id::text AS id`,
      [actorId, userId]
    )
    const operationId = operation.rows[0]!.id
    await testPool.query(
      `UPDATE users
          SET lifecycle_state = 'retired',
              retired_at = NOW(),
              retirement_reason = 'oidc member sign-in fixture',
              retired_by_type = 'control_admin',
              retired_by_control_admin_id = $3::uuid,
              retirement_request_id = 'oidc-member-sign-in-fixture',
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

  async function sessionCount(userId: string): Promise<number> {
    const result = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM external_user_sessions
        WHERE user_id = $1::uuid AND revoked_at IS NULL`,
      [userId]
    )
    return result.rows[0]!.n
  }

  async function linkCount(subject: string): Promise<number> {
    const result = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_oidc_links WHERE subject = $1`,
      [subject]
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

  /** Resolves once another backend in this database waits on a row or key lock. */
  async function waitForLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const waiting = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [database]
      )
      if (waiting.rows[0]!.n > 0) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('no transaction ever waited on a lock')
  }

  /**
   * Races two sign-ins: the first finishes its work, then holds its transaction
   * open until the second waits on a lock behind it, and only then commits.
   *
   * Each sign-in must finish in exactly one transaction attempt. The locks in
   * account resolution, not the unique-key retry, must decide the race: if
   * they did not, the second attempt would hit 23505 and the retry would hide it.
   */
  async function raceSignIns(
    fake: OidcMemberSignInFakeProvider,
    firstProof: VerifiedOidcIdentityProof,
    secondProof: VerifiedOidcIdentityProof
  ): Promise<[OidcMemberSignInResult, OidcMemberSignInResult]> {
    const attempts = { first: 0, second: 0 }
    let second: Promise<PromiseSettledResult<OidcMemberSignInResult>> | undefined
    const gated: TransactionRunner = work => {
      attempts.first += 1
      return withTransaction(async db => {
        const result = await work(db)
        if (!second) {
          second = settle(
            signIn(fake, secondProof, {
              transaction: secondWork => {
                attempts.second += 1
                return committed(secondWork)
              },
            })
          )
          await waitForLockWaiter()
        }
        return result
      }, testPool)
    }
    const first = await settle(signIn(fake, firstProof, { transaction: gated }))
    const secondOutcome = second ? await second : undefined
    const firstResult = valueOf(first)
    if (!secondOutcome) throw new Error('the second sign-in never started')
    const secondResult = valueOf(secondOutcome)
    expect(attempts).toEqual({ first: 1, second: 1 })
    return [firstResult, secondResult]
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    holder.pool = testPool
    await initDb({ connect: () => testPool.connect() })
    await testPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'fixture-password-hash', 'admin', 'active')`,
      [actorId, `oidc-member-sign-in-actor-${actorId}`]
    )
    defaultFake = createOidcMemberSignInFakeProvider()
    await seedConnection(defaultFake.provider)
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(testPool)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  it('applies pending invitations by the account email, not the claim email', async () => {
    // Row 1: the link decides, and the provider now reports another address.
    const subject = uniqueLabel('by-account-email-subject')
    const local = uniqueLabel('stored.member')
    const storedEmail = `${local.toUpperCase()}@Stored.Fixture.Test`
    const claimEmail = `${uniqueLabel('claim.member')}@claim.fixture.test`
    const userId = await seedUser(storedEmail)
    await seedLink(defaultFake.provider, subject, userId)
    const storedTeam = await seedTeam('stored-email-team')
    const claimTeam = await seedTeam('claim-email-team')
    // The directory stores invitation addresses lowercased; the account kept its case.
    const forStoredEmail = await seedInvitation({
      email: storedEmail,
      teamId: storedTeam,
      role: 'inviter',
    })
    const forClaimEmail = await seedInvitation({ email: claimEmail, teamId: claimTeam })
    const proof = await defaultFake.signIn({
      sub: subject,
      email: claimEmail,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    expect(result).toMatchObject({
      status: 'signed_in',
      userId,
      contract: 'v1',
      created: { account: false, link: false },
      invitationsApplied: 1,
    })
    // The session names the stored address too, and lands in the invited team.
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      email: storedEmail,
      teamId: storedTeam,
      role: 'inviter',
    })
    expect(await invitationState(forStoredEmail.id)).toEqual({
      status: 'accepted',
      accepted_user_id: userId,
    })
    expect(await invitationState(forClaimEmail.id)).toEqual({
      status: 'pending',
      accepted_user_id: null,
    })
    expect(await membershipsOf(userId)).toEqual([{ team_id: storedTeam, role: 'inviter' }])
  })

  it('skips password_reset, admin_desktop_access, expired and revoked invitations', async () => {
    const email = `${uniqueLabel('skips')}@fixture.test`
    const userId = await seedUser(email)
    const validTeam = await seedTeam('valid-invitation-team')
    const skippedTeam = await seedTeam('skipped-invitation-team')
    const valid = await seedInvitation({ email, teamId: validTeam })
    const passwordReset = await seedInvitation({
      email,
      teamId: skippedTeam,
      purpose: 'password_reset',
    })
    const adminDesktopAccess = await seedInvitation({
      email,
      teamId: skippedTeam,
      purpose: 'admin_desktop_access',
    })
    const expired = await seedInvitation({ email, teamId: skippedTeam })
    await testPool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [expired.id]
    )
    const revoked = await seedInvitation({ email, teamId: skippedTeam })
    await testPool.query(`UPDATE invitations SET status = 'revoked' WHERE id = $1`, [revoked.id])
    const draft = await seedInvitation({ email, teamId: skippedTeam, status: 'draft' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('skips-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof))

    expect(result).toMatchObject({
      userId,
      created: { account: false, link: true },
      invitationsApplied: 1,
    })
    expect(await invitationState(valid.id)).toEqual({
      status: 'accepted',
      accepted_user_id: userId,
    })
    for (const skipped of [passwordReset, adminDesktopAccess, expired]) {
      expect(await invitationState(skipped.id)).toEqual({
        status: 'pending',
        accepted_user_id: null,
      })
    }
    expect(await invitationState(revoked.id)).toEqual({
      status: 'revoked',
      accepted_user_id: null,
    })
    expect(await invitationState(draft.id)).toEqual({ status: 'draft', accepted_user_id: null })
    expect(await membershipsOf(userId)).toEqual([{ team_id: validTeam, role: 'member' }])
  })

  it("keeps an existing member's team when an invitation is applied", async () => {
    const email = `${uniqueLabel('keeps-team')}@fixture.test`
    const userId = await seedUser(email)
    const existingTeam = await seedTeam('existing-team')
    const invitedTeam = await seedTeam('invited-team')
    // No accepted invitation backs the existing membership, so a membership
    // lookup after the acceptance would rank the invited team first.
    await seedMembership(existingTeam, userId, 'member')
    await seedInvitation({ email, teamId: invitedTeam, role: 'admin' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('keeps-team-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    expect(result).toMatchObject({ userId, contract: 'v1', invitationsApplied: 1 })
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      email,
      teamId: existingTeam,
      role: 'member',
    })
    const memberships = await membershipsOf(userId)
    expect(memberships).toHaveLength(2)
    expect(memberships).toEqual(
      expect.arrayContaining([
        { team_id: existingTeam, role: 'member' },
        { team_id: invitedTeam, role: 'admin' },
      ])
    )
  })

  it("an invitation to a kept team does not change the member's role", async () => {
    const email = `${uniqueLabel('kept-role')}@fixture.test`
    const userId = await seedUser(email)
    const keptTeam = await seedTeam('kept-role-team')
    await seedMembership(keptTeam, userId, 'member')
    const invitation = await seedInvitation({ email, teamId: keptTeam, role: 'admin' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('kept-role-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    // The invitation is consumed, but only a password-login or invitation-link
    // acceptance can change an existing membership.
    expect(result).toMatchObject({ userId, contract: 'v1', invitationsApplied: 1 })
    expect(await invitationState(invitation.id)).toEqual({
      status: 'accepted',
      accepted_user_id: userId,
    })
    expect(await membershipsOf(userId)).toEqual([{ team_id: keptTeam, role: 'member' }])
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      email,
      teamId: keptTeam,
      role: 'member',
    })
  })

  it('an existing admin with a pending member invitation stays admin', async () => {
    const email = `${uniqueLabel('kept-admin')}@fixture.test`
    const userId = await seedUser(email)
    const adminTeam = await seedTeam('kept-admin-team')
    await seedMembership(adminTeam, userId, 'admin')
    // An inviter of the team can create this invitation for any address.
    const invitation = await seedInvitation({ email, teamId: adminTeam, role: 'member' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('kept-admin-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    expect(result).toMatchObject({ userId, invitationsApplied: 1 })
    expect(await invitationState(invitation.id)).toEqual({
      status: 'accepted',
      accepted_user_id: userId,
    })
    expect(await membershipsOf(userId)).toEqual([{ team_id: adminTeam, role: 'admin' }])
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      teamId: adminTeam,
      role: 'admin',
    })
  })

  it('an invitation does not reactivate a removed membership', async () => {
    const email = `${uniqueLabel('removed-member')}@fixture.test`
    const userId = await seedUser(email)
    const removedTeam = await seedTeam('removed-member-team')
    await seedMembership(removedTeam, userId, 'admin')
    expect(await softDeleteMember(removedTeam, userId, actorId)).toMatchObject({
      status: 'deleted',
    })
    const invitation = await seedInvitation({ email, teamId: removedTeam, role: 'member' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('removed-member-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    expect(result).toMatchObject({ userId, invitationsApplied: 1 })
    expect(await invitationState(invitation.id)).toEqual({
      status: 'accepted',
      accepted_user_id: userId,
    })
    const rows = await testPool.query<{ role: string; status: string }>(
      `SELECT role, status FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [removedTeam, userId]
    )
    expect(rows.rows).toEqual([{ role: 'admin', status: 'deleted' }])
    expect(await membershipsOf(userId)).toEqual([])
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      teamId: null,
      role: 'member',
    })
  })

  it('an invitation to a new team still adds that membership next to a kept one', async () => {
    const email = `${uniqueLabel('new-team-invite')}@fixture.test`
    const userId = await seedUser(email)
    const adminTeam = await seedTeam('new-team-invite-kept')
    const newTeam = await seedTeam('new-team-invite-added')
    await seedMembership(adminTeam, userId, 'admin')
    const sameTeam = await seedInvitation({ email, teamId: adminTeam, role: 'member' })
    const otherTeam = await seedInvitation({ email, teamId: newTeam, role: 'inviter' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('new-team-invite-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    expect(result).toMatchObject({ userId, invitationsApplied: 2 })
    for (const invitation of [sameTeam, otherTeam]) {
      expect(await invitationState(invitation.id)).toEqual({
        status: 'accepted',
        accepted_user_id: userId,
      })
    }
    const memberships = await membershipsOf(userId)
    expect(memberships).toHaveLength(2)
    expect(memberships).toEqual(
      expect.arrayContaining([
        { team_id: adminTeam, role: 'admin' },
        { team_id: newTeam, role: 'inviter' },
      ])
    )
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      teamId: adminTeam,
      role: 'admin',
    })
  })

  it('a teamless member lands in the invited team', async () => {
    const email = `${uniqueLabel('teamless')}@fixture.test`
    const userId = await seedUser(email)
    const invitedTeam = await seedTeam('teamless-invited-team')
    await seedInvitation({ email, teamId: invitedTeam, role: 'inviter' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('teamless-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

    expect(result).toMatchObject({ userId, contract: 'v1', invitationsApplied: 1 })
    expect(verifyExternalSessionToken(result.token)).toMatchObject({
      userId,
      email,
      teamId: invitedTeam,
      role: 'inviter',
    })
  })

  it('a new account with a pending invitation lands in the invited team, not the new-member team', async () => {
    const newMemberTeam = await seedTeam('new-member-team')
    const fake = entraFake('fake-entra-new-account-team', {
      CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: newMemberTeam,
    })
    const invitedTeam = await seedTeam('new-account-invited-team')
    const invitedEmail = `${uniqueLabel('new-invited')}@entra.fixture.test`
    await seedInvitation({ email: invitedEmail, teamId: invitedTeam, role: 'inviter' })

    const invited = signedIn(
      await signIn(
        fake,
        await fake.signIn({
          sub: uniqueLabel('new-invited-subject'),
          tid: ENTRA_TENANT_ID,
          email: invitedEmail,
          email_verified: true,
        }),
        { contract: 'v1' }
      )
    )

    expect(invited).toMatchObject({
      created: { account: true, link: true },
      invitationsApplied: 1,
    })
    expect(verifyExternalSessionToken(invited.token)).toMatchObject({
      userId: invited.userId,
      email: invitedEmail,
      teamId: invitedTeam,
      role: 'inviter',
    })
    const memberships = await membershipsOf(invited.userId)
    expect(memberships).toHaveLength(2)
    expect(memberships).toEqual(
      expect.arrayContaining([
        { team_id: newMemberTeam, role: 'member' },
        { team_id: invitedTeam, role: 'inviter' },
      ])
    )

    // Without an invitation, a new account lands in the new-member team.
    const plainEmail = `${uniqueLabel('new-plain')}@entra.fixture.test`
    const plain = signedIn(
      await signIn(
        fake,
        await fake.signIn({
          sub: uniqueLabel('new-plain-subject'),
          tid: ENTRA_TENANT_ID,
          email: plainEmail,
          email_verified: true,
        }),
        { contract: 'v1' }
      )
    )
    expect(plain).toMatchObject({ created: { account: true, link: true }, invitationsApplied: 0 })
    expect(verifyExternalSessionToken(plain.token)).toMatchObject({
      userId: plain.userId,
      email: plainEmail,
      teamId: newMemberTeam,
      role: 'member',
    })
  })

  it.each(['row 3', 'row 4'] as const)(
    'concurrent first sign-ins give one account, one link and two sessions: %s',
    async row => {
      const fake = entraFake(row === 'row 3' ? 'fake-entra-race-row3' : 'fake-entra-race-row4')
      // The connection already exists, so the second sign-in waits on the account itself.
      await seedConnection(fake.provider)
      const subject = uniqueLabel(`race-${row.replace(' ', '')}-subject`)
      const email = `${uniqueLabel(`race-${row.replace(' ', '')}`)}@entra.fixture.test`
      const existingUserId = row === 'row 3' ? await seedUser(email) : undefined
      const claims = { sub: subject, tid: ENTRA_TENANT_ID, email, email_verified: true }
      const firstProof = await fake.signIn(claims)
      const secondProof = await fake.signIn(claims)

      const [first, second] = await raceSignIns(fake, firstProof, secondProof)

      const firstSignedIn = signedIn(first)
      const secondSignedIn = signedIn(second)
      if (existingUserId) expect(firstSignedIn.userId).toBe(existingUserId)
      expect(secondSignedIn.userId).toBe(firstSignedIn.userId)
      expect(firstSignedIn.created).toEqual({ account: row === 'row 4', link: true })
      expect(secondSignedIn.created).toEqual({ account: false, link: false })
      expect(secondSignedIn.token).not.toBe(firstSignedIn.token)
      expect(await userCount(email)).toBe(1)
      expect(await linkCount(subject)).toBe(1)
      expect(await sessionCount(firstSignedIn.userId)).toBe(2)
    }
  )

  it('a concurrent sign-in and pending invitation accept the invitation once without 40P01', async () => {
    const fake = entraFake('fake-entra-invitation-race')
    await seedConnection(fake.provider)

    // Two first sign-ins for one subject race over one pending invitation.
    const email = `${uniqueLabel('invitation-race')}@entra.fixture.test`
    const userId = await seedUser(email)
    const teamId = await seedTeam('invitation-race-team')
    const invitation = await seedInvitation({ email, teamId })
    const claims = {
      sub: uniqueLabel('invitation-race-subject'),
      tid: ENTRA_TENANT_ID,
      email,
      email_verified: true,
    }
    const [first, second] = await raceSignIns(
      fake,
      await fake.signIn(claims),
      await fake.signIn(claims)
    )
    expect(signedIn(first).userId).toBe(userId)
    expect(signedIn(second).userId).toBe(userId)
    expect(signedIn(first).invitationsApplied + signedIn(second).invitationsApplied).toBe(1)
    expect(await invitationState(invitation.id)).toEqual({
      status: 'accepted',
      accepted_user_id: userId,
    })
    expect(await membershipsOf(userId)).toEqual([{ team_id: teamId, role: 'member' }])

    // The invitation link's own acceptance takes the user, then the invitation.
    // A sign-in that held the invitation while waiting for the user would deadlock it.
    const acceptEmail = `${uniqueLabel('accept-race')}@entra.fixture.test`
    const acceptUserId = await seedUser(acceptEmail)
    const acceptTeamId = await seedTeam('accept-race-team')
    const accepted = await seedInvitation({ email: acceptEmail, teamId: acceptTeamId })
    const proof = await fake.signIn({
      sub: uniqueLabel('accept-race-subject'),
      tid: ENTRA_TENANT_ID,
      email: acceptEmail,
      email_verified: true,
    })
    const acceptance = await testPool.connect()
    let signingIn: Promise<PromiseSettledResult<OidcMemberSignInResult>> | undefined
    try {
      await acceptance.query('BEGIN')
      await acceptance.query(`SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, [acceptUserId])
      signingIn = settle(signIn(fake, proof))
      await waitForLockWaiter()
      const acceptedByLink = await acceptInvitationForEmailInTransaction(
        acceptance as unknown as DbClient,
        acceptEmail,
        accepted.token
      )
      expect(acceptedByLink).toMatchObject({ data: { accepted: true, userId: acceptUserId } })
      await acceptance.query('COMMIT')
    } catch (error) {
      await acceptance.query('ROLLBACK')
      throw error
    } finally {
      acceptance.release()
      if (signingIn) await signingIn
    }
    const afterAcceptance = signedIn(valueOf(await signingIn!))
    expect(afterAcceptance).toMatchObject({ userId: acceptUserId, invitationsApplied: 0 })
    expect(await invitationState(accepted.id)).toEqual({
      status: 'accepted',
      accepted_user_id: acceptUserId,
    })
    expect(await membershipsOf(acceptUserId)).toEqual([{ team_id: acceptTeamId, role: 'member' }])
  })

  it('refusals issue no session and write no link', async () => {
    const teamId = await seedTeam('refusal-team')

    // no_account: an unknown address with a pending invitation.
    const unknownEmail = `${uniqueLabel('refused-unknown')}@fixture.test`
    const unknownInvitation = await seedInvitation({ email: unknownEmail, teamId })
    // account_disabled: a linked, retired member.
    const retiredSubject = uniqueLabel('refused-retired-subject')
    const retiredEmail = `${uniqueLabel('refused-retired')}@fixture.test`
    const retiredUserId = await seedUser(retiredEmail)
    await seedLink(defaultFake.provider, retiredSubject, retiredUserId)
    await retireUser(retiredUserId)
    const retiredInvitation = await seedInvitation({ email: retiredEmail, teamId })
    // identity_conflict: the address belongs to a member linked to another subject.
    const conflictEmail = `${uniqueLabel('refused-conflict')}@fixture.test`
    const conflictUserId = await seedUser(conflictEmail)
    await seedLink(defaultFake.provider, uniqueLabel('refused-other-subject'), conflictUserId)
    const conflictInvitation = await seedInvitation({ email: conflictEmail, teamId })
    // email_unverified: an existing member whose address the provider did not verify.
    const unverifiedEmail = `${uniqueLabel('refused-unverified')}@fixture.test`
    await seedUser(unverifiedEmail)
    const unverifiedInvitation = await seedInvitation({ email: unverifiedEmail, teamId })

    const cases = [
      {
        reason: 'no_account',
        claims: {
          sub: uniqueLabel('refused-unknown-subject'),
          email: unknownEmail,
          email_verified: true,
        },
      },
      {
        reason: 'account_disabled',
        claims: { sub: retiredSubject, email: retiredEmail, email_verified: true },
      },
      {
        reason: 'identity_conflict',
        claims: {
          sub: uniqueLabel('refused-new-subject'),
          email: conflictEmail,
          email_verified: true,
        },
      },
      {
        reason: 'email_unverified',
        claims: {
          sub: uniqueLabel('refused-unverified-subject'),
          email: unverifiedEmail,
          email_verified: false,
        },
      },
    ] as const
    const proofs: VerifiedOidcIdentityProof[] = []
    for (const refusal of cases) proofs.push(await defaultFake.signIn(refusal.claims))
    const before = await watchedTables()

    for (const [index, refusal] of cases.entries()) {
      expect(await signIn(defaultFake, proofs[index]!)).toEqual({
        status: 'refused',
        reason: refusal.reason,
      })
      expect(await signIn(defaultFake, proofs[index]!, { contract: 'v1' })).toEqual({
        status: 'refused',
        reason: refusal.reason,
      })
    }

    expect(await watchedTables()).toEqual(before)
    for (const invitation of [
      unknownInvitation,
      retiredInvitation,
      conflictInvitation,
      unverifiedInvitation,
    ]) {
      expect(await invitationState(invitation.id)).toEqual({
        status: 'pending',
        accepted_user_id: null,
      })
    }

    // Positive control: the same snapshot sees a sign-in's session, link and acceptance.
    const acceptedEmail = `${uniqueLabel('refusal-control')}@fixture.test`
    const acceptedUserId = await seedUser(acceptedEmail)
    const controlInvitation = await seedInvitation({ email: acceptedEmail, teamId })
    const controlSubject = uniqueLabel('refusal-control-subject')
    const beforeControl = await watchedTables()
    const control = signedIn(
      await signIn(
        defaultFake,
        await defaultFake.signIn({
          sub: controlSubject,
          email: acceptedEmail,
          email_verified: true,
        })
      )
    )
    const afterControl = await watchedTables()
    expect(control.userId).toBe(acceptedUserId)
    for (const table of [
      'user_oidc_links',
      'external_user_sessions',
      'invitations',
      'team_members',
    ]) {
      expect(afterControl[table]).not.toEqual(beforeControl[table])
    }
    expect(await sessionCount(acceptedUserId)).toBe(1)
    expect(await linkCount(controlSubject)).toBe(1)
    expect(await invitationState(controlInvitation.id)).toEqual({
      status: 'accepted',
      accepted_user_id: acceptedUserId,
    })
  })

  it('applies two invitations in one sign-in', async () => {
    const email = `${uniqueLabel('two-invitations')}@fixture.test`
    const userId = await seedUser(email)
    const firstTeam = await seedTeam('two-invitations-first')
    const secondTeam = await seedTeam('two-invitations-second')
    const first = await seedInvitation({ email, teamId: firstTeam, role: 'member' })
    const second = await seedInvitation({ email, teamId: secondTeam, role: 'inviter' })
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('two-invitations-subject'),
      email,
      email_verified: true,
    })

    const result = signedIn(await signIn(defaultFake, proof))

    expect(result).toMatchObject({ userId, invitationsApplied: 2 })
    for (const invitation of [first, second]) {
      expect(await invitationState(invitation.id)).toEqual({
        status: 'accepted',
        accepted_user_id: userId,
      })
    }
    const memberships = await membershipsOf(userId)
    expect(memberships).toHaveLength(2)
    expect(memberships).toEqual(
      expect.arrayContaining([
        { team_id: firstTeam, role: 'member' },
        { team_id: secondTeam, role: 'inviter' },
      ])
    )
  })

  it("a teamless member with two invitations lands in the most recently created invitation's team", async () => {
    for (const newest of ['lower id', 'higher id'] as const) {
      const email = `${uniqueLabel('latest-team')}@fixture.test`
      const userId = await seedUser(email)
      const { older, newer } = await seedTwoInvitations(
        email,
        [
          { teamId: await seedTeam('latest-team-a'), role: 'member' },
          { teamId: await seedTeam('latest-team-b'), role: 'inviter' },
        ],
        newest
      )
      // The member was removed from the older invitation's team a month ago.
      // The older invitation is accepted but does not restore that membership,
      // so the newer invitation's team is the only active one.
      await seedMembership(older.teamId, userId, 'member')
      await testPool.query(
        `UPDATE team_members SET created_at = NOW() - INTERVAL '30 days'
          WHERE team_id = $1 AND user_id = $2`,
        [older.teamId, userId]
      )
      expect(await softDeleteMember(older.teamId, userId, actorId)).toMatchObject({
        status: 'deleted',
      })
      expect(await membershipsOf(userId)).toEqual([])
      const proof = await defaultFake.signIn({
        sub: uniqueLabel('latest-team-subject'),
        email,
        email_verified: true,
      })

      const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

      expect(result, newest).toMatchObject({ userId, invitationsApplied: 2 })
      expect(await invitationState(older.id), newest).toEqual({
        status: 'accepted',
        accepted_user_id: userId,
      })
      expect(await membershipsOf(userId), newest).toEqual([
        { team_id: newer.teamId, role: newer.role },
      ])
      expect(verifyExternalSessionToken(result.token), newest).toMatchObject({
        userId,
        teamId: newer.teamId,
        role: newer.role,
      })
    }
  })

  it('the latest-created duplicate invitation sets the role', async () => {
    for (const newest of ['lower id', 'higher id'] as const) {
      const email = `${uniqueLabel('duplicate-role')}@fixture.test`
      const userId = await seedUser(email)
      const teamId = await seedTeam('duplicate-role-team')
      const { newer } = await seedTwoInvitations(
        email,
        [
          { teamId, role: 'admin' },
          { teamId, role: 'inviter' },
        ],
        newest
      )
      const proof = await defaultFake.signIn({
        sub: uniqueLabel('duplicate-role-subject'),
        email,
        email_verified: true,
      })

      const result = signedIn(await signIn(defaultFake, proof, { contract: 'v1' }))

      expect(result, newest).toMatchObject({ userId, invitationsApplied: 2 })
      expect(await membershipsOf(userId), newest).toEqual([{ team_id: teamId, role: newer.role }])
      expect(verifyExternalSessionToken(result.token), newest).toMatchObject({
        userId,
        teamId,
        role: newer.role,
      })
    }
  })

  describe('removing a member who never signed in with OIDC', () => {
    const retirementActor = () => ({ kind: 'control_admin' as const, controlAdminId: actorId })

    async function userRow(userId: string) {
      const result = await testPool.query<{ lifecycle_state: string }>(
        `SELECT lifecycle_state FROM users WHERE id = $1::uuid`,
        [userId]
      )
      return result.rows
    }

    it('keeps a retired row while member sign-in is on, so OIDC cannot recreate the member', async () => {
      const fake = entraFake('fake-entra-retained-removal')
      await seedConnection(fake.provider)
      stubOidcEnvironment(fake.env)
      const email = `${uniqueLabel('retained-removal')}@entra.fixture.test`
      const userId = await seedUser(email)

      const retirement = await retireDesktopUser(
        retirementActor(),
        userId,
        'removed before OIDC sign-in',
        uniqueLabel('retained-removal-key'),
        'retained-removal-request'
      )

      expect(retirement).toMatchObject({ id: userId, outcome: 'retired' })
      expect(await userRow(userId)).toEqual([{ lifecycle_state: 'retired' }])
      // Entra creates accounts, so a hard-deleted member would come back (row 4).
      expect(policyOf(fake).accountCreation).toBe('entra')
      const proof = await fake.signIn({
        sub: uniqueLabel('retained-removal-subject'),
        tid: ENTRA_TENANT_ID,
        email,
        email_verified: true,
      })
      const before = await watchedTables()

      expect(await signIn(fake, proof)).toEqual({
        status: 'refused',
        reason: 'account_needs_attention',
      })
      expect(await watchedTables()).toEqual(before)
      expect(await userCount(email)).toBe(1)
    })

    it("keeps a retired row when a team manager removes the member's account", async () => {
      const fake = entraFake('fake-entra-retained-managed-removal')
      stubOidcEnvironment(fake.env)
      const teamId = await seedTeam('retained-managed-removal-team')
      const managerId = await seedUser(`${uniqueLabel('retained-manager')}@fixture.test`)
      const userId = await seedUser(`${uniqueLabel('retained-managed')}@fixture.test`)
      await seedMembership(teamId, managerId, 'admin')
      await seedMembership(teamId, userId, 'member')

      const removal = await deleteManagedUserForUser(managerId, userId, {
        reason: 'removed by a team admin before OIDC sign-in',
        idempotencyKey: uniqueLabel('retained-managed-key'),
        requestId: 'retained-managed-request',
      })

      expect(removal).toMatchObject({ outcome: { id: userId, outcome: 'retired' } })
      expect(await userRow(userId)).toEqual([{ lifecycle_state: 'retired' }])
    })

    it('keeps a retired row when the OIDC configuration cannot be read', async () => {
      // The switch without its release guard: the loader refuses the configuration.
      const { CONTROL_API_OIDC_UNRELEASED: _guard, ...switchWithoutGuard } = entraFake(
        'fake-entra-unreadable-removal'
      ).env
      stubOidcEnvironment(switchWithoutGuard)
      const userId = await seedUser(`${uniqueLabel('unreadable-removal')}@fixture.test`)

      const retirement = await retireDesktopUser(
        retirementActor(),
        userId,
        'removed while the OIDC configuration is broken',
        uniqueLabel('unreadable-removal-key'),
        'unreadable-removal-request'
      )

      expect(retirement).toMatchObject({ id: userId, outcome: 'retired' })
      expect(await userRow(userId)).toEqual([{ lifecycle_state: 'retired' }])
    })

    it('still hard-deletes the member while member sign-in is off', async () => {
      const { CONTROL_API_OIDC_MEMBER_SIGN_IN: _switch, ...switchOff } = entraFake(
        'fake-entra-switch-off-removal'
      ).env
      for (const env of [{}, switchOff]) {
        stubOidcEnvironment(env)
        const userId = await seedUser(`${uniqueLabel('hard-deleted-removal')}@fixture.test`)

        const retirement = await retireDesktopUser(
          retirementActor(),
          userId,
          'removed while member sign-in is off',
          uniqueLabel('hard-deleted-removal-key'),
          'hard-deleted-removal-request'
        )

        expect(retirement).toMatchObject({ id: userId, outcome: 'deleted' })
        expect(await userRow(userId)).toEqual([])
      }
    })
  })

  it('the issued token authenticates as the member', async () => {
    for (const contract of ['v1', 'v2'] as const) {
      const email = `${uniqueLabel(`authenticates-${contract}`)}@fixture.test`
      const userId = await seedUser(email)
      const proof = await defaultFake.signIn({
        sub: uniqueLabel(`authenticates-${contract}-subject`),
        email,
        email_verified: true,
      })

      const result = signedIn(await signIn(defaultFake, proof, { contract }))
      expect(result).toMatchObject({ userId, contract })

      const authentication = await authenticateExternalUserSession(result.token, {
        purpose: 'protected',
        policy: sessionPolicy,
      })
      expect(authentication).toMatchObject({
        status: 'authenticated',
        contract,
        claims: { userId, email },
        authorityContext: { contract, userId },
      })
      if (contract === 'v2') {
        expect(authentication).toMatchObject({ tokenClaims: { sub: userId, amr: ['oidc'] } })
      }
    }
  })

  it('signs in through the default transaction runner', async () => {
    // No deps.transaction: the module's own withTransaction runs, on the
    // suite's database through the mocked db.js pool.
    const email = `${uniqueLabel('default-runner')}@fixture.test`
    const userId = await seedUser(email)
    const subject = uniqueLabel('default-runner-subject')
    const proof = await defaultFake.signIn({ sub: subject, email, email_verified: true })

    const result = await signInOidcMember({
      proof,
      provider: defaultFake.provider,
      policy: policyOf(defaultFake),
      contract: 'v2',
      sessionPolicy,
    })

    expect(result).toMatchObject({
      status: 'signed_in',
      userId,
      contract: 'v2',
      created: { account: false, link: true },
    })
    expect(await linkCount(subject)).toBe(1)
    expect(await sessionCount(userId)).toBe(1)
  })

  it('reruns the whole transaction once on a unique-key conflict and rethrows a second', async () => {
    // A parallel sign-in links the subject after this one looked for a link:
    // its link insert fails with 23505, and the rerun signs in by that link.
    const subject = uniqueLabel('retry-subject')
    const email = `${uniqueLabel('retry')}@fixture.test`
    const userId = await seedUser(email)
    const proof = await defaultFake.signIn({ sub: subject, email, email_verified: true })
    let attempts = 0
    const counted: TransactionRunner = work => {
      attempts += 1
      return committed(work)
    }
    const parallel = await testPool.connect()
    let signingIn: Promise<PromiseSettledResult<OidcMemberSignInResult>> | undefined
    try {
      await parallel.query('BEGIN')
      await parallel.query(
        `INSERT INTO user_oidc_links (connection_id, issuer, subject, user_id)
         VALUES ($1, $2, $3, $4::uuid)`,
        [defaultFake.provider.registrationId, defaultFake.provider.issuer, subject, userId]
      )
      signingIn = settle(signIn(defaultFake, proof, { transaction: counted }))
      await waitForLockWaiter()
      await parallel.query('COMMIT')
    } catch (error) {
      await parallel.query('ROLLBACK')
      throw error
    } finally {
      parallel.release()
      if (signingIn) await signingIn
    }
    expect(valueOf(await signingIn!)).toMatchObject({
      status: 'signed_in',
      userId,
      created: { account: false, link: false },
    })
    expect(attempts).toBe(2)
    expect(await linkCount(subject)).toBe(1)
    expect(await sessionCount(userId)).toBe(1)

    // A second 23505 is rethrown; any other error is not retried.
    const conflict = Object.assign(new Error('duplicate key fixture'), { code: '23505' })
    let conflictAttempts = 0
    const alwaysConflicts: TransactionRunner = async () => {
      conflictAttempts += 1
      throw conflict
    }
    await expect(signIn(defaultFake, proof, { transaction: alwaysConflicts })).rejects.toBe(
      conflict
    )
    expect(conflictAttempts).toBe(2)

    const serialization = Object.assign(new Error('serialization fixture'), { code: '40001' })
    let otherAttempts = 0
    const otherFailure: TransactionRunner = async () => {
      otherAttempts += 1
      throw serialization
    }
    await expect(signIn(defaultFake, proof, { transaction: otherFailure })).rejects.toBe(
      serialization
    )
    expect(otherAttempts).toBe(1)
  })
})

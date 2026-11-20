import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { type DbTransactionClient, initDb, withTransaction } from '../src/db.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import type { OidcProviderConfiguration } from '../src/oidc/configuration.js'
import type { VerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import {
  type OidcResolution,
  ensureOidcConnection,
  resolveOidcAccount,
} from '../src/services/auth/oidcAccountResolution.js'
import {
  OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP,
  type OidcMemberSignInFakeProvider,
  createOidcMemberSignInFakeProvider,
  oidcMemberSignInFakeTransport,
} from './helpers/oidcMemberSignInFakeProvider.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

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

beforeEach(() => {
  network.lookup
    .mockReset()
    .mockResolvedValue([{ address: OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP, family: 4 }])
  network.transport.mockReset().mockImplementation(input => oidcMemberSignInFakeTransport(input))
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const ENTRA_TENANT_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const ENTRA_ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`
const OTHER_TENANT_IDP = 'https://sts.windows.net/0a0b0c0d-1e1f-4a2b-8c3d-4e5f6a7b8c9d/'
const MEMBER_ROLE = 'Evenfire.Member'
const ALLOWED_DOMAIN = 'allowed.fixture.test'
const WATCHED_TABLES = ['users', 'profiles', 'user_oidc_links', 'team_members', 'invitations']

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

describeRealPostgres('OIDC account resolution on real PostgreSQL', () => {
  const database = `oidc_account_resolution_${randomBytes(6).toString('hex')}`
  const actorId = randomUUID()
  const newMemberTeamId = randomUUID()
  let adminPool: Pool
  let testPool: Pool
  let defaultFake: OidcMemberSignInFakeProvider

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

  /** Resolves inside a committed transaction, as the sign-in caller does. */
  async function resolve(
    fake: OidcMemberSignInFakeProvider,
    proof: VerifiedOidcIdentityProof
  ): Promise<OidcResolution> {
    return withTransaction(
      db => resolveOidcAccount(db, { proof, provider: fake.provider, policy: policyOf(fake) }),
      testPool
    )
  }

  async function seedConnection(provider: OidcProviderConfiguration): Promise<void> {
    await testPool.query(
      `INSERT INTO oidc_connections (id, issuer, client_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [provider.registrationId, provider.issuer, provider.clientId]
    )
  }

  async function seedUser(email: string, name = 'Seeded Member'): Promise<string> {
    const id = randomUUID()
    await testPool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      email,
      name,
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

  async function retireUser(userId: string): Promise<void> {
    const operation = await testPool.query<{ id: string }>(
      `INSERT INTO desktop_user_retirement_operations(
         actor_type, actor_control_admin_id, target_user_id,
         idempotency_key_hash, request_fingerprint, reason, request_id
       )
       VALUES ('control_admin', $1::uuid, $2::uuid, repeat('a', 64), repeat('b', 64),
               'oidc account resolution fixture', 'oidc-account-resolution-fixture')
       RETURNING id::text AS id`,
      [actorId, userId]
    )
    const operationId = operation.rows[0]!.id
    await testPool.query(
      `UPDATE users
          SET lifecycle_state = 'retired',
              retired_at = NOW(),
              retirement_reason = 'oidc account resolution fixture',
              retired_by_type = 'control_admin',
              retired_by_control_admin_id = $3::uuid,
              retirement_request_id = 'oidc-account-resolution-fixture',
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

  async function linksFor(subject: string) {
    const result = await testPool.query<{
      connection_id: string
      issuer: string
      subject: string
      user_id: string
    }>(
      `SELECT connection_id, issuer, subject, user_id::text AS user_id
         FROM user_oidc_links WHERE subject = $1 ORDER BY connection_id`,
      [subject]
    )
    return result.rows
  }

  async function usersWithEmail(email: string) {
    const result = await testPool.query<{
      id: string
      email: string
      name: string | null
      lifecycle_state: string
    }>(
      `SELECT id::text AS id, email, name, lifecycle_state
         FROM users WHERE lower(email) = lower($1) ORDER BY id`,
      [email]
    )
    return result.rows
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => testPool.connect() })
    await testPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'fixture-password-hash', 'admin', 'active')`,
      [actorId, `oidc-account-resolution-actor-${actorId}`]
    )
    await testPool.query(`INSERT INTO teams (id, name) VALUES ($1, 'New members')`, [
      newMemberTeamId,
    ])
    defaultFake = createOidcMemberSignInFakeProvider()
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

  it('row 1 signs in by link without an email claim', async () => {
    const subject = uniqueLabel('row1-subject')
    const email = `${uniqueLabel('row1')}@fixture.test`
    const userId = await seedUser(email)
    await seedLink(defaultFake.provider, subject, userId)
    const proof = await defaultFake.signIn({ sub: subject })
    expect(proof.attributes.email).toBeUndefined()
    const before = await watchedTables()

    const result = await resolve(defaultFake, proof)

    expect(result).toEqual({
      status: 'resolved',
      account: {
        userId,
        email,
        lifecycleState: 'active',
        lifecycleVersion: '1',
        created: { account: false, link: false },
      },
      guest: false,
    })
    expect(await watchedTables()).toEqual(before)
  })

  it('row 2 refuses a retired linked account', async () => {
    const subject = uniqueLabel('row2-subject')
    const email = `${uniqueLabel('row2')}@fixture.test`
    const userId = await seedUser(email)
    await seedLink(defaultFake.provider, subject, userId)
    await retireUser(userId)
    const proof = await defaultFake.signIn({ sub: subject, email, email_verified: true })
    const before = await watchedTables()

    const result = await resolve(defaultFake, proof)

    expect(result).toEqual({ status: 'refused', reason: 'account_disabled' })
    expect(await watchedTables()).toEqual(before)
    expect(await usersWithEmail(email)).toEqual([
      { id: userId, email, name: 'Seeded Member', lifecycle_state: 'retired' },
    ])
  })

  it('row 3 links the one active account whose email differs only by case', async () => {
    const subject = uniqueLabel('row3-subject')
    const local = uniqueLabel('row3-member')
    const storedEmail = `${local}@case.fixture.test`
    const claimEmail = `${local.toUpperCase()}@Case.Fixture.TEST`
    const userId = await seedUser(storedEmail)
    const proof = await defaultFake.signIn({
      sub: subject,
      email: claimEmail,
      email_verified: true,
    })
    const before = await watchedTables()

    const result = await resolve(defaultFake, proof)

    expect(result).toEqual({
      status: 'resolved',
      account: {
        userId,
        email: storedEmail,
        lifecycleState: 'active',
        lifecycleVersion: '1',
        created: { account: false, link: true },
      },
      guest: false,
    })
    expect(await linksFor(subject)).toEqual([
      {
        connection_id: defaultFake.provider.registrationId,
        issuer: defaultFake.provider.issuer,
        subject,
        user_id: userId,
      },
    ])
    expect(await usersWithEmail(claimEmail)).toEqual([
      { id: userId, email: storedEmail, name: 'Seeded Member', lifecycle_state: 'active' },
    ])
    const after = await watchedTables()
    expect(after.user_oidc_links).not.toEqual(before.user_oidc_links)
    for (const table of ['users', 'profiles', 'team_members', 'invitations']) {
      expect(after[table]).toEqual(before[table])
    }
  })

  it('row 4 creates an Entra account with profile and new-member team', async () => {
    const fake = entraFake('fake-entra-new-member', {
      CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: newMemberTeamId,
    })
    const subject = uniqueLabel('row4-entra-subject')
    const local = uniqueLabel('new.member')
    const claimEmail = `${local.toUpperCase()}@Entra.Fixture.Test`
    const storedEmail = `${local}@entra.fixture.test`
    // An Entra member without email_verified is accepted (missing_claim).
    const proof = await fake.signIn({
      sub: subject,
      tid: ENTRA_TENANT_ID,
      email: claimEmail,
      name: 'New Entra Member',
    })
    expect(proof.verifiedClaims.claims.email_verified).toEqual({ status: 'missing' })
    const invitationsBefore = (await watchedTables()).invitations

    const result = await resolve(fake, proof)

    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    const userId = result.account.userId
    expect(result).toEqual({
      status: 'resolved',
      account: {
        userId,
        email: storedEmail,
        lifecycleState: 'active',
        lifecycleVersion: '1',
        created: { account: true, link: true },
      },
      guest: false,
    })
    expect(await usersWithEmail(claimEmail)).toEqual([
      { id: userId, email: storedEmail, name: 'New Entra Member', lifecycle_state: 'active' },
    ])
    const profile = await testPool.query(
      `SELECT display_name FROM profiles WHERE user_id = $1::uuid`,
      [userId]
    )
    expect(profile.rows).toEqual([{ display_name: 'New Entra Member' }])
    expect(await linksFor(subject)).toEqual([
      { connection_id: 'fake-entra-new-member', issuer: ENTRA_ISSUER, subject, user_id: userId },
    ])
    const memberships = await testPool.query(
      `SELECT team_id::text AS team_id, role, status FROM team_members WHERE user_id = $1::uuid`,
      [userId]
    )
    expect(memberships.rows).toEqual([
      { team_id: newMemberTeamId, role: 'member', status: 'active' },
    ])
    const connection = await testPool.query(
      `SELECT issuer, client_id FROM oidc_connections WHERE id = 'fake-entra-new-member'`
    )
    expect(connection.rows).toEqual([{ issuer: ENTRA_ISSUER, client_id: fake.provider.clientId }])
    expect((await watchedTables()).invitations).toEqual(invitationsBefore)
  })

  it('row 4 creates for an allowed domain and refuses other domains with no_account', async () => {
    const fake = createOidcMemberSignInFakeProvider({
      memberSignInEnv: {
        CONTROL_API_OIDC_REGISTRATION_ID: 'fake-allowed-domains',
        CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
        CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS: ALLOWED_DOMAIN,
      },
    })
    expect(policyOf(fake).accountCreation).toBe('allowed_domains')

    const allowedSubject = uniqueLabel('row4-allowed-subject')
    const local = uniqueLabel('allowed')
    const allowedProof = await fake.signIn({
      sub: allowedSubject,
      email: `${local}@ALLOWED.Fixture.Test`,
      email_verified: true,
      name: 'Allowed Member',
    })
    const created = await resolve(fake, allowedProof)
    expect(created.status).toBe('resolved')
    if (created.status !== 'resolved') return
    expect(created.account).toMatchObject({
      email: `${local}@${ALLOWED_DOMAIN}`,
      lifecycleState: 'active',
      created: { account: true, link: true },
    })
    expect(await usersWithEmail(`${local}@${ALLOWED_DOMAIN}`)).toEqual([
      {
        id: created.account.userId,
        email: `${local}@${ALLOWED_DOMAIN}`,
        name: 'Allowed Member',
        lifecycle_state: 'active',
      },
    ])
    expect(await linksFor(allowedSubject)).toHaveLength(1)
    const profile = await testPool.query(`SELECT 1 FROM profiles WHERE user_id = $1::uuid`, [
      created.account.userId,
    ])
    expect(profile.rowCount).toBe(1)
    // No new-member team configured: the account is teamless.
    const memberships = await testPool.query(
      `SELECT 1 FROM team_members WHERE user_id = $1::uuid`,
      [created.account.userId]
    )
    expect(memberships.rowCount).toBe(0)

    const before = await watchedTables()
    for (const email of [
      `${uniqueLabel('other')}@other.fixture.test`,
      `${uniqueLabel('sub')}@sub.${ALLOWED_DOMAIN}`,
      `${uniqueLabel('suffix')}@not${ALLOWED_DOMAIN}`,
      `${ALLOWED_DOMAIN}@other.fixture.test`,
    ]) {
      const proof = await fake.signIn({
        sub: uniqueLabel('row4-other-subject'),
        email,
        email_verified: true,
      })
      expect(await resolve(fake, proof)).toEqual({ status: 'refused', reason: 'no_account' })
    }
    expect(await watchedTables()).toEqual(before)
  })

  it('non-Entra without account creation refuses an unknown email with no_account and writes nothing', async () => {
    expect(policyOf(defaultFake).accountCreation).toBe('disabled')
    const email = `${uniqueLabel('unknown')}@fixture.test`
    const proof = await defaultFake.signIn({
      sub: uniqueLabel('unknown-subject'),
      email,
      email_verified: true,
    })
    const before = await watchedTables()

    const result = await resolve(defaultFake, proof)

    expect(result).toEqual({ status: 'refused', reason: 'no_account' })
    expect(await watchedTables()).toEqual(before)
    expect(await usersWithEmail(email)).toEqual([])
  })

  it('row 5 refuses an account linked to another subject', async () => {
    const email = `${uniqueLabel('row5')}@fixture.test`
    const userId = await seedUser(email)
    const firstSubject = uniqueLabel('row5-first-subject')
    await seedLink(defaultFake.provider, firstSubject, userId)
    const secondSubject = uniqueLabel('row5-second-subject')
    const proof = await defaultFake.signIn({
      sub: secondSubject,
      email: email.toUpperCase(),
      email_verified: true,
    })
    const before = await watchedTables()

    const result = await resolve(defaultFake, proof)

    expect(result).toEqual({ status: 'refused', reason: 'identity_conflict' })
    expect(await watchedTables()).toEqual(before)
    expect(await linksFor(secondSubject)).toEqual([])
    expect((await linksFor(firstSubject)).map(link => link.user_id)).toEqual([userId])
  })

  it('row 6 refuses two case-variant accounts and a retired match', async () => {
    const local = uniqueLabel('row6-dup')
    await seedUser(`${local}@fixture.test`)
    await seedUser(`${local.toUpperCase()}@FIXTURE.test`)
    const retiredEmail = `${uniqueLabel('row6-retired')}@fixture.test`
    await retireUser(await seedUser(retiredEmail))
    const before = await watchedTables()

    const duplicateProof = await defaultFake.signIn({
      sub: uniqueLabel('row6-dup-subject'),
      email: `${local}@Fixture.Test`,
      email_verified: true,
    })
    expect(await resolve(defaultFake, duplicateProof)).toEqual({
      status: 'refused',
      reason: 'account_needs_attention',
    })

    const retiredProof = await defaultFake.signIn({
      sub: uniqueLabel('row6-retired-subject'),
      email: retiredEmail,
      email_verified: true,
    })
    expect(await resolve(defaultFake, retiredProof)).toEqual({
      status: 'refused',
      reason: 'account_needs_attention',
    })

    expect(await watchedTables()).toEqual(before)
  })

  it('row 7 refuses a proof without email and without link', async () => {
    const subject = uniqueLabel('row7-subject')
    const proof = await defaultFake.signIn({ sub: subject })
    expect(proof.attributes.email).toBeUndefined()
    const before = await watchedTables()

    const result = await resolve(defaultFake, proof)

    expect(result).toEqual({ status: 'refused', reason: 'email_claim_missing' })
    expect(await watchedTables()).toEqual(before)
    expect(await linksFor(subject)).toEqual([])
  })

  it('email_unverified when email_verified is false', async () => {
    const email = `${uniqueLabel('unverified')}@fixture.test`
    await seedUser(email)
    const before = await watchedTables()

    const proof = await defaultFake.signIn({
      sub: uniqueLabel('unverified-subject'),
      email,
      email_verified: false,
    })
    expect(await resolve(defaultFake, proof)).toEqual({
      status: 'refused',
      reason: 'email_unverified',
    })

    // An Entra guest without email_verified is unverified too (not missing_claim).
    const guests = entraFake('fake-entra-unverified-guest', {
      CONTROL_API_OIDC_REQUIRED_ROLE: MEMBER_ROLE,
      CONTROL_API_OIDC_ALLOW_GUESTS: 'true',
    })
    const guestProof = await guests.signIn({
      sub: uniqueLabel('unverified-guest-subject'),
      tid: ENTRA_TENANT_ID,
      roles: [MEMBER_ROLE],
      acct: 1,
      email: `${uniqueLabel('unverified-guest')}@guest.fixture.test`,
    })
    expect(guestProof.verifiedClaims.claims.email_verified).toEqual({ status: 'missing' })
    expect(await resolve(guests, guestProof)).toEqual({
      status: 'refused',
      reason: 'email_unverified',
    })

    expect(await watchedTables()).toEqual(before)
  })

  it('guests are not linked to an existing account by email', async () => {
    const fake = entraFake('fake-entra-guests', {
      CONTROL_API_OIDC_REQUIRED_ROLE: MEMBER_ROLE,
      CONTROL_API_OIDC_ALLOW_GUESTS: 'true',
    })
    const email = `${uniqueLabel('guest')}@guest.fixture.test`
    const userId = await seedUser(email)
    const subject = uniqueLabel('guest-subject')
    const memberClaims = {
      sub: subject,
      tid: ENTRA_TENANT_ID,
      roles: [MEMBER_ROLE],
      email,
      email_verified: true,
    }
    const before = await watchedTables()

    for (const guestMarker of [{ acct: 1 }, { idp: OTHER_TENANT_IDP }]) {
      const guestProof = await fake.signIn({ ...memberClaims, ...guestMarker })
      expect(await resolve(fake, guestProof)).toEqual({
        status: 'refused',
        reason: 'account_needs_attention',
      })
    }
    expect(await watchedTables()).toEqual(before)
    expect(await linksFor(subject)).toEqual([])

    // Positive control: the same identity without a guest marker links by email.
    const memberResult = await resolve(fake, await fake.signIn(memberClaims))
    expect(memberResult).toMatchObject({
      status: 'resolved',
      account: { userId, created: { account: false, link: true } },
      guest: false,
    })

    // Once linked, the guest signs in by link (row 1) and is reported as a guest.
    const linkedGuest = await resolve(fake, await fake.signIn({ ...memberClaims, acct: 1 }))
    expect(linkedGuest).toMatchObject({
      status: 'resolved',
      account: { userId, created: { account: false, link: false } },
      guest: true,
    })
  })

  it('an unknown new-member team refuses with provider_configuration and rolls back the user insert', async () => {
    const fake = entraFake('fake-entra-unknown-team', {
      CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: randomUUID(),
    })
    const subject = uniqueLabel('unknown-team-subject')
    const email = `${uniqueLabel('unknown-team')}@entra.fixture.test`
    const proof = await fake.signIn({
      sub: subject,
      tid: ENTRA_TENANT_ID,
      email,
      email_verified: true,
      name: 'Unknown Team Member',
    })
    const before = await watchedTables()

    const result = await resolve(fake, proof)

    expect(result).toEqual({ status: 'refused', reason: 'provider_configuration' })
    expect(await usersWithEmail(email)).toEqual([])
    expect(await linksFor(subject)).toEqual([])
    expect(await watchedTables()).toEqual(before)
  })

  it('a connection id reused with another issuer refuses with provider_configuration', async () => {
    await seedConnection(defaultFake.provider)
    const email = `${uniqueLabel('reused')}@fixture.test`
    await seedUser(email)
    const otherIssuer = createOidcMemberSignInFakeProvider({
      issuer: 'https://other-issuer.example.test/tenant',
    })
    const otherClient = createOidcMemberSignInFakeProvider({
      memberSignInEnv: { CONTROL_API_OIDC_CLIENT_ID: 'fake-member-sign-in-other-client' },
    })
    expect(otherIssuer.provider.registrationId).toBe(defaultFake.provider.registrationId)
    expect(otherClient.provider.registrationId).toBe(defaultFake.provider.registrationId)
    const before = await watchedTables()

    for (const fake of [otherIssuer, otherClient]) {
      const subject = uniqueLabel('reused-subject')
      const proof = await fake.signIn({ sub: subject, email, email_verified: true })
      expect(await resolve(fake, proof)).toEqual({
        status: 'refused',
        reason: 'provider_configuration',
      })
      expect(await linksFor(subject)).toEqual([])
    }

    expect(await watchedTables()).toEqual(before)
    const connection = await testPool.query(
      `SELECT issuer, client_id FROM oidc_connections WHERE id = $1`,
      [defaultFake.provider.registrationId]
    )
    expect(connection.rows).toEqual([
      { issuer: defaultFake.provider.issuer, client_id: defaultFake.provider.clientId },
    ])
    expect(await ensureOidcConnection(testPool, defaultFake.provider)).toBe('ok')
    expect(await ensureOidcConnection(testPool, otherIssuer.provider)).toBe('mismatch')
    expect(await ensureOidcConnection(testPool, otherClient.provider)).toBe('mismatch')

    // A proof minted under one configuration is never resolved against another.
    const foreignProof = await otherIssuer.signIn({ email, email_verified: true })
    await expect(
      withTransaction(
        db =>
          resolveOidcAccount(db, {
            proof: foreignProof,
            provider: defaultFake.provider,
            policy: policyOf(defaultFake),
          }),
        testPool
      )
    ).rejects.toThrow('OIDC identity proof was not issued for this provider configuration')
    expect(await watchedTables()).toEqual(before)
  })

  it('a parallel first sign-in that commits first leaves one account and one link', async () => {
    const fake = entraFake('fake-entra-race', {
      CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID: newMemberTeamId,
    })
    await seedConnection(fake.provider)

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
      throw new Error('the second resolution never waited on the first one')
    }

    /** The first resolution commits only after the second is blocked behind it. */
    async function race(subject: string, email: string) {
      const claims = { sub: subject, tid: ENTRA_TENANT_ID, email, email_verified: true }
      const [firstProof, secondProof] = [await fake.signIn(claims), await fake.signIn(claims)]
      const first = await testPool.connect()
      try {
        await first.query('BEGIN')
        const firstResult = await resolveOidcAccount(first as unknown as DbTransactionClient, {
          proof: firstProof,
          provider: fake.provider,
          policy: policyOf(fake),
        })
        const second = resolve(fake, secondProof)
        await waitForLockWaiter()
        await first.query('COMMIT')
        return { firstResult, secondResult: await second }
      } catch (error) {
        await first.query('ROLLBACK')
        throw error
      } finally {
        first.release()
      }
    }

    // Row 4: the second insert loses ON CONFLICT and re-reads the winner's link under the lock.
    const createdSubject = uniqueLabel('race-create-subject')
    const createdEmail = `${uniqueLabel('race-create')}@entra.fixture.test`
    const created = await race(createdSubject, createdEmail)
    expect(created.firstResult).toMatchObject({
      status: 'resolved',
      account: { created: { account: true, link: true } },
    })
    if (created.firstResult.status !== 'resolved') return
    const createdUserId = created.firstResult.account.userId
    expect(created.secondResult).toEqual({
      status: 'resolved',
      account: {
        userId: createdUserId,
        email: createdEmail,
        lifecycleState: 'active',
        lifecycleVersion: '1',
        created: { account: false, link: false },
      },
      guest: false,
    })
    expect(await usersWithEmail(createdEmail)).toHaveLength(1)
    expect(await linksFor(createdSubject)).toHaveLength(1)
    const memberships = await testPool.query(
      `SELECT 1 FROM team_members WHERE user_id = $1::uuid`,
      [createdUserId]
    )
    expect(memberships.rowCount).toBe(1)

    // Row 3: the second waits on the user row lock, then finds the winner's link.
    const linkedSubject = uniqueLabel('race-link-subject')
    const linkedEmail = `${uniqueLabel('race-link')}@entra.fixture.test`
    const linkedUserId = await seedUser(linkedEmail)
    const linked = await race(linkedSubject, linkedEmail)
    expect(linked.firstResult).toMatchObject({
      status: 'resolved',
      account: { userId: linkedUserId, created: { account: false, link: true } },
    })
    expect(linked.secondResult).toMatchObject({
      status: 'resolved',
      account: { userId: linkedUserId, created: { account: false, link: false } },
    })
    expect(await linksFor(linkedSubject)).toEqual([
      {
        connection_id: 'fake-entra-race',
        issuer: ENTRA_ISSUER,
        subject: linkedSubject,
        user_id: linkedUserId,
      },
    ])
  })

  it('refuses an ineligible proof with not_eligible before recording the connection', async () => {
    const fake = entraFake('fake-entra-ineligible')
    const email = `${uniqueLabel('ineligible')}@entra.fixture.test`
    await seedUser(email)
    const before = await watchedTables()

    const proof = await fake.signIn({
      sub: uniqueLabel('ineligible-subject'),
      tid: '11111111-2222-4333-8444-555555555555',
      email,
      email_verified: true,
    })
    expect(await resolve(fake, proof)).toEqual({ status: 'refused', reason: 'not_eligible' })

    expect(await watchedTables()).toEqual(before)
    const connection = await testPool.query(
      `SELECT 1 FROM oidc_connections WHERE id = 'fake-entra-ineligible'`
    )
    expect(connection.rowCount).toBe(0)
  })
})

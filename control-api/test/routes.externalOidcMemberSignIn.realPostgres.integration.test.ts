import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb, pool, withTransaction } from '../src/db.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
import {
  type InvitationPurpose,
  insertInvitationForTeams,
} from '../src/services/directory/invitationStore.js'
import { resendInvitation } from '../src/services/directory/membership.js'
import { createPasswordResetInvitation } from '../src/services/directory/passwordResetInvitations.js'
import type { InviteRole } from '../src/services/directory/types.js'
import { MemberRegistrationUnavailableError } from '../src/services/memberRegistrationErrors.js'
import { boundedBucketKey } from '../src/services/rateLimitBucketKey.js'
import { currentWindowStartMs } from '../src/services/rateLimiterService.js'
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

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const network = vi.hoisted(() => ({ lookup: vi.fn(), transport: vi.fn() }))

/**
 * The hub, which lives in another repository, stood in for at its in-repo
 * adapter. Every request is recorded with its body. A registration mints a
 * flow token for the invitation it registers, and validate answers a known
 * flow token with that invitation's email and local token, as the hub does.
 */
const hub = vi.hoisted(() => ({
  requests: [] as Array<{ path: string; body: Record<string, unknown>; flowToken?: string }>,
  flowTokens: new Map<string, { email: string; invitationUuid: string }>(),
  /** When set, every request throws it. */
  failure: null as Error | null,
}))

vi.mock('../src/memberRegistrationServiceClient.js', () => ({
  memberRegistrationServiceRequest: async (
    method: string,
    path: string,
    options: { body?: Record<string, unknown> }
  ) => {
    const body = options.body ?? {}
    const recorded: { path: string; body: Record<string, unknown>; flowToken?: string } = {
      path,
      body,
    }
    hub.requests.push(recorded)
    if (hub.failure) throw hub.failure
    if (path === '/invitations-flow/invitations') {
      recorded.flowToken = `fixture-hub-flow-token-${hub.requests.length}`
      hub.flowTokens.set(recorded.flowToken, {
        email: String(body.email),
        invitationUuid: String(body.invitationUuid),
      })
      return { sent: true, registered: true }
    }
    if (path === '/invitations-flow/validate') {
      const invitation = hub.flowTokens.get(String(body.token))
      // The adapter's own message for a hub 4xx.
      if (!invitation) {
        throw new Error(`Member registration service ${method} ${path} failed (400): invalid_token`)
      }
      return { valid: true, ...invitation }
    }
    throw new Error(`the fixture hub has no route for ${method} ${path}`)
  },
}))

vi.mock('node:dns/promises', () => ({ lookup: () => network.lookup() }))

vi.mock('../src/http/pinnedFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/pinnedFetch.js')>()
  return {
    ...actual,
    pinnedFetch: (url: string, field: string, options: PinnedFetchOptions = {}) =>
      actual.pinnedFetch(url, field, { ...options, transport: input => network.transport(input) }),
  }
})

// The route's default engine, sign-in and session authentication all use the
// module-level pool; point it at this suite's database.
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

const ENTRA_TENANT_ID = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ENTRA_ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`
const REGISTRATION_ID = 'fake-entra-route'
const GROUPS_REGISTRATION_ID = 'fake-groups-route'
const REQUIRED_GROUP = 'evenfire-users'
const WRITTEN_TABLES = ['users', 'user_oidc_links', 'oidc_connections', 'external_user_sessions']

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

/**
 * An Entra registration that creates accounts. The switch tests differ only in
 * the member sign-in switch and its guard; the eligibility tests add settings.
 * Eligibility needs the `tid` claim, so a sign-in also proves the route's
 * default engine collects it.
 */
function entraFake(
  memberSignIn: 'on' | 'off',
  env: Record<string, string> = {}
): OidcMemberSignInFakeProvider {
  return createOidcMemberSignInFakeProvider({
    issuer: ENTRA_ISSUER,
    memberSignInEnv: {
      CONTROL_API_OIDC_REGISTRATION_ID: REGISTRATION_ID,
      CONTROL_API_OIDC_TENANT_ID: ENTRA_TENANT_ID,
      ...(memberSignIn === 'off'
        ? { CONTROL_API_OIDC_MEMBER_SIGN_IN: undefined, CONTROL_API_OIDC_UNRELEASED: undefined }
        : {}),
      ...env,
    },
  })
}

/** The route reads its provider from process.env: exactly the fake's OIDC settings. */
function stubOidcEnvironment(env: Record<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONTROL_API_OIDC_') && !(name in env)) vi.stubEnv(name, undefined)
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

describeRealPostgres(
  'OIDC member sign-in through the Profile UI flow route on real PostgreSQL',
  () => {
    const database = `oidc_member_route_${randomBytes(6).toString('hex')}`
    let adminPool: Pool
    let testPool: Pool
    /** `control_api_runtime`, for the invitation rows: every statement the app runs there. */
    let runtimePool: Pool | undefined

    async function tableCounts(): Promise<Record<string, number>> {
      const counts: Record<string, number> = {}
      for (const table of WRITTEN_TABLES) {
        const result = await testPool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`
        )
        counts[table] = result.rows[0]!.n
      }
      return counts
    }

    async function attemptStatus(state: string): Promise<string | undefined> {
      const result = await testPool.query<{ status: string }>(
        `SELECT status FROM oidc_protocol_attempts WHERE state_hash = $1`,
        [createHash('sha256').update(state).digest('hex')]
      )
      return result.rows[0]?.status
    }

    /**
     * Begins and completes one attempt through the route with every default
     * dependency: the provider from process.env, the route's own engine and the
     * real member sign-in. `attemptBody` adds fields to the `/attempts` body.
     */
    async function completeThroughRoute(
      fake: OidcMemberSignInFakeProvider,
      claims: FakeIdTokenClaims,
      attemptBody: Record<string, unknown> = {}
    ) {
      stubOidcEnvironment(fake.env)
      const app = express()
      app.use(express.json())
      app.use(createExternalOidcProfileFlowRouter())
      const browserBinding = randomBytes(32).toString('base64url')

      const begun = await request(app)
        .post('/external/oidc/profile-flow/attempts')
        .send({ browserBinding, ...attemptBody })
      expect(begun.status).toBe(200)
      const callback = fake.authorize(begun.body.authorizationUrl, claims)
      const completed = await request(app)
        .post('/external/oidc/profile-flow/complete')
        .send({ ...callback, browserBinding })
      return { completed, state: callback.state }
    }

    function memberClaims(label: string) {
      const subject = uniqueLabel(`${label}-subject`)
      const email = `${uniqueLabel(label)}@entra.fixture.test`
      return {
        subject,
        email,
        claims: { sub: subject, tid: ENTRA_TENANT_ID, email, email_verified: true },
      }
    }

    beforeAll(async () => {
      if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
      adminPool = new Pool({ connectionString: adminUrl })
      await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
      testPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
      holder.pool = testPool
      await initDb({ connect: () => testPool.connect() })
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

    it('the switch off writes no users, links or connections rows and sets no session', async () => {
      const fake = entraFake('off')
      const member = memberClaims('switch-off')
      const before = await tableCounts()

      const { completed, state } = await completeThroughRoute(fake, member.claims)

      expect(completed.status).toBe(200)
      expect(completed.body).toEqual({
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: false,
      })
      expect(completed.headers['set-cookie']).toBeUndefined()
      // The path ran: the default engine verified the proof on this database.
      expect(await attemptStatus(state)).toBe('completed')
      expect(await tableCounts()).toEqual(before)
      const traces = await testPool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM users WHERE lower(email) = lower($1))
            + (SELECT count(*) FROM user_oidc_links WHERE subject = $2) AS n`,
        [member.email, member.subject]
      )
      expect(Number(traces.rows[0]!.n)).toBe(0)
    })

    it('the switch and guard on create a link and return member_signed_in', async () => {
      const fake = entraFake('on')
      const member = memberClaims('switch-on')
      const before = await tableCounts()

      const { completed, state } = await completeThroughRoute(fake, member.claims)

      expect(completed.status).toBe(200)
      expect(completed.body).toEqual({
        outcome: 'member_signed_in',
        memberAuthenticationActivated: true,
        token: expect.any(String),
        sessionContract: expect.stringMatching(/^v[12]$/),
      })
      expect(completed.headers['set-cookie']).toBeUndefined()
      expect(await attemptStatus(state)).toBe('completed')

      const link = await testPool.query<{ user_id: string; email: string }>(
        `SELECT l.user_id::text AS user_id, u.email
         FROM user_oidc_links l
         JOIN users u ON u.id = l.user_id
        WHERE l.connection_id = $1 AND l.issuer = $2 AND l.subject = $3`,
        [REGISTRATION_ID, ENTRA_ISSUER, member.subject]
      )
      expect(link.rows).toEqual([{ user_id: expect.any(String), email: member.email }])
      const after = await tableCounts()
      expect(after.users).toBe(before.users + 1)
      expect(after.user_oidc_links).toBe(before.user_oidc_links + 1)
      expect(after.oidc_connections).toBeGreaterThanOrEqual(1)

      const authentication = await authenticateExternalUserSession(completed.body.token, {
        purpose: 'protected',
        policy: await resolveEffectiveUserAccessPolicy(),
      })
      expect(authentication).toMatchObject({
        status: 'authenticated',
        contract: completed.body.sessionContract,
        claims: { userId: link.rows[0]!.user_id, email: member.email },
      })
    })

    /**
     * Completes one refused attempt through the route, then the same claims
     * with only `fixed` changed, which must sign in. The refusal must write
     * no row; the control proves the claims were otherwise eligible.
     */
    async function expectNotEligibleThenControl(
      fake: OidcMemberSignInFakeProvider,
      claims: FakeIdTokenClaims,
      fixed: FakeIdTokenClaims
    ) {
      const before = await tableCounts()

      const refused = await completeThroughRoute(fake, claims)

      expect(refused.completed.status).toBe(200)
      expect(refused.completed.body).toEqual({
        outcome: 'refused',
        memberAuthenticationActivated: true,
        reason: 'not_eligible',
      })
      // The path ran: the default engine verified the proof before the refusal.
      expect(await attemptStatus(refused.state)).toBe('completed')
      expect(await tableCounts()).toEqual(before)

      const control = await completeThroughRoute(fake, { ...claims, ...fixed })
      expect(control.completed.status).toBe(200)
      expect(control.completed.body).toMatchObject({ outcome: 'member_signed_in' })
      expect((await tableCounts()).users).toBe(before.users + 1)
    }

    it('33 roles under a required roles claim are not_eligible and write no row', async () => {
      const requiredRole = 'Evenfire.Member'
      // The claim name defaults to `roles`.
      const fake = entraFake('on', { CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE: requiredRole })
      const member = memberClaims('too-many-roles')
      const roles = (count: number) => [
        ...Array.from({ length: count - 1 }, (_, index) => `fixture-role-${index}`),
        requiredRole,
      ]

      await expectNotEligibleThenControl(
        fake,
        { ...member.claims, roles: roles(33) },
        { roles: roles(32) }
      )
    })

    it('an acct that is not the number 0 counts as a guest: not_eligible without ALLOW_GUESTS', async () => {
      const fake = entraFake('on')
      const member = memberClaims('string-acct')

      await expectNotEligibleThenControl(fake, { ...member.claims, acct: '0' }, { acct: 0 })
    })

    it('a foreign tid on an Entra provider is not_eligible and writes no row', async () => {
      const fake = entraFake('on')
      const member = memberClaims('foreign-tid')

      await expectNotEligibleThenControl(
        fake,
        { ...member.claims, tid: '0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c' },
        { tid: ENTRA_TENANT_ID }
      )
    })

    /**
     * A non-Entra registration that creates accounts and requires the `groups`
     * claim, as Okta sends it. Its registration id is its own: an id recorded
     * for the Entra issuer would be refused as connection_mismatch. A sign-in
     * proves the route's default engine collects the configured claim name.
     */
    function groupsFake(): OidcMemberSignInFakeProvider {
      return createOidcMemberSignInFakeProvider({
        memberSignInEnv: {
          CONTROL_API_OIDC_REGISTRATION_ID: GROUPS_REGISTRATION_ID,
          CONTROL_API_OIDC_ACCOUNT_CREATION: 'enabled',
          CONTROL_API_OIDC_REQUIRED_CLAIM_NAME: 'groups',
          CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE: REQUIRED_GROUP,
        },
      })
    }

    function groupsMemberClaims(label: string) {
      const subject = uniqueLabel(`${label}-subject`)
      const email = `${uniqueLabel(label)}@okta.fixture.test`
      return { subject, email, claims: { sub: subject, email, email_verified: true } }
    }

    it('signs in an Okta-style member whose groups claim holds the value', async () => {
      const fake = groupsFake()
      const member = groupsMemberClaims('groups-member')
      const before = await tableCounts()

      const { completed, state } = await completeThroughRoute(fake, {
        ...member.claims,
        groups: ['Everyone', REQUIRED_GROUP],
      })

      expect(completed.status).toBe(200)
      expect(completed.body).toEqual({
        outcome: 'member_signed_in',
        memberAuthenticationActivated: true,
        token: expect.any(String),
        sessionContract: expect.stringMatching(/^v[12]$/),
      })
      expect(await attemptStatus(state)).toBe('completed')
      const link = await testPool.query<{ email: string }>(
        `SELECT u.email
           FROM user_oidc_links l
           JOIN users u ON u.id = l.user_id
          WHERE l.connection_id = $1 AND l.issuer = $2 AND l.subject = $3`,
        [GROUPS_REGISTRATION_ID, fake.provider.issuer, member.subject]
      )
      expect(link.rows).toEqual([{ email: member.email }])
      const after = await tableCounts()
      expect(after.users).toBe(before.users + 1)
      expect(after.user_oidc_links).toBe(before.user_oidc_links + 1)
    })

    it('refuses a member whose groups claim lacks the value, then signs in with it', async () => {
      const member = groupsMemberClaims('groups-without-value')

      await expectNotEligibleThenControl(
        groupsFake(),
        { ...member.claims, groups: ['Everyone'] },
        { groups: [REQUIRED_GROUP] }
      )
    })

    it('refuses a member in 33 groups, then signs in with 32', async () => {
      const member = groupsMemberClaims('too-many-groups')
      // The value is in both lists, so only the 32-element cap differs.
      const groups = (count: number) => [
        ...Array.from({ length: count - 1 }, (_, index) => `fixture-group-${index}`),
        REQUIRED_GROUP,
      ]

      await expectNotEligibleThenControl(
        groupsFake(),
        { ...member.claims, groups: groups(33) },
        { groups: groups(32) }
      )
    })

    /**
     * Design §9: `/attempts` with the token of an invitation link. The hub is
     * the only stand-in; the route, its default hub check and bucket, the
     * context writer, the engine and member sign-in are the real ones. Every
     * statement the app runs goes through a pool whose connections start as
     * `control_api_runtime`, so the grants are part of what is proved.
     * Fixtures and reads use the owner pool.
     */
    describe('the invitation link through OIDC', () => {
      const ATTEMPTS_PATH = '/external/oidc/profile-flow/attempts'
      const INVITATION_WATCHED_TABLES = [
        'users',
        'profiles',
        'user_oidc_links',
        'oidc_connections',
        'team_members',
        'invitations',
        'external_user_sessions',
      ]
      /** The non-Entra default: account creation is off. */
      let fake: OidcMemberSignInFakeProvider

      beforeAll(async () => {
        // The role is a startup parameter, so it is set before the first
        // query on each connection. The suite's afterAll ends this pool.
        runtimePool = new Pool({
          connectionString: databaseUrl(adminUrl!, database),
          options: '-c role=control_api_runtime',
        })
        fake = createOidcMemberSignInFakeProvider()
        expect(fake.provider.memberSignIn?.accountCreation).toBe('disabled')
        // A refusal still records the connection; seeded, so every row below
        // can compare whole tables.
        await testPool.query(
          `INSERT INTO oidc_connections (id, issuer, client_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [fake.provider.registrationId, fake.provider.issuer, fake.provider.clientId]
        )
      })

      beforeEach(async () => {
        holder.pool = runtimePool!
        // Through the only two ways the app reaches the database: the mocked
        // db.js transaction and pool (rateLimitPool is the same proxy).
        const transactionRole = await withTransaction(db => db.query('SELECT current_user'))
        expect(transactionRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
        const poolRole = await pool.query<{ current_user: string }>('SELECT current_user')
        expect(poolRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
        hub.requests.length = 0
        hub.flowTokens.clear()
        hub.failure = null
      })

      afterEach(() => {
        holder.pool = testPool
      })

      function invitedAddress(label: string): string {
        return `${uniqueLabel(label)}@invitation.fixture.test`
      }

      async function seedTeam(label: string): Promise<string> {
        const result = await testPool.query<{ id: string }>(
          `INSERT INTO teams (name) VALUES ($1) RETURNING id::text AS id`,
          [uniqueLabel(label)]
        )
        return result.rows[0]!.id
      }

      /** A pending invitation written by the directory's own insert. */
      async function seedInvitation(input: {
        email: string
        teams: ReadonlyArray<{ teamId: string; role: InviteRole }>
        purpose?: InvitationPurpose
      }): Promise<{ id: string; email: string; token: string }> {
        const created = await insertInvitationForTeams(testPool, {
          inviteeName: 'Invited Member',
          email: input.email,
          teamAssignments: input.teams,
          purpose: input.purpose ?? 'member_invitation',
          status: 'pending',
        })
        const { id, email, token } = created.invitation
        return { id, email, token }
      }

      /** A flow token the hub validates for this row, as if it had sent the link. */
      function flowTokenFor(row: { email: string; token: string }): string {
        const flowToken = `fixture-seeded-flow-token-${randomBytes(6).toString('hex')}`
        hub.flowTokens.set(flowToken, { email: row.email, invitationUuid: row.token })
        return flowToken
      }

      function validateRequests() {
        return hub.requests.filter(entry => entry.path === '/invitations-flow/validate')
      }

      function stateOf(authorizationUrl: string): string {
        const state = new URL(authorizationUrl).searchParams.get('state')
        if (!state) throw new Error('authorization URL has no state')
        return state
      }

      /** Every column of the attempt's context rows (none for a plain attempt). */
      async function contextsOf(state: string): Promise<Array<Record<string, unknown>>> {
        const result = await testPool.query<{ context: Record<string, unknown> }>(
          `SELECT to_jsonb(c) AS context
             FROM oidc_attempt_sign_in_contexts c
             JOIN oidc_protocol_attempts a ON a.id = c.attempt_id
            WHERE a.state_hash = $1`,
          [createHash('sha256').update(state).digest('hex')]
        )
        return result.rows.map(row => row.context)
      }

      async function userCount(email: string): Promise<number> {
        const result = await testPool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)`,
          [email]
        )
        return result.rows[0]!.n
      }

      async function invitationStatus(id: string): Promise<string | undefined> {
        const result = await testPool.query<{ status: string }>(
          `SELECT status FROM invitations WHERE id = $1`,
          [id]
        )
        return result.rows[0]?.status
      }

      /** Row count and content digest of every table a refusal must leave untouched. */
      async function watchedTables(): Promise<Record<string, string>> {
        const snapshot: Record<string, string> = {}
        for (const table of INVITATION_WATCHED_TABLES) {
          const result = await testPool.query<{ n: number; digest: string }>(
            `SELECT count(*)::int AS n,
                    md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
               FROM ${table} t`
          )
          snapshot[table] = `${result.rows[0]!.n}:${result.rows[0]!.digest}`
        }
        return snapshot
      }

      function claimsFor(email: string) {
        return { sub: uniqueLabel('invited-subject'), email, email_verified: true }
      }

      it('creates the invited account through the routes while creation is off', async () => {
        const firstTeamId = await seedTeam('invited-first-team')
        const secondTeamId = await seedTeam('invited-second-team')
        const address = invitedAddress('invited')
        const invitation = await seedInvitation({
          email: address,
          teams: [
            { teamId: firstTeamId, role: 'member' },
            { teamId: secondTeamId, role: 'inviter' },
          ],
        })
        // The directory's insert lower-cases; a row from before that rule
        // keeps the address as typed.
        const mixedCase = `Invited.${address}`.replace('invitation.fixture', 'Invitation.Fixture')
        await testPool.query(`UPDATE invitations SET email = $2 WHERE id = $1`, [
          invitation.id,
          mixedCase,
        ])
        expect(mixedCase).not.toBe(mixedCase.toLowerCase())
        const flowToken = flowTokenFor({ email: mixedCase, token: invitation.token })
        const claims = claimsFor(mixedCase.toLowerCase())

        const { completed, state } = await completeThroughRoute(fake, claims, {
          invitationToken: flowToken,
        })

        expect(validateRequests().map(entry => entry.body.token)).toEqual([flowToken])
        const contexts = await contextsOf(state)
        expect(contexts).toEqual([
          {
            attempt_id: expect.any(String),
            context_kind: 'invitation',
            desktop_code_challenge: null,
            invitation_id: invitation.id,
            invited_email: mixedCase.toLowerCase(),
            created_at: expect.any(String),
          },
        ])
        // The token is never stored: no column holds it.
        expect(Object.values(contexts[0]!)).not.toContain(flowToken)
        expect(JSON.stringify(contexts)).not.toContain(flowToken)

        expect(completed.status).toBe(200)
        expect(completed.body).toEqual({
          outcome: 'member_signed_in',
          memberAuthenticationActivated: true,
          token: expect.any(String),
          sessionContract: expect.stringMatching(/^v[12]$/),
        })
        const created = await testPool.query<{ id: string }>(
          `SELECT id::text AS id FROM users WHERE email = $1`,
          [mixedCase.toLowerCase()]
        )
        expect(created.rows).toHaveLength(1)
        const memberships = await testPool.query<{ team_id: string; role: string }>(
          `SELECT team_id::text AS team_id, role FROM team_members
            WHERE user_id = $1::uuid AND status = 'active' ORDER BY role`,
          [created.rows[0]!.id]
        )
        expect(memberships.rows).toEqual([
          { team_id: secondTeamId, role: 'inviter' },
          { team_id: firstTeamId, role: 'member' },
        ])
        expect(await invitationStatus(invitation.id)).toBe('accepted')
      })

      it('gives a resent admin_desktop_access invitation no context', async () => {
        const teamId = await seedTeam('resent-team')
        const adminAddress = invitedAddress('resent-admin-access')
        const adminInvitation = await seedInvitation({
          email: adminAddress,
          teams: [{ teamId, role: 'member' }],
          purpose: 'admin_desktop_access',
        })

        expect(await resendInvitation(teamId, adminInvitation.id)).toMatchObject({
          id: adminInvitation.id,
        })
        // The hub registers it as a member invitation: only the local row says otherwise.
        const registration = hub.requests.at(-1)!
        expect(registration).toMatchObject({
          path: '/invitations-flow/invitations',
          body: {
            email: adminAddress,
            invitationUuid: adminInvitation.token,
            purpose: 'member_invitation',
          },
        })
        const { completed, state } = await completeThroughRoute(fake, claimsFor(adminAddress), {
          invitationToken: registration.flowToken,
        })

        expect(validateRequests()).toHaveLength(1)
        expect(await contextsOf(state)).toEqual([])
        expect(completed.status).toBe(200)
        expect(completed.body).toEqual({
          outcome: 'refused',
          memberAuthenticationActivated: true,
          reason: 'no_account',
        })
        expect(await userCount(adminAddress)).toBe(0)

        // Control: a member invitation resent the same way gets its context.
        const memberAddress = invitedAddress('resent-member')
        const memberInvitation = await seedInvitation({
          email: memberAddress,
          teams: [{ teamId, role: 'member' }],
        })
        await resendInvitation(teamId, memberInvitation.id)
        const control = await completeThroughRoute(fake, claimsFor(memberAddress), {
          invitationToken: hub.requests.at(-1)!.flowToken,
        })
        expect(await contextsOf(control.state)).toMatchObject([
          { context_kind: 'invitation', invitation_id: memberInvitation.id },
        ])
      })

      it('gives a password reset no context', async () => {
        const address = invitedAddress('password-reset')
        await testPool.query(`INSERT INTO users (email, name) VALUES ($1, 'Reset Member')`, [
          address,
        ])
        // Through the directory's own reset path, which registers it with the hub.
        const reset = await createPasswordResetInvitation({
          email: address,
          inviteeName: 'Reset Member',
        })
        const registration = hub.requests.at(-1)!
        expect(registration).toMatchObject({
          path: '/invitations-flow/invitations',
          body: { invitationUuid: reset.token, purpose: 'password_reset' },
        })
        stubOidcEnvironment(fake.env)
        const app = express()
        app.use(express.json())
        app.use(createExternalOidcProfileFlowRouter())

        const begun = await request(app)
          .post(ATTEMPTS_PATH)
          .send({
            browserBinding: randomBytes(32).toString('base64url'),
            invitationToken: registration.flowToken,
          })

        expect(begun.status).toBe(200)
        expect(begun.body).toEqual({
          authorizationUrl: expect.any(String),
          expiresAt: expect.any(String),
        })
        // The hub was asked, and accepted the token.
        expect(validateRequests().map(entry => entry.body.token)).toEqual([registration.flowToken])
        expect(await contextsOf(stateOf(begun.body.authorizationUrl))).toEqual([])
        expect(await invitationStatus(reset.id)).toBe('pending')
      })

      it('falls back to a plain attempt on a hub failure, which gets no exception', async () => {
        const teamId = await seedTeam('hub-failure-team')
        const address = invitedAddress('hub-failure')
        const invitation = await seedInvitation({
          email: address,
          teams: [{ teamId, role: 'member' }],
        })
        const flowToken = flowTokenFor(invitation)
        hub.failure = new MemberRegistrationUnavailableError('fixture: hub unreachable')

        const { completed, state } = await completeThroughRoute(fake, claimsFor(address), {
          invitationToken: flowToken,
        })

        expect(validateRequests().map(entry => entry.body.token)).toEqual([flowToken])
        expect(await contextsOf(state)).toEqual([])
        expect(completed.status).toBe(200)
        expect(completed.body).toEqual({
          outcome: 'refused',
          memberAuthenticationActivated: true,
          reason: 'no_account',
        })
        expect(await userCount(address)).toBe(0)
        expect(await invitationStatus(invitation.id)).toBe('pending')
      })

      it('gives the 31st invitation attempt in a minute from one client a plain attempt, counted in Postgres', async () => {
        // One fixed window for all 31 requests (currentWindowStartMs).
        const leftInWindow = 60_000 - (Date.now() % 60_000)
        if (leftInWindow < 15_000) {
          await new Promise(resolve => setTimeout(resolve, leftInWindow + 50))
        }
        const windowStart = currentWindowStartMs()
        const teamId = await seedTeam('bucket-team')
        const invitation = await seedInvitation({
          email: invitedAddress('bucket'),
          teams: [{ teamId, role: 'member' }],
        })
        const flowToken = flowTokenFor(invitation)
        stubOidcEnvironment(fake.env)
        // One route set for every request, as in the running service.
        const app = express()
        app.use(express.json())
        app.use(createExternalOidcProfileFlowRouter())
        const begin = async (clientIp: string) => {
          const response = await request(app)
            .post(ATTEMPTS_PATH)
            .set('x-external-client-ip', clientIp)
            .send({
              browserBinding: randomBytes(32).toString('base64url'),
              invitationToken: flowToken,
            })
          expect(response.status).toBe(200)
          expect(response.body).toEqual({
            authorizationUrl: expect.any(String),
            expiresAt: expect.any(String),
          })
          return stateOf(response.body.authorizationUrl)
        }

        const states: string[] = []
        for (let index = 0; index < 31; index += 1) states.push(await begin('198.51.100.31'))

        expect(validateRequests()).toHaveLength(30)
        for (const state of states.slice(0, 30)) {
          expect(await contextsOf(state)).toHaveLength(1)
        }
        expect(await contextsOf(states[30]!)).toEqual([])
        const bucket = await testPool.query<{ count: number }>(
          `SELECT count FROM rate_limit_buckets WHERE bucket_key = $1 AND window_start_ms = $2`,
          [boundedBucketKey(`oidc-invitation-hub:${ipKeyGenerator('198.51.100.31')}`), windowStart]
        )
        expect(bucket.rows).toEqual([{ count: 31 }])

        // Positive control: another client is still checked.
        const other = await begin('198.51.100.32')
        expect(validateRequests()).toHaveLength(31)
        expect(await contextsOf(other)).toHaveLength(1)
        // Every request fell in the window the bucket was read for.
        expect(currentWindowStartMs()).toBe(windowStart)
      }, 60_000)

      it('refuses a provider email that is not the invited one, end to end, and writes nothing', async () => {
        const teamId = await seedTeam('mismatch-team')
        const alice = invitedAddress('alice')
        const bob = invitedAddress('bob')
        const invitation = await seedInvitation({
          email: alice,
          teams: [{ teamId, role: 'member' }],
        })
        const flowToken = flowTokenFor(invitation)
        const before = await watchedTables()

        const { completed, state } = await completeThroughRoute(fake, claimsFor(bob), {
          invitationToken: flowToken,
        })

        expect(completed.status).toBe(200)
        expect(completed.body).toEqual({
          outcome: 'refused',
          memberAuthenticationActivated: true,
          reason: 'invitation_email_mismatch',
        })
        // The path ran: the attempt carried the invitation, and the proof was verified.
        expect(await contextsOf(state)).toMatchObject([
          { context_kind: 'invitation', invitation_id: invitation.id, invited_email: alice },
        ])
        expect(await attemptStatus(state)).toBe('completed')
        expect(await watchedTables()).toEqual(before)
        expect(await userCount(alice)).toBe(0)
        expect(await userCount(bob)).toBe(0)
        expect(await invitationStatus(invitation.id)).toBe('pending')
      })
    })
  }
)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
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
     * real member sign-in.
     */
    async function completeThroughRoute(
      fake: OidcMemberSignInFakeProvider,
      claims: FakeIdTokenClaims
    ) {
      stubOidcEnvironment(fake.env)
      const app = express()
      app.use(express.json())
      app.use(createExternalOidcProfileFlowRouter())
      const browserBinding = randomBytes(32).toString('base64url')

      const begun = await request(app)
        .post('/external/oidc/profile-flow/attempts')
        .send({ browserBinding })
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
  }
)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import request from 'supertest'
import { type DbTransactionClient, initDb, pool, withTransaction } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import type { PinnedFetchOptions } from '../src/http/pinnedFetch.js'
import {
  type ExternalOidcDesktopSignInDependencies,
  createExternalOidcDesktopSignInRouter,
} from '../src/routes/external/oidcDesktopSignIn.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { authenticateExternalUserSession } from '../src/services/auth/externalSessionAuthentication.js'
import { s256Challenge } from '../src/services/auth/oidcDesktopSignInCode.js'
import { redeemDesktopSignInCode } from '../src/services/auth/oidcDesktopSignInRedeem.js'
import { insertInvitationForTeams } from '../src/services/directory/invitationStore.js'
import { findFirstActiveMembership } from '../src/services/directory/login.js'
import { acceptInvitationForEmail, softDeleteMember } from '../src/services/directory/membership.js'
import type { InviteRole } from '../src/services/directory/types.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import {
  type ContractRecord,
  expectContractFile,
  normalizeContractBody,
} from './helpers/contractFixture.js'
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
 * Evenfire Desktop's browser sign-in through the real routes, end to end:
 * `/attempts` with a Desktop code challenge, the fake provider's callback,
 * `/complete` minting a one-use code, and redeem trading it with the PKCE
 * verifier for a session. Every statement the app runs goes through a pool
 * whose connections start as `control_api_runtime`, so the grants are part of
 * what is proved. Fixtures and the writes production never makes (an expired
 * code, a reactivated account, a security cutoff) use the admin pool.
 */

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))
const network = vi.hoisted(() => ({ lookup: vi.fn(), transport: vi.fn() }))
const accessPolicy = vi.hoisted(() => ({ resolve: vi.fn() }))
/** Every call to the root logger and to any logger derived from it, with the child bindings. */
const logs = vi.hoisted(() => ({
  records: [] as Array<{ bindings: Record<string, unknown>; level: string; args: unknown[] }>,
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

// The routes' default engine, sign-in, context write, redeem and the directory
// services all use the module-level pool; point it at this suite's runtime pool.
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

// The access policy is a process constant compiled from config; the 426 and
// Profile-selection rows swap it per request.
vi.mock('../src/services/access/userAccessRuntimePolicy.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/access/userAccessRuntimePolicy.js')>()),
  resolveEffectiveUserAccessPolicy: accessPolicy.resolve,
}))

// Records every level call on the root logger and on every child, at any
// depth, so a value logged by any part of the chain is seen.
vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  const levels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  function recording<L extends object>(target: L, bindings: Record<string, unknown>): L {
    return new Proxy(target, {
      get(inner, prop, receiver) {
        if (typeof prop === 'string' && levels.has(prop)) {
          return (...args: unknown[]) => {
            logs.records.push({ bindings, level: prop, args })
          }
        }
        if (prop === 'child') {
          return (childBindings: Record<string, unknown>, options?: object) =>
            recording(
              (inner as unknown as typeof actual.rootLogger).child(childBindings, options),
              { ...bindings, ...childBindings }
            )
        }
        return Reflect.get(inner, prop, receiver)
      },
    })
  }
  return { ...actual, rootLogger: recording(actual.rootLogger, {}) }
})

const SESSION_POLICY: EffectiveUserAccessPolicy = Object.freeze({
  policyVersion: '1',
  policyRevision: 'oidc-desktop-sign-in-route-fixture',
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

/** No session format can be selected for a client that requests none. */
const NO_V1_ISSUANCE_POLICY: EffectiveUserAccessPolicy = Object.freeze({
  ...SESSION_POLICY,
  policyRevision: 'oidc-desktop-sign-in-route-no-v1-fixture',
  issueV1: false,
})

beforeEach(() => {
  network.lookup
    .mockReset()
    .mockResolvedValue([{ address: OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP, family: 4 }])
  network.transport.mockReset().mockImplementation(input => oidcMemberSignInFakeTransport(input))
  accessPolicy.resolve.mockReset().mockResolvedValue(SESSION_POLICY)
  logs.records.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const CONFIGURATION_PATH = '/external/oidc/profile-flow/configuration'
const ATTEMPTS_PATH = '/external/oidc/profile-flow/attempts'
const COMPLETE_PATH = '/external/oidc/profile-flow/complete'
const REDEEM_PATH = '/external/oidc/desktop-sign-in/redeem'
const DESKTOP_CODE_RE = /^[A-Za-z0-9_-]{43}$/
const MEMBER_NAME = 'Desktop Fixture Member'
const TEAM_NAME = 'Desktop Sign-In Team'
const SECOND_TEAM_NAME = 'Desktop Second Team'
const OLDEST_TEAM_NAME = 'Desktop Oldest Team'
const LATE_TEAM_NAME = 'Desktop Late Team'
const ADMIN_ACTOR_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
/** The answers only the real chain gives, which the edge's contract test replays. */
const CONTRACT_FILE = fileURLToPath(
  new URL('./fixtures/oidc-desktop-sign-in/control-api.realPostgres.json', import.meta.url)
)

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** An RFC 7636 code verifier: 43 random base64url characters. */
function randomVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** The route reads its provider from process.env: exactly the fake's OIDC settings. */
function stubOidcEnvironment(env: Record<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONTROL_API_OIDC_') && !(name in env)) vi.stubEnv(name, undefined)
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

/** Attaches the outcome handler at once, so a request that fails while the test waits elsewhere is not an unhandled rejection. */
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

/** The attempt, the callback and the routes' answers, kept for the recorded contract bodies. */
type ChainSignIn = {
  begun: request.Response
  completed: request.Response
  state: string
}

type DesktopChainSignIn = ChainSignIn & { code: string; verifier: string; challenge: string }

type Member = { userId: string; email: string; claims: FakeIdTokenClaims }

describeRealPostgres('Desktop sign-in through the routes on real PostgreSQL', () => {
  const database = `oidc_desktop_route_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let ownerPool: Pool
  let runtimePool: Pool
  /** The one provider every row signs in with, unless the row changes its settings. */
  const desktopFake = createOidcMemberSignInFakeProvider()
  /** Route answers recorded by the rows below, by contract record key; the last row writes them. */
  const contract: Record<string, ContractRecord> = {}

  function recordContract(key: string, response: request.Response): void {
    contract[key] = { status: response.status, body: normalizeContractBody(response.body) }
  }

  /** The profile-flow and redeem routers, with the shared error handler. */
  function chainApp(redeemDependencies: ExternalOidcDesktopSignInDependencies = {}) {
    const app = express()
    app.use(express.json())
    app.use(createExternalOidcProfileFlowRouter())
    app.use(createExternalOidcDesktopSignInRouter(redeemDependencies))
    app.use(clerumErrorHandler)
    return app
  }

  /**
   * Begins and completes one attempt through the route with every default
   * dependency: the provider from process.env, the route's own engine and the
   * real member sign-in.
   */
  async function signInThroughRoute(
    fake: OidcMemberSignInFakeProvider,
    claims: FakeIdTokenClaims,
    desktopSignIn?: { codeChallenge: string }
  ): Promise<ChainSignIn> {
    stubOidcEnvironment(fake.env)
    const app = chainApp()
    const browserBinding = randomBytes(32).toString('base64url')
    const begun = await request(app)
      .post(ATTEMPTS_PATH)
      .send({ browserBinding, ...(desktopSignIn ? { desktopSignIn } : {}) })
    expect(begun.status).toBe(200)
    const callback = fake.authorize(begun.body.authorizationUrl, claims)
    const completed = await request(app)
      .post(COMPLETE_PATH)
      .send({ ...callback, browserBinding })
    return { begun, completed, state: callback.state }
  }

  /** A Desktop attempt with a fresh verifier, completed to its one-use code. */
  async function desktopCodeThroughRoute(
    member: Member,
    fake: OidcMemberSignInFakeProvider = desktopFake
  ): Promise<DesktopChainSignIn> {
    const verifier = randomVerifier()
    const challenge = s256Challenge(verifier)
    const signIn = await signInThroughRoute(fake, member.claims, { codeChallenge: challenge })
    expect(signIn.begun.body).toEqual({
      authorizationUrl: expect.any(String),
      expiresAt: expect.any(String),
      signInContext: 'desktop_sign_in',
    })
    expect(signIn.completed.status).toBe(200)
    expect(signIn.completed.body).toEqual({
      outcome: 'desktop_code_issued',
      memberAuthenticationActivated: true,
      code: expect.stringMatching(DESKTOP_CODE_RE),
      expiresInSeconds: 90,
    })
    return { ...signIn, code: signIn.completed.body.code, verifier, challenge }
  }

  function redeem(code: string, codeVerifier: string, extra: Record<string, unknown> = {}) {
    return request(chainApp())
      .post(REDEEM_PATH)
      .send({ code, codeVerifier, ...extra })
  }

  /** A member with a fixed name and a fixed email per row, linked by the sign-in. */
  async function seedMember(label: string): Promise<Member> {
    const email = `${label}@desktop.fixture.test`
    const created = await ownerPool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id::text AS id`,
      [email, MEMBER_NAME]
    )
    return {
      userId: created.rows[0]!.id,
      email,
      claims: { sub: `${label}-subject`, email, email_verified: true },
    }
  }

  async function seedTeam(name: string): Promise<string> {
    const created = await ownerPool.query<{ id: string }>(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id::text AS id`,
      [name]
    )
    return created.rows[0]!.id
  }

  async function seedMembership(
    teamId: string,
    userId: string,
    role: InviteRole,
    createdAgo = '1 hour'
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'active', now() - $4::interval)`,
      [teamId, userId, role, createdAgo]
    )
  }

  /** A pending invitation written by the directory's own invitation insert. */
  async function seedInvitation(email: string, teamId: string, role: InviteRole) {
    const created = await insertInvitationForTeams(ownerPool, {
      inviteeName: MEMBER_NAME,
      email,
      teamAssignments: [{ teamId, role }],
      purpose: 'member_invitation',
      status: 'pending',
    })
    return { id: created.invitation.id, token: created.invitation.token }
  }

  /** Joins a team the way a member does: an invitation, accepted by the directory as the app. */
  async function acceptInvitationAs(member: Member, teamId: string, role: InviteRole) {
    const invitation = await seedInvitation(member.email, teamId, role)
    const accepted = await acceptInvitationForEmail(member.email, invitation.token)
    expect(accepted).toMatchObject({ data: { userId: member.userId } })
  }

  /** The team the shared default-team rule (password login's) picks for the member. */
  async function firstRankedTeam(userId: string): Promise<string | undefined> {
    const ranked = await findFirstActiveMembership(ownerPool, userId)
    return (ranked.rows[0] as { team_id: string } | undefined)?.team_id
  }

  type StoredCode = { user_id: string; team_id: string | null; code_challenge: string }

  /** The stored row of a minted code, found by the hash the test computes itself. */
  async function storedCode(code: string): Promise<StoredCode | undefined> {
    const result = await ownerPool.query<StoredCode>(
      `SELECT user_id::text AS user_id, team_id::text AS team_id, code_challenge
         FROM oidc_desktop_sign_in_codes
        WHERE code_hash = $1`,
      [sha256Hex(code)]
    )
    return result.rows[0]
  }

  async function codesOf(userId: string): Promise<number> {
    const result = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM oidc_desktop_sign_in_codes WHERE user_id = $1::uuid`,
      [userId]
    )
    return result.rows[0]!.n
  }

  /** The sign-in contexts recorded for the attempt with this state. */
  async function contextsOf(state: string): Promise<Array<Record<string, unknown>>> {
    const result = await ownerPool.query(
      `SELECT c.context_kind, c.desktop_code_challenge
         FROM oidc_attempt_sign_in_contexts c
         JOIN oidc_protocol_attempts a ON a.id = c.attempt_id
        WHERE a.state_hash = $1`,
      [sha256Hex(state)]
    )
    return result.rows
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM external_user_sessions
        WHERE user_id = $1::uuid AND revoked_at IS NULL`,
      [userId]
    )
    return result.rows[0]!.n
  }

  /** The member's row returned to active, as no production path does. */
  async function reactivate(userId: string): Promise<void> {
    const updated = await ownerPool.query(
      `UPDATE users
          SET lifecycle_state = 'active',
              retired_at = NULL,
              retirement_reason = NULL,
              retired_by_type = NULL,
              retired_by_control_admin_id = NULL,
              retired_by_desktop_user_id = NULL,
              retirement_request_id = NULL,
              retirement_operation_id = NULL,
              lifecycle_version = lifecycle_version + 1,
              updated_at = now()
        WHERE id = $1::uuid AND lifecycle_state = 'retired'`,
      [userId]
    )
    expect(updated.rowCount).toBe(1)
  }

  async function retire(member: Member, label: string): Promise<void> {
    const retirement = await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: ADMIN_ACTOR_ID },
      member.userId,
      'retired after a Desktop sign-in code was minted',
      `${label}-idempotency-key`,
      `${label}-request`
    )
    // Retained, not deleted: a deleted user would cascade the code row away.
    expect(retirement).toMatchObject({ id: member.userId, outcome: 'retired' })
  }

  /** The first argument of every recorded log call that names this event. */
  function loggedEvents(event: string): Array<Record<string, unknown>> {
    return logs.records
      .map(record => record.args[0])
      .filter(
        (first): first is Record<string, unknown> =>
          typeof first === 'object' &&
          first !== null &&
          (first as { event?: unknown }).event === event
      )
  }

  /** Every recorded log call, its bindings and Error objects expanded. */
  function loggedText(): string {
    return JSON.stringify(logs.records, (_key, value) =>
      value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value
    )
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
    throw new Error('the second redeem never waited on the first one')
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    ownerPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    holder.pool = ownerPool
    await initDb({ connect: () => ownerPool.connect() })

    // The role is a startup parameter, so it is set before the first query on
    // each connection. Every statement the app runs from here uses this pool.
    runtimePool = new Pool({
      connectionString: databaseUrl(adminUrl, database),
      options: '-c role=control_api_runtime',
    })
    holder.pool = runtimePool
    const role = await runtimePool.query<{ current_user: string }>('SELECT current_user')
    expect(role.rows).toEqual([{ current_user: 'control_api_runtime' }])
    await expect(
      runtimePool.query('UPDATE oidc_desktop_sign_in_codes SET team_id = NULL')
    ).rejects.toMatchObject({ code: '42501' })
    // The same, through the only two ways the app reaches the database: the
    // mocked db.js transaction and pool. Both read holder.pool, so a suite that
    // stopped pointing it at the runtime pool would run every row as the owner.
    const transactionRole = await withTransaction(db => db.query('SELECT current_user'))
    expect(transactionRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
    const poolRole = await pool.query<{ current_user: string }>('SELECT current_user')
    expect(poolRole.rows).toEqual([{ current_user: 'control_api_runtime' }])
    await expect(
      withTransaction(db => db.query('UPDATE oidc_desktop_sign_in_codes SET team_id = NULL'))
    ).rejects.toMatchObject({ code: '42501' })

    await ownerPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, 'oidc-desktop-sign-in-actor', 'fixture-password-hash', 'admin', 'active')`,
      [ADMIN_ACTOR_ID]
    )
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(runtimePool)
      await endPoolAndWaitForClients(ownerPool)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  it('signs a plain Profile attempt in as before', async () => {
    const member = await seedMember('desktop-plain')
    const team = await seedTeam(TEAM_NAME)
    await seedMembership(team, member.userId, 'member')
    // What Profile UI reads before it starts an attempt.
    stubOidcEnvironment(desktopFake.env)
    const configuration = await request(chainApp()).get(CONFIGURATION_PATH)
    expect(configuration.status).toBe(200)
    expect(configuration.body).toEqual({
      redirectUri: desktopFake.provider.redirectUri,
      memberAuthenticationActivated: true,
      displayLabel: desktopFake.provider.displayLabel,
    })

    const { begun, completed, state } = await signInThroughRoute(desktopFake, member.claims)

    expect(begun.body).toEqual({
      authorizationUrl: expect.any(String),
      expiresAt: expect.any(String),
    })
    expect(completed.status).toBe(200)
    expect(completed.body).toEqual({
      outcome: 'member_signed_in',
      memberAuthenticationActivated: true,
      token: expect.any(String),
      sessionContract: 'v1',
    })
    // No context and no code: the plain attempt is the sign-in it always was.
    expect(await contextsOf(state)).toEqual([])
    expect(await codesOf(member.userId)).toBe(0)
    expect(
      await authenticateExternalUserSession(completed.body.token, {
        purpose: 'protected',
        policy: SESSION_POLICY,
      })
    ).toMatchObject({
      status: 'authenticated',
      contract: 'v1',
      claims: { userId: member.userId, email: member.email, teamId: team },
    })
    recordContract('GET /external/oidc/profile-flow/configuration activated', configuration)
    recordContract('POST /external/oidc/profile-flow/attempts plain', begun)
    recordContract('POST /external/oidc/profile-flow/complete member-signed-in', completed)
  })

  it('mints at /complete and redeems once for { token, me }', async () => {
    const member = await seedMember('desktop-mint')
    const team = await seedTeam(TEAM_NAME)
    await seedInvitation(member.email, team, 'member')

    const minted = await desktopCodeThroughRoute(member)

    expect(await contextsOf(minted.state)).toEqual([
      { context_kind: 'desktop_sign_in', desktop_code_challenge: minted.challenge },
    ])
    // The team member sign-in chose: the teamless member lands in the team of
    // the invitation the sign-in applied, and the code records it.
    expect(await storedCode(minted.code)).toEqual({
      user_id: member.userId,
      team_id: team,
      code_challenge: minted.challenge,
    })

    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toEqual({
      token: expect.any(String),
      sessionContract: 'v1',
      me: {
        id: member.userId,
        email: member.email,
        name: MEMBER_NAME,
        picture: null,
        teamId: team,
        teamName: TEAM_NAME,
        role: 'member',
      },
    })
    expect(await storedCode(minted.code)).toBeUndefined()
    expect(
      await authenticateExternalUserSession(redeemed.body.token, {
        purpose: 'protected',
        policy: SESSION_POLICY,
      })
    ).toMatchObject({
      status: 'authenticated',
      contract: 'v1',
      claims: { userId: member.userId, email: member.email, teamId: team },
    })
    recordContract('POST /external/oidc/profile-flow/attempts desktop-echo', minted.begun)
    recordContract(
      'POST /external/oidc/profile-flow/complete desktop-code-issued',
      minted.completed
    )
    recordContract('POST /external/oidc/desktop-sign-in/redeem signed-in', redeemed)
  })

  it('leaves the code redeemable after a wrong verifier', async () => {
    const member = await seedMember('desktop-wrong-verifier')
    const minted = await desktopCodeThroughRoute(member)

    const refused = await redeem(minted.code, randomVerifier())

    expect(refused.status).toBe(400)
    expect(refused.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
    expect(await storedCode(minted.code)).toMatchObject({ user_id: member.userId })
    expect(loggedEvents('oidc_desktop_code_verifier_mismatch')).toHaveLength(1)

    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toMatchObject({ token: expect.any(String), me: { id: member.userId } })
    expect(await storedCode(minted.code)).toBeUndefined()
  })

  it('refuses an expired code', async () => {
    const member = await seedMember('desktop-expired')
    const minted = await desktopCodeThroughRoute(member)
    const expired = await ownerPool.query(
      `UPDATE oidc_desktop_sign_in_codes
          SET expires_at = now() - interval '1 second'
        WHERE code_hash = $1`,
      [sha256Hex(minted.code)]
    )
    expect(expired.rowCount).toBe(1)

    const refused = await redeem(minted.code, minted.verifier)

    expect(refused.status).toBe(400)
    expect(refused.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
    // Redeem never took it: the right verifier on a live code is not what failed.
    expect(await storedCode(minted.code)).toMatchObject({ user_id: member.userId })
    expect(loggedEvents('oidc_desktop_code_verifier_mismatch')).toEqual([])
  })

  it('refuses a second redeem', async () => {
    const member = await seedMember('desktop-second-redeem')
    const minted = await desktopCodeThroughRoute(member)

    const first = await redeem(minted.code, minted.verifier)
    const second = await redeem(minted.code, minted.verifier)

    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ token: expect.any(String), me: { id: member.userId } })
    expect(second.status).toBe(400)
    expect(second.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
  })

  it('answers 409 and spends the code when member sign-in is switched off after mint', async () => {
    const member = await seedMember('desktop-switch-off')
    const minted = await desktopCodeThroughRoute(member)
    const switchedOff = createOidcMemberSignInFakeProvider({
      memberSignInEnv: {
        CONTROL_API_OIDC_MEMBER_SIGN_IN: undefined,
        CONTROL_API_OIDC_UNRELEASED: undefined,
      },
    })
    // Only the switch differs: it is not part of the configuration generation.
    expect(switchedOff.provider.memberAuthenticationActivated).toBe(false)
    expect(switchedOff.provider.configurationGeneration).toBe(
      desktopFake.provider.configurationGeneration
    )
    stubOidcEnvironment(switchedOff.env)

    const refused = await redeem(minted.code, minted.verifier)

    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(await storedCode(minted.code)).toBeUndefined()
    expect(loggedEvents('oidc_desktop_code_connection_mismatch')).toEqual([
      expect.objectContaining({ userId: member.userId, cause: 'switch_off' }),
    ])

    stubOidcEnvironment(desktopFake.env)
    const again = await redeem(minted.code, minted.verifier)

    expect(again.status).toBe(400)
    expect(again.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
  })

  it('answers 409 and spends the code when the configuration generation changes after mint', async () => {
    const member = await seedMember('desktop-generation')
    const minted = await desktopCodeThroughRoute(member)
    const regenerated = createOidcMemberSignInFakeProvider({
      memberSignInEnv: { CONTROL_API_OIDC_TRUST_GENERATION: 'fake-desktop-sign-in-regenerated' },
    })
    expect(regenerated.provider.registrationId).toBe(desktopFake.provider.registrationId)
    expect(regenerated.provider.memberAuthenticationActivated).toBe(true)
    expect(regenerated.provider.configurationGeneration).not.toBe(
      desktopFake.provider.configurationGeneration
    )
    stubOidcEnvironment(regenerated.env)

    const refused = await redeem(minted.code, minted.verifier)

    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: 'desktop_sign_in_unavailable' })
    expect(await storedCode(minted.code)).toBeUndefined()
    expect(loggedEvents('oidc_desktop_code_connection_mismatch')).toEqual([
      expect.objectContaining({ userId: member.userId, cause: 'generation_changed' }),
    ])

    stubOidcEnvironment(desktopFake.env)
    const again = await redeem(minted.code, minted.verifier)

    expect(again.status).toBe(400)
    expect(again.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
  })

  it('answers 403 account_disabled, issues no token and spends the code when the account is retired after mint', async () => {
    const member = await seedMember('desktop-retired')
    const minted = await desktopCodeThroughRoute(member)
    await retire(member, 'desktop-retired')

    // A V2 request: an issued token would leave a session row.
    const refused = await redeem(minted.code, minted.verifier, { sessionContract: 'v2' })

    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: 'desktop_sign_in_refused', reason: 'account_disabled' })
    expect(await sessionCount(member.userId)).toBe(0)
    expect(await storedCode(minted.code)).toBeUndefined()
    recordContract('POST /external/oidc/desktop-sign-in/redeem refused-account-disabled', refused)

    await reactivate(member.userId)
    const again = await redeem(minted.code, minted.verifier, { sessionContract: 'v2' })

    expect(again.status).toBe(400)
    expect(again.body).toEqual({ error: 'invalid_desktop_sign_in_code' })
    expect(await sessionCount(member.userId)).toBe(0)
  })

  it('keeps the stored team when it no longer ranks first', async () => {
    const member = await seedMember('desktop-kept-team')
    // The member's oldest membership, and their first team_members row.
    const oldest = await seedTeam(OLDEST_TEAM_NAME)
    await seedMembership(oldest, member.userId, 'admin', '2 hours')
    // The team the sign-in keeps: joined later, through an accepted
    // invitation, so the default-team rule ranks it first at mint.
    const kept = await seedTeam(TEAM_NAME)
    await acceptInvitationAs(member, kept, 'member')
    expect(await firstRankedTeam(member.userId)).toBe(kept)
    const minted = await desktopCodeThroughRoute(member)
    expect(await storedCode(minted.code)).toMatchObject({ team_id: kept })

    const other = await seedTeam(SECOND_TEAM_NAME)
    await acceptInvitationAs(member, other, 'inviter')
    // Witnesses: the stored team is now neither the oldest membership nor the
    // one the default-team rule picks, which is the newly accepted team.
    const byAge = await ownerPool.query<{ team_id: string }>(
      `SELECT team_id::text AS team_id FROM team_members
        WHERE user_id = $1::uuid AND status = 'active'
        ORDER BY created_at, team_id`,
      [member.userId]
    )
    expect(byAge.rows.map(row => row.team_id)).toEqual([oldest, kept, other])
    expect(await firstRankedTeam(member.userId)).toBe(other)

    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body.me).toMatchObject({
      id: member.userId,
      teamId: kept,
      teamName: TEAM_NAME,
      role: 'member',
    })
  })

  it('falls back to the second team when the stored team is removed', async () => {
    const member = await seedMember('desktop-removed-team')
    const first = await seedTeam(TEAM_NAME)
    const second = await seedTeam(SECOND_TEAM_NAME)
    await seedMembership(first, member.userId, 'member', '2 hours')
    await seedMembership(second, member.userId, 'inviter', '1 hour')
    const minted = await desktopCodeThroughRoute(member)
    expect(await storedCode(minted.code)).toMatchObject({ team_id: first })

    const removed = await softDeleteMember(first, member.userId, ADMIN_ACTOR_ID)
    expect(removed).toMatchObject({ team_id: first, status: 'deleted' })

    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body.me).toMatchObject({
      id: member.userId,
      teamId: second,
      teamName: SECOND_TEAM_NAME,
      role: 'inviter',
    })
  })

  it('gives a teamless member a teamless session', async () => {
    const member = await seedMember('desktop-teamless')
    const minted = await desktopCodeThroughRoute(member)
    expect(await storedCode(minted.code)).toMatchObject({ team_id: null })

    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toEqual({
      token: expect.any(String),
      sessionContract: 'v1',
      me: {
        id: member.userId,
        email: member.email,
        name: MEMBER_NAME,
        picture: null,
        teamId: null,
        teamName: null,
        role: 'member',
      },
    })
  })

  it('gives a teamless mint the team the member joined before redeem', async () => {
    const member = await seedMember('desktop-late-team')
    const minted = await desktopCodeThroughRoute(member)
    // Teamless at mint: the member had no team and no pending invitation.
    expect(await storedCode(minted.code)).toMatchObject({ user_id: member.userId, team_id: null })

    // Joined after the mint, through an accepted invitation.
    const late = await seedTeam(LATE_TEAM_NAME)
    await acceptInvitationAs(member, late, 'inviter')
    expect(await firstRankedTeam(member.userId)).toBe(late)

    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body.me).toMatchObject({
      id: member.userId,
      teamId: late,
      teamName: LATE_TEAM_NAME,
      role: 'inviter',
    })
    expect(
      await authenticateExternalUserSession(redeemed.body.token, {
        purpose: 'protected',
        policy: SESSION_POLICY,
      })
    ).toMatchObject({
      status: 'authenticated',
      claims: { userId: member.userId, teamId: late },
    })
  })

  it('answers 426 and leaves the code redeemable', async () => {
    const member = await seedMember('desktop-upgrade')
    const minted = await desktopCodeThroughRoute(member)
    accessPolicy.resolve.mockResolvedValue(NO_V1_ISSUANCE_POLICY)

    const refused = await redeem(minted.code, minted.verifier)

    expect(refused.status).toBe(426)
    expect(refused.body).toEqual({ error: 'upgrade_required' })
    expect(await storedCode(minted.code)).toMatchObject({ user_id: member.userId })

    accessPolicy.resolve.mockResolvedValue(SESSION_POLICY)
    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toMatchObject({ sessionContract: 'v1', me: { id: member.userId } })
  })

  it('answers 503 under V1 when issuance is unavailable and leaves the code redeemable', async () => {
    const member = await seedMember('desktop-issuance-cutoff')
    const minted = await desktopCodeThroughRoute(member)
    // A security cutoff after now: V1 issuance defers until it passes.
    await ownerPool.query(
      `INSERT INTO external_user_session_security_epochs (user_id, valid_after, reason)
       VALUES ($1, now() + interval '1 hour', 'desktop-sign-in-fixture')`,
      [member.userId]
    )

    const deferred = await redeem(minted.code, minted.verifier)

    expect(deferred.status).toBe(503)
    expect(deferred.headers['retry-after']).toBe('2')
    expect(deferred.body.error).toMatchObject({
      code: 'session_issuance_temporarily_unavailable',
      retryable: true,
    })
    expect(await storedCode(minted.code)).toMatchObject({ user_id: member.userId })

    const cleared = await ownerPool.query(
      `DELETE FROM external_user_session_security_epochs WHERE user_id = $1`,
      [member.userId]
    )
    expect(cleared.rowCount).toBe(1)
    const redeemed = await redeem(minted.code, minted.verifier)

    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toMatchObject({ sessionContract: 'v1', me: { id: member.userId } })
  })

  it('mints at /complete even when Profile session selection would fail', async () => {
    const member = await seedMember('desktop-no-profile-selection')
    accessPolicy.resolve.mockResolvedValue(NO_V1_ISSUANCE_POLICY)

    // The control: under this policy a plain Profile attempt cannot complete.
    const plain = await signInThroughRoute(desktopFake, member.claims)
    expect(plain.completed.status).toBe(503)
    expect(plain.completed.body).toEqual({
      error: 'oidc_storage_unavailable',
      retrySameAttempt: false,
    })

    const minted = await desktopCodeThroughRoute(member)

    expect(minted.completed.body).toMatchObject({ outcome: 'desktop_code_issued' })
    expect(await storedCode(minted.code)).toMatchObject({ user_id: member.userId })
  })

  it('gives one token to two concurrent redeems', async () => {
    const member = await seedMember('desktop-concurrent')
    const minted = await desktopCodeThroughRoute(member)
    // V2, so each issued token leaves a session row to count.
    const body = { code: minted.code, codeVerifier: minted.verifier, sessionContract: 'v2' }

    // The first redeem holds its transaction, and the row lock its DELETE
    // took, until the second, through the route, waits on that lock.
    let second: Promise<PromiseSettledResult<request.Response>> | undefined
    const gated = <T>(work: (db: DbTransactionClient) => Promise<T>): Promise<T> =>
      withTransaction(async db => {
        const result = await work(db)
        if (!second) {
          second = settle(
            new Promise<request.Response>((resolve, reject) => {
              request(chainApp())
                .post(REDEEM_PATH)
                .send(body)
                .end((error, response) => (error ? reject(error) : resolve(response)))
            })
          )
          await waitForLockWaiter()
        }
        return result
      })
    const firstApp = chainApp({
      redeem: input => redeemDesktopSignInCode(input, { transaction: gated }),
    })

    const first = await request(firstApp).post(REDEEM_PATH).send(body)
    if (!second) throw new Error('the second redeem never started')
    const secondResponse = valueOf(await second)

    expect([first.status, secondResponse.status].sort()).toEqual([200, 400])
    const tokens = [first.body, secondResponse.body].filter(
      answer => typeof answer.token === 'string'
    )
    expect(tokens).toHaveLength(1)
    expect(await sessionCount(member.userId)).toBe(1)
    expect(await storedCode(minted.code)).toBeUndefined()
    // The winning V2 token names the member and says it came from an OIDC sign-in.
    const authentication = await authenticateExternalUserSession(tokens[0]!.token, {
      purpose: 'protected',
      policy: SESSION_POLICY,
    })
    expect(authentication).toMatchObject({
      status: 'authenticated',
      contract: 'v2',
      claims: { userId: member.userId, email: member.email },
      authorityContext: { contract: 'v2', userId: member.userId },
    })
    expect(authentication).toMatchObject({ tokenClaims: { sub: member.userId, amr: ['oidc'] } })
  })

  it('logs no code, verifier, state, subject, token or email across success, refusal and mismatch', async () => {
    const success = await seedMember('desktop-log-success')
    const mismatch = await seedMember('desktop-log-mismatch')
    const refusal = await seedMember('desktop-log-refusal')

    const successCode = await desktopCodeThroughRoute(success)
    const redeemed = await redeem(successCode.code, successCode.verifier)
    expect(redeemed.status).toBe(200)

    const mismatchCode = await desktopCodeThroughRoute(mismatch)
    const wrongVerifier = randomVerifier()
    expect((await redeem(mismatchCode.code, wrongVerifier)).status).toBe(400)
    const switchedOff = createOidcMemberSignInFakeProvider({
      memberSignInEnv: {
        CONTROL_API_OIDC_MEMBER_SIGN_IN: undefined,
        CONTROL_API_OIDC_UNRELEASED: undefined,
      },
    })
    stubOidcEnvironment(switchedOff.env)
    expect((await redeem(mismatchCode.code, mismatchCode.verifier)).status).toBe(409)

    const refusalCode = await desktopCodeThroughRoute(refusal)
    await retire(refusal, 'desktop-log-refusal')
    expect((await redeem(refusalCode.code, refusalCode.verifier)).status).toBe(403)

    // The events were logged, each naming its member and none of the values.
    expect(loggedEvents('oidc_desktop_code_minted')).toEqual([
      expect.objectContaining({ userId: success.userId }),
      expect.objectContaining({ userId: mismatch.userId }),
      expect.objectContaining({ userId: refusal.userId }),
    ])
    expect(loggedEvents('oidc_desktop_code_redeemed')).toEqual([
      expect.objectContaining({ userId: success.userId, sessionContract: 'v1' }),
    ])
    expect(loggedEvents('oidc_desktop_code_verifier_mismatch')).toEqual([
      expect.objectContaining({ registrationId: desktopFake.provider.registrationId }),
    ])
    expect(loggedEvents('oidc_desktop_code_connection_mismatch')).toEqual([
      expect.objectContaining({ userId: mismatch.userId, cause: 'switch_off' }),
    ])
    expect(loggedEvents('oidc_desktop_code_refused')).toEqual([
      expect.objectContaining({ userId: refusal.userId, reason: 'account_disabled' }),
    ])

    const text = loggedText()
    const values = [
      successCode.code,
      mismatchCode.code,
      refusalCode.code,
      successCode.verifier,
      mismatchCode.verifier,
      refusalCode.verifier,
      wrongVerifier,
      successCode.challenge,
      mismatchCode.challenge,
      refusalCode.challenge,
      successCode.state,
      mismatchCode.state,
      refusalCode.state,
      // The raw `sub` claim the fake provider issued for each member.
      success.claims.sub,
      mismatch.claims.sub,
      refusal.claims.sub,
      redeemed.body.token,
      success.email,
      mismatch.email,
      refusal.email,
    ]
    for (const value of values) {
      expect(typeof value === 'string' && value.length >= 20).toBe(true)
      expect(text).not.toContain(value)
    }
  })

  it('records the contract bodies', async () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        'GET /external/oidc/profile-flow/configuration activated',
        'POST /external/oidc/profile-flow/attempts desktop-echo',
        'POST /external/oidc/profile-flow/attempts plain',
        'POST /external/oidc/profile-flow/complete desktop-code-issued',
        'POST /external/oidc/profile-flow/complete member-signed-in',
        'POST /external/oidc/desktop-sign-in/redeem signed-in',
        'POST /external/oidc/desktop-sign-in/redeem refused-account-disabled',
      ].sort()
    )
    // recordContract already refused a missing, repeated or malformed state,
    // nonce or code_challenge, and an expiresAt Profile UI's start route would
    // refuse. The URL Profile UI receives must name the recorded callback.
    const configured = contract['GET /external/oidc/profile-flow/configuration activated']!
      .body as { redirectUri: string }
    for (const key of [
      'POST /external/oidc/profile-flow/attempts plain',
      'POST /external/oidc/profile-flow/attempts desktop-echo',
    ]) {
      const recorded = contract[key]!.body as { authorizationUrl: string }
      const params = new URL(recorded.authorizationUrl).searchParams
      expect(params.get('redirect_uri')).toBe(configured.redirectUri)
    }

    await expectContractFile(contract, CONTRACT_FILE)
  })
})

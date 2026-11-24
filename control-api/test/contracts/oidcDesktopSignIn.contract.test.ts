import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { externalNotFoundHandler } from '../../src/app.js'
import { clerumErrorHandler } from '../../src/http/errorHandler.js'
import type { OidcProviderConfiguration } from '../../src/oidc/configuration.js'
import { createExternalAuthMethodsRouter } from '../../src/routes/external/authMethods.js'
import {
  type ExternalOidcDesktopSignInDependencies,
  createExternalOidcDesktopSignInRouter,
} from '../../src/routes/external/oidcDesktopSignIn.js'
import {
  type ExternalOidcProfileFlowDependencies,
  createExternalOidcProfileFlowRouter,
} from '../../src/routes/external/oidcProfileFlow.js'
import type { EffectiveUserAccessPolicy } from '../../src/services/access/userAccessPolicy.js'
import { ExternalSessionIssuanceUnavailableError } from '../../src/services/auth/externalSessionIssuance.js'
import {
  type ContractRecord,
  expectContractFile,
  normalizeContractBody,
} from '../helpers/contractFixture.js'
import { createOidcMemberSignInFakeProvider } from '../helpers/oidcMemberSignInFakeProvider.js'

/**
 * Stage 1 of the Desktop sign-in contract chain: the refusals, errors and
 * methods answers control-api's routes build from an outcome, recorded to
 * control-api.json. The routes run with injected engine, provider, member
 * sign-in and redeem outcomes, behind control-api's own catch-all 404 and
 * error handler. Answers that need the real chain (a minted code, a session
 * token, a redeemed session) are recorded by the real-PostgreSQL suite.
 */

const resolveEffectiveUserAccessPolicy = vi.hoisted(() => vi.fn())

vi.mock('../../src/services/access/userAccessRuntimePolicy.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../src/services/access/userAccessRuntimePolicy.js')
  >()),
  resolveEffectiveUserAccessPolicy,
}))

const CONTRACT_FILE = fileURLToPath(
  new URL('../fixtures/oidc-desktop-sign-in/control-api.json', import.meta.url)
)

const SESSION_POLICY: EffectiveUserAccessPolicy = Object.freeze({
  policyVersion: '1',
  policyRevision: 'desktop-sign-in-contract-fixture',
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
  policyRevision: 'desktop-sign-in-contract-no-v1-fixture',
  issueV1: false,
})

/** Member sign-in on: the switch and its release guard are set. */
const activated = createOidcMemberSignInFakeProvider().provider
/** The same registration with member sign-in off: identity proof only. */
const proofOnly = createOidcMemberSignInFakeProvider({
  memberSignInEnv: {
    CONTROL_API_OIDC_MEMBER_SIGN_IN: undefined,
    CONTROL_API_OIDC_UNRELEASED: undefined,
  },
}).provider

const BROWSER_BINDING = 'fixture-browser-binding-'.padEnd(43, 'b')
const STATE = 'fixture-state-'.padEnd(43, 's')
const CODE_CHALLENGE = 'fixture-code-challenge-'.padEnd(43, 'c')
const DESKTOP_CODE = 'fixture-desktop-code-'.padEnd(43, 'd')
const CODE_VERIFIER = 'fixture-desktop-verifier-'.padEnd(43, 'v')
const USER_ID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const completeBody = {
  state: STATE,
  code: 'fixture-provider-code',
  browserBinding: BROWSER_BINDING,
  issuer: activated.issuer,
}
const redeemBody = { code: DESKTOP_CODE, codeVerifier: CODE_VERIFIER }

/** The proof /complete hands to member sign-in; it never reaches a body. */
function proofFrom(provider: OidcProviderConfiguration) {
  return {
    purpose: 'oidc-identity-proof-v1',
    issuer: provider.issuer,
    subject: 'fixture-contract-subject',
    registrationId: provider.registrationId,
    clientId: provider.clientId,
    configurationGeneration: provider.configurationGeneration,
    attemptId: '7d1f3c2a-9b4e-4f6a-8c5d-2e1b0a9f8c7d',
    signInContext: null,
    issuedAt: 0,
    attributes: {},
    verifiedClaims: {},
  }
}

type Engine = ReturnType<NonNullable<ExternalOidcProfileFlowDependencies['createEngine']>>

type ContractDependencies = Readonly<{
  provider: OidcProviderConfiguration | undefined
  engine?: Partial<Engine>
  signInMember?: ExternalOidcProfileFlowDependencies['signInMember']
  redeem?: ExternalOidcDesktopSignInDependencies['redeem']
}>

function notReached(name: string) {
  return () => {
    throw new Error(`${name} is not reached in this case`)
  }
}

/** The external routes this contract covers, as control-api mounts them, with injected outcomes. */
function contractApp(dependencies: ContractDependencies) {
  const getProvider = () => dependencies.provider
  const app = express()
  app.use(express.json())
  app.use(
    createExternalOidcProfileFlowRouter({
      getProvider,
      createEngine: () => (dependencies.engine ?? {}) as Engine,
      signInMember: dependencies.signInMember ?? notReached('member sign-in'),
      writeDesktopSignInContext: notReached('the Desktop context write'),
    })
  )
  app.use(
    createExternalOidcDesktopSignInRouter({
      getProvider,
      redeem: dependencies.redeem ?? notReached('redeem'),
    })
  )
  app.use(createExternalAuthMethodsRouter({ getProvider }))
  app.use(externalNotFoundHandler)
  app.use(clerumErrorHandler)
  return app
}

type ContractCase = Readonly<{
  key: string
  dependencies: ContractDependencies
  policy?: EffectiveUserAccessPolicy
  send: (app: express.Express) => request.Test
  status: number
  body: unknown
}>

const cases: readonly ContractCase[] = [
  {
    key: 'POST /external/oidc/profile-flow/attempts desktop-unavailable',
    dependencies: { provider: proofOnly, engine: {} },
    send: app =>
      request(app)
        .post('/external/oidc/profile-flow/attempts')
        .send({
          browserBinding: BROWSER_BINDING,
          desktopSignIn: { codeChallenge: CODE_CHALLENGE },
        }),
    status: 409,
    body: { error: 'desktop_sign_in_unavailable' },
  },
  {
    key: 'POST /external/oidc/profile-flow/attempts invalid',
    dependencies: { provider: activated, engine: {} },
    send: app =>
      request(app).post('/external/oidc/profile-flow/attempts').send({ browserBinding: 'short' }),
    status: 400,
    body: { error: 'invalid_oidc_attempt' },
  },
  {
    key: 'POST /external/oidc/profile-flow/complete refused',
    dependencies: {
      provider: activated,
      engine: { completeIdentityProofAttempt: async () => proofFrom(activated) as never },
      signInMember: async () => ({ status: 'refused', reason: 'not_eligible' }),
    },
    send: app => request(app).post('/external/oidc/profile-flow/complete').send(completeBody),
    status: 200,
    body: { outcome: 'refused', memberAuthenticationActivated: true, reason: 'not_eligible' },
  },
  {
    key: 'POST /external/oidc/profile-flow/complete identity-proof-verified',
    dependencies: {
      provider: proofOnly,
      engine: { completeIdentityProofAttempt: async () => proofFrom(proofOnly) as never },
    },
    send: app => request(app).post('/external/oidc/profile-flow/complete').send(completeBody),
    status: 200,
    body: { outcome: 'identity_proof_verified', memberAuthenticationActivated: false },
  },
  {
    // Member sign-in fails after the provider consumed the attempt.
    key: 'POST /external/oidc/profile-flow/complete storage-unavailable',
    dependencies: {
      provider: activated,
      engine: { completeIdentityProofAttempt: async () => proofFrom(activated) as never },
      signInMember: async () => {
        throw new Error('fixture member sign-in failure')
      },
    },
    send: app => request(app).post('/external/oidc/profile-flow/complete').send(completeBody),
    status: 503,
    body: { error: 'oidc_storage_unavailable', retrySameAttempt: false },
  },
  {
    key: 'POST /external/oidc/profile-flow/cancel cancelled',
    dependencies: { provider: activated, engine: { cancelIdentityProofAttempt: async () => true } },
    send: app =>
      request(app)
        .post('/external/oidc/profile-flow/cancel')
        .send({ state: STATE, browserBinding: BROWSER_BINDING }),
    status: 200,
    body: { outcome: 'attempt_cancelled' },
  },
  {
    key: 'POST /external/oidc/desktop-sign-in/redeem invalid',
    dependencies: {
      provider: activated,
      redeem: async () => ({ status: 'invalid_code', verifierMismatch: false }),
    },
    send: app => request(app).post('/external/oidc/desktop-sign-in/redeem').send(redeemBody),
    status: 400,
    body: { error: 'invalid_desktop_sign_in_code' },
  },
  {
    key: 'POST /external/oidc/desktop-sign-in/redeem unavailable',
    dependencies: {
      provider: activated,
      redeem: async () => ({ status: 'unavailable', userId: USER_ID, cause: 'switch_off' }),
    },
    send: app => request(app).post('/external/oidc/desktop-sign-in/redeem').send(redeemBody),
    status: 409,
    body: { error: 'desktop_sign_in_unavailable' },
  },
  {
    key: 'POST /external/oidc/desktop-sign-in/redeem upgrade-required',
    dependencies: { provider: activated },
    policy: NO_V1_ISSUANCE_POLICY,
    send: app => request(app).post('/external/oidc/desktop-sign-in/redeem').send(redeemBody),
    status: 426,
    body: { error: 'upgrade_required' },
  },
  {
    key: 'POST /external/oidc/desktop-sign-in/redeem issuance-unavailable',
    dependencies: {
      provider: activated,
      redeem: async () => {
        throw new ExternalSessionIssuanceUnavailableError()
      },
    },
    send: app => request(app).post('/external/oidc/desktop-sign-in/redeem').send(redeemBody),
    status: 503,
    body: {
      error: {
        code: 'session_issuance_temporarily_unavailable',
        message: 'A session could not be issued right now. Try again in two seconds.',
        correlationId: expect.any(String),
        retryable: true,
      },
    },
  },
  {
    key: 'GET /external/auth/methods password',
    dependencies: { provider: proofOnly },
    send: app => request(app).get('/external/auth/methods'),
    status: 200,
    body: { methods: ['password'] },
  },
  {
    key: 'GET /external/auth/methods password-and-oidc',
    dependencies: { provider: activated },
    send: app => request(app).get('/external/auth/methods'),
    status: 200,
    body: {
      methods: ['password', 'oidc'],
      oidc: {
        label: activated.displayLabel,
        signInUrl: `${new URL(activated.redirectUri).origin}/desktop-login`,
      },
    },
  },
  {
    key: 'GET /external/unknown not-found',
    dependencies: { provider: activated },
    send: app => request(app).get('/external/unknown'),
    status: 404,
    body: { error: 'Not Found' },
  },
]

describe('Desktop sign-in contract bodies built by control-api routes', () => {
  const records: Record<string, ContractRecord> = {}

  beforeEach(() => {
    resolveEffectiveUserAccessPolicy.mockReset().mockResolvedValue(SESSION_POLICY)
  })

  it.each(cases.map(contractCase => [contractCase.key, contractCase] as const))(
    'answers %s',
    async (key, contractCase) => {
      resolveEffectiveUserAccessPolicy.mockResolvedValue(contractCase.policy ?? SESSION_POLICY)

      const response = await contractCase.send(contractApp(contractCase.dependencies))

      expect(response.status).toBe(contractCase.status)
      expect(response.body).toEqual(contractCase.body)
      records[key] = { status: response.status, body: normalizeContractBody(response.body) }
    }
  )

  it('records the contract bodies', async () => {
    expect(Object.keys(records).sort()).toEqual(cases.map(({ key }) => key).sort())
    // Profile UI reads this field to start a new attempt rather than retry the consumed one.
    expect(
      records['POST /external/oidc/profile-flow/complete storage-unavailable']?.body
    ).toHaveProperty('retrySameAttempt', false)

    await expectContractFile(records, CONTRACT_FILE)
  })
})

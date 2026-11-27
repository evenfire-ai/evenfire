import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { VerifiedOidcIdentityProof } from '../src/oidc/protocol.js'
import { createExternalOidcProfileFlowRouter } from '../src/routes/external/oidcProfileFlow.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { createOidcMemberSignInFakeProvider } from './helpers/oidcMemberSignInFakeProvider.js'

/**
 * `/complete` through the route's own default sign-in (defaultSignInMember):
 * no `signInMember` is injected. Only the service it calls, the session-format
 * selection it may call, and the access policy it may read are replaced, so
 * the test sees which completion the route asks for.
 */
const flowLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
const signInOidcMember = vi.hoisted(() => vi.fn())
const selectExternalSessionRepresentation = vi.hoisted(() => vi.fn())
const resolveEffectiveUserAccessPolicy = vi.hoisted(() => vi.fn())

vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  const rootLogger = new Proxy(actual.rootLogger, {
    get(target, prop, receiver) {
      if (prop !== 'child') return Reflect.get(target, prop, receiver)
      return (bindings: Record<string, unknown>, options?: object) =>
        bindings?.component === 'oidc_profile_flow' ? flowLog : target.child(bindings, options)
    },
  })
  return { ...actual, rootLogger }
})

vi.mock('../src/services/auth/oidcMemberSignIn.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/auth/oidcMemberSignIn.js')>()),
  signInOidcMember,
}))

vi.mock('../src/services/auth/externalSessionIssuance.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/auth/externalSessionIssuance.js')>()),
  selectExternalSessionRepresentation,
}))

vi.mock('../src/services/access/userAccessRuntimePolicy.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/access/userAccessRuntimePolicy.js')>()),
  resolveEffectiveUserAccessPolicy,
}))

const COMPLETE_PATH = '/external/oidc/profile-flow/complete'
const CODE_CHALLENGE = 'fixture-desktop-challenge-'.padEnd(43, 'c')
const DESKTOP_CODE = 'fixture-desktop-code-'.padEnd(43, 'd')
const SESSION_TOKEN = 'session-token-fixture'

const fake = createOidcMemberSignInFakeProvider()
const provider = fake.provider

const sessionPolicy: EffectiveUserAccessPolicy = Object.freeze({
  policyVersion: '1',
  policyRevision: 'desktop-completion-fixture',
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

const completeBody = {
  state: 'S'.repeat(43),
  code: 'provider-code-fixture',
  browserBinding: 'B'.repeat(43),
  issuer: provider.issuer,
}

/** The fields of a verified proof the route and its default sign-in read. */
function proofWith(signInContext: VerifiedOidcIdentityProof['signInContext']) {
  return {
    issuer: provider.issuer,
    subject: 'opaque-provider-subject',
    registrationId: provider.registrationId,
    configurationGeneration: provider.configurationGeneration,
    attemptId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    signInContext,
    attributes: { source: 'validated_id_token', email: 'member@fixture.test', emailVerified: true },
  }
}

const desktopProof = proofWith({ kind: 'desktop_sign_in', codeChallenge: CODE_CHALLENGE })
const plainProof = proofWith(null)
const invitationProof = proofWith({
  kind: 'invitation',
  invitationId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
  invitedEmail: 'member@fixture.test',
})

function appCompleting(proof: object) {
  const router = createExternalOidcProfileFlowRouter({
    getProvider: () => provider,
    createEngine: () =>
      ({ completeIdentityProofAttempt: vi.fn().mockResolvedValue(proof) }) as never,
  })
  const app = express()
  app.use(express.json())
  app.use(router)
  return app
}

function desktopCodeIssued(overrides: Record<string, unknown> = {}) {
  return {
    status: 'desktop_code_issued',
    userId: 'user-desktop-1',
    code: DESKTOP_CODE,
    expiresInSeconds: 90,
    teamless: false,
    created: { account: false, link: false },
    invitationsApplied: 0,
    ...overrides,
  }
}

/** Every call the route made to its logger. */
function loggedText(): string {
  return JSON.stringify(Object.values(flowLog).map(method => method.mock.calls))
}

beforeEach(async () => {
  for (const method of Object.values(flowLog)) method.mockReset()
  signInOidcMember.mockReset()
  resolveEffectiveUserAccessPolicy.mockReset().mockResolvedValue(sessionPolicy)
  // The real selection runs; the spy only counts it.
  const actual = await vi.importActual<
    typeof import('../src/services/auth/externalSessionIssuance.js')
  >('../src/services/auth/externalSessionIssuance.js')
  selectExternalSessionRepresentation
    .mockReset()
    .mockImplementation(actual.selectExternalSessionRepresentation)
})

describe('/complete for a Desktop sign-in attempt', () => {
  it('passes a desktop completion and never selects a session format for a Desktop attempt', async () => {
    signInOidcMember.mockResolvedValue(desktopCodeIssued())

    const response = await request(appCompleting(desktopProof))
      .post(COMPLETE_PATH)
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(signInOidcMember).toHaveBeenCalledTimes(1)
    expect(signInOidcMember).toHaveBeenCalledWith({
      proof: desktopProof,
      provider,
      policy: provider.memberSignIn,
      completion: { kind: 'desktop_code', codeChallenge: CODE_CHALLENGE },
    })
    expect(signInOidcMember.mock.calls[0]![0].completion.kind).toBe('desktop_code')
    expect(selectExternalSessionRepresentation).toHaveBeenCalledTimes(0)
    expect(resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(0)
  })

  it('still selects once for a plain attempt', async () => {
    signInOidcMember.mockResolvedValue({
      status: 'signed_in',
      userId: 'user-plain-1',
      token: SESSION_TOKEN,
      contract: 'v1',
      created: { account: false, link: false },
      invitationsApplied: 0,
    })

    const response = await request(appCompleting(plainProof)).post(COMPLETE_PATH).send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'member_signed_in',
      memberAuthenticationActivated: true,
      token: SESSION_TOKEN,
      sessionContract: 'v1',
    })
    expect(resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(1)
    expect(selectExternalSessionRepresentation).toHaveBeenCalledTimes(1)
    expect(selectExternalSessionRepresentation).toHaveBeenCalledWith({}, sessionPolicy)
    expect(signInOidcMember).toHaveBeenCalledTimes(1)
    expect(signInOidcMember).toHaveBeenCalledWith({
      proof: plainProof,
      provider,
      policy: provider.memberSignIn,
      completion: { kind: 'session', contract: 'v1', sessionPolicy },
    })
  })

  it('answers desktop_code_issued and logs no code', async () => {
    signInOidcMember.mockResolvedValue(
      desktopCodeIssued({
        teamless: true,
        created: { account: true, link: true },
        invitationsApplied: 2,
      })
    )

    const response = await request(appCompleting(desktopProof))
      .post(COMPLETE_PATH)
      .set('x-request-id', 'request-fixture-desktop')
      .send(completeBody)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      outcome: 'desktop_code_issued',
      memberAuthenticationActivated: true,
      code: DESKTOP_CODE,
      expiresInSeconds: 90,
    })

    // The account, link and invitation events fire as for any sign-in; the
    // Desktop one replaces the session event: the same member context, and
    // `teamless` in place of the session contract.
    const member = {
      registrationId: provider.registrationId,
      issuer: provider.issuer,
      subjectFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      userId: 'user-desktop-1',
      requestId: 'request-fixture-desktop',
    }
    expect(flowLog.info.mock.calls.map(call => call[0])).toEqual([
      { event: 'oidc_member_account_created', ...member },
      { event: 'oidc_member_link_created', ...member },
      { event: 'oidc_member_invitation_applied', ...member, count: 2 },
      { event: 'oidc_desktop_code_minted', ...member, teamless: true },
    ])
    expect(flowLog.warn).not.toHaveBeenCalled()
    expect(flowLog.error).not.toHaveBeenCalled()
    expect(loggedText()).not.toContain(DESKTOP_CODE)
    expect(loggedText()).not.toContain(CODE_CHALLENGE)
  })
})

describe('/complete for an invitation attempt', () => {
  it('fails closed with the terminal 503 instead of issuing a Profile session', async () => {
    // What member sign-in answers for an ordinary attempt: a session for this member.
    signInOidcMember.mockResolvedValue({
      status: 'signed_in',
      userId: 'user-invited-1',
      token: SESSION_TOKEN,
      contract: 'v1',
      created: { account: false, link: false },
      invitationsApplied: 0,
    })

    const response = await request(appCompleting(invitationProof))
      .post(COMPLETE_PATH)
      .set('x-request-id', 'request-fixture-invitation')
      .send(completeBody)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'oidc_storage_unavailable', retrySameAttempt: false })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain(SESSION_TOKEN)
    expect(signInOidcMember).toHaveBeenCalledTimes(0)
    expect(selectExternalSessionRepresentation).toHaveBeenCalledTimes(0)
    expect(resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(0)
    // The route reached member sign-in and logged its failure, by class only.
    expect(flowLog.error).toHaveBeenCalledTimes(1)
    expect(flowLog.error.mock.calls[0]![0]).toEqual({
      event: 'oidc_member_sign_in_failed',
      registrationId: provider.registrationId,
      issuer: provider.issuer,
      subjectFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      requestId: 'request-fixture-invitation',
      errorClass: 'Error',
    })
    expect(loggedText()).not.toContain('member@fixture.test')
  })
})

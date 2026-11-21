import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
  HOST_EDGE_ASSERTION_JWT_TYPE,
  HOST_EDGE_ASSERTION_V2_CLAIM_KEYS,
  canonicalActionTarget,
  hashActionTarget,
  validateActionAuthorityCheckpointResponse,
  validateHostEdgeAssertionClaims,
} from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import { knownBehavior } from '../src/services/access/accessPath.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

/**
 * Host edge assertion issuance on the V2 action authority checkpoint. The route runs the real
 * checkpoint service and the real destination resolver; only the live authorizer (which reads
 * PostgreSQL) is replaced by a fixture that answers for the request it receives. Assertions are
 * decoded the way the Host verifies them.
 */

const admission = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const accessPolicy = vi.hoisted(() => ({ resolveEffectiveUserAccessPolicy: vi.fn() }))
const authority = vi.hoisted(() => ({
  checkpointCalls: 0,
  authorize: undefined as undefined | ((input: Record<string, unknown>) => Promise<unknown>),
  resolveDestination: undefined as undefined | (() => Promise<unknown>),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: admission.checkAndIncrement,
  checkAndIncrementStrict: admission.checkAndIncrement,
}))
vi.mock('../src/services/access/userAccessRuntimePolicy.js', () => accessPolicy)
vi.mock('../src/services/access/actionAuthorityCheckpoint.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/access/actionAuthorityCheckpoint.js')>()
  return {
    ...actual,
    checkpointActionAuthority: (input: Parameters<typeof actual.checkpointActionAuthority>[0]) => {
      authority.checkpointCalls += 1
      return actual.checkpointActionAuthority(input, {
        authorize: authority.authorize as never,
        ...(authority.resolveDestination
          ? { resolveDestination: authority.resolveDestination as never }
          : {}),
      })
    },
  }
})
vi.mock('../src/middleware/actionCheckpointCaller.js', () => ({
  requireActionCheckpointCaller: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    const service = req.header('x-test-checkpoint-caller') ?? 'rpc-proxy'
    req.actionCheckpointCaller = (
      service === 'mcp-host'
        ? {
            service,
            trustPlane: 'mcp_host_runtime_jwt',
            permittedResource: { type: 'host', logicalId: HOST_LOGICAL_ID },
          }
        : service === 'workflow-recipes'
          ? { service, trustPlane: 'internal_control_jwt' }
          : { service: 'rpc-proxy', trustPlane: 'internal_service_token' }
    ) as never
    next()
  },
}))

const { createInternalActionAuthorityCheckpointRouter } =
  await import('../src/routes/internal/actionAuthorityCheckpoint.js')

const HOST_LOGICAL_ID = `${config.hostsNamespace}/chatllm`
const SUBJECT = '10000000-0000-4000-8000-000000000001'
const SID = '20000000-0000-4000-8000-000000000002'
const DELEGATION_JTI = '30000000-0000-4000-8000-000000000003'
const TEAM_ID = '50000000-0000-4000-8000-000000000005'
const ACCESS_PATH_ID = `ap1_${'a'.repeat(43)}`
const AUTHORIZATION_REVISION = `ar1_${'b'.repeat(43)}`
const BEHAVIOR_BINDING_HASH = `bh2_${'c'.repeat(43)}`
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ALLOWED_KEYS = [
  'attribution',
  'authorizationRevision',
  'behavior',
  'behaviorBindingHash',
  'checkedAt',
  'destination',
  'status',
  'validUntil',
  'version',
]
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: HOST_LOGICAL_ID,
})

type OperationId = 'host.status.read' | 'chat.message.invoke'

function checkpointRequest(operationId: OperationId, callerService = 'rpc-proxy') {
  const target = canonicalActionTarget(
    operationId === 'chat.message.invoke'
      ? {
          hostRef: HOST_LOGICAL_ID,
          channelType: 'rpc',
          channelId: 'chatllm',
          messageId: '40000000-0000-4000-8000-000000000001',
        }
      : { hostRef: HOST_LOGICAL_ID }
  )
  const targetHash = hashActionTarget(target)
  return {
    version: 2,
    principal: { sub: SUBJECT, sid: SID, sessionVersion: 3 },
    delegationJti: DELEGATION_JTI,
    resource,
    operationId,
    target,
    targetHash,
    accessPathId: ACCESS_PATH_ID,
    authorizationRevision: AUTHORIZATION_REVISION,
    behaviorBindingHash: BEHAVIOR_BINDING_HASH,
    ...(operationId === 'chat.message.invoke' && callerService === 'rpc-proxy'
      ? {
          hostMessageAdmission: {
            sendNonce: '1'.padStart(43, '0'),
            delegationExpiresAt: Math.floor(Date.now() / 1000) + 120,
          },
        }
      : {}),
    domain: { service: callerService, resource, targetHash },
  }
}

type AllowedOptions = {
  validUntil?: string | null
  pathKind?: 'direct' | 'team'
  effectiveTeamId?: string | null
}

/** Live authorizer fixture: allows the request it receives, for the selected path. */
function allowAuthorization(options: AllowedOptions = {}) {
  authority.authorize = async input => {
    const session = input.session as { userId: string; sid: string; sessionVersion: number }
    const operationTarget = input.operationTarget as Parameters<typeof hashActionTarget>[0]
    return {
      status: 'allowed',
      context: {
        version: 2,
        principal: {
          userId: session.userId,
          sid: session.sid,
          sessionVersion: session.sessionVersion,
        },
        operationId: input.operationId,
        resource: input.resource,
        target: operationTarget,
        targetHash: hashActionTarget(operationTarget),
        accessPathId: ACCESS_PATH_ID,
        authorizationRevision: AUTHORIZATION_REVISION,
        behaviorBindingHash: BEHAVIOR_BINDING_HASH,
        pathKind: options.pathKind ?? 'direct',
        effectiveTeamId: options.effectiveTeamId ?? null,
        selectedPathCapabilities: ['host.read'],
        behavior: {
          capabilities: ['host.read'],
          budget: knownBehavior(null),
          credentialPolicy: knownBehavior(null),
          approvalPolicy: knownBehavior(null),
          filesystemScope: knownBehavior(null),
          runtime: knownBehavior(null),
          providerModelPolicy: knownBehavior(null),
          audit: knownBehavior(`user:${session.userId}`),
        },
        validUntil: options.validUntil ?? null,
      },
      behaviorBindingHash: BEHAVIOR_BINDING_HASH,
      operation: {},
      preparedTarget: { target: operationTarget, targetHash: hashActionTarget(operationTarget) },
    }
  }
}

function app() {
  const server = express()
  server.use(express.json())
  server.use(createInternalActionAuthorityCheckpointRouter({} as never))
  return server
}

function checkpoint(body: unknown, callerService = 'rpc-proxy') {
  return request(app())
    .post('/internal/action-authority/checkpoint')
    .set('x-test-checkpoint-caller', callerService)
    .send(body as object)
}

/** Decodes an assertion exactly as the Host verifies it. */
function verifyAsHost(assertion: string): jwt.JwtPayload {
  const decoded = jwt.decode(assertion, { complete: true })
  expect(decoded?.header).toEqual({ alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE })
  return jwt.verify(assertion, config.rpcJwtPublicKey, {
    algorithms: ['RS256'],
    audience: HOST_EDGE_ASSERTION_AUDIENCE,
    issuer: config.rpcJwtIssuer,
  }) as jwt.JwtPayload
}

beforeEach(() => {
  vi.clearAllMocks()
  authority.checkpointCalls = 0
  authority.resolveDestination = undefined
  allowAuthorization()
  accessPolicy.resolveEffectiveUserAccessPolicy.mockResolvedValue({ actionContextV2: true })
  admission.checkAndIncrement.mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetMs: Date.now() + 30_000,
    count: 1,
    backendAvailable: true,
  })
})

describe('V2 checkpoint issues a Host edge assertion to rpc-proxy for a Host destination', () => {
  it('adds hostEdgeAssertion with claims from the parsed request and the allowed result', async () => {
    const sent = checkpointRequest('host.status.read')
    const response = await checkpoint(sent).expect(200)

    expect(Object.keys(response.body).sort()).toEqual([...ALLOWED_KEYS, 'hostEdgeAssertion'].sort())
    expect(response.body.destination).toMatchObject({ kind: 'host', ref: HOST_LOGICAL_ID })
    const payload = verifyAsHost(response.body.hostEdgeAssertion)
    expect(Object.keys(payload).sort()).toEqual([...HOST_EDGE_ASSERTION_V2_CLAIM_KEYS].sort())
    expect(payload).toEqual({
      typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
      v: 2,
      iss: config.rpcJwtIssuer,
      aud: HOST_EDGE_ASSERTION_AUDIENCE,
      sub: response.body.attribution.userId,
      host: response.body.destination.ref,
      jti: expect.stringMatching(UUID_V4),
      iat: expect.any(Number),
      exp: payload.iat! + 300,
      operationId: 'host.status.read',
      delegationJti: DELEGATION_JTI,
      sid: SID,
      sessionVersion: 3,
      accessPathId: ACCESS_PATH_ID,
      pathKind: 'direct',
      effectiveTeamId: null,
      resource: JSON.parse(JSON.stringify(resource)),
      targetHash: sent.targetHash,
      authorizationRevision: response.body.authorizationRevision,
      behaviorBindingHash: response.body.behaviorBindingHash,
      checkedAt: response.body.checkedAt,
    })
    expect(payload.sub).toBe(SUBJECT)
    // Witness: the route ran the checkpoint once.
    expect(authority.checkpointCalls).toBe(1)
  })

  it('round-trips a checkpoint-issued assertion through the Host verifier and the shared validator', async () => {
    const sent = checkpointRequest('host.status.read')
    const response = await checkpoint(sent).expect(200)
    const payload = verifyAsHost(response.body.hostEdgeAssertion)
    // The Host does not accept v 2 yet; the round trip stops at the claim validator.
    expect(
      validateHostEdgeAssertionClaims(payload, {
        v: 2,
        iss: config.rpcJwtIssuer,
        host: HOST_LOGICAL_ID,
        sub: SUBJECT,
        operationId: 'host.status.read',
        delegationJti: DELEGATION_JTI,
        sid: SID,
        sessionVersion: 3,
        accessPathId: ACCESS_PATH_ID,
        pathKind: 'direct',
        effectiveTeamId: null,
        resource: JSON.parse(JSON.stringify(resource)),
        targetHash: sent.targetHash,
        authorizationRevision: AUTHORIZATION_REVISION,
        behaviorBindingHash: BEHAVIOR_BINDING_HASH,
        checkedAt: response.body.checkedAt,
      })
    ).toEqual({ ok: true })
    // rpc-proxy reads the whole response through the shared checkpoint response validator.
    expect(validateActionAuthorityCheckpointResponse(response.body)).toEqual(response.body)
    expect(authority.checkpointCalls).toBe(1)
  })

  it('bounds the expiry by validUntil', async () => {
    const validUntil = new Date(Date.now() + 60_000).toISOString()
    allowAuthorization({ validUntil })
    const response = await checkpoint(checkpointRequest('host.status.read')).expect(200)
    const payload = verifyAsHost(response.body.hostEdgeAssertion)
    expect(payload.exp).toBe(Math.floor(Date.parse(validUntil) / 1000))
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60)
    expect(authority.checkpointCalls).toBe(1)
  })

  it('carries the team path attribution', async () => {
    allowAuthorization({ pathKind: 'team', effectiveTeamId: TEAM_ID })
    const response = await checkpoint(checkpointRequest('host.status.read')).expect(200)
    expect(verifyAsHost(response.body.hostEdgeAssertion)).toMatchObject({
      pathKind: 'team',
      effectiveTeamId: TEAM_ID,
    })
    expect(authority.checkpointCalls).toBe(1)
  })

  it('returns the admission receipt and the assertion together for a Host message', async () => {
    const response = await checkpoint(checkpointRequest('chat.message.invoke')).expect(200)
    expect(Object.keys(response.body).sort()).toEqual(
      [...ALLOWED_KEYS, 'hostEdgeAssertion', 'hostMessageAdmissionReceipt'].sort()
    )
    expect(verifyAsHost(response.body.hostEdgeAssertion)).toMatchObject({
      v: 2,
      operationId: 'chat.message.invoke',
      host: HOST_LOGICAL_ID,
    })
    expect(response.body.hostEdgeAssertion).not.toBe(response.body.hostMessageAdmissionReceipt)
    expect(validateActionAuthorityCheckpointResponse(response.body)).toEqual(response.body)
    expect(admission.checkAndIncrement).toHaveBeenCalledTimes(1)
    expect(authority.checkpointCalls).toBe(1)
  })

  it('answers 400 invalid_binding when validUntil leaves no lifetime', async () => {
    // validUntil at the current whole second: the bounded expiry equals the issue second.
    allowAuthorization({ validUntil: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() })
    const response = await checkpoint(checkpointRequest('host.status.read')).expect(400)
    expect(response.body).toEqual({
      version: 2,
      status: 'invalid_binding',
      code: 'invalid_binding',
    })
    // Witness: the checkpoint allowed the action before signing was refused.
    expect(authority.checkpointCalls).toBe(1)
  })
})

describe('V2 checkpoint issues no Host edge assertion outside an allowed rpc-proxy Host checkpoint', () => {
  it.each([
    { name: 'caller workflow-recipes', caller: 'workflow-recipes' },
    { name: 'caller mcp-host', caller: 'mcp-host' },
  ])('allowed Host checkpoint for $name', async ({ caller }) => {
    const response = await checkpoint(checkpointRequest('host.status.read', caller), caller).expect(
      200
    )
    expect(response.body.status).toBe('allowed')
    expect(response.body.destination).toMatchObject({ kind: 'host' })
    expect(response.body).not.toHaveProperty('hostEdgeAssertion')
    expect(validateActionAuthorityCheckpointResponse(response.body)).toEqual(response.body)
    expect(Object.keys(response.body).sort()).toEqual(ALLOWED_KEYS)
    expect(authority.checkpointCalls).toBe(1)
  })

  it.each([
    {
      name: 'an mcp_server destination',
      destination: {
        kind: 'mcp_server',
        ref: 'mcp-server/files',
        url: 'http://files.mcp-server.svc.cluster.local:8080',
      },
    },
    { name: 'a null destination', destination: null },
  ])('allowed rpc-proxy checkpoint with $name', async ({ destination }) => {
    authority.resolveDestination = async () => ({ status: 'resolved', destination })
    const response = await checkpoint(checkpointRequest('host.status.read')).expect(200)
    expect(response.body.status).toBe('allowed')
    expect(response.body.destination).toEqual(destination)
    // The validator runs before the key check, so an assertion on a non-Host destination is
    // refused by the shared contract that rpc-proxy applies.
    expect(validateActionAuthorityCheckpointResponse(response.body)).toEqual(response.body)
    expect(response.body).not.toHaveProperty('hostEdgeAssertion')
    expect(Object.keys(response.body).sort()).toEqual(ALLOWED_KEYS)
    expect(authority.checkpointCalls).toBe(1)
  })

  it.each([
    {
      name: 'denied',
      outcome: { status: 'denied' },
      status: 403,
      body: { version: 2, status: 'denied', code: 'forbidden' },
    },
    {
      name: 'not found',
      outcome: { status: 'not_found' },
      status: 404,
      body: { version: 2, status: 'not_found', code: 'not_found' },
    },
    {
      name: 'stale',
      outcome: {
        status: 'access_path_stale',
        currentAuthorizationRevision: `ar1_${'d'.repeat(43)}`,
      },
      status: 409,
      body: {
        version: 2,
        status: 'access_path_stale',
        code: 'access_path_stale',
        currentAuthorizationRevision: `ar1_${'d'.repeat(43)}`,
      },
    },
    {
      name: 'unavailable',
      outcome: { status: 'authority_unavailable' },
      status: 503,
      body: {
        version: 2,
        status: 'authority_unavailable',
        code: 'authority_unavailable',
        retryable: true,
      },
    },
    {
      name: 'invalid',
      outcome: { status: 'invalid_binding' },
      status: 400,
      body: { version: 2, status: 'invalid_binding', code: 'invalid_binding' },
    },
  ])('$name checkpoint', async ({ outcome, status, body }) => {
    authority.authorize = async () => outcome
    const response = await checkpoint(checkpointRequest('host.status.read')).expect(status)
    expect(response.body).toEqual(body)
    expect(authority.checkpointCalls).toBe(1)
  })

  it('a request that fails parsing, before any checkpoint', async () => {
    const valid = checkpointRequest('host.status.read')
    const response = await checkpoint({ ...valid, targetHash: `ath2_${'z'.repeat(43)}` }).expect(
      400
    )
    expect(response.body).toEqual({
      version: 2,
      status: 'invalid_binding',
      code: 'invalid_binding',
    })
    expect(authority.checkpointCalls).toBe(0)
    // Witness: the same route issues an assertion for the valid request.
    const allowed = await checkpoint(valid).expect(200)
    expect(allowed.body.hostEdgeAssertion).toEqual(expect.any(String))
    expect(authority.checkpointCalls).toBe(1)
  })

  it('the action context switched off (409 action_context_disabled)', async () => {
    accessPolicy.resolveEffectiveUserAccessPolicy.mockResolvedValueOnce({ actionContextV2: false })
    const disabled = await checkpoint(checkpointRequest('host.status.read')).expect(409)
    expect(disabled.body).toEqual({
      version: 2,
      status: 'conflict',
      code: 'action_context_disabled',
    })
    expect(authority.checkpointCalls).toBe(0)
    // Witness: the policy was read, and with the policy on the route issues the assertion.
    expect(accessPolicy.resolveEffectiveUserAccessPolicy).toHaveBeenCalledTimes(1)
    const allowed = await checkpoint(checkpointRequest('host.status.read')).expect(200)
    expect(allowed.body.hostEdgeAssertion).toEqual(expect.any(String))
    expect(authority.checkpointCalls).toBe(1)
  })
})

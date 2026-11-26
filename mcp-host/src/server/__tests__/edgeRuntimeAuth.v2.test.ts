import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Response as ExpressResponse, Request } from 'express'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import request from 'supertest'
import {
  type ActionOperationId,
  HOST_EDGE_ASSERTION_HEADER,
  type TrustedEdgeActionContextV2,
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { signHostEdgeTestAssertion } from '../../__tests__/rpcProxyEdgeTestHeaders'
import {
  legacyMcpHostConsumer,
  legacyRpcProxyHostProducer,
} from './fixtures/rpcProxyEdgeProtocolV0'

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const delegationJti = '33333333-3333-4333-8333-333333333333'
type RpcProxyAction = {
  trustedEdgeHeader: string
  checkpoint: {
    destination: { kind: 'host'; ref: string; url: string } | null
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type RpcProxyActionInput = {
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  target: Record<string, string>
}
type SetupOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Setup, not behaviour under test: the control-api checkpoint producer runs in
// a `tsx` child process. `beforeAll` runs it once per input below, so no test
// body starts a process, and records its output or the error it failed with. A
// recorded error is rethrown by `rpcProxyActionFor`: a broken producer fails
// the tests that call it, with its own error, and the other tests still run.
// Each child has its own `timeout`: a child that is too slow is recorded as an
// ETIMEDOUT error and fails only the tests of its input.
// An input that is not listed here has no checkpoint and fails its test.
// Every call still builds fresh claims and a fresh admission nonce. The
// recorded chat.message.invoke checkpoint carries the receipt minted for the
// setup call; `authorizeActionV2` requires a receipt and never verifies it.
const PRODUCER_CHILD_TIMEOUT_MS = 240_000
const chatMessageInvokeInput: RpcProxyActionInput = {
  operationId: 'chat.message.invoke',
  resourceType: 'host',
  target: {
    hostRef: 'mcp-host/chatllm',
    channelType: 'rpc',
    channelId: 'chatllm',
    messageId: '44444444-4444-4444-8444-444444444444',
  },
}
const producerInputs: readonly RpcProxyActionInput[] = [
  chatMessageInvokeInput,
  {
    operationId: 'session.read',
    resourceType: 'runtime_session',
    target: { hostRef: 'mcp-host/chatllm' },
  },
]
// One child limit per input, plus 120 s for the imports the hook awaits.
const PRODUCER_SETUP_TIMEOUT_MS = producerInputs.length * PRODUCER_CHILD_TIMEOUT_MS + 120_000
const producerStdout = new Map<string, SetupOutcome<string>>()

async function recordSetup<T>(run: () => T | Promise<T>): Promise<SetupOutcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

function setupValue<T>(outcome: SetupOutcome<T> | undefined, name: string): T {
  if (!outcome) throw new Error(`${name} was not set up in beforeAll`)
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

function producerKey(input: RpcProxyActionInput): string {
  return JSON.stringify([input.operationId, input.resourceType, input.target])
}

function rpcProxyAuthorityInputs(input: RpcProxyActionInput) {
  const resource = canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: input.resourceType,
    logicalId: 'mcp-host/chatllm',
    displayName: 'chatllm',
  })
  const target = validateActionOperationTarget({
    operationId: input.operationId,
    resource,
    operationTarget: input.target,
  })
  const targetHash = hashActionTarget(target)
  const claims = {
    typ: 'user_delegation' as const,
    ver: 2 as const,
    sub: userId,
    sid,
    sv: 7,
    jti: delegationJti,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    operationIds: [input.operationId],
    scopes: [actionOperationScope(input.operationId)],
    resource,
    targets: { [input.operationId]: target },
    targetHashes: { [input.operationId]: targetHash },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind: 'direct' as const,
    effectiveTeamId: null,
  }
  const hostMessageAdmission =
    input.operationId === 'chat.message.invoke'
      ? {
          sendNonce: randomBytes(32).toString('base64url'),
          delegationExpiresAt: claims.exp,
        }
      : undefined
  return { resource, target, targetHash, claims, hostMessageAdmission }
}

function produceCheckpoint(input: RpcProxyActionInput): string {
  const { resource, target, targetHash, claims, hostMessageAdmission } =
    rpcProxyAuthorityInputs(input)
  const repositoryRoot = resolve(process.cwd(), '..')
  return execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(
        repositoryRoot,
        'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
      ),
      JSON.stringify({
        request: {
          version: 2,
          principal: { sub: claims.sub, sid: claims.sid, sessionVersion: claims.sv },
          delegationJti: claims.jti,
          resource,
          operationId: input.operationId,
          target,
          targetHash,
          accessPathId: claims.accessPathId,
          authorizationRevision: claims.authorizationRevision,
          behaviorBindingHash: claims.behaviorBindingHash,
          ...(hostMessageAdmission ? { hostMessageAdmission } : {}),
          domain: { service: 'rpc-proxy', resource, targetHash },
        },
        destination: {
          kind: 'host',
          ref: 'mcp-host/chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        },
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: PRODUCER_CHILD_TIMEOUT_MS }
  )
}

beforeAll(async () => {
  for (const input of producerInputs) {
    producerStdout.set(producerKey(input), await recordSetup(() => produceCheckpoint(input)))
  }
  // The tests import these modules after `vi.resetModules()`. Importing them
  // here first makes Vitest compile them outside any test body. This runs
  // before `beforeEach` mocks `../../config`, so here they load the real
  // config. The results are not used: every test imports again and reports a
  // failing module itself.
  await Promise.allSettled([
    import(`${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`),
    import('../edgeRuntimeAuth'),
    import('../routes'),
    import('./testHelpers'),
  ])
}, PRODUCER_SETUP_TIMEOUT_MS)

async function rpcProxyActionFor(input: RpcProxyActionInput): Promise<RpcProxyAction> {
  // Keep the real producer out of mcp-host's TypeScript rootDir while Vitest
  // loads it from the sibling service for the cross-service contract proof.
  const producerModule = `${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`
  const { authorizeActionV2 } = (await import(producerModule)) as {
    authorizeActionV2: (
      claims: unknown,
      bound: unknown,
      options: unknown
    ) => Promise<RpcProxyAction>
  }
  const { target, targetHash, claims, hostMessageAdmission } = rpcProxyAuthorityInputs(input)
  const key = producerKey(input)
  const checkpoint = JSON.parse(
    setupValue(producerStdout.get(key), `the checkpoint producer for ${key}`)
  )
  const authorized = await authorizeActionV2(
    claims,
    { operationId: input.operationId, target, targetHash },
    {
      hostMessageAdmission,
      fetchImpl: vi.fn().mockResolvedValue(
        new globalThis.Response(JSON.stringify(checkpoint), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ) as typeof fetch,
    }
  )
  return authorized
}

async function rpcProxyHeaderFor(input: {
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  target: Record<string, string>
}): Promise<string> {
  return (await rpcProxyActionFor(input)).trustedEdgeHeader
}

async function realRpcProxyAction(): Promise<RpcProxyAction> {
  return rpcProxyActionFor(chatMessageInvokeInput)
}

async function realRpcProxyHeader(): Promise<string> {
  return (await realRpcProxyAction()).trustedEdgeHeader
}

describe('runtimeEdgeGuard v2', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../config', () => ({
      config: {
        hostName: 'chatllm',
        namespace: 'mcp-host',
        authJwtPublicKey: process.env.CLERUM_AUTH_JWT_PUBLIC_KEY,
        authJwtIssuer: 'control-api',
      },
    }))
  })

  async function runRuntimeGuard(
    operations: readonly ['chat.message.invoke'] | readonly ['task.read'],
    headers: Record<string, string>
  ) {
    const { runtimeEdgeGuard, getRuntimeCallerContext } = await import('../edgeRuntimeAuth')
    const req = {
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
      ),
    } as Request
    const response = { status: 200, body: undefined as unknown }
    const res = {
      status(code: number) {
        response.status = code
        return this
      },
      json(body: unknown) {
        response.body = body
        return this
      },
    } as unknown as ExpressResponse
    let continued = false
    runtimeEdgeGuard(['rpc-proxy', 'channel-reader'], operations, 'host:message:invoke')(
      req,
      res,
      () => {
        continued = true
      }
    )
    return {
      status: continued ? 200 : response.status,
      body: continued ? getRuntimeCallerContext(req) : response.body,
    }
  }

  const MISSING = { error: 'Missing runtime edge assertion' }
  const INVALID = { error: 'Invalid runtime edge assertion' }

  function v1Assertion(sub = userId): string {
    return signHostEdgeTestAssertion({ sub, host: 'mcp-host/chatllm' })
  }

  function v2Assertion(): string {
    return signHostEdgeTestAssertion({
      sub: userId,
      host: 'mcp-host/chatllm',
      v: 2,
      claims: { teamId: undefined, scopes: undefined },
    })
  }

  /** The V1 request rpc-proxy forwards: clear headers plus the edge assertion. */
  function v1Headers(hostRef = 'chatllm'): Record<string, string> {
    return {
      ...legacyRpcProxyHostProducer({ userId, hostRef }),
      [HOST_EDGE_ASSERTION_HEADER]: v1Assertion(),
    }
  }

  function v2EnvelopeHeaders(hostRef: string, actionContext: string): Record<string, string> {
    return {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': hostRef,
      'x-clerum-edge-action-context': actionContext,
    }
  }

  it('refuses the real rpc-proxy V2 producer until the Host accepts V2 assertions', async () => {
    // The envelope comes from the real rpc-proxy producer. The headers are the
    // V2 headers rpc-proxy forwards with it, so the refusal is the Host's own.
    const authorizedActionV2 = await realRpcProxyAction()
    const envelope = v2EnvelopeHeaders('chatllm', authorizedActionV2.trustedEdgeHeader)
    expect(await runRuntimeGuard(['chat.message.invoke'], envelope)).toEqual({
      status: 401,
      body: MISSING,
    })
    expect(
      await runRuntimeGuard(['chat.message.invoke'], {
        ...envelope,
        [HOST_EDGE_ASSERTION_HEADER]: v2Assertion(),
      })
    ).toEqual({ status: 401, body: INVALID })

    // Liveness witness: the guard admits the V1 request for the same user.
    const v1 = await runRuntimeGuard(['chat.message.invoke'], v1Headers())
    expect(v1.status).toBe(200)
    expect(v1.body).toMatchObject({ caller: 'rpc-proxy', userId })
    expect(v1.body).not.toHaveProperty('actionContextV2')

    const decoded = JSON.parse(
      Buffer.from(authorizedActionV2.trustedEdgeHeader, 'base64url').toString('utf8')
    ) as Record<string, unknown>
    expect(decoded).not.toHaveProperty('hostMessageAdmission')
    expect(decoded).not.toHaveProperty('hostMessageAdmissionReceipt')
    expect(decoded).not.toHaveProperty('sendNonce')
  })

  it('refuses a real session.read edge envelope before the session-search consumer', async () => {
    const header = await rpcProxyHeaderFor({
      operationId: 'session.read',
      resourceType: 'runtime_session',
      target: { hostRef: 'mcp-host/chatllm' },
    })
    const { runtimeEdgeGuard } = await import('../edgeRuntimeAuth')
    const { handleSessionSearchRoute } = await import('../routes')
    const { makeHandlers } = await import('./testHelpers')
    const sessionSearchHandler = vi.fn().mockResolvedValue({ results: [], total: 0 })
    const guard = runtimeEdgeGuard(['rpc-proxy'], ['session.read'], 'host:session:read')
    const app = express()
    app.get('/search', guard, async (req, res) => {
      await handleSessionSearchRoute(req, res, makeHandlers({ sessionSearchHandler }))
    })
    const probe = vi.fn()
    app.get('/probe', guard, (_req, res) => {
      probe()
      res.status(200).json({ ok: true })
    })

    for (const assertion of [undefined, v2Assertion()]) {
      const response = await request(app)
        .get('/search?q=budget')
        .set({
          ...v2EnvelopeHeaders('chatllm', header),
          ...(assertion ? { [HOST_EDGE_ASSERTION_HEADER]: assertion } : {}),
        })
      expect(response.status).toBe(401)
      expect(response.body).toEqual(assertion ? INVALID : MISSING)
    }
    expect(sessionSearchHandler).not.toHaveBeenCalled()

    // Liveness witness: the same guard admits a V1 request with its assertion.
    const v1 = await request(app)
      .get('/probe')
      .set({
        ...v1Headers(),
        [HOST_EDGE_ASSERTION_HEADER]: signHostEdgeTestAssertion({
          sub: userId,
          host: 'mcp-host/chatllm',
          scopes: ['host:session:read'],
        }),
      })
    expect(v1.status).toBe(200)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('refuses operation substitution and mixed legacy authority headers', async () => {
    const header = await realRpcProxyHeader()
    const mismatch = await runRuntimeGuard(['task.read'], {
      ...v2EnvelopeHeaders('chatllm', header),
      [HOST_EDGE_ASSERTION_HEADER]: v2Assertion(),
    })
    expect(mismatch).toEqual({ status: 401, body: INVALID })

    const mixed = await runRuntimeGuard(['chat.message.invoke'], {
      ...v2EnvelopeHeaders('chatllm', header),
      'x-clerum-edge-user-id': 'attacker',
      [HOST_EDGE_ASSERTION_HEADER]: v1Assertion('attacker'),
    })
    expect(mixed).toEqual({ status: 401, body: { error: 'Missing runtime edge caller context' } })
  })

  it('rejects target/hash substitution in an otherwise valid envelope', async () => {
    const header = await realRpcProxyHeader()
    const decoded = JSON.parse(
      Buffer.from(header, 'base64url').toString('utf8')
    ) as TrustedEdgeActionContextV2
    const substituted = Buffer.from(
      JSON.stringify({ ...decoded, target: { ...decoded.target, channelId: 'other-host' } }),
      'utf8'
    ).toString('base64url')
    const response = await runRuntimeGuard(
      ['chat.message.invoke'],
      v2EnvelopeHeaders('chatllm', substituted)
    )
    expect(response).toEqual({
      status: 401,
      body: { error: 'Missing runtime edge caller context' },
    })
  })

  it('rejects unknown authority fields in the producer-built envelope', async () => {
    const header = await realRpcProxyHeader()
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const extended = Buffer.from(
      JSON.stringify({ ...decoded, hostMessageAdmissionReceipt: 'not-for-downstream' }),
      'utf8'
    ).toString('base64url')
    const response = await runRuntimeGuard(
      ['chat.message.invoke'],
      v2EnvelopeHeaders('chatllm', extended)
    )
    expect(response).toEqual({
      status: 401,
      body: { error: 'Missing runtime edge caller context' },
    })
  })

  it('keeps legacy caller context separate from V2 authority', async () => {
    const legacy = await runRuntimeGuard(['chat.message.invoke'], v1Headers())
    expect(legacy.status).toBe(200)
    expect(legacy.body).toMatchObject({ caller: 'rpc-proxy', userId })
    expect(legacy.body).not.toHaveProperty('actionContextV2')

    const forgedV2 = await runRuntimeGuard(['chat.message.invoke'], {
      ...v1Headers(),
      'x-clerum-edge-action-context': await realRpcProxyHeader(),
    })
    expect(forgedV2).toEqual({
      status: 401,
      body: { error: 'Missing runtime edge caller context' },
    })
  })

  it('keeps the Host name check on a V1 request with a valid assertion', async () => {
    const response = await runRuntimeGuard(['chat.message.invoke'], v1Headers('another-host'))
    expect(response).toEqual({ status: 403, body: { error: 'Runtime edge host mismatch' } })
    // Liveness witness: the same request naming the receiving Host is admitted.
    expect((await runRuntimeGuard(['chat.message.invoke'], v1Headers())).status).toBe(200)
  })

  it('rejects a producer-built V2 envelope at and after its expiresAt', async () => {
    // The envelope is not edited: an edited expiresAt is either rejected
    // against checkedAt or is no longer the producer's envelope. Only the
    // clock the guard reads moves.
    const header = await realRpcProxyHeader()
    const { expiresAt } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      expiresAt: string
    }
    const expiresAtMs = Date.parse(expiresAt)
    expect(Number.isFinite(expiresAtMs)).toBe(true)
    const headers = v2EnvelopeHeaders('chatllm', header)

    // Liveness witness: before expiresAt the envelope parses, so the guard
    // reaches the assertion check, which refuses a V2 request without one.
    expect(await runRuntimeGuard(['chat.message.invoke'], headers)).toEqual({
      status: 401,
      body: MISSING,
    })

    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(expiresAtMs - 1)
    expect(await runRuntimeGuard(['chat.message.invoke'], headers)).toEqual({
      status: 401,
      body: MISSING,
    })

    clock.mockReturnValue(expiresAtMs)
    expect(await runRuntimeGuard(['chat.message.invoke'], headers)).toEqual({
      status: 401,
      body: { error: 'Missing runtime edge caller context' },
    })

    clock.mockReturnValue(expiresAtMs + 60_000)
    expect(await runRuntimeGuard(['chat.message.invoke'], headers)).toEqual({
      status: 401,
      body: { error: 'Missing runtime edge caller context' },
    })
  })

  it('proves the old/new rpc-proxy and Host compatibility matrix', async () => {
    // Old rpc-proxy: clear headers only (frozen fixture). New rpc-proxy: the
    // same clear headers plus the edge assertion control-api signed.
    const oldProxyHeaders = legacyRpcProxyHostProducer({ userId, hostRef: 'chatllm' })
    const newProxyHeaders = v1Headers()
    const oldHost = legacyMcpHostConsumer()
    const newHost = (headers: Record<string, string>) => runRuntimeGuard(['task.read'], headers)

    expect((await request(oldHost).post('/v1/runtime/messages').set(oldProxyHeaders)).status).toBe(
      200
    )
    expect((await request(oldHost).post('/v1/runtime/messages').set(newProxyHeaders)).status).toBe(
      200
    )
    expect((await newHost(newProxyHeaders)).status).toBe(200)
    expect(await newHost(oldProxyHeaders)).toEqual({ status: 401, body: MISSING })
  })

  it('rejects V2 authority injected into otherwise legacy caller context', async () => {
    const actionContextV2 = await realRpcProxyHeader()
    const injectedLegacyHeaders = {
      ...v1Headers(),
      'x-clerum-edge-action-context': actionContextV2,
    }
    const response = await runRuntimeGuard(['chat.message.invoke'], injectedLegacyHeaders)
    expect(response.status).toBe(401)
  })

  it('rejects Authorization and V2 authority asserted by another caller', async () => {
    const actionContext = await realRpcProxyHeader()
    const authorization = await runRuntimeGuard(['task.read'], {
      ...v1Headers(),
      authorization: 'Bearer unrelated-token',
    })
    expect(authorization).toEqual({
      status: 401,
      body: { error: 'Authorization is not accepted on this direct mcp-host runtime route' },
    })

    const otherCaller = await runRuntimeGuard(['task.read'], {
      'x-clerum-edge-caller': 'workflow-approval-request-reader',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-action-context': actionContext,
      [HOST_EDGE_ASSERTION_HEADER]: v2Assertion(),
    })
    expect(otherCaller).toEqual({
      status: 401,
      body: { error: 'Missing authenticated rpc-proxy service context' },
    })
    // Liveness witness: the same guard admits the V1 request.
    expect((await runRuntimeGuard(['task.read'], v1Headers())).status).toBe(200)
  })

  it('rejects standalone V2 authority headers on the legacy path', async () => {
    const response = await runRuntimeGuard(['task.read'], {
      ...v1Headers(),
      'x-clerum-edge-access-path-id': `ap1_${'b'.repeat(43)}`,
    })
    expect(response).toEqual({
      status: 401,
      body: { error: 'Unsupported runtime V2 authority header' },
    })
  })

  it('keeps the independent channel-reader caller path working without an assertion', async () => {
    const response = await runRuntimeGuard(['chat.message.invoke'], {
      'x-clerum-edge-caller': 'channel-reader',
      'x-clerum-edge-host-ref': 'chatllm',
      'x-clerum-edge-channel-type': 'telegram',
      'x-clerum-edge-channel-id': 'chatllm',
      'x-clerum-edge-sender': 'sender-1',
    })

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('caller', 'channel-reader')
  })
})

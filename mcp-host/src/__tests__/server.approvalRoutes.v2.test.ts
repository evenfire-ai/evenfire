import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import {
  type ActionOperationId,
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { withRpcProxyEdgeTestAuthentication } from './rpcProxyEdgeTestHeaders'

// The approve and deny mounts in `server.ts` pass `['task.manage']` as the V2
// operation allowlist of `runtimeEdgeGuard`. These tests drive a real
// `RPCServer` with envelopes built by the real rpc-proxy producer, so the
// allowlist is read from the mounts themselves, not from an ad-hoc app.

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const delegationJti = '33333333-3333-4333-8333-333333333333'
const taskId = '60000000-0000-4000-8000-000000000006'
const approvalRequestId = '70000000-0000-4000-8000-000000000007'

const originalEnv = new Map<string, string | undefined>()
const envKeys = ['CLERUM_ENABLE_AUTH', 'CLERUM_HOST_NAME', 'CLERUM_NAMESPACE']

type RpcProxyAction = { trustedEdgeHeader: string }
type RpcProxyActionInput = {
  operationId: ActionOperationId
  resourceType: 'host' | 'runtime_session'
  target: Record<string, string>
}
type SetupOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Setup, not behaviour under test, copied from
// `server/__tests__/edgeRuntimeAuth.v2.test.ts`: the control-api checkpoint
// producer runs in a `tsx` child process once per input in `beforeAll`, and
// its output or error is recorded. A recorded error fails only the tests that
// use that input. Every test builds its own envelope from the recorded
// checkpoint with fresh claims, so no envelope can expire between setup and
// use.
const PRODUCER_CHILD_TIMEOUT_MS = 240_000
const approveInput: RpcProxyActionInput = {
  operationId: 'task.manage',
  resourceType: 'runtime_session',
  target: { hostRef: 'mcp-host/chatllm', taskId, action: 'approve', approvalRequestId },
}
const denyInput: RpcProxyActionInput = {
  operationId: 'task.manage',
  resourceType: 'runtime_session',
  target: { hostRef: 'mcp-host/chatllm', taskId, action: 'deny', approvalRequestId },
}
const sessionReadInput: RpcProxyActionInput = {
  operationId: 'session.read',
  resourceType: 'runtime_session',
  target: { hostRef: 'mcp-host/chatllm' },
}
const producerInputs: readonly RpcProxyActionInput[] = [approveInput, denyInput, sessionReadInput]
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
  return { resource, target, targetHash, claims }
}

function produceCheckpoint(input: RpcProxyActionInput): string {
  const { resource, target, targetHash, claims } = rpcProxyAuthorityInputs(input)
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
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  for (const input of producerInputs) {
    producerStdout.set(producerKey(input), await recordSetup(() => produceCheckpoint(input)))
  }
  // Compile the producer outside any test body. The result is not used: every
  // test imports it again and reports a failing module itself.
  await Promise.allSettled([import(`${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`)])
}, PRODUCER_SETUP_TIMEOUT_MS)

afterAll(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

async function rpcProxyHeaderFor(input: RpcProxyActionInput): Promise<string> {
  // Keep the real producer out of mcp-host's TypeScript rootDir while Vitest
  // loads it from the sibling service.
  const producerModule = `${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`
  const { authorizeActionV2 } = (await import(producerModule)) as {
    authorizeActionV2: (
      claims: unknown,
      bound: unknown,
      options: unknown
    ) => Promise<RpcProxyAction>
  }
  const { target, targetHash, claims } = rpcProxyAuthorityInputs(input)
  const key = producerKey(input)
  const checkpoint = JSON.parse(
    setupValue(producerStdout.get(key), `the checkpoint producer for ${key}`)
  )
  const authorized = await authorizeActionV2(
    claims,
    { operationId: input.operationId, target, targetHash },
    {
      fetchImpl: vi.fn().mockResolvedValue(
        new globalThis.Response(JSON.stringify(checkpoint), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ) as typeof fetch,
    }
  )
  return authorized.trustedEdgeHeader
}

async function withServer(
  run: (baseUrl: string, onApproval: ReturnType<typeof vi.fn>) => Promise<void>
) {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  // `config.namespace` reads CLERUM_NAMESPACE; the envelope target is
  // `mcp-host/chatllm`, so the Host must run in namespace `mcp-host`.
  process.env.CLERUM_NAMESPACE = 'mcp-host'
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  const onApproval = vi.fn().mockResolvedValue({ success: true })
  server.onApproval(onApproval)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, onApproval)
  } finally {
    await server.stop()
    vi.resetModules()
  }
}

function postDecision(
  baseUrl: string,
  route: 'approve' | 'deny',
  actionContext: string
): Promise<Response> {
  // The body rpc-proxy relays to the Host for each route.
  const body: Record<string, unknown> = { userId, taskId, requestId: approvalRequestId }
  if (route === 'approve') body.alwaysApprove = false
  return fetch(`${baseUrl}/v1/runtime/approvals/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...withRpcProxyEdgeTestAuthentication({
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-host-ref': 'chatllm',
        'x-clerum-edge-action-context': actionContext,
      }),
    },
    body: JSON.stringify(body),
  })
}

describe('mounted approval routes with V2 authority', () => {
  it('admits a producer-built task.manage approve envelope on the approve mount', async () => {
    await withServer(async (baseUrl, onApproval) => {
      const response = await postDecision(baseUrl, 'approve', await rpcProxyHeaderFor(approveInput))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(onApproval).toHaveBeenCalledTimes(1)
      expect(onApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          requestId: approvalRequestId,
          approved: true,
          channelType: 'rpc',
          channelId: 'chatllm',
        })
      )
    })
  })

  it('admits a producer-built task.manage deny envelope on the deny mount', async () => {
    await withServer(async (baseUrl, onApproval) => {
      const response = await postDecision(baseUrl, 'deny', await rpcProxyHeaderFor(denyInput))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(onApproval).toHaveBeenCalledTimes(1)
      expect(onApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          requestId: approvalRequestId,
          approved: false,
          channelType: 'rpc',
          channelId: 'chatllm',
        })
      )
    })
  })

  it('rejects another V2 operation on the approve and deny mounts', async () => {
    await withServer(async (baseUrl, onApproval) => {
      for (const route of ['approve', 'deny'] as const) {
        const response = await postDecision(
          baseUrl,
          route,
          await rpcProxyHeaderFor(sessionReadInput)
        )
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Runtime edge operation mismatch' })
      }
      expect(onApproval).not.toHaveBeenCalled()

      // Liveness witness: the same server admits the matching task.manage
      // envelope, so the rejections above came from the guard, not from a
      // server that never reaches the handler.
      const admitted = await postDecision(baseUrl, 'approve', await rpcProxyHeaderFor(approveInput))
      expect(admitted.status).toBe(200)
      expect(onApproval).toHaveBeenCalledTimes(1)
    })
  })
})

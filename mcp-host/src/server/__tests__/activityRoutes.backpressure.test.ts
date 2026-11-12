import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { HostActivityHub } from '../../activityHub'
import { parseTrustedEdgeActionContext } from '../edgeRuntimeAuth'
import { handleActivityStreamRoute } from '../routes'
import type { HostActivityEvent } from '../types'
import { makeHandlers } from './testHelpers'

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const delegationJti = '33333333-3333-4333-8333-333333333333'

const ACTIVITY_OPERATION_IDS = ['host.activity.read', 'host.activity.read_all'] as const
type ActivityOperationId = (typeof ACTIVITY_OPERATION_IDS)[number]
type AuthorizeActionV2 = (
  delegation: unknown,
  bound: unknown,
  options: unknown
) => Promise<{ trustedEdgeHeader: string }>
type SetupOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Setup, not behaviour under test: the control-api checkpoint producer runs in
// a `tsx` child process, and Vitest compiles the rpc-proxy authority module on
// its first import. `beforeAll` runs both once, so no test body starts a
// process, and records each result or the error it failed with. A recorded
// error is rethrown by `realActivityContext`: a broken producer fails the tests
// that call it, with its own error, and the other tests still run. Each child
// has its own `timeout`: a child that is too slow is recorded as an ETIMEDOUT
// error and fails only the tests of its operation. The producer request
// depends only on the operation; its other fields are constants here.
const PRODUCER_CHILD_TIMEOUT_MS = 240_000
// One child limit per operation, plus 120 s for the import the hook awaits.
const PRODUCER_SETUP_TIMEOUT_MS =
  ACTIVITY_OPERATION_IDS.length * PRODUCER_CHILD_TIMEOUT_MS + 120_000
const producerStdout = new Map<ActivityOperationId, SetupOutcome<string>>()
let rpcProxyAuthority: SetupOutcome<{ authorizeActionV2: AuthorizeActionV2 }> | undefined

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

function activityAuthorityInputs(operationId: ActivityOperationId) {
  const resource = canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: 'host',
    logicalId: 'mcp-host/chatllm',
    displayName: 'chatllm',
  })
  const target = validateActionOperationTarget({
    operationId,
    resource,
    operationTarget: {
      hostRef: 'mcp-host/chatllm',
      visibility: operationId === 'host.activity.read_all' ? 'host_all' : 'caller_path',
    },
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
    operationIds: [operationId],
    scopes: [actionOperationScope(operationId)],
    resource,
    targets: { [operationId]: target },
    targetHashes: { [operationId]: targetHash },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind: 'direct' as const,
    effectiveTeamId: null,
  }
  return { resource, target, targetHash, claims }
}

function produceCheckpoint(operationId: ActivityOperationId): string {
  const { resource, target, targetHash, claims } = activityAuthorityInputs(operationId)
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
          operationId,
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
  for (const operationId of ACTIVITY_OPERATION_IDS) {
    producerStdout.set(operationId, await recordSetup(() => produceCheckpoint(operationId)))
  }
  rpcProxyAuthority = await recordSetup(
    () =>
      import(`${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`) as Promise<{
        authorizeActionV2: AuthorizeActionV2
      }>
  )
}, PRODUCER_SETUP_TIMEOUT_MS)

async function realActivityContext(operationId: ActivityOperationId = 'host.activity.read') {
  const { target, targetHash, claims } = activityAuthorityInputs(operationId)
  const checkpoint = JSON.parse(
    setupValue(producerStdout.get(operationId), `the ${operationId} checkpoint producer`)
  )
  const { authorizeActionV2 } = setupValue(rpcProxyAuthority, 'the rpc-proxy authority module')
  const authorized = await authorizeActionV2(
    claims,
    { operationId, target, targetHash },
    {
      fetchImpl: vi.fn().mockResolvedValue(
        new globalThis.Response(JSON.stringify(checkpoint), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ) as typeof fetch,
    }
  )
  const context = parseTrustedEdgeActionContext(authorized.trustedEdgeHeader)
  if (!context) throw new Error('real rpc-proxy activity authority did not parse at the Host')
  return context
}

function streamRequest(actionContextV2: unknown): Request {
  return {
    query: {},
    runtimeCaller: { caller: 'rpc-proxy', userId, actionContextV2 },
  } as unknown as Request
}

function slowWritable() {
  const writes: string[] = []
  let closeListener: (() => void) | undefined
  let ended = false
  let writeReturnedFalse = false
  let bufferedBytes = 0
  let writesAfterEnd = 0
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      if (ended) writesAfterEnd += 1
      writes.push(chunk)
      if (writeReturnedFalse) {
        bufferedBytes += Buffer.byteLength(chunk, 'utf8')
        return false
      }
      if (chunk.includes('event: activity')) {
        writeReturnedFalse = true
        bufferedBytes += Buffer.byteLength(chunk, 'utf8')
        return false
      }
      return true
    }),
    end: vi.fn(() => {
      ended = true
    }),
    on: vi.fn((name: string, listener: () => void) => {
      if (name === 'close') closeListener = listener
      return res
    }),
    get writableEnded() {
      return ended
    },
  } as unknown as Response
  return {
    res,
    writes,
    close: () => closeListener?.(),
    isBackpressured: () => writeReturnedFalse,
    isEnded: () => ended,
    activityWriteCount: () => writes.filter(chunk => chunk.includes('event: activity')).length,
    bufferedBytes: () => bufferedBytes,
    writesAfterEnd: () => writesAfterEnd,
  }
}

function activity(
  user: string,
  path: string,
  eventId: string
): Omit<HostActivityEvent, 'hostRef' | 'ts'> {
  const resource = canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: 'host',
    logicalId: 'mcp-host/chatllm',
    displayName: 'chatllm',
  })
  const target = validateActionOperationTarget({
    operationId: 'host.activity.read',
    resource,
    operationTarget: { hostRef: resource.logicalId, visibility: 'caller_path' },
  })
  return {
    version: '1.0',
    eventId,
    type: 'task.started',
    title: 'started',
    severity: 'info',
    meta: {},
    redactions: [],
    authorityV2: {
      version: 2,
      userId: user,
      sid,
      sessionVersion: 7,
      delegationJti,
      operationId: 'host.activity.read',
      resource,
      target,
      targetHash: hashActionTarget(target),
      accessPathId: path,
      authorizationRevision: `ar1_${'c'.repeat(43)}`,
      pathKind: 'direct',
      effectiveTeamId: null,
      behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    },
  }
}

describe('activity stream writable backpressure', () => {
  it.each(['host.activity.read', 'host.activity.read_all'] as const)(
    'closes after write(false) for %s while the producer continues, without replay or leaks',
    async operationId => {
      const context = await realActivityContext(operationId)
      const hub = new HostActivityHub(1_000, 2_048)
      const checkpoint = vi.fn().mockResolvedValue('allowed')
      const unsubscribe = vi.fn()
      const captured = slowWritable()

      await handleActivityStreamRoute(
        streamRequest(context),
        captured.res,
        makeHandlers({
          activityStreamCheckpointHandler: checkpoint,
          activityStreamHandler: subscriber => {
            const remove = hub.subscribe(subscriber)
            unsubscribe.mockImplementation(remove)
            return { hostRef: 'chatllm', unsubscribe }
          },
        })
      )

      let produced = 0
      const publish = (title: string) => {
        produced += 1
        hub.publish({
          ...activity(userId, context.accessPathId, `event-${produced}`),
          hostRef: 'chatllm',
          type: 'task.started',
          title,
        })
      }
      publish('first')
      await vi.waitFor(() => expect(captured.isBackpressured()).toBe(true))

      for (let index = 0; index < 100; index += 1) {
        publish(`event-${index + 1}`)
        await new Promise(resolve => setImmediate(resolve))
      }

      expect(produced).toBe(101)
      expect(captured.res.end).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(captured.activityWriteCount()).toBe(1)
      expect(captured.writesAfterEnd()).toBe(0)
      expect(captured.bufferedBytes()).toBeLessThanOrEqual(2_048 + 128)
      expect(checkpoint).toHaveBeenCalledOnce()
      captured.close()
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )

  it('closes before retaining an oversized serialized activity payload', async () => {
    const context = await realActivityContext('host.activity.read_all')
    const hub = new HostActivityHub(1_000, 2_048)
    const checkpoint = vi.fn().mockResolvedValue('allowed')
    const unsubscribe = vi.fn()
    const captured = slowWritable()

    await handleActivityStreamRoute(
      streamRequest(context),
      captured.res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: subscriber => {
          const remove = hub.subscribe(subscriber)
          unsubscribe.mockImplementation(remove)
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )

    hub.publish({
      hostRef: 'chatllm',
      taskId: `oversized-task-id-${'x'.repeat(4_096)}`,
      type: 'task.started',
      title: 'large event',
      severity: 'info',
      authorityV2: activity(userId, context.accessPathId, 'oversized')
        .authorityV2 as HostActivityEvent['authorityV2'],
    })

    expect(captured.res.end).toHaveBeenCalledOnce()
    expect(captured.writes.some(chunk => chunk.includes('event: activity'))).toBe(false)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('bounds a legacy V1 activity frame before writing it', async () => {
    const hub = new HostActivityHub(1_000, 2_048)
    const unsubscribe = vi.fn()
    const captured = slowWritable()

    await handleActivityStreamRoute(
      streamRequest(null),
      captured.res,
      makeHandlers({
        activityStreamHandler: subscriber => {
          const remove = hub.subscribe(subscriber)
          unsubscribe.mockImplementation(remove)
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )

    hub.publish({
      hostRef: 'chatllm',
      taskId: `oversized-task-id-${'x'.repeat(4_096)}`,
      type: 'task.started',
      title: 'large legacy event',
      severity: 'info',
    })

    expect(captured.res.end).toHaveBeenCalledOnce()
    expect(captured.writes.some(chunk => chunk.includes('event: activity'))).toBe(false)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(captured.writesAfterEnd()).toBe(0)
  })
})

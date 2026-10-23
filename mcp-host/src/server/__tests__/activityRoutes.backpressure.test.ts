import { describe, expect, it, vi } from 'vitest'
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

async function realActivityContext(
  operationId: 'host.activity.read' | 'host.activity.read_all' = 'host.activity.read'
) {
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
  const repositoryRoot = resolve(process.cwd(), '..')
  const checkpoint = JSON.parse(
    execFileSync(
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
      { cwd: repositoryRoot, encoding: 'utf8' }
    )
  )
  const { authorizeActionV2 } = (await import(
    `${process.cwd()}/../rpc-proxy/src/actionAuthorityV2.ts`
  )) as {
    authorizeActionV2: (
      delegation: unknown,
      bound: unknown,
      options: unknown
    ) => Promise<{ trustedEdgeHeader: string }>
  }
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

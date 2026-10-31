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
import { handleActivityRoute, handleActivityStreamRoute } from '../routes'
import type { HostActivityEvent } from '../types'
import { makeHandlers } from './testHelpers'

const streamUserId = '11111111-1111-4111-8111-111111111111'
const streamSessionId = '22222222-2222-4222-8222-222222222222'
const streamDelegationJti = '33333333-3333-4333-8333-333333333333'

async function realActivityContext(operationId: 'host.activity.read' | 'host.activity.read_all') {
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
    sub: streamUserId,
    sid: streamSessionId,
    sv: 7,
    jti: streamDelegationJti,
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
    runtimeCaller: {
      caller: 'rpc-proxy',
      userId: streamUserId,
      actionContextV2,
    },
  } as unknown as Request
}

function streamResponse() {
  const writes: string[] = []
  let closeListener: (() => void) | undefined
  let ended = false
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk)
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
  }
}

function responseCapture(): { res: Response; status: () => number; body: () => any } {
  let statusCode = 0
  let body: unknown
  const res = {
    writeHead: vi.fn((status: number) => {
      statusCode = status
      return res
    }),
    end: vi.fn((value?: string) => {
      body = value ? JSON.parse(value) : undefined
      return res
    }),
  } as unknown as Response
  return { res, status: () => statusCode, body: () => body }
}

function event(eventId: string, userId?: string, accessPathId?: string): HostActivityEvent {
  return {
    version: '1.0',
    eventId,
    hostRef: 'chatllm',
    ts: new Date().toISOString(),
    type: 'task.started',
    title: 'started',
    severity: 'info',
    meta: {},
    redactions: [],
    ...(userId && accessPathId
      ? {
          authorityV2: {
            version: 2,
            userId,
            sid: '22222222-2222-4222-8222-222222222222',
            sessionVersion: 2,
            delegationJti: '33333333-3333-4333-8333-333333333333',
            operationId: 'chat.message.invoke',
            resource: {
              environmentId: 'cluster.local/evenfire',
              type: 'host',
              canonicalId: 'host:mcp-host/chatllm',
              logicalId: 'mcp-host/chatllm',
              displayName: 'chatllm',
            },
            target: {
              hostRef: 'mcp-host/chatllm',
              channelType: 'rpc',
              channelId: 'chatllm',
              messageId: '44444444-4444-4444-8444-444444444444',
            },
            targetHash: `ath2_${'a'.repeat(43)}`,
            accessPathId,
            authorizationRevision: `ar1_${'c'.repeat(43)}`,
            pathKind: 'direct',
            effectiveTeamId: null,
            behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
          },
        }
      : {}),
  }
}

describe('v2 activity visibility', () => {
  it('ordinary activity exposes only the trusted user and selected path', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accessPathId = `ap1_${'b'.repeat(43)}`
    const hub = new HostActivityHub(20, 4096)
    for (const authorityV2 of [
      event('ignored', userId, accessPathId).authorityV2,
      event('ignored', userId, `ap1_${'e'.repeat(43)}`).authorityV2,
      event('ignored', '99999999-9999-4999-8999-999999999999', accessPathId).authorityV2,
      undefined,
    ]) {
      hub.publish({
        hostRef: 'chatllm',
        type: 'task.started',
        title: 'started',
        severity: 'info',
        authorityV2,
      })
    }
    const req = {
      query: {},
      runtimeCaller: {
        caller: 'rpc-proxy',
        userId,
        actionContextV2: { operationId: 'host.activity.read', userId, accessPathId },
      },
    } as unknown as Request
    const captured = responseCapture()
    await handleActivityRoute(
      req,
      captured.res,
      makeHandlers({
        activitySnapshotHandler: async (limit, sinceEventId, visibility) =>
          hub.snapshot('chatllm', limit, sinceEventId, visibility),
      })
    )
    expect(captured.status()).toBe(200)
    expect(captured.body().items.map((item: HostActivityEvent) => item.eventId)).toEqual([
      'evt_0000000001',
    ])
    expect(captured.body().items[0]).not.toHaveProperty('authorityV2')
    expect(captured.body().nextCursor).toBe('evt_0000000001')
  })

  it('applies selected-path visibility before limiting the snapshot', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accessPathId = `ap1_${'b'.repeat(43)}`
    const hub = new HostActivityHub(20, 4096)
    hub.publish({
      hostRef: 'chatllm',
      type: 'task.started',
      title: 'authorized older event',
      severity: 'info',
      authorityV2: event('ignored', userId, accessPathId).authorityV2,
    })
    hub.publish({
      hostRef: 'chatllm',
      type: 'task.started',
      title: 'newer event on another path',
      severity: 'info',
      authorityV2: event('ignored', userId, `ap1_${'e'.repeat(43)}`).authorityV2,
    })
    const req = {
      query: { limit: '1' },
      runtimeCaller: {
        caller: 'rpc-proxy',
        userId,
        actionContextV2: {
          operationId: 'host.activity.read',
          userId,
          accessPathId,
          target: { hostRef: 'mcp-host/chatllm', visibility: 'caller_path' },
        },
      },
    } as unknown as Request
    const captured = responseCapture()

    await handleActivityRoute(
      req,
      captured.res,
      makeHandlers({
        activitySnapshotHandler: async (limit, sinceEventId, visibility) =>
          hub.snapshot('chatllm', limit, sinceEventId, visibility),
      })
    )

    expect(captured.status()).toBe(200)
    expect(captured.body().items).toHaveLength(1)
    expect(captured.body().items[0]).toMatchObject({ title: 'authorized older event' })
    expect(captured.body().nextCursor).toBe(captured.body().items[0].eventId)
  })

  it('denies a caller-requested host-wide view without the exact read-all operation', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accessPathId = `ap1_${'b'.repeat(43)}`
    const activitySnapshotHandler = vi.fn()
    const req = {
      query: { visibility: 'host_all' },
      runtimeCaller: {
        caller: 'rpc-proxy',
        userId,
        actionContextV2: { operationId: 'host.activity.read', userId, accessPathId },
      },
    } as unknown as Request
    const captured = responseCapture()

    await handleActivityRoute(req, captured.res, makeHandlers({ activitySnapshotHandler }))

    expect(captured.status()).toBe(403)
    expect(captured.body()).toEqual({
      error: 'Host-wide activity requires explicit current path authority',
    })
    expect(activitySnapshotHandler).not.toHaveBeenCalled()
  })

  it('does not infer host-wide visibility from a legacy edge caller', async () => {
    const activitySnapshotHandler = vi.fn()
    const req = {
      query: { visibility: 'host_all' },
      runtimeCaller: { caller: 'rpc-proxy', userId: 'legacy-user' },
    } as unknown as Request
    const captured = responseCapture()

    await handleActivityRoute(req, captured.res, makeHandlers({ activitySnapshotHandler }))

    expect(captured.status()).toBe(403)
    expect(activitySnapshotHandler).not.toHaveBeenCalled()
  })

  it('permits host-wide visibility only for the exact selected-path read-all operation', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accessPathId = `ap1_${'b'.repeat(43)}`
    const items = [
      event('evt_0000000001', userId, accessPathId),
      event('evt_0000000002', '99999999-9999-4999-8999-999999999999', `ap1_${'e'.repeat(43)}`),
    ]
    const req = {
      query: { visibility: 'host_all' },
      runtimeCaller: {
        caller: 'rpc-proxy',
        userId,
        actionContextV2: {
          operationId: 'host.activity.read_all',
          userId,
          accessPathId,
          target: { hostRef: 'mcp-host/chatllm', visibility: 'host_all' },
        },
      },
    } as unknown as Request
    const captured = responseCapture()

    await handleActivityRoute(
      req,
      captured.res,
      makeHandlers({
        activitySnapshotHandler: vi.fn().mockResolvedValue({
          hostRef: 'chatllm',
          version: '1.0',
          items,
          nextCursor: 'evt_0000000002',
        }),
      })
    )

    expect(captured.status()).toBe(200)
    expect(captured.body().items.map((item: HostActivityEvent) => item.eventId)).toEqual([
      'evt_0000000001',
      'evt_0000000002',
    ])
    expect(captured.body().items.every((item: HostActivityEvent) => !('authorityV2' in item))).toBe(
      true
    )
  })

  it('filters streamed activity across both user and selected-path boundaries', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const accessPathId = `ap1_${'b'.repeat(43)}`
    let subscriber: ((value: HostActivityEvent) => void) | undefined
    let responseCloseListener: (() => void) | undefined
    const writes: string[] = []
    const unsubscribe = vi.fn()
    const checkpoint = vi.fn().mockResolvedValue('allowed')
    const req = {
      query: {},
      runtimeCaller: {
        caller: 'rpc-proxy',
        userId,
        actionContextV2: {
          operationId: 'host.activity.read',
          userId,
          accessPathId,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          target: { hostRef: 'mcp-host/chatllm', visibility: 'caller_path' },
        },
      },
    } as unknown as Request
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
      end: vi.fn(),
      on: vi.fn((name: string, listener: () => void) => {
        if (name === 'close') responseCloseListener = listener
        return res
      }),
    } as unknown as Response

    await handleActivityStreamRoute(
      req,
      res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: listener => {
          subscriber = listener
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )
    subscriber?.(event('evt_0000000001', userId, accessPathId))
    subscriber?.(event('evt_0000000002', userId, `ap1_${'e'.repeat(43)}`))
    subscriber?.(event('evt_0000000003', '99999999-9999-4999-8999-999999999999', accessPathId))

    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledTimes(1))
    const activityWrites = writes
      .join('')
      .split('\n\n')
      .filter(frame => frame.startsWith('event: activity\n'))
    expect(activityWrites).toHaveLength(1)
    expect(activityWrites[0]).toContain('evt_0000000001')
    expect(activityWrites[0]).not.toContain('authorityV2')
    expect(activityWrites[0]).not.toContain('delegationJti')
    expect(activityWrites.join('')).not.toContain('evt_0000000002')
    expect(activityWrites.join('')).not.toContain('evt_0000000003')

    responseCloseListener?.()
    responseCloseListener?.()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('preserves legacy SSE payload delivery and unsubscribe cleanup without V2 checkpoints', async () => {
    let subscriber: ((value: HostActivityEvent) => void) | undefined
    const captured = streamResponse()
    const unsubscribe = vi.fn()
    const checkpoint = vi.fn()
    await handleActivityStreamRoute(
      streamRequest(undefined),
      captured.res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: listener => {
          subscriber = listener
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )
    const legacyEvent = event(
      'evt_0000000007',
      '99999999-9999-4999-8999-999999999999',
      `ap1_${'e'.repeat(43)}`
    )
    subscriber?.(legacyEvent)

    expect(captured.writes.join('')).toContain(legacyEvent.eventId)
    expect(captured.writes.join('')).not.toContain('authorityV2')
    expect(checkpoint).not.toHaveBeenCalled()
    captured.close()
    captured.close()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(captured.res.end).not.toHaveBeenCalled()
  })

  it.each(['host.activity.read', 'host.activity.read_all'] as const)(
    'uses a real rpc-proxy %s envelope and checkpoints each emitted payload first',
    async operationId => {
      const context = await realActivityContext(operationId)
      let subscriber: ((value: HostActivityEvent) => void) | undefined
      let releaseCheckpoint: ((decision: 'allowed' | 'denied' | 'unavailable') => void) | undefined
      const checkpoint = vi.fn(
        (_binding: unknown) =>
          new Promise<'allowed' | 'denied' | 'unavailable'>(resolve => {
            releaseCheckpoint = resolve
          })
      )
      const captured = streamResponse()
      const unsubscribe = vi.fn()

      await handleActivityStreamRoute(
        streamRequest(context),
        captured.res,
        makeHandlers({
          activityStreamCheckpointHandler: checkpoint,
          activityStreamHandler: listener => {
            subscriber = listener
            return { hostRef: 'chatllm', unsubscribe }
          },
        })
      )

      const activity =
        operationId === 'host.activity.read'
          ? event('evt_0000000001', streamUserId, context.accessPathId)
          : event('evt_0000000002', '99999999-9999-4999-8999-999999999999', `ap1_${'e'.repeat(43)}`)
      subscriber?.(activity)
      expect(checkpoint).toHaveBeenCalledOnce()
      expect(checkpoint.mock.calls[0][0]).toMatchObject({ operationId })
      expect(captured.writes.join('')).not.toContain(activity.eventId)

      releaseCheckpoint?.('allowed')
      await vi.waitFor(() => expect(captured.writes.join('')).toContain(activity.eventId))
      expect(captured.writes.join('')).not.toContain('delegationJti')
      captured.close()
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )

  it('checks consecutive payloads independently and preserves their order', async () => {
    const context = await realActivityContext('host.activity.read')
    let subscriber: ((value: HostActivityEvent) => void) | undefined
    const checkpoint = vi.fn().mockResolvedValue('allowed')
    const captured = streamResponse()
    const unsubscribe = vi.fn()
    await handleActivityStreamRoute(
      streamRequest(context),
      captured.res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: listener => {
          subscriber = listener
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )

    subscriber?.(event('evt_0000000008', streamUserId, context.accessPathId))
    subscriber?.(event('evt_0000000009', streamUserId, context.accessPathId))
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledTimes(2))
    const firstIndex = captured.writes.join('').indexOf('evt_0000000008')
    const secondIndex = captured.writes.join('').indexOf('evt_0000000009')
    expect(firstIndex).toBeGreaterThan(-1)
    expect(secondIndex).toBeGreaterThan(firstIndex)
    expect(checkpoint).toHaveBeenCalledTimes(2)

    captured.close()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('closes and clears when the bounded V2 event queue overflows', async () => {
    const context = await realActivityContext('host.activity.read_all')
    let subscriber: ((value: HostActivityEvent) => void) | undefined
    let releaseCheckpoint: ((decision: 'allowed' | 'denied' | 'unavailable') => void) | undefined
    const checkpoint = vi.fn(
      () =>
        new Promise<'allowed' | 'denied' | 'unavailable'>(resolve => {
          releaseCheckpoint = resolve
        })
    )
    const captured = streamResponse()
    const unsubscribe = vi.fn()
    await handleActivityStreamRoute(
      streamRequest(context),
      captured.res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: listener => {
          subscriber = listener
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )

    for (let i = 0; i < 65; i += 1) {
      subscriber?.(
        event(`evt_${String(i + 10).padStart(10, '0')}`, streamUserId, context.accessPathId)
      )
    }
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(captured.res.end).not.toHaveBeenCalled()
    subscriber?.(event('evt_9999999999', streamUserId, context.accessPathId))

    expect(captured.res.end).toHaveBeenCalledOnce()
    expect(captured.writes.join('')).toContain('stream_overloaded')
    expect(checkpoint).toHaveBeenCalledOnce()
    releaseCheckpoint?.('allowed')
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.writes.join('')).not.toContain('evt_0000000010')
    expect(unsubscribe).toHaveBeenCalledOnce()
    captured.close()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['denied', 'unavailable'] as const)(
    'closes a V2 stream without emitting the pending payload when checkpoint is %s',
    async decision => {
      const context = await realActivityContext('host.activity.read_all')
      let subscriber: ((value: HostActivityEvent) => void) | undefined
      const captured = streamResponse()
      const unsubscribe = vi.fn()
      const checkpoint = vi.fn().mockResolvedValue(decision)

      await handleActivityStreamRoute(
        streamRequest(context),
        captured.res,
        makeHandlers({
          activityStreamCheckpointHandler: checkpoint,
          activityStreamHandler: listener => {
            subscriber = listener
            return { hostRef: 'chatllm', unsubscribe }
          },
        })
      )
      const protectedEvent = event(
        'evt_0000000003',
        '99999999-9999-4999-8999-999999999999',
        `ap1_${'e'.repeat(43)}`
      )
      subscriber?.(protectedEvent)

      await vi.waitFor(() => expect(captured.res.end).toHaveBeenCalledOnce())
      expect(captured.writes.join('')).not.toContain(protectedEvent.eventId)
      expect(captured.writes.join('')).toContain(
        decision === 'denied' ? 'authority_denied' : 'authority_unavailable'
      )
      expect(unsubscribe).toHaveBeenCalledOnce()
      captured.close()
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(captured.res.end).toHaveBeenCalledOnce()
    }
  )

  it('stops the next host-wide event when live authority is revoked', async () => {
    const context = await realActivityContext('host.activity.read_all')
    let subscriber: ((value: HostActivityEvent) => void) | undefined
    const checkpoint = vi.fn().mockResolvedValueOnce('allowed').mockResolvedValueOnce('denied')
    const captured = streamResponse()
    const unsubscribe = vi.fn()
    await handleActivityStreamRoute(
      streamRequest(context),
      captured.res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: listener => {
          subscriber = listener
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )

    const first = event('evt_0000000011', streamUserId, context.accessPathId)
    const afterRevocation = event(
      'evt_0000000012',
      '99999999-9999-4999-8999-999999999999',
      `ap1_${'e'.repeat(43)}`
    )
    subscriber?.(first)
    await vi.waitFor(() => expect(captured.writes.join('')).toContain(first.eventId))
    subscriber?.(afterRevocation)

    await vi.waitFor(() => expect(captured.res.end).toHaveBeenCalledOnce())
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(captured.writes.join('')).not.toContain(afterRevocation.eventId)
    expect(unsubscribe).toHaveBeenCalledOnce()
    captured.close()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('closes on original expiry while idle without periodic authority checks', async () => {
    vi.useFakeTimers()
    try {
      const context = await realActivityContext('host.activity.read')
      let subscriber: ((value: HostActivityEvent) => void) | undefined
      const checkpoint = vi.fn().mockResolvedValue('allowed')
      const captured = streamResponse()
      const unsubscribe = vi.fn()

      await handleActivityStreamRoute(
        streamRequest(context),
        captured.res,
        makeHandlers({
          activityStreamCheckpointHandler: checkpoint,
          activityStreamHandler: listener => {
            subscriber = listener
            return { hostRef: 'chatllm', unsubscribe }
          },
        })
      )

      await vi.advanceTimersByTimeAsync(60_000)
      expect(checkpoint).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(Date.parse(context.expiresAt) - Date.now())
      expect(captured.res.end).toHaveBeenCalledOnce()
      expect(captured.writes.join('')).toContain('authority_expired')
      expect(unsubscribe).toHaveBeenCalledOnce()
      subscriber?.(event('evt_0000000004', streamUserId, context.accessPathId))
      expect(checkpoint).not.toHaveBeenCalled()
      expect(captured.writes.join('')).not.toContain('evt_0000000004')
      captured.close()
      expect(unsubscribe).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit a payload when its checkpoint crosses the original expiry', async () => {
    vi.useFakeTimers()
    try {
      const context = await realActivityContext('host.activity.read_all')
      let subscriber: ((value: HostActivityEvent) => void) | undefined
      let releaseCheckpoint: ((decision: 'allowed' | 'denied' | 'unavailable') => void) | undefined
      const checkpoint = vi.fn(
        () =>
          new Promise<'allowed' | 'denied' | 'unavailable'>(resolve => {
            releaseCheckpoint = resolve
          })
      )
      const captured = streamResponse()
      const unsubscribe = vi.fn()
      await handleActivityStreamRoute(
        streamRequest(context),
        captured.res,
        makeHandlers({
          activityStreamCheckpointHandler: checkpoint,
          activityStreamHandler: listener => {
            subscriber = listener
            return { hostRef: 'chatllm', unsubscribe }
          },
        })
      )
      const protectedEvent = event(
        'evt_0000000005',
        '99999999-9999-4999-8999-999999999999',
        `ap1_${'e'.repeat(43)}`
      )
      subscriber?.(protectedEvent)
      expect(checkpoint).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(Date.parse(context.expiresAt) - Date.now())
      expect(captured.res.end).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
      releaseCheckpoint?.('allowed')
      await Promise.resolve()
      await Promise.resolve()
      expect(captured.writes.join('')).not.toContain(protectedEvent.eventId)
      expect(unsubscribe).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit an in-flight payload after the client disconnects', async () => {
    const context = await realActivityContext('host.activity.read')
    let subscriber: ((value: HostActivityEvent) => void) | undefined
    let releaseCheckpoint: ((decision: 'allowed' | 'denied' | 'unavailable') => void) | undefined
    const checkpoint = vi.fn(
      () =>
        new Promise<'allowed' | 'denied' | 'unavailable'>(resolve => {
          releaseCheckpoint = resolve
        })
    )
    const captured = streamResponse()
    const unsubscribe = vi.fn()
    await handleActivityStreamRoute(
      streamRequest(context),
      captured.res,
      makeHandlers({
        activityStreamCheckpointHandler: checkpoint,
        activityStreamHandler: listener => {
          subscriber = listener
          return { hostRef: 'chatllm', unsubscribe }
        },
      })
    )
    const protectedEvent = event('evt_0000000006', streamUserId, context.accessPathId)
    subscriber?.(protectedEvent)
    expect(checkpoint).toHaveBeenCalledOnce()
    captured.close()
    releaseCheckpoint?.('allowed')
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.writes.join('')).not.toContain(protectedEvent.eventId)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(captured.res.end).not.toHaveBeenCalled()
  })
})

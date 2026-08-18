import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleActivityRoute } from '../routes'
import type { HostActivityEvent } from '../types'
import { makeHandlers } from './testHelpers'

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
    const items = [
      event('evt_0000000001', userId, accessPathId),
      event('evt_0000000002', userId, `ap1_${'e'.repeat(43)}`),
      event('evt_0000000003', '99999999-9999-4999-8999-999999999999', accessPathId),
      event('evt_0000000004'),
    ]
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
        activitySnapshotHandler: vi.fn().mockResolvedValue({
          hostRef: 'chatllm',
          version: '1.0',
          items,
          nextCursor: 'evt_0000000004',
        }),
      })
    )
    expect(captured.status()).toBe(200)
    expect(captured.body().items.map((item: HostActivityEvent) => item.eventId)).toEqual([
      'evt_0000000001',
    ])
    expect(captured.body().nextCursor).toBe('evt_0000000001')
  })
})

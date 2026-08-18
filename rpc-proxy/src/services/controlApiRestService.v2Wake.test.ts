import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CanonicalActionTarget,
  canonicalResourceIdentity,
  hashActionTarget,
} from '@clerum/action-context-contracts'
import type { AuthorizedActionV2 } from '../actionAuthorityV2.js'
import { config } from '../config.js'
import { requestHostWakeFromControlApi } from './controlApiRestService.js'

const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
})
const target: CanonicalActionTarget = Object.freeze({
  hostRef: 'mcp-host/chatllm',
  wakeReason: 'explicit',
})
const action = {
  claims: {
    sub: '10000000-0000-4000-8000-000000000001',
    sid: '20000000-0000-4000-8000-000000000002',
    sv: 1,
    jti: '30000000-0000-4000-8000-000000000003',
    resource,
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
  },
  bound: {
    operationId: 'host.wake',
    target,
    targetHash: hashActionTarget(target),
  },
} as unknown as AuthorizedActionV2

afterEach(() => vi.unstubAllGlobals())

describe('Control API v2 host-wake adapter client', () => {
  it('uses only the rpc-proxy service credential and exact checkpoint binding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'wake-requested', wakeGeneration: 7 }), {
        status: 202,
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestHostWakeFromControlApi('chatllm', 'raw-user-delegation', {
        authorizedActionV2: action,
        wakeReason: 'explicit',
      })
    ).resolves.toEqual({ kind: 'wake-requested', wakeGeneration: 7 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/internal\/action-authority\/hosts\/chatllm\/wake$/)
    expect(init.headers.authorization).toBe(`Bearer ${config.controlApiServiceToken}`)
    expect(init.headers.authorization).not.toContain('raw-user-delegation')
    expect(init.headers['x-service-token']).toBe(config.controlApiServiceName)
    expect(JSON.parse(init.body)).toMatchObject({
      wakeReason: 'explicit',
      binding: {
        operationId: 'host.wake',
        target,
        accessPathId: action.claims.accessPathId,
      },
    })
  })

  it('preserves wake-delegation-required as a typed fail-closed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: 2,
            status: 'denied',
            code: 'wake_delegation_required',
          }),
          { status: 403 }
        )
      )
    )

    await expect(
      requestHostWakeFromControlApi('chatllm', 'raw-user-delegation', {
        authorizedActionV2: action,
        wakeReason: 'message_retry',
      })
    ).resolves.toEqual({
      kind: 'authority',
      status: 403,
      code: 'wake_delegation_required',
    })
  })
})

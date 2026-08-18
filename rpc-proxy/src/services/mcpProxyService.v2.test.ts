import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveHostConnectionForUser, resolveServerConnectionForUser } from './mcpProxyService.js'

describe('v2 checkpoint destination routing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('routes hosts from the validated checkpoint without legacy user access lookup', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const connection = await resolveHostConnectionForUser('user', 'chatllm', 'raw-v2-token', {
      actionContextV2: 'trusted-edge',
      destination: {
        kind: 'host',
        ref: 'mcp-host/chatllm',
        url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      },
    })
    expect(connection).toMatchObject({
      name: 'chatllm',
      url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      headers: { 'x-clerum-edge-action-context': 'trusted-edge' },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a direct/team path destination collision or resource substitution', async () => {
    await expect(
      resolveHostConnectionForUser('user', 'chatllm', 'raw-v2-token', {
        actionContextV2: 'trusted-edge',
        destination: {
          kind: 'host',
          ref: 'mcp-host/other',
          url: 'http://other.mcp-host.svc.cluster.local:8080',
        },
      })
    ).rejects.toThrow('Invalid v2 host destination binding')
  })

  it('routes MCP from the validated checkpoint without the legacy catalog cache', async () => {
    const authorized = {
      checkpoint: {
        destination: {
          kind: 'mcp_server',
          ref: 'mcp-server/weather',
          url: 'http://weather.mcp-server.svc.cluster.local:8080',
        },
      },
    }
    await expect(
      resolveServerConnectionForUser('user', 'weather', 'raw-v2-token', authorized as never)
    ).resolves.toEqual({
      name: 'weather',
      url: 'http://weather.mcp-server.svc.cluster.local:8080',
      headers: {},
    })
  })
})

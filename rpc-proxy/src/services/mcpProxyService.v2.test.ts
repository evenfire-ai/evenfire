import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveHostConnectionForUser, resolveServerConnectionForUser } from './mcpProxyService.js'

describe('v2 checkpoint destination routing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('routes hosts from the validated checkpoint without legacy user access lookup', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const connection = await resolveHostConnectionForUser('user', 'chatllm', 'raw-v2-token', {
      authorizedActionV2: {
        trustedEdgeHeader: 'trusted-edge',
        checkpoint: {
          destination: {
            kind: 'host',
            ref: 'mcp-host/chatllm',
            url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
          },
        },
      } as never,
    })
    expect(connection).toMatchObject({
      name: 'chatllm',
      url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
      headers: {
        'x-clerum-edge-action-context': 'trusted-edge',
      },
    })
    expect(connection?.headers['x-service-token']).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a direct/team path destination collision or resource substitution', async () => {
    await expect(
      resolveHostConnectionForUser('user', 'chatllm', 'raw-v2-token', {
        authorizedActionV2: {
          trustedEdgeHeader: 'trusted-edge',
          checkpoint: {
            destination: {
              kind: 'host',
              ref: 'mcp-host/other',
              url: 'http://other.mcp-host.svc.cluster.local:8080',
            },
          },
        } as never,
      })
    ).rejects.toThrow('Invalid v2 host destination binding')
  })

  it('keeps ordinary V1 Host traffic on the clear edge headers without an action context', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: 'user',
          hostRef: 'chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
          edgeAssertion: 'edge-assertion-fixture',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const connection = await resolveHostConnectionForUser('user', 'chatllm', 'legacy-token')
    expect(connection).toMatchObject({
      headers: {
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-user-id': 'user',
        'x-clerum-edge-assertion': 'edge-assertion-fixture',
      },
    })
    expect(connection?.headers['x-service-token']).toBeUndefined()
    expect(connection?.headers['x-clerum-edge-action-context']).toBeUndefined()
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

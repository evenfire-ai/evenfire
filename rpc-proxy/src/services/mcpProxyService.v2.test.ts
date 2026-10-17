import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config.js'
import {
  resolveArtifactReadHostConnectionForUser,
  resolveHostConnectionForUser,
  resolveServerConnectionForUser,
} from './mcpProxyService.js'

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
        'x-clerum-rpc-proxy-edge-token': expect.stringMatching(/^.{16,}$/),
        'x-service-token': 'rpc-proxy',
      },
    })
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

  it('does not downgrade authorized V2 when the edge credential is unavailable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const previousToken = config.mcpHostEdgeToken
    ;(config as { mcpHostEdgeToken: string }).mcpHostEdgeToken = ''
    try {
      await expect(
        resolveHostConnectionForUser('user', 'chatllm', 'raw-v2-token', {
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
      ).rejects.toThrow('RPC Proxy edge credential is unavailable')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      ;(config as { mcpHostEdgeToken: string }).mcpHostEdgeToken = previousToken
    }
  })

  it('keeps ordinary legacy Host traffic on the legacy edge without the V2 credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: 'user',
          hostRef: 'chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const connection = await resolveHostConnectionForUser('user', 'chatllm', 'legacy-token')
    expect(connection).toMatchObject({
      headers: {
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-user-id': 'user',
        'x-service-token': 'rpc-proxy',
      },
    })
    expect(connection?.headers['x-clerum-rpc-proxy-edge-token']).toBeUndefined()
    expect(connection?.headers['x-clerum-edge-action-context']).toBeUndefined()
  })

  it('keeps artifact-read connections on their existing legacy Spec 48 path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: 'user',
          hostRef: 'chatllm',
          url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const connection = await resolveArtifactReadHostConnectionForUser(
      'user',
      'chatllm',
      'rpc-access-token'
    )

    expect(connection).toMatchObject({
      headers: {
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-service-token': 'rpc-proxy',
      },
    })
    expect(connection?.headers['x-clerum-rpc-proxy-edge-token']).toBeUndefined()
    expect(connection?.headers.authorization).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledOnce()
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

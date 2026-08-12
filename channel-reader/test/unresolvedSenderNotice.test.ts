import { describe, expect, it, vi } from 'vitest'
import { RPCClient } from '../src/rpcClient'

const mockCfg = vi.hoisted(() => ({
  hostRef: 'test-host',
}))

vi.mock('../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

describe('authorizeProviderMessage response shape', () => {
  const identity = {
    medium: 'slack' as const,
    providerUserId: 'U1',
    providerWorkspaceId: 'T1',
    providerChannelId: 'C1',
  }

  it('returns the reason from the body when unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ authorized: false, reason: 'unresolved' })))
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({
      authorized: false,
      reason: 'unresolved',
    })
  })

  it('returns no reason when the response is not ok, so callers stay silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 }))
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({ authorized: false })
  })

  it('returns no reason when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({ authorized: false })
  })

  it('omits the reason when an older mcp-host returns only authorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ authorized: false })))
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({ authorized: false })
  })
})

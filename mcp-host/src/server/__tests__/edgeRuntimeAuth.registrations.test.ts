import { describe, expect, it, vi } from 'vitest'
import { HOST_EDGE_RPC_PROXY_ROUTE_SCOPES } from '@clerum/action-context-contracts'

// Every runtimeEdgeGuard call made while the Host modules load and the server
// registers its routes, with the middleware each call returned.
const guardCalls = vi.hoisted(
  () => [] as Array<{ callers: string[]; scope: unknown; middleware: unknown }>
)

vi.mock('../edgeRuntimeAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('../edgeRuntimeAuth')>()
  return {
    ...actual,
    runtimeEdgeGuard: (...args: Parameters<typeof actual.runtimeEdgeGuard>) => {
      const middleware = actual.runtimeEdgeGuard(...args)
      guardCalls.push({ callers: [...args[0]], scope: args[2], middleware })
      return middleware
    },
  }
})

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
}

function routeKeysUsing(stack: RouteLayer[], handle: unknown): string[] {
  const keys: string[] = []
  for (const layer of stack) {
    if (!layer.route || !layer.route.stack.some(entry => entry.handle === handle)) continue
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) keys.push(`${method.toUpperCase()} ${layer.route.path}`)
    }
  }
  return keys
}

describe('runtime route registrations that admit caller rpc-proxy', () => {
  it('pass the route scope of the shared table for each of the 18 routes', async () => {
    const { RPCServer } = await import('../../server')
    const { sessionSearchAuthority } = await import('../sessionSearchAuth')
    const server = new RPCServer(0)
    const stack = (server as unknown as { app: { router: { stack: RouteLayer[] } } }).app.router
      .stack

    const rpcProxyCalls = guardCalls.filter(call => call.callers.includes('rpc-proxy'))
    expect(rpcProxyCalls).toHaveLength(18)

    const registered = new Map<string, unknown>()
    for (const call of rpcProxyCalls) {
      const direct = routeKeysUsing(stack, call.middleware)
      // Session search wraps its guard in sessionSearchAuthority, which is the
      // middleware mounted on the route.
      const keys = direct.length > 0 ? direct : routeKeysUsing(stack, sessionSearchAuthority)
      expect(keys).toHaveLength(1)
      expect(registered.has(keys[0]!)).toBe(false)
      registered.set(keys[0]!, call.scope)
    }

    expect(Object.fromEntries(registered)).toEqual(HOST_EDGE_RPC_PROXY_ROUTE_SCOPES)
  })

  it('refuses to register an rpc-proxy route without a known route scope', async () => {
    const { runtimeEdgeGuard } = await import('../edgeRuntimeAuth')
    const message = 'A runtime route that admits caller rpc-proxy requires its edge route scope'
    expect(() => runtimeEdgeGuard(['rpc-proxy'], ['session.read'])).toThrow(message)
    expect(() =>
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader'], undefined, 'host:unknown' as never)
    ).toThrow(message)
    // Witness: the same registration with its scope, and a route without
    // caller rpc-proxy, both register.
    expect(typeof runtimeEdgeGuard(['rpc-proxy'], ['session.read'], 'host:session:read')).toBe(
      'function'
    )
    expect(typeof runtimeEdgeGuard(['channel-reader'])).toBe('function')
  })
})

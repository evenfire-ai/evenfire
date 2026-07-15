/**
 * §3.14 (stateless agents) — Ready never waits for MCP.
 *
 * Regression contract for the boot ordering restructure: the RPC server must
 * reach listening AND answer the k8s probe routes (/v1/runtime/live,
 * /v1/runtime/health) while an injected MCP discovery/connect dependency
 * NEVER resolves. The pending discovery must not block, and its eventual
 * settlement (success or loud failure) must trigger the reconciliation hook.
 *
 * Same real-listening-server + fetch pattern as
 * `server.drainingFence.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { startMcpInitializationInBackground } from '../mcpBackgroundInit'

type StartedServer = {
  server: { stop(): Promise<void> }
  baseUrl: string
}

async function startServer(): Promise<StartedServer> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

/** One macrotask turn — lets already-settled promise chains flush. */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('startMcpInitializationInBackground (§3.14 — Ready never waits for MCP)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('server listens and readiness answers OK while MCP discovery never resolves', async () => {
    const afterInitialAttempt = vi.fn()

    // Injected discovery dependency that NEVER resolves.
    startMcpInitializationInBackground({
      initialize: () => new Promise<void>(() => {}),
      afterInitialAttempt,
    })

    const { server, baseUrl } = await startServer()
    try {
      const live = await fetch(`${baseUrl}/v1/runtime/live`)
      expect(live.status).toBe(200)
      expect(await live.json()).toEqual({ status: 'live' })

      const health = await fetch(`${baseUrl}/v1/runtime/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ status: 'ok' })

      // The pending discovery has not settled — the reconciliation hook
      // must not have run.
      expect(afterInitialAttempt).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  }, 10_000) // bounded: a blocking (awaited) discovery would time this out

  it('runs afterInitialAttempt once discovery succeeds', async () => {
    const afterInitialAttempt = vi.fn()
    startMcpInitializationInBackground({
      initialize: () => Promise.resolve(),
      afterInitialAttempt,
    })
    // Returned synchronously — nothing has settled inside the same tick.
    expect(afterInitialAttempt).not.toHaveBeenCalled()

    await flushMicrotasks()
    expect(afterInitialAttempt).toHaveBeenCalledTimes(1)
  })

  it('logs a loud ERROR on discovery failure and STILL starts reconciliation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const afterInitialAttempt = vi.fn()
    const failure = new Error('context-mapper unreachable')

    startMcpInitializationInBackground({
      initialize: () => Promise.reject(failure),
      afterInitialAttempt,
    })

    await flushMicrotasks()

    expect(afterInitialAttempt).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('initial MCP discovery/connect failed'),
      failure
    )
  })
})

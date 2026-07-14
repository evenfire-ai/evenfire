import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import type { CancelHandler, CancelResult, RPCServer } from '../server'

async function startServer(
  cancelResult: CancelResult | (() => CancelResult)
): Promise<{ server: RPCServer; baseUrl: string }> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  // config reads auth settings at module load, so import after the test env is set.
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  server.onCancel(_taskId => (typeof cancelResult === 'function' ? cancelResult() : cancelResult))
  await server.start()
  const address = (server as any).server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function startServerWithHandler(
  handler: CancelHandler
): Promise<{ server: RPCServer; baseUrl: string }> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  // config reads auth settings at module load, so import after the test env is set.
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  server.onCancel(handler)
  await server.start()
  const address = (server as any).server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function rpcEdgeHeaders(userId = 'alice'): Record<string, string> {
  return {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': userId,
  }
}

describe('POST /v1/runtime/tasks/:taskId/cancel', () => {
  it('returns 204 when the cancel handler reports cancelled (pending task)', async () => {
    const { server, baseUrl } = await startServer('cancelled')
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
      })
      expect(res.status).toBe(204)
    } finally {
      await server.stop()
    }
  })

  it('returns 204 when the cancel handler reports cancelled (processing/waiting task)', async () => {
    // The cancel handler abstracts all cancel paths. Whether the task was pending
    // or processing, both map to 'cancelled' → 204.
    const { server, baseUrl } = await startServer('cancelled')
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/xyz/cancel`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
      })
      expect(res.status).toBe(204)
    } finally {
      await server.stop()
    }
  })

  it('returns 204 when task is already terminal (idempotent)', async () => {
    const { server, baseUrl } = await startServer('already_terminal')
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
      })
      expect(res.status).toBe(204)
    } finally {
      await server.stop()
    }
  })

  it('returns 404 when task is not found anywhere', async () => {
    const { server, baseUrl } = await startServer('not_found')
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Task not found')
    } finally {
      await server.stop()
    }
  })

  it('returns 501 when no cancel handler is configured', async () => {
    process.env.CLERUM_ENABLE_AUTH = 'false'
    process.env.CLERUM_HOST_NAME = 'chatllm'
    vi.resetModules()
    // config reads auth settings at module load, so import after the test env is set.
    const { RPCServer } = await import('../server')
    const server = new RPCServer(0)
    // Note: do NOT call onCancel — leave it unconfigured
    await server.start()
    const address = (server as any).server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
      })
      expect(res.status).toBe(501)
    } finally {
      await server.stop()
    }
  })

  // ── Ownership check tests ──────────────────────────────────────────────

  it('passes userId from trusted rpc-proxy edge context to the cancel handler', async () => {
    let capturedUserId: string | undefined
    const { server, baseUrl } = await startServerWithHandler((taskId, requesterUserId) => {
      capturedUserId = requesterUserId
      return 'cancelled'
    })
    try {
      await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: { ...rpcEdgeHeaders('alice'), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'mallory' }),
      })
      expect(capturedUserId).toBe('alice')
    } finally {
      await server.stop()
    }
  })

  it('passes trusted edge userId even when body has no userId field', async () => {
    let capturedUserId: string | undefined | null = 'sentinel'
    const { server, baseUrl } = await startServerWithHandler((taskId, requesterUserId) => {
      capturedUserId = requesterUserId
      return 'cancelled'
    })
    try {
      await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: rpcEdgeHeaders('alice'),
      })
      expect(capturedUserId).toBe('alice')
    } finally {
      await server.stop()
    }
  })

  it('ignores empty-string body userId and uses trusted edge userId instead', async () => {
    let capturedUserId: string | undefined | null = 'sentinel'
    const { server, baseUrl } = await startServerWithHandler((taskId, requesterUserId) => {
      capturedUserId = requesterUserId
      return 'cancelled'
    })
    try {
      await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: { ...rpcEdgeHeaders('alice'), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: '' }),
      })
      expect(capturedUserId).toBe('alice')
    } finally {
      await server.stop()
    }
  })

  it('returns 404 (not 403) when handler returns not_found due to ownership mismatch', async () => {
    // Simulates the main.ts handler returning 'not_found' on mismatch.
    // The HTTP layer collapses both 'not_found' and ownership_mismatch to 404.
    const { server, baseUrl } = await startServer('not_found')
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, {
        method: 'POST',
        headers: { ...rpcEdgeHeaders('mallory'), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'mallory' }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Task not found')
    } finally {
      await server.stop()
    }
  })

  it('returns 401 without authentication when auth is enabled', async () => {
    // Enable auth for this single test via a fresh module instance with env override.
    const originalEnv = process.env.CLERUM_ENABLE_AUTH
    process.env.CLERUM_ENABLE_AUTH = 'true'
    vi.resetModules()
    const { RPCServer: AuthRPCServer } = await import('../server')
    const server = new AuthRPCServer(0)
    server.onCancel(() => 'not_found')
    await server.start()
    const address = (server as any).server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      // No Authorization header
      const res = await fetch(`${baseUrl}/v1/runtime/tasks/abc/cancel`, { method: 'POST' })
      expect(res.status).toBe(401)
    } finally {
      await server.stop()
      process.env.CLERUM_ENABLE_AUTH = originalEnv
      vi.resetModules()
    }
  })
})
